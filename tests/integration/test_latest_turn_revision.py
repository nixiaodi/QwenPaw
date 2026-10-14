"""Latest-turn revisions retain audit facts and enforce owner/version checks."""

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import uuid4
import asyncio
from types import SimpleNamespace

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from qwenpaw.app.chats.repo import (
    ConversationRecord,
    MessageRecord,
    PostgresConversationRepository,
    RepositoryConflictError,
    RunRecord,
    AttachmentRecord,
)
from qwenpaw.app.chats.models import ChatSpec
from qwenpaw.app.chats.run_persistence import PostgresChatRunPersistence
from qwenpaw.app.chats.session import SafeJSONSession
from qwenpaw.app.chats.turn_edit import LatestTurnEditor, TurnEditRequest
from qwenpaw.app.task_tracker import TaskTracker


@pytest.fixture
def revision_database(postgres_test_schema):
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", postgres_test_schema.async_url())
    config.attributes["target_schema"] = postgres_test_schema.name
    command.upgrade(config, "head")
    engine = create_async_engine(postgres_test_schema.async_url(), poolclass=NullPool)
    factory = async_sessionmaker(engine)

    @asynccontextmanager
    async def sessions():
        async with factory.begin() as session:
            yield session

    return postgres_test_schema.name, sessions


async def seed(database, latest_attachment=None):
    schema, sessions = database
    owner, other, agent, conversation = (uuid4() for _ in range(4))
    now = datetime.now(timezone.utc)
    async with sessions() as db:
        for uid, name in ((owner, "owner"), (other, "other")):
            await db.execute(
                text(
                    f'INSERT INTO "{schema}".users '
                    "(id,username,password_hash,status,platform_role) VALUES (:id,:name,'x','active','member')"
                ),
                {"id": uid, "name": name},
            )
        await db.execute(
            text(
                f'INSERT INTO "{schema}".agents '
                "(id,owner_user_id,name,status,visibility,default_model_mode,draft_workspace_key) "
                "VALUES (:id,:owner,'Agent','active','private','inherit','workspaces/revision')"
            ),
            {"id": agent, "owner": owner},
        )
    repository = PostgresConversationRepository(
        schema=schema, session_factory=sessions
    ).with_user(owner)
    await repository.create_conversation(
        ConversationRecord(
            id=conversation,
            agent_id=agent,
            owner_user_id=owner,
            title="Edit",
            status="active",
            created_at=now,
            updated_at=now,
        )
    )
    old_run = uuid4()
    await repository.create_run(
        RunRecord(
            id=old_run,
            conversation_id=conversation,
            initiated_by=owner,
            status="completed",
            started_at=now,
            finished_at=now,
        )
    )
    messages = []
    for seq, role, content in (
        (1, "user", "earlier"),
        (2, "assistant", "earlier answer"),
        (3, "user", "old"),
        (4, "assistant", "old answer"),
    ):
        message = MessageRecord(
            id=uuid4(),
            conversation_id=conversation,
            sequence=seq,
            run_id=old_run if seq >= 3 else None,
            role=role,
            message_type="message",
            content={"content": [{"type": "text", "text": content}]},
            status="completed",
            created_by=owner,
            created_at=now,
        )
        if seq == 3 and latest_attachment is not None:
            message.content["content"].append(latest_attachment)
        await repository.save_message(message)
        messages.append(message)
    return repository, owner, other, agent, conversation, messages


def replacement(owner, conversation, now):
    run = RunRecord(
        id=uuid4(),
        conversation_id=conversation,
        initiated_by=owner,
        status="queued",
        started_at=now,
    )
    message = MessageRecord(
        id=uuid4(),
        run_id=run.id,
        conversation_id=conversation,
        sequence=0,
        role="user",
        message_type="message",
        content={"content": [{"type": "text", "text": "edited"}]},
        status="completed",
        created_by=owner,
        created_at=now,
    )
    return run, message


@pytest.mark.asyncio
async def test_revision_hides_old_turn_but_keeps_audit_and_is_idempotent(
    revision_database,
):
    repo, owner, _, agent, conversation, messages = await seed(revision_database)
    run, incoming = replacement(owner, conversation, messages[-1].created_at)
    kwargs = dict(
        conversation_id=conversation,
        agent_id=agent,
        target_message_id=messages[2].id,
        run=run,
        message=incoming,
        revision={"target_message_id": str(messages[2].id), "text": "edited"},
    )
    result = await repo.revise_latest_turn(**kwargs)
    assert result.sequence == 5
    assert [
        m.content["content"][0]["text"]
        for m in await repo.list_active_messages(conversation)
    ] == ["earlier", "earlier answer", "edited"]
    audit = await repo.list_messages(conversation)
    assert [m.status for m in audit] == [
        "completed",
        "completed",
        "superseded",
        "superseded",
        "completed",
    ]
    assert await repo.revise_latest_turn(**kwargs) == result
    assert len(await repo.list_messages(conversation)) == 5


@pytest.mark.asyncio
async def test_revision_rejects_older_message_without_changing_history(
    revision_database,
):
    repo, owner, _, agent, conversation, messages = await seed(revision_database)
    run, incoming = replacement(owner, conversation, messages[-1].created_at)
    with pytest.raises(RepositoryConflictError, match="latest_message_changed"):
        await repo.revise_latest_turn(
            conversation_id=conversation,
            agent_id=agent,
            target_message_id=messages[0].id,
            run=run,
            message=incoming,
            revision={},
        )
    assert await repo.list_messages(conversation) == messages


@pytest.mark.asyncio
async def test_legacy_attachment_turn_without_snapshot_can_be_edited(
    revision_database, tmp_path
):
    attachment_id = uuid4()
    local_path = str(tmp_path / "original.pdf")
    attachment_url = f"/api/console/attachments/{attachment_id}"
    repo, owner, _, agent, conversation, messages = await seed(
        revision_database,
        latest_attachment={
            "type": "file",
            "file_url": attachment_url,
            "filename": "original.pdf",
        },
    )
    original = messages[2]
    await repo.add_attachment(
        AttachmentRecord(
            id=attachment_id,
            conversation_id=conversation,
            message_id=original.id,
            owner_user_id=owner,
            agent_id=agent,
            original_name="original.pdf",
            media_type="application/pdf",
            size=5,
            storage_key=local_path,
            content_hash="0" * 64,
            lifecycle="temporary",
            created_at=original.created_at,
        )
    )
    session = SafeJSONSession(save_dir=str(tmp_path / "sessions"))
    chat = ChatSpec(
        id=str(conversation), session_id="legacy-with-file", user_id=str(owner)
    )
    context = [
        {"role": "user", "content": "earlier"},
        {"role": "assistant", "content": "earlier answer"},
        {
            "id": "latest",
            "role": "user",
            "content": [
                {"type": "text", "text": "old"},
                {
                    "type": "data",
                    "source": {
                        "type": "url",
                        "url": (tmp_path / "original.pdf").as_uri(),
                    },
                },
                {"type": "text", "text": "用户上传文件，已经下载到 " + local_path},
            ],
        },
        {"role": "assistant", "content": "old answer"},
    ]
    identity = dict(
        session_id=chat.session_id, user_id=chat.user_id, channel=chat.channel
    )
    await session.save_session_state(
        **identity,
        agent=SimpleNamespace(state_dict=lambda: {"state": {"context": context}}),
    )
    with pytest.raises(FileNotFoundError):
        await session.get_turn_snapshot(**identity, run_id=str(original.run_id))
    workspace = SimpleNamespace(
        workspace_dir=tmp_path,
        session=session,
        task_tracker=TaskTracker(),
        chat_manager=SimpleNamespace(
            conversation_repository=repo,
            run_persistence=PostgresChatRunPersistence(repository=repo, agent_id=agent),
        ),
    )
    editor = LatestTurnEditor(workspace, chat)
    edit = TurnEditRequest(message_id=original.id, request_id=uuid4())
    payload = {
        "content_parts": [{"type": "text", "text": "edited"}],
        "meta": {"request_context": {}},
    }
    await editor.preserve_input(edit, payload)
    assert await editor.prepare(edit, payload, SimpleNamespace()) == "start"
    restored = await session.get_session_state_dict(**identity)
    assert restored["agent"]["state"]["context"] == context[:2]
    latest = (await repo.list_active_messages(conversation))[-1]
    assert latest.content["content"] == [
        {"type": "text", "text": "edited"},
        original.content["content"][1],
    ]
    assert (await repo.list_attachments(conversation))[0].message_id == latest.id


@pytest.mark.asyncio
async def test_editor_stops_running_turn_and_rewinds_before_new_run(
    revision_database, tmp_path
):
    repo, owner, _, agent, conversation, messages = await seed(revision_database)
    session = SafeJSONSession(save_dir=str(tmp_path / "sessions"))
    chat = ChatSpec(
        id=str(conversation), session_id="console-session", user_id=str(owner)
    )
    tracker = TaskTracker()
    persistence = PostgresChatRunPersistence(repository=repo, agent_id=agent)
    workspace = SimpleNamespace(
        workspace_dir=tmp_path,
        session=session,
        task_tracker=tracker,
        chat_manager=SimpleNamespace(
            conversation_repository=repo, run_persistence=persistence
        ),
    )
    identity = dict(
        session_id=chat.session_id, user_id=chat.user_id, channel=chat.channel
    )
    module = SimpleNamespace(state_dict=lambda: {"state": {"context": ["previous"]}})
    await session.save_session_state(**identity, agent=module)
    await session.begin_turn(**identity, run_id=str(messages[2].run_id))
    await session.save_session_state(
        **identity,
        run_id=str(messages[2].run_id),
        agent=SimpleNamespace(
            state_dict=lambda: {"state": {"context": ["previous", "old", "partial"]}}
        ),
    )
    running, stopped = asyncio.Event(), asyncio.Event()

    async def old_stream(_):
        running.set()
        try:
            await asyncio.Event().wait()
            yield "unreachable"
        finally:
            stopped.set()

    await tracker.attach_or_start(
        chat.id, {"_qwenpaw_run_id": str(messages[2].run_id)}, old_stream
    )
    await running.wait()
    edit = TurnEditRequest(message_id=messages[2].id, request_id=uuid4())
    payload = {
        "content_parts": [{"type": "text", "text": "edited"}],
        "meta": {"request_context": {}},
        "_qwenpaw_run_id": str(uuid4()),
    }
    editor = LatestTurnEditor(workspace, chat)
    await editor.preserve_input(edit, payload)
    assert await editor.prepare(edit, payload, SimpleNamespace()) == "start"
    assert stopped.is_set()
    assert (await session.get_session_state_dict(**identity))["agent"] == {
        "state": {"context": ["previous"]}
    }
    assert payload["meta"]["request_context"]["run_id"] == payload["_qwenpaw_run_id"]
    # A delayed cancellation save still cannot restore the superseded context.
    await session.save_session_state(
        **identity,
        run_id=str(messages[2].run_id),
        agent=SimpleNamespace(state_dict=lambda: {"state": {"context": ["old"]}}),
    )
    assert (await session.get_session_state_dict(**identity))["agent"]["state"][
        "context"
    ] == ["previous"]

    async def new_stream(_):
        yield 'data: {"id":"new-answer","object":"message","role":"assistant","type":"message","status":"completed","content":[{"type":"text","text":"new answer"}]}\n\n'

    lines = [
        line
        async for line in persistence.wrap_stream(
            chat=chat, initiated_by=owner, stream_fn=new_stream
        )(payload)
    ]
    assert len(lines) == 1
    assert len(await repo.list_active_messages(conversation)) == 4
    assert len(await repo.list_messages(conversation)) == 6
    assert await editor.prepare(edit, payload, SimpleNamespace()) == "complete"
    replay = [line async for line in editor.replay(edit)]
    assert any("new answer" in line for line in replay)
    assert (
        replay[-1]
        == 'data: {"object":"response","status":"completed","qwenpaw_completion_only":true}\n\n'
    )
    assert len(await repo.list_messages(conversation)) == 6


@pytest.mark.asyncio
async def test_replaced_queued_edit_cannot_restart_or_attach_to_newer_turn(
    revision_database, tmp_path
):
    repo, owner, _, agent, conversation, messages = await seed(revision_database)
    session = SafeJSONSession(save_dir=str(tmp_path))
    chat = ChatSpec(id=str(conversation), session_id="queue-test", user_id=str(owner))
    workspace = SimpleNamespace(
        workspace_dir=tmp_path,
        session=session,
        task_tracker=TaskTracker(),
        chat_manager=SimpleNamespace(
            conversation_repository=repo,
            run_persistence=PostgresChatRunPersistence(repository=repo, agent_id=agent),
        ),
    )
    await session.begin_turn(
        session_id=chat.session_id,
        user_id=chat.user_id,
        channel=chat.channel,
        run_id=str(messages[2].run_id),
    )
    editor = LatestTurnEditor(workspace, chat)

    async def prepare(target, text):
        edit = TurnEditRequest(message_id=target, request_id=uuid4())
        payload = {
            "content_parts": [{"type": "text", "text": text}],
            "meta": {"request_context": {}},
        }
        await editor.preserve_input(edit, payload)
        await editor.prepare(edit, payload, SimpleNamespace())
        return edit, payload

    first, first_payload = await prepare(messages[2].id, "first edit")
    replacement = (await repo.list_active_messages(conversation))[-1]
    await prepare(replacement.id, "second edit")
    assert (await repo.get_run(replacement.run_id)).status == "cancelled"
    with pytest.raises(RepositoryConflictError, match="latest_message_changed"):
        await editor.prepare(first, first_payload, SimpleNamespace())
    assert (await repo.list_active_messages(conversation))[-1].content["content"][0][
        "text"
    ] == "second edit"


@pytest.mark.asyncio
async def test_new_submission_is_durable_before_its_stream_starts(revision_database):
    repo, owner, _, agent, conversation, messages = await seed(revision_database)
    run, incoming = replacement(owner, conversation, messages[-1].created_at)
    admitted = await repo.admit_user_turn(agent_id=agent, run=run, message=incoming)
    assert admitted.sequence == 5
    assert (await repo.get_run(run.id)).status == "queued"
    another_run, another_message = replacement(
        owner, conversation, messages[-1].created_at
    )
    with pytest.raises(RepositoryConflictError, match="latest_message_changed"):
        await repo.revise_latest_turn(
            conversation_id=conversation,
            agent_id=agent,
            target_message_id=messages[2].id,
            run=another_run,
            message=another_message,
            revision={},
        )


@pytest.mark.asyncio
async def test_revision_rejects_other_owner(revision_database):
    repo, owner, other, agent, conversation, messages = await seed(revision_database)
    run, incoming = replacement(other, conversation, messages[-1].created_at)
    with pytest.raises(PermissionError):
        await repo.with_user(other).revise_latest_turn(
            conversation_id=conversation,
            agent_id=agent,
            target_message_id=messages[2].id,
            run=run,
            message=incoming,
            revision={},
        )
    assert await repo.list_messages(conversation) == messages
