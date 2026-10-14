"""Input preservation and legacy context rewind for latest-message edits."""

import asyncio
from datetime import datetime, timezone
from copy import deepcopy

import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4, uuid5

from qwenpaw.app.chats import turn_edit
from qwenpaw.app.chats.models import ChatSpec
from qwenpaw.app.chats.repo import (
    MessageRecord,
    RepositoryConflictError,
    RunRecord,
)
from qwenpaw.app.chats.session import SafeJSONSession
from qwenpaw.app.task_tracker import TaskTracker


def test_edit_preserves_original_media_and_changes_only_text():
    original = [
        {"type": "text", "text": "old"},
        {
            "type": "image",
            "image_url": "/api/console/attachments/id",
            "attachment_id": "id",
        },
    ]
    edited = turn_edit.replace_text(original, "new")
    assert edited == [{"type": "text", "text": "new"}, original[1]]
    assert original[0]["text"] == "old"


def test_legacy_rewind_keeps_previous_context_and_excludes_old_tools():
    state = {
        "agent": {
            "state": {
                "context": [
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": "previous"}],
                    },
                    {"role": "assistant", "content": "answer"},
                    {
                        "role": "user",
                        "id": "latest",
                        "content": [{"type": "text", "text": "old"}],
                    },
                    {"role": "assistant", "content": "partial tool answer"},
                ]
            },
            "scroll": {"seq_by_id": {"latest": [8, 8]}},
        }
    }
    restored, boundary = turn_edit.rewind_legacy_state(state, "old")
    assert len(restored["agent"]["state"]["context"]) == 2
    assert boundary == 7
    assert len(state["agent"]["state"]["context"]) == 4


def test_legacy_rewind_does_not_guess_if_latest_user_is_not_available():
    with pytest.raises(ValueError, match="turn_context_unavailable"):
        turn_edit.rewind_legacy_state({"agent": {"state": {"context": []}}}, "old")


@pytest.mark.parametrize(
    "prefix",
    [
        "用户上传文件，已经下载到 ",
        "User uploaded a file, downloaded to ",
    ],
)
@pytest.mark.parametrize("frozen_image", [False, True])
def test_legacy_rewind_matches_original_text_without_generated_attachment_hint(
    prefix, frozen_image
):
    path = (
        "C:/workspace/media/original.png"
        if frozen_image
        else "C:/workspace/media/original.pdf"
    )
    source = (
        {"type": "base64", "data": "eA==", "media_type": "image/png"}
        if frozen_image
        else {
            "type": "url",
            "url": "file:///" + path,
            "media_type": "application/octet-stream",
        }
    )
    state = {
        "agent": {
            "state": {
                "context": [
                    {"role": "user", "content": "earlier"},
                    {"role": "assistant", "content": "earlier answer"},
                    {
                        "id": "latest",
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "summarize"},
                            {"type": "data", "source": source},
                            {"type": "text", "text": prefix + path},
                        ],
                    },
                    {"role": "assistant", "content": "old answer"},
                ]
            },
            "scroll": {"seq_by_id": {"latest": [558, 558]}},
        }
    }
    restored, boundary = turn_edit.rewind_legacy_state(
        state, "summarize", attachment_paths=[path]
    )
    assert boundary == 557
    assert len(restored["agent"]["state"]["context"]) == 2
    assert len(state["agent"]["state"]["context"]) == 4


def test_legacy_rewind_never_discards_user_text_or_unmatched_attachment_hint():
    state = {
        "agent": {
            "state": {
                "context": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "summarize"},
                            {
                                "type": "data",
                                "source": {
                                    "type": "url",
                                    "url": "file:///tmp/original.pdf",
                                },
                            },
                            {
                                "type": "text",
                                "text": "用户上传文件，已经下载到 /tmp/different.pdf",
                            },
                        ],
                    }
                ]
            }
        }
    }
    with pytest.raises(ValueError, match="turn_context_unavailable"):
        turn_edit.rewind_legacy_state(
            state, "summarize", attachment_paths=["/tmp/original.pdf"]
        )
    state["agent"]["state"]["context"][0]["content"][1]["source"][
        "url"
    ] = "file:///tmp/different.pdf"
    with pytest.raises(ValueError, match="turn_context_unavailable"):
        turn_edit.rewind_legacy_state(
            state, "summarize", attachment_paths=["/tmp/original.pdf"]
        )
    state["agent"]["state"]["context"][0]["content"][-1][
        "text"
    ] = "Also explain chapter two"
    with pytest.raises(ValueError, match="turn_context_unavailable"):
        turn_edit.rewind_legacy_state(
            state, "summarize", attachment_paths=["/tmp/original.pdf"]
        )


def test_first_scroll_turn_records_zero_boundary_before_database_exists(
    tmp_path,
):
    workspace = SimpleNamespace(workspace_dir=tmp_path)
    config = SimpleNamespace(
        running=SimpleNamespace(
            light_context_config=SimpleNamespace(
                strategy="scroll",
                scroll_config=SimpleNamespace(db_filename="history.db"),
            )
        )
    )
    cursor = turn_edit._history_cursor(
        workspace, SimpleNamespace(session_id="first"), config
    )
    assert cursor == {"path": str(tmp_path / "history.db"), "sequence": 0}


@pytest.mark.asyncio
@pytest.mark.parametrize("canonical", [False, True])
async def test_terminal_replay_does_not_invent_an_empty_answer(canonical):
    editor = object.__new__(turn_edit.LatestTurnEditor)
    editor.chat = SimpleNamespace(id=str(uuid4()))
    wires = [
        {
            "object": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": "answer"}],
        }
    ]
    if canonical:
        wires.append(
            {
                "object": "response",
                "status": "completed",
                "output": wires.copy(),
            }
        )
    editor.repository = SimpleNamespace(
        list_events=AsyncMock(
            return_value=[
                SimpleNamespace(sequence=index + 2, payload=wire)
                for index, wire in enumerate(wires)
            ]
        )
    )
    editor.persistence = SimpleNamespace(
        load_event_payload=AsyncMock(side_effect=lambda value: value)
    )
    edit = turn_edit.TurnEditRequest(message_id=uuid4(), request_id=uuid4())
    replay = [line async for line in editor.replay(edit)]
    assert len(replay) == 2
    assert ("qwenpaw_completion_only" in replay[-1]) is not canonical


async def _accepted_revision(tmp_path, *, status, newer=False, audit="admitted"):
    """Keep real session/tracker behavior; replace only PostgreSQL reads."""
    owner, conversation_id, source_run_id, target_id = (uuid4() for _ in range(4))
    edit = turn_edit.TurnEditRequest(message_id=target_id, request_id=uuid4())
    run_id = uuid5(turn_edit._EDIT_NAMESPACE, f"{conversation_id}:{edit.request_id}")
    now = datetime.now(timezone.utc)
    chat = ChatSpec(
        id=str(conversation_id), session_id="accepted-edit", user_id=str(owner)
    )
    identity = dict(
        session_id=chat.session_id, user_id=chat.user_id, channel=chat.channel
    )
    session = SafeJSONSession(save_dir=str(tmp_path / "sessions"))
    before = {"state": {"context": ["earlier context"]}}
    await session.save_session_state(
        **identity, agent=SimpleNamespace(state_dict=lambda: before)
    )
    await session.begin_turn(**identity, run_id=str(source_run_id))
    await session.restore_turn(
        **identity, source_run_id=str(source_run_id), run_id=str(run_id)
    )
    live = {"state": {"context": ["earlier context", "edited input", "tool result"]}}
    if newer:
        live["state"]["context"].extend(["newer input", "newer answer"])
    await session.save_session_state(
        **identity,
        run_id=str(run_id),
        agent=SimpleNamespace(state_dict=lambda: live),
    )
    records = [
        MessageRecord(
            id=target_id,
            conversation_id=conversation_id,
            run_id=source_run_id,
            sequence=1,
            role="user",
            message_type="message",
            content={"content": [{"type": "text", "text": "old input"}]},
            status="superseded",
            created_by=owner,
            created_at=now,
        ),
        MessageRecord(
            id=uuid4(),
            conversation_id=conversation_id,
            run_id=run_id,
            sequence=2,
            role="user",
            message_type="message",
            content={"content": [{"type": "text", "text": "edited input"}]},
            status="completed",
            created_by=owner,
            created_at=now,
        ),
    ]
    if newer:
        records.append(
            records[-1].model_copy(
                update={
                    "id": uuid4(),
                    "run_id": uuid4(),
                    "sequence": 3,
                    "content": {"content": [{"type": "text", "text": "newer input"}]},
                }
            )
        )
    run = RunRecord(
        id=run_id,
        conversation_id=conversation_id,
        initiated_by=owner,
        status=status,
        started_at=now,
    )
    events = [
        SimpleNamespace(
            sequence=0,
            event_type="turn_revision",
            payload={
                "target_message_id": str(target_id),
                "text": "edited input",
                "source_run_id": str(source_run_id),
            },
        ),
        SimpleNamespace(
            sequence=1, event_type="user_message", payload=records[1].content
        ),
    ]
    if audit == "executed":
        events.append(
            SimpleNamespace(
                sequence=2,
                event_type="tool_completed",
                payload={"call_id": "completed-fixture-tool"},
            )
        )
    elif audit == "incomplete":
        events.pop()
    repository = SimpleNamespace(
        list_messages=AsyncMock(return_value=records),
        get_run=AsyncMock(return_value=run),
        list_events=AsyncMock(return_value=events),
    )
    repository.with_user = lambda _: repository
    tracker = TaskTracker()
    workspace = SimpleNamespace(
        session=session,
        task_tracker=tracker,
        chat_manager=SimpleNamespace(
            conversation_repository=repository, run_persistence=object()
        ),
    )
    return SimpleNamespace(
        editor=turn_edit.LatestTurnEditor(workspace, chat),
        edit=edit,
        payload={
            "content_parts": [{"type": "text", "text": "edited input"}],
            "meta": {"request_context": {}},
        },
        session=session,
        identity=identity,
        tracker=tracker,
        run=run,
        records=records,
        events=events,
        before={"agent": before},
        live={"agent": live},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status", ["queued", "running", "completed", "failed", "cancelled"]
)
async def test_accepted_edit_retry_rejects_newer_normal_input_without_rewind(
    tmp_path, status
):
    fixture = await _accepted_revision(tmp_path, status=status, newer=True)
    records, events = deepcopy(fixture.records), deepcopy(fixture.events)
    with pytest.raises(RepositoryConflictError, match="latest_message_changed"):
        await fixture.editor.prepare(fixture.edit, fixture.payload, SimpleNamespace())
    assert (
        await fixture.session.get_session_state_dict(**fixture.identity) == fixture.live
    )
    assert fixture.records == records
    assert fixture.events == events


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["running", "waiting_input", "waiting_approval"])
@pytest.mark.parametrize("audit", ["admitted", "executed"])
async def test_orphaned_started_edit_cannot_restart_completed_tools(
    tmp_path, status, audit
):
    fixture = await _accepted_revision(tmp_path, status=status, audit=audit)
    events = deepcopy(fixture.events)
    with pytest.raises(ValueError, match="edit_run_unavailable"):
        await fixture.editor.prepare(fixture.edit, fixture.payload, SimpleNamespace())
    assert (
        await fixture.session.get_session_state_dict(**fixture.identity) == fixture.live
    )
    assert fixture.events == events
    assert fixture.run.status == status
    assert "_qwenpaw_prepared_edit" not in fixture.payload


@pytest.mark.asyncio
@pytest.mark.parametrize("audit", ["executed", "incomplete"])
async def test_queued_edit_needs_complete_unstarted_admission_facts(tmp_path, audit):
    fixture = await _accepted_revision(tmp_path, status="queued", audit=audit)
    with pytest.raises(ValueError, match="edit_run_unavailable"):
        await fixture.editor.prepare(fixture.edit, fixture.payload, SimpleNamespace())
    assert (
        await fixture.session.get_session_state_dict(**fixture.identity) == fixture.live
    )


@pytest.mark.asyncio
async def test_unstarted_latest_queued_edit_can_start_once(tmp_path):
    fixture = await _accepted_revision(tmp_path, status="queued")
    assert (
        await fixture.editor.prepare(fixture.edit, fixture.payload, SimpleNamespace())
        == "start"
    )
    assert (
        await fixture.session.get_session_state_dict(**fixture.identity)
        == fixture.before
    )
    assert fixture.payload["_qwenpaw_run_id"] == str(fixture.run.id)


@pytest.mark.asyncio
async def test_started_latest_edit_retry_attaches_without_rewinding(tmp_path):
    fixture = await _accepted_revision(tmp_path, status="running", audit="executed")
    started = asyncio.Event()

    async def active_stream(_):
        started.set()
        await asyncio.Event().wait()
        yield "unreachable"

    await fixture.tracker.attach_or_start(
        fixture.editor.chat.id,
        {"_qwenpaw_run_id": str(fixture.run.id)},
        active_stream,
    )
    try:
        await started.wait()
        assert (
            await fixture.editor.prepare(
                fixture.edit, fixture.payload, SimpleNamespace()
            )
            == "attach"
        )
        assert (
            await fixture.session.get_session_state_dict(**fixture.identity)
            == fixture.live
        )
    finally:
        await fixture.tracker.request_stop(fixture.editor.chat.id)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
async def test_latest_terminal_edit_retry_replays_without_rewinding(tmp_path, status):
    fixture = await _accepted_revision(tmp_path, status=status, audit="executed")
    assert (
        await fixture.editor.prepare(fixture.edit, fixture.payload, SimpleNamespace())
        == "complete"
    )
    assert (
        await fixture.session.get_session_state_dict(**fixture.identity) == fixture.live
    )
