# -*- coding: utf-8 -*-
"""Lightweight runtime status cache and SSE broadcast."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

logger = logging.getLogger(__name__)

_queues: dict[str, set[asyncio.Queue]] = {}
_status_cache: dict[str, dict[str, dict[str, Any] | None]] = {}


def register_sse_client(agent_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=256)
    _queues.setdefault(agent_id, set()).add(q)
    return q


def unregister_sse_client(agent_id: str, q: asyncio.Queue) -> None:
    clients = _queues.get(agent_id)
    if clients is not None:
        clients.discard(q)
        if not clients:
            del _queues[agent_id]


def get_runtime_status(
    agent_id: str,
    session_id: str,
) -> dict[str, Any] | None:
    return _status_cache.get(agent_id, {}).get(session_id)


def clear_runtime_status(agent_id: str, session_id: str) -> None:
    sessions = _status_cache.get(agent_id)
    if not sessions:
        return
    sessions.pop(session_id, None)
    if not sessions:
        _status_cache.pop(agent_id, None)


def broadcast_runtime_status(
    agent_id: str,
    *,
    session_id: str,
    root_session_id: str | None = None,
    chat_id: str | None = None,
    stage: str,
    status: str = "running",
    message: str = "",
    detail: dict[str, Any] | None = None,
) -> None:
    if not session_id:
        return
    payload = {
        "type": "runtime_status",
        "event_id": str(uuid.uuid4()),
        "agent_id": agent_id,
        "session_id": session_id,
        "root_session_id": root_session_id or session_id,
        "chat_id": chat_id,
        "stage": stage,
        "status": status,
        "message": message,
        "detail": detail or {},
        "ts": time.time(),
    }
    if status in {"idle", "completed"}:
        clear_runtime_status(agent_id, session_id)
    else:
        _status_cache.setdefault(agent_id, {})[session_id] = payload

    clients = _queues.get(agent_id)
    if not clients:
        return
    for q in list(clients):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            logger.warning(
                "Runtime status SSE queue full for agent %s",
                agent_id,
            )
