# -*- coding: utf-8 -*-
"""Require current-turn generation and image delivery before completion."""
from __future__ import annotations

import json
from agentscope.middleware import MiddlewareBase
from agentscope.tool import ToolResponse

from agentscope.message import DataBlock, Msg, TextBlock, ToolCallBlock, ToolResultBlock

from ..loop.gates import StopAction, StopHandlerResult


def output_media_types(output) -> set[str]:
    """Support native blocks and the adapter's JSON-encoded media result."""
    if isinstance(output, str):
        try:
            output = json.loads(output)
        except ValueError:
            return set()
    if not isinstance(output, list):
        return set()
    result = set()
    for item in output:
        if isinstance(item, DataBlock):
            media_type = getattr(item.source, "media_type", None)
        elif isinstance(item, dict) and item.get("type") in ("image", "data"):
            source = item.get("source")
            media_type = source.get("media_type") if isinstance(source, dict) else None
        elif isinstance(item, TextBlock):
            result.update(output_media_types(item.text))
            continue
        else:
            continue
        if isinstance(media_type, str):
            result.add(media_type)
    return result


def _has_image_output(output) -> bool:
    return any(mime.startswith("image/") for mime in output_media_types(output))


class ImageGenerationGuard:
    reason = "image_generation_not_delivered"
    continuation_message = (
        "The requested image has not been generated and delivered in this turn. "
        "Execute the loaded imagegen skill's scripts/image_gen.py, then call "
        "send_file_to_user with the existing generated image. Reading instructions "
        "or describing an image is not completion. If an API or tool fails, inspect "
        "the actual error; never claim success or invent a file/link."
    )
    failure_message = "本次未生成并交付可下载的图片。图片生成或文件发送未成功完成，不能将此任务标记为已完成。请查看本轮工具的实际错误后重试。"

    def __init__(self) -> None:
        self._old_ids: set[str] = set()
        self._generation_ids: set[str] = set()
        self._generated = False
        self._image_sent = False
        self.has_tool_calls = False
        self._retries = 0

    def seed(self, context: list) -> None:
        self._old_ids = {
            block.id
            for message in context
            for block in message.get_content_blocks()
            if isinstance(block, (ToolCallBlock, ToolResultBlock))
        }

    @property
    def delivered(self) -> bool:
        return self._generated and self._image_sent

    def observe(self, context: list) -> None:
        blocks = [
            block
            for message in context
            for block in message.get_content_blocks()
            if isinstance(block, (ToolCallBlock, ToolResultBlock))
            and block.id not in self._old_ids
        ]
        for block in blocks:
            if not isinstance(block, ToolCallBlock):
                continue
            self.has_tool_calls = True
            if block.name != "execute_shell_command":
                continue
            try:
                command = json.loads(block.input).get("command", "")
            except (ValueError, AttributeError):
                continue
            if not isinstance(command, str):
                continue
            if (
                "image_gen.py" in command
                and any(
                    action in command for action in (" generate", " edit", " batch")
                )
                and "--dry-run" not in command
            ):
                self._generation_ids.add(block.id)
        for block in blocks:
            if not isinstance(block, ToolResultBlock) or block.state != "success":
                continue
            if block.id in self._generation_ids:
                self._generated = True
            if block.name == "send_file_to_user" and _has_image_output(block.output):
                self._image_sent = True

    def check(
        self, final_msg: Msg | None, *, allow_retry: bool = True
    ) -> StopHandlerResult:
        if final_msg is None or self.delivered:
            return StopHandlerResult(action=StopAction.BYPASS)
        if allow_retry and self._retries < 2:
            self._retries += 1
            return StopHandlerResult(
                action=StopAction.INTERRUPT_AND_CONTINUE,
                reason=self.reason,
                continuation_message=self.continuation_message,
            )
        return StopHandlerResult(
            action=StopAction.TERMINATE,
            reason=self.reason,
            final_message=Msg(
                name=final_msg.name,
                role="assistant",
                content=[TextBlock(text=self.failure_message)],
            ),
        )


class ImageGenerationEvidenceMiddleware(MiddlewareBase):
    """Observe real execution results before Scroll compacts tool history."""

    def __init__(self, guard: ImageGenerationGuard) -> None:
        self.guard = guard

    async def on_acting(self, agent, input_kwargs, next_handler):
        call = input_kwargs.get("tool_call")
        async for chunk in next_handler():
            if isinstance(call, ToolCallBlock) and isinstance(chunk, ToolResponse):
                result = ToolResultBlock(
                    id=call.id,
                    name=call.name,
                    state=chunk.state,
                    output=chunk.content,
                )
                self.guard.observe(
                    [Msg(name="tool", role="assistant", content=[call, result])]
                )
            yield chunk
