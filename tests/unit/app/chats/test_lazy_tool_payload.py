"""外置工具输出首屏只读摘要，展开后才读取完整文件。"""

import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from qwenpaw.app.chats.history import project_history_messages
from qwenpaw.app.chats.repo import MessageRecord
from qwenpaw.app.chats.run_persistence import PostgresChatRunPersistence


def wire_output(output):
    return {
        "object": "message",
        "id": "wire-tool",
        "type": "plugin_call_output",
        "role": "tool",
        "status": "completed",
        "content": [
            {
                "type": "data",
                "data": {
                    "name": "read_file",
                    "call_id": "call-1",
                    "state": "success",
                    "output": output,
                },
            }
        ],
    }


def record(stored, message_type="plugin_call_output", role="tool"):
    return MessageRecord(
        id=uuid4(),
        conversation_id=uuid4(),
        sequence=1,
        role=role,
        message_type=message_type,
        content=stored,
        status="completed",
        created_by=uuid4(),
        created_at=datetime.now(UTC),
    )


@pytest.mark.asyncio
async def test_history_skips_full_file_until_expanded_and_keeps_canonical_output(
    tmp_path,
):
    persistence = PostgresChatRunPersistence(
        repository=None, agent_id=uuid4(), payload_storage_dir=tmp_path
    )
    original = wire_output("汉" * 800_000)
    stored = await persistence._store_payload(original, uuid4(), 1)
    item = record(stored)
    load = AsyncMock(wraps=persistence.load_event_payload)
    for prefix in ("/chats/current", "/admin/agents/current/conversations/current"):
        messages = await project_history_messages(
            [item],
            conversation_id=item.conversation_id,
            load_payload=load,
            tool_output_path=lambda mid: f"{prefix}/messages/{mid}/tool-output",
        )
        assert load.await_count == 0
        data = messages[0].content[0].data
        assert data["name"] == "read_file" and data["call_id"] == "call-1"
        assert data["qwenpaw_output_ref"]["byte_size"] == 2_400_000
        assert (
            data["qwenpaw_output_ref"]["path"]
            == f"{prefix}/messages/{item.id}/tool-output"
        )
        assert len(json.dumps(stored, ensure_ascii=False).encode()) < 4096
    full = await project_history_messages(
        [item], conversation_id=item.conversation_id, load_payload=load
    )
    assert load.await_count == 1
    assert full[0].content[0].data["output"] == original["content"][0]["data"]["output"]
    assert await persistence.load_event_payload(stored) == original


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "preview", [None, {"version": 99}, {"version": 1, "message": {"type": "message"}}]
)
async def test_old_or_invalid_previews_fall_back_without_losing_messages(
    tmp_path, preview
):
    persistence = PostgresChatRunPersistence(
        repository=None, agent_id=uuid4(), payload_storage_dir=tmp_path
    )
    stored = await persistence._store_payload(wire_output("x" * 100_000), uuid4(), 1)
    stored.pop("qwenpaw_history_preview", None)
    if preview is not None:
        stored["qwenpaw_history_preview"] = preview
    item = record(stored)
    load = AsyncMock(wraps=persistence.load_event_payload)
    messages = await project_history_messages(
        [item],
        conversation_id=item.conversation_id,
        load_payload=load,
        tool_output_path=lambda _: "/tool-output",
    )
    assert load.await_count == 1
    assert messages[0].content[0].data["call_id"] == "call-1"


@pytest.mark.asyncio
async def test_non_tool_payloads_and_oversized_previews_keep_full_read_path(tmp_path):
    persistence = PostgresChatRunPersistence(
        repository=None, agent_id=uuid4(), payload_storage_dir=tmp_path
    )
    text = {
        "object": "message",
        "id": "text",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": "x" * 100_000}],
    }
    large_metadata = wire_output("x" * 100_000)
    large_metadata["metadata"] = {"details": "y" * 100_000}
    for original in (text, large_metadata):
        stored = await persistence._store_payload(original, uuid4(), 1)
        assert "qwenpaw_history_preview" not in stored
        assert await persistence.load_event_payload(stored) == original


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message_type",
    ["plugin_call_output", "function_call_output", "mcp_tool_call_output"],
)
async def test_preview_preserves_other_parts_and_rebinds_untrusted_paths(
    tmp_path, message_type
):
    persistence = PostgresChatRunPersistence(
        repository=None, agent_id=uuid4(), payload_storage_dir=tmp_path
    )
    original = wire_output({"result": "汉" * 30_000})
    original["type"] = message_type
    original["content"].append(
        {"type": "data", "data": {"name": "small", "output": "small output"}}
    )
    original["content"].append({"type": "text", "text": "retained explanation"})
    stored = await persistence._store_payload(original, uuid4(), 1)
    stored["qwenpaw_history_preview"]["message"]["content"][0]["data"][
        "qwenpaw_output_ref"
    ]["path"] = "/another-user/output"
    item = record(stored, message_type=message_type)
    load = AsyncMock(wraps=persistence.load_event_payload)
    messages = await project_history_messages(
        [item],
        conversation_id=item.conversation_id,
        load_payload=load,
        tool_output_path=lambda _: "/authorized/output",
    )
    assert load.await_count == 0
    assert (
        messages[0].content[0].data["qwenpaw_output_ref"]["path"]
        == "/authorized/output"
    )
    assert messages[0].content[1].data["output"] == "small output"
    assert messages[0].content[2].text == "retained explanation"
    assert await persistence.load_event_payload(stored) == original
