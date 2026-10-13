# -*- coding: utf-8 -*-
from agentscope.message import (
    Msg,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    DataBlock,
    URLSource,
)

from qwenpaw.agents.image_generation_guard import ImageGenerationGuard
from qwenpaw.loop.gates import StopAction
import pytest
import json


@pytest.mark.asyncio
async def test_tool_evidence_survives_context_compression():
    from qwenpaw.agents.image_generation_guard import ImageGenerationEvidenceMiddleware
    from agentscope.tool import ToolResponse

    guard = ImageGenerationGuard()
    middleware = ImageGenerationEvidenceMiddleware(guard)
    call = ToolCallBlock(
        id="generate",
        name="execute_shell_command",
        input='{"command":"python scripts/image_gen.py generate --out poster.png"}',
    )

    async def generated():
        yield ToolResponse(
            state="success", content=[TextBlock(text="Wrote poster.png")]
        )

    _ = [
        chunk
        async for chunk in middleware.on_acting(None, {"tool_call": call}, generated)
    ]
    output = json.dumps(
        [
            {
                "type": "image",
                "source": {
                    "type": "url",
                    "url": "file:///tmp/poster.png",
                    "media_type": "image/png",
                },
            }
        ]
    )

    async def sent():
        yield ToolResponse(state="success", content=[TextBlock(text=output)])

    delivery = ToolCallBlock(
        id="sent", name="send_file_to_user", input='{"file_path":"poster.png"}'
    )
    _ = [
        chunk
        async for chunk in middleware.on_acting(None, {"tool_call": delivery}, sent)
    ]
    guard.observe([])  # Scroll has replaced the active model context with hints.
    assert guard.delivered


def delivered(identifier="delivery", state="success", mime="image/png"):
    return ToolResultBlock(
        id=identifier,
        name="send_file_to_user",
        state=state,
        output=[
            DataBlock(
                name="poster.png",
                source=URLSource(url="file:///tmp/poster.png", media_type=mime),
            )
        ],
    )


def messages(*blocks):
    return [Msg(name="assistant", role="assistant", content=list(blocks))]


def test_plain_claim_cannot_complete_image_request():
    guard = ImageGenerationGuard()
    guard.observe([])
    assert (
        guard.check(
            Msg(name="assistant", role="assistant", content=[TextBlock(text="已生成海报")])
        ).action
        == StopAction.INTERRUPT_AND_CONTINUE
    )
    assert not guard.delivered


def test_successful_file_delivery_requires_generation_in_this_turn():
    guard = ImageGenerationGuard()
    guard.observe(messages(delivered()))
    assert not guard.delivered
    guard.observe(
        messages(
            ToolCallBlock(
                id="generate",
                name="execute_shell_command",
                input='{"command":"python scripts/image_gen.py generate --prompt 成都 --out poster.png"}',
            ),
            ToolResultBlock(
                id="generate",
                name="execute_shell_command",
                state="success",
                output="created poster.png",
            ),
            delivered(),
        )
    )
    assert guard.delivered
    assert (
        guard.check(
            Msg(name="assistant", role="assistant", content=[TextBlock(text="完成")])
        ).action
        == StopAction.BYPASS
    )


def test_old_or_failed_delivery_does_not_validate_new_generation():
    guard = ImageGenerationGuard()
    guard.seed(messages(delivered("old")))
    guard.observe(
        messages(
            delivered("old"),
            delivered("failed", state="error"),
            delivered("pdf", mime="application/pdf"),
        )
    )
    assert not guard.delivered


def test_repeated_claims_end_with_honest_failure():
    guard = ImageGenerationGuard()
    for _ in range(2):
        assert (
            guard.check(
                Msg(name="assistant", role="assistant", content=[TextBlock(text="已生成")])
            ).action
            == StopAction.INTERRUPT_AND_CONTINUE
        )
    result = guard.check(
        Msg(name="assistant", role="assistant", content=[TextBlock(text="已生成")])
    )
    assert result.action == StopAction.TERMINATE
    assert "未生成" in result.final_message.get_text_content()


def test_serialized_delivery_from_live_tool_adapter_is_accepted():
    guard = ImageGenerationGuard()
    output = json.dumps(
        [
            {
                "type": "image",
                "source": {
                    "type": "url",
                    "url": "file:///tmp/poster.png",
                    "media_type": "image/png",
                },
            },
            {
                "type": "text",
                "text": "File sent successfully. Download link: /api/console/artifacts/172a24c8-0831-4883-b30e-dd69bd2489f9/download",
            },
        ]
    )
    guard.observe(
        messages(
            ToolCallBlock(
                id="generate",
                name="execute_shell_command",
                input='{"command":"python scripts/image_gen.py generate --prompt 成都 --out poster.png"}',
            ),
            ToolResultBlock(
                id="generate",
                name="execute_shell_command",
                state="success",
                output="created poster.png",
            ),
            ToolResultBlock(
                id="delivery", name="send_file_to_user", state="success", output=output
            ),
        )
    )
    assert guard.delivered


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["image", "pdf"])
async def test_stream_never_exposes_or_persists_fabricated_success(monkeypatch, kind):
    from types import SimpleNamespace
    from agentscope.agent import Agent
    from agentscope.event import (
        TextBlockStartEvent,
        TextBlockDeltaEvent,
        TextBlockEndEvent,
    )
    from qwenpaw.agents.react_agent import QwenPawAgent
    from qwenpaw.loop.gates import StopHandlerResult

    agent = object.__new__(QwenPawAgent)
    agent.name = "designer"
    agent.state = SimpleNamespace(context=[], reply_id="reply")
    agent._context_manager = None
    agent._gate_pending_stop = None
    agent._request_context = {}
    agent.model = SimpleNamespace(model_key=None)
    agent._model_rejects_media = lambda: False
    agent._uses_request_time_media_normalization = lambda: False
    from qwenpaw.agents.file_delivery_guard import FileDeliveryGuard

    agent._delivery_guard = (
        ImageGenerationGuard()
        if kind == "image"
        else FileDeliveryGuard({"application/pdf"})
    )
    claim = (
        "已生成海报" if kind == "image" else "PDF已生成，下载 https://invented.example/report.pdf"
    )
    monkeypatch.setattr(
        "qwenpaw.agents.model_factory._supports_multimodal_for_current_model",
        lambda: True,
    )
    choices = []

    async def stop(final_msg):
        return StopHandlerResult(final_message=final_msg)

    agent._run_stop_handlers = stop

    async def fake_reasoning(self, tool_choice=None):
        from agentscope.model import OpenAIChatModel

        formatter = object.__new__(OpenAIChatModel)
        _, wire_choice = formatter._format_tools(
            [
                {
                    "type": "function",
                    "function": {
                        "name": "execute_shell_command",
                        "parameters": {"type": "object"},
                    },
                }
            ],
            tool_choice,
        )
        assert wire_choice == ("required" if kind == "image" else None)
        choices.append(getattr(tool_choice, "mode", None))
        yield TextBlockStartEvent(reply_id="reply", block_id="text")
        yield TextBlockDeltaEvent(reply_id="reply", block_id="text", delta=claim)
        yield TextBlockEndEvent(reply_id="reply", block_id="text")
        msg = Msg(name="designer", role="assistant", content=[TextBlock(text=claim)])
        self.state.context.append(msg)
        yield msg

    monkeypatch.setattr(Agent, "_reasoning", fake_reasoning)
    events = []
    for _ in range(3):
        events.extend([event async for event in agent._reasoning()])
    text = "".join(
        event.delta for event in events if isinstance(event, TextBlockDeltaEvent)
    )
    assert claim not in text
    assert ("未生成" if kind == "image" else "未完成") in text
    assert choices == (["required"] if kind == "image" else [None]) * 3
    assert not any(
        claim in message.get_text_content() for message in agent.state.context
    )
