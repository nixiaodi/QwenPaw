# -*- coding: utf-8 -*-
"""聊天与管理员只读视图共用的历史消息投影。"""

import logging
import json
from uuid import uuid5
from agentscope.message import Msg
from ...schemas import Message
from .utils import agentscope_msg_to_message

logger = logging.getLogger(__name__)

TOOL_OUTPUT_TYPES = frozenset(
    {
        "plugin_call_output",
        "function_call_output",
        "mcp_tool_call_output",
    }
)


def compact_tool_output(message: Message, *, path: str) -> Message:
    """仅缩减展示副本，保留工具身份和受会话权限保护的完整读取引用。"""
    if message.type.value not in TOOL_OUTPUT_TYPES:
        return message
    result = message.model_copy(deep=True)
    for part in result.content:
        data = getattr(part, "data", None)
        if not isinstance(data, dict) or "output" not in data:
            continue
        output = data["output"]
        encoded = (
            output
            if isinstance(output, str)
            else json.dumps(
                output,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        ).encode("utf-8")
        if len(encoded) <= 16 * 1024:
            continue
        data["output"] = "工具输出较大，展开后读取完整内容。"
        data["qwenpaw_output_ref"] = {"path": path, "byte_size": len(encoded)}
    return result


def page_legacy_messages(
    messages: list[Message], *, page_size: int, before_sequence: int | None = None
) -> tuple[list[Message], bool, int | None]:
    """为旧会话使用稳定的列表序号游标，边界始终落在用户输入处。"""
    visible = list(enumerate(messages, start=1))
    if before_sequence is not None:
        visible = [(seq, msg) for seq, msg in visible if seq < before_sequence]
    starts = [
        seq for seq, msg in visible if getattr(msg.role, "value", msg.role) == "user"
    ]
    lower = starts[-page_size] if len(starts) > page_size else None
    selected = [(seq, msg) for seq, msg in visible if lower is None or seq >= lower]
    return [msg for _, msg in selected], lower is not None, lower


async def project_history_messages(
    records, *, conversation_id, load_payload=None, tool_output_path=None
) -> list[Message]:
    """还原外置载荷及旧版消息，忽略已被后续编辑替换的记录。"""
    projected: list[Message] = []
    for record in records:
        if record.status == "superseded":
            continue
        try:
            stored_content = record.content
            if isinstance(stored_content.get("qwenpaw_payload_ref"), dict):
                if load_payload is None:
                    raise RuntimeError("chat_event_payload_loader_unavailable")
                stored_content = await load_payload(stored_content)
            if record.message_type == "legacy_snapshot":
                if record.role == "user":
                    from .user_content import user_content_parts

                    projected.append(
                        Message.model_validate(
                            {
                                "id": str(record.id),
                                "type": "message",
                                "role": "user",
                                "status": record.status,
                                "content": user_content_parts(record),
                                "metadata": {
                                    "timestamp": record.created_at.isoformat(),
                                    "metadata": record.content.get("metadata") or {},
                                    "qwenpaw_editable": True,
                                },
                            }
                        )
                    )
                    continue
                legacy = agentscope_msg_to_message(Msg.model_validate(stored_content))
                for index, message in enumerate(legacy):
                    message.id = str(uuid5(record.id, f"history:{index}"))
                    if tool_output_path is not None:
                        path = tool_output_path(str(record.id))
                        if len(legacy) > 1:
                            path += f"?part={index}"
                        message = compact_tool_output(message, path=path)
                    projected.append(message)
                continue
            payload = {
                "id": str(record.id),
                "type": record.message_type,
                "role": record.role,
                "status": record.status,
                **stored_content,
            }
            metadata = dict(payload.get("metadata") or {})
            metadata.setdefault("timestamp", record.created_at.isoformat())
            if record.role == "user":
                metadata["qwenpaw_editable"] = True
            payload["metadata"] = metadata
            message = Message.model_validate(payload)
            if tool_output_path is not None:
                message = compact_tool_output(
                    message, path=tool_output_path(str(record.id))
                )
            projected.append(message)
        except Exception as exc:
            logger.error(
                "PostgreSQL message projection failed for conversation=%s sequence=%s",
                conversation_id,
                record.sequence,
                exc_info=True,
            )
            raise RuntimeError("postgres_message_projection_failed") from exc
    return projected
