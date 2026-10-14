# -*- coding: utf-8 -*-
"""Normalize imported and native user facts for display and text revision."""

from copy import deepcopy

from agentscope.message import Msg

from .utils import agentscope_msg_to_message


def user_content_parts(record) -> list[dict]:
    if record.message_type != "legacy_snapshot":
        return deepcopy(record.content.get("content") or [])
    projected = agentscope_msg_to_message(Msg.model_validate(record.content))
    return [
        part.model_dump(mode="json")
        for message in projected
        if getattr(message.role, "value", message.role) == "user"
        for part in message.content
    ]
