# -*- coding: utf-8 -*-
"""有界历史投影、摘要和权限边界。"""

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from qwenpaw.app.chats import api
from qwenpaw.app.chats.repo import MessageRecord
from qwenpaw.app.chats.history import project_history_messages
from qwenpaw.app.routers import agent_members
from qwenpaw.access.agent_governance import AgentGovernanceDeniedError


def record(sequence=1, role="tool", output="结果", status="completed"):
    return MessageRecord(
        id=uuid4(),
        conversation_id=uuid4(),
        sequence=sequence,
        role=role,
        message_type="plugin_call_output" if role == "tool" else "message",
        content={
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
            ]
        }
        if role == "tool"
        else {"content": [{"type": "text", "text": "问题"}]},
        status=status,
        created_by=uuid4(),
        created_at=datetime.now(UTC),
    )


@pytest.mark.asyncio
async def test_compact_output_is_bounded_and_does_not_mutate_record():
    stored = record(output="汉" * 800_000)
    messages = await project_history_messages(
        [stored],
        conversation_id=stored.conversation_id,
        tool_output_path=lambda message_id: f"/chats/chat/messages/{message_id}/tool-output",
    )
    data = messages[0].content[0].data
    assert len(json.dumps(data["output"], ensure_ascii=False).encode()) <= 2048
    assert data["call_id"] == "call-1"
    assert data["name"] == "read_file"
    assert data["state"] == "success"
    assert data["qwenpaw_output_ref"]["byte_size"] >= 2_400_000
    assert data["qwenpaw_output_ref"]["path"].endswith(f"/{stored.id}/tool-output")
    assert stored.content["content"][0]["data"]["output"] == "汉" * 800_000
    full = await project_history_messages(
        [stored], conversation_id=stored.conversation_id
    )
    assert full[0].content[0].data["output"] == "汉" * 800_000


@pytest.mark.asyncio
async def test_compact_hydrates_old_offload_and_keeps_call_id():
    stored = record()
    payload = stored.content
    payload["content"][0]["data"]["output"] = "x" * 17000
    stored = stored.model_copy(
        update={"content": {"qwenpaw_payload_ref": {"path": "old.json"}}}
    )

    async def load(_):
        return payload

    messages = await project_history_messages(
        [stored],
        conversation_id=stored.conversation_id,
        load_payload=load,
        tool_output_path=lambda _: "/chats/chat/messages/id/tool-output",
    )
    assert messages[0].id == str(stored.id)
    assert messages[0].content[0].data["call_id"] == "call-1"
    assert "qwenpaw_output_ref" in messages[0].content[0].data


@pytest.mark.asyncio
async def test_legacy_multiple_outputs_have_stable_ids_and_distinct_references():
    stored = record().model_copy(
        update={
            "message_type": "legacy_snapshot",
            "role": "assistant",
            "content": {
                "id": "old-message",
                "name": "assistant",
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_result",
                        "id": f"call-{i}",
                        "name": "read_file",
                        "output": "x" * 17000,
                    }
                    for i in range(2)
                ],
            },
        }
    )
    kwargs = {
        "conversation_id": stored.conversation_id,
        "tool_output_path": lambda message_id: f"/chats/chat/messages/{message_id}/tool-output",
    }
    first = await project_history_messages([stored], **kwargs)
    repeated = await project_history_messages([stored], **kwargs)
    assert [message.id for message in first] == [message.id for message in repeated]
    assert first[0].content[0].data["qwenpaw_output_ref"]["path"].endswith("?part=0")
    assert first[1].content[0].data["qwenpaw_output_ref"]["path"].endswith("?part=1")


@pytest.mark.asyncio
async def test_legacy_session_output_reference_can_be_reopened(monkeypatch):
    from qwenpaw.schemas import Message

    monkeypatch.setattr(api, "is_multi_user_enabled", lambda: False)

    async def owned(*_):
        return SimpleNamespace(session_id="legacy", user_id="user", channel="console")

    monkeypatch.setattr(api, "_require_owned_chat", owned)
    monkeypatch.setattr(
        api,
        "agentscope_msg_to_message",
        lambda _: [
            Message.model_validate(
                {
                    "type": "plugin_call_output",
                    "content": [
                        {
                            "type": "data",
                            "data": {"call_id": "legacy-call", "output": "x" * 20000},
                        }
                    ],
                }
            )
        ],
    )

    async def state(*_):
        return {"agent": {}}

    async def status(*_):
        return "idle"

    dependencies = {
        "mgr": SimpleNamespace(),
        "session": SimpleNamespace(get_session_state_dict=state),
        "workspace": SimpleNamespace(
            config=SimpleNamespace(backend="qwenpaw"),
            task_tracker=SimpleNamespace(get_status=status),
        ),
    }
    page = await api.get_chat(
        "legacy-chat", SimpleNamespace(), page_size=5, **dependencies
    )
    output = await api.get_chat_tool_output(
        "legacy-chat", page.messages[0].id, SimpleNamespace(), **dependencies
    )
    assert output.content[0].data["output"] == "x" * 20000


@pytest.mark.asyncio
async def test_summary_checks_permission_before_lightweight_repository_query(
    monkeypatch,
):
    called = False

    async def denied(*args):
        raise HTTPException(404, "Chat not found")

    class Repository:
        def with_user(self, _):
            return self

        async def has_messages(self, _):
            nonlocal called
            called = True
            return True

    monkeypatch.setattr(api, "is_multi_user_enabled", lambda: True)
    monkeypatch.setattr(api, "_require_readable_chat", denied)
    with pytest.raises(HTTPException) as exc:
        await api.get_chat_summary(
            "chat",
            SimpleNamespace(),
            mgr=SimpleNamespace(conversation_repository=Repository()),
            session=None,
            workspace=None,
        )
    assert exc.value.status_code == 404
    assert not called


@pytest.mark.asyncio
async def test_tool_output_rejects_record_from_other_conversation(monkeypatch):
    monkeypatch.setattr(
        api,
        "load_cutover_policy",
        lambda: SimpleNamespace(read_uses_postgres=lambda _: True),
    )
    stored = record()
    actor = SimpleNamespace(user_id=uuid4())

    class Repository:
        def with_user(self, _):
            return self

        async def get_message(self, conversation_id, message_id):
            assert conversation_id != stored.conversation_id
            return None

    async def readable(*_):
        return SimpleNamespace(), SimpleNamespace(read_only=False)

    monkeypatch.setattr(api, "is_multi_user_enabled", lambda: True)
    monkeypatch.setattr(api, "_require_readable_chat", readable)
    monkeypatch.setattr(api, "get_actor", lambda _: actor)
    with pytest.raises(HTTPException) as exc:
        await api.get_chat_tool_output(
            str(uuid4()),
            str(stored.id),
            SimpleNamespace(),
            mgr=SimpleNamespace(conversation_repository=Repository()),
            session=None,
            workspace=None,
        )
    assert exc.value.status_code == 404


def enable_postgres(monkeypatch):
    monkeypatch.setattr(api, "is_multi_user_enabled", lambda: True)
    monkeypatch.setattr(
        api,
        "load_cutover_policy",
        lambda: SimpleNamespace(read_uses_postgres=lambda _: True),
    )
    actor = SimpleNamespace(user_id=uuid4())
    monkeypatch.setattr(api, "get_actor", lambda _: actor)

    async def readable(*_):
        return SimpleNamespace(), SimpleNamespace(
            read_only=True, access_role="viewer", shared_by_username="owner"
        )

    monkeypatch.setattr(api, "_require_readable_chat", readable)


@pytest.mark.asyncio
async def test_summary_does_not_read_or_project_message_payloads(monkeypatch):
    enable_postgres(monkeypatch)

    class Repository:
        def with_user(self, _):
            return self

        async def has_messages(self, _):
            return True

        async def list_messages(self, _):
            raise AssertionError("不应加载历史")

    result = await api.get_chat_summary(
        str(uuid4()),
        SimpleNamespace(),
        mgr=SimpleNamespace(conversation_repository=Repository()),
        session=None,
        workspace=None,
    )
    assert result == {"has_messages": True}


@pytest.mark.asyncio
async def test_bounded_chat_only_projects_selected_page_and_preserves_viewer(
    monkeypatch,
):
    enable_postgres(monkeypatch)
    stored = record(output="x" * 17000)

    class Repository:
        def with_user(self, _):
            return self

        async def list_history_page(self, conversation_id, **kwargs):
            assert kwargs == {"page_size": 5, "before_sequence": 80}
            return [stored], True, 20

        async def list_messages(self, _):
            raise AssertionError("不应加载完整历史")

    async def get_status(_):
        return "idle"

    result = await api.get_chat(
        str(stored.conversation_id),
        SimpleNamespace(),
        mgr=SimpleNamespace(conversation_repository=Repository()),
        session=None,
        workspace=SimpleNamespace(task_tracker=SimpleNamespace(get_status=get_status)),
        page_size=5,
        before_sequence=80,
    )
    assert result.has_more and result.next_before == 20
    assert result.read_only and result.access_role == "viewer"
    assert "qwenpaw_output_ref" in result.messages[0].content[0].data


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["tool", "user"])
async def test_full_output_only_accepts_tool_records_and_does_not_truncate(
    monkeypatch, role
):
    enable_postgres(monkeypatch)
    stored = record(role=role, output="x" * 20000)

    class Repository:
        def with_user(self, _):
            return self

        async def get_message(self, *_):
            return stored

    operation = api.get_chat_tool_output(
        str(stored.conversation_id),
        str(stored.id),
        SimpleNamespace(),
        mgr=SimpleNamespace(conversation_repository=Repository()),
        session=None,
        workspace=None,
    )
    if role == "user":
        with pytest.raises(HTTPException) as exc:
            await operation
        assert exc.value.status_code == 404
    else:
        result = await operation
        assert result.content[0].data["output"] == "x" * 20000
        assert "qwenpaw_output_ref" not in result.content[0].data


@pytest.mark.asyncio
@pytest.mark.parametrize("admin_denied", [True, False])
async def test_admin_output_checks_governance_and_agent_conversation_scope(
    monkeypatch, admin_denied
):
    class Service:
        async def require_admin_agent(self, **_):
            if admin_denied:
                raise AgentGovernanceDeniedError()

    class Repository:
        async def get_conversation_for_admin(self, agent_id, conversation_id):
            return None

        async def get_message(self, *_):
            raise AssertionError("跨 Agent 不应查询消息")

    monkeypatch.setattr(
        agent_members, "get_admin_conversation_repository", lambda _: Repository()
    )
    with pytest.raises(HTTPException) as exc:
        await agent_members.get_admin_conversation_tool_output(
            "other-agent",
            uuid4(),
            uuid4(),
            actor=SimpleNamespace(user_id=uuid4()),
            service=Service(),
        )
    assert exc.value.status_code == (403 if admin_denied else 404)


@pytest.mark.asyncio
async def test_admin_raw_view_never_projects_or_hydrates_history(monkeypatch):
    class Service:
        async def require_admin_agent(self, **_):
            pass

    class Repository:
        async def get_conversation_for_admin(self, *_):
            return SimpleNamespace()

        async def list_raw_message_page(self, _, **kwargs):
            assert kwargs == {"limit": 100, "before_sequence": 101}
            return [record()], True, 1

    monkeypatch.setattr(
        agent_members, "get_admin_conversation_repository", lambda _: Repository()
    )

    def forbidden():
        raise AssertionError("原始视图不应读取 Agent 文件或投影历史")

    monkeypatch.setattr(agent_members, "load_config", forbidden)
    result = await agent_members.get_admin_conversation(
        "agent",
        uuid4(),
        actor=SimpleNamespace(user_id=uuid4()),
        service=Service(),
        view="raw",
        before_sequence=101,
    )
    assert result["has_more"] and result["next_before"] == 1
    assert "history_messages" not in result


@pytest.mark.asyncio
async def test_admin_bounded_history_omits_raw_messages_and_links_own_scope(
    monkeypatch,
):
    stored = record(output="x" * 17000)

    class Service:
        async def require_admin_agent(self, **_):
            pass

    class Repository:
        async def get_conversation_for_admin(self, *_):
            return SimpleNamespace(id=stored.conversation_id)

        async def list_history_page(self, _, **kwargs):
            assert kwargs == {"page_size": 5, "before_sequence": None}
            return [stored], True, 50

        async def list_messages(self, _):
            raise AssertionError("不应加载原始记录")

    monkeypatch.setattr(
        agent_members, "get_admin_conversation_repository", lambda _: Repository()
    )
    monkeypatch.setattr(
        agent_members,
        "_admin_history_persistence",
        lambda *_: SimpleNamespace(load_event_payload=None),
    )
    result = await agent_members.get_admin_conversation(
        "agent-a",
        stored.conversation_id,
        actor=SimpleNamespace(user_id=uuid4()),
        service=Service(),
        page_size=5,
    )
    assert "messages" not in result
    assert result["has_more"] and result["next_before"] == 50
    reference = result["history_messages"][0].content[0].data["qwenpaw_output_ref"]
    assert reference["path"].startswith(
        f"/admin/agents/agent-a/conversations/{stored.conversation_id}/"
    )


@pytest.mark.asyncio
async def test_321_record_initial_page_transfer_is_bounded():
    records = [
        record(
            sequence=i,
            role="user" if i % 3 == 1 else "tool" if i % 3 == 0 else "assistant",
            output="x" * (2 * 1024 * 1024) if i == 321 else "结果",
        )
        for i in range(1, 322)
    ]
    full = await project_history_messages(records, conversation_id="benchmark")
    first_page = await project_history_messages(
        records[-15:],
        conversation_id="benchmark",
        tool_output_path=lambda message_id: f"/chats/chat/messages/{message_id}/tool-output",
    )

    def encoded(messages):
        return json.dumps(
            {"messages": [message.model_dump(mode="json") for message in messages]},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()

    full_size, first_page_size = len(encoded(full)), len(encoded(first_page))
    assert full_size > 2 * 1024 * 1024
    assert first_page_size < 20_000
    print(
        f"321 records, 2 MiB output: full={full_size} B, first_page={first_page_size} B"
    )
