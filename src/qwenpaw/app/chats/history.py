# -*- coding: utf-8 -*-
"""聊天与管理员只读视图共用的历史消息投影。"""

import logging
from agentscope.message import Msg
from ...schemas import Message
from .utils import agentscope_msg_to_message

logger = logging.getLogger(__name__)


async def project_history_messages(
    records, *, conversation_id, load_payload=None
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
                projected.extend(
                    agentscope_msg_to_message(Msg.model_validate(stored_content))
                )
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
            projected.append(Message.model_validate(payload))
        except Exception as exc:
            logger.error(
                "PostgreSQL message projection failed for conversation=%s sequence=%s",
                conversation_id,
                record.sequence,
                exc_info=True,
            )
            raise RuntimeError("postgres_message_projection_failed") from exc
    return projected
