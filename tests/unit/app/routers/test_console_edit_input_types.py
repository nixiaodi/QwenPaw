"""Edited text/files must reach Console as runtime Content, not raw dicts."""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from starlette.requests import Request

from qwenpaw.app.chats.models import ChatSpec
from qwenpaw.schemas import TextContent, FileContent


@pytest.mark.asyncio
async def test_console_edit_converts_preserved_parts_before_streaming(
    workspace_mock, monkeypatch, tmp_path
):
    from qwenpaw.app.routers import console
    from qwenpaw.app.chats import turn_edit
    from qwenpaw.config import config
    from qwenpaw.models import runtime
    from qwenpaw.app.task_tracker import TaskTracker

    received = []

    async def stream(payload):
        received.extend(payload["content_parts"])
        yield 'data: {"object":"response","status":"completed"}\n\n'

    channel = SimpleNamespace(
        resolve_session_id=lambda **_: "edit-session", stream_one=stream
    )
    workspace_mock.channel_manager.get_channel = AsyncMock(return_value=channel)
    workspace_mock.task_tracker = TaskTracker()
    workspace_mock.workspace_dir = tmp_path
    chat = ChatSpec(id=str(uuid4()), session_id="edit-session", user_id="default")

    class Editor:
        def __init__(self, *_):
            pass

        async def preserve_input(self, edit, payload):
            payload["content_parts"] = [
                {"type": "text", "text": "edited input"},
                {"type": "file", "file_url": "file-url", "filename": "original.txt"},
            ]

        async def prepare(self, *_):
            return "start"

    monkeypatch.setattr(turn_edit, "LatestTurnEditor", Editor)
    monkeypatch.setattr(console, "is_multi_user_enabled", lambda: False)
    monkeypatch.setattr(
        console, "get_agent_for_request", AsyncMock(return_value=workspace_mock)
    )
    monkeypatch.setattr(console, "_require_console_conversation_write", AsyncMock())
    monkeypatch.setattr(console, "_resolve_console_chat", AsyncMock(return_value=chat))
    monkeypatch.setattr(console, "_resolve_personal_library_references", AsyncMock())
    monkeypatch.setattr(
        console, "_apply_session_project_dir", AsyncMock(return_value=chat)
    )
    monkeypatch.setattr(
        console,
        "_resolve_console_runtime_project",
        AsyncMock(return_value=(tmp_path, "workspace_fallback")),
    )
    monkeypatch.setattr(console, "_bind_console_task_output", AsyncMock())
    monkeypatch.setattr(
        config,
        "load_agent_config",
        lambda *_: SimpleNamespace(project_dir=str(tmp_path)),
    )
    monkeypatch.setattr(runtime, "prepare_console_model", AsyncMock())
    request = Request(
        {"type": "http", "method": "POST", "path": "/api/console/chat", "headers": []}
    )
    response = await console.post_console_chat(
        {
            "conversation_id": chat.id,
            "session_id": chat.session_id,
            "channel": "console",
            "user_id": "default",
            "input": [
                {"role": "user", "content": [{"type": "text", "text": "before edit"}]}
            ],
            "edit_last_message": {
                "message_id": str(uuid4()),
                "request_id": str(uuid4()),
            },
        },
        request,
    )
    _ = [line async for line in response.body_iterator]
    assert isinstance(received[0], TextContent)
    assert received[0].text == "edited input"
    assert isinstance(received[1], FileContent)
    assert received[1].file_url == "file-url"
