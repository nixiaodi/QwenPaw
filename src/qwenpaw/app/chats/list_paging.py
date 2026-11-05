"""会话列表游标与运行索引筛选；授权始终由请求时的数据库查询决定。"""
from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from .models import ChatSpec

if TYPE_CHECKING:
    from .manager import AccessibleChat

ChatSortKey = tuple[int, int, str]


@dataclass
class ChatPageResult:
    items: list[AccessibleChat]
    has_more: bool
    next_cursor: str | None


def timestamp_microseconds(timestamp: datetime) -> int:
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    delta = timestamp - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def chat_sort_key(chat: ChatSpec) -> ChatSortKey:
    return int(chat.pinned), timestamp_microseconds(chat.updated_at), chat.id


def query_key(*parts: object) -> str:
    return hashlib.sha256(json.dumps(parts, default=str).encode()).hexdigest()


def encode_cursor(key: ChatSortKey, query: str) -> str:
    data = json.dumps([1, query, *key], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def decode_cursor(cursor: str | None, query: str) -> ChatSortKey | None:
    if cursor is None:
        return None
    try:
        if not cursor or len(cursor) > 1024:
            raise ValueError
        value = json.loads(base64.b64decode(cursor + "=" * (-len(cursor) % 4),
                                          altchars=b"-_", validate=True))
        version, binding, pinned, timestamp, chat_id = value
        if (version != 1 or binding != query or type(pinned) is not int
                or pinned not in (0, 1) or type(timestamp) is not int
                or not isinstance(chat_id, str) or not 0 < len(chat_id) <= 256):
            raise ValueError
        return pinned, timestamp, chat_id
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ValueError("invalid_chat_cursor") from exc


def select_candidates(chats: list[ChatSpec], *, after: ChatSortKey | None,
                      limit: int, search: str, channel: str | None,
                      archived: bool | None, owner_query: str,
                      legacy_user_id: str | None = None,
                      session_id: str | None = None) -> list[ChatSpec]:
    selected = []
    start, end = 0, len(chats)
    # The cached index is sorted descending. Seek instead of re-scanning all
    # preceding candidates on each authorization batch / continuation page.
    if after is not None:
        while start < end:
            middle = (start + end) // 2
            if chat_sort_key(chats[middle]) >= after:
                start = middle + 1
            else:
                end = middle
    for index in range(start, len(chats)):
        chat = chats[index]
        if session_id is not None and chat.session_id != session_id:
            continue
        if archived is not None and chat.archived != archived:
            continue
        if channel and chat.channel != channel:
            continue
        if search not in chat.name.casefold():
            continue
        if owner_query not in chat.user_id.casefold():
            continue
        if legacy_user_id is not None and chat.user_id != legacy_user_id:
            continue
        selected.append(chat.model_copy(deep=True))
        if len(selected) == limit:
            break
    return selected
