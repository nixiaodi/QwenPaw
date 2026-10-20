"""管理员排查必须独立鉴权，普通成员不能触达会话存储。"""

from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import AsyncMock
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from qwenpaw.access.actor import ActorContext, ActorType
from qwenpaw.access.agent_governance import AgentGovernanceDeniedError
from qwenpaw.access.dependencies import get_actor, require_multi_user_mode
from qwenpaw.identity.models import PlatformRole
from qwenpaw.app.routers import agent_members


@pytest.mark.parametrize("suffix", ["", "/11111111-1111-1111-1111-111111111111"])
def test_member_cannot_inspect_conversations(suffix):
    app = FastAPI()
    app.include_router(agent_members.router, prefix="/api")
    service = SimpleNamespace(
        require_admin_agent=AsyncMock(side_effect=AgentGovernanceDeniedError())
    )
    app.dependency_overrides[require_multi_user_mode] = lambda: None
    app.dependency_overrides[get_actor] = lambda: ActorContext(
        uuid4(), ActorType.USER, PlatformRole.MEMBER, False, "test"
    )
    app.dependency_overrides[agent_members.get_governance_service] = lambda: service
    response = TestClient(app).get("/api/admin/agents/other/conversations" + suffix)
    assert response.status_code == 403
    service.require_admin_agent.assert_awaited_once()


@pytest.mark.asyncio
async def test_inspection_history_rejects_conversation_from_another_agent(monkeypatch):
    from fastapi import HTTPException

    repository = SimpleNamespace(
        get_conversation_for_admin=AsyncMock(return_value=None),
        list_messages=AsyncMock(),
    )
    monkeypatch.setattr(
        agent_members, "get_admin_conversation_repository", lambda actor: repository
    )
    service = SimpleNamespace(require_admin_agent=AsyncMock())
    actor = ActorContext(uuid4(), ActorType.USER, PlatformRole.ADMIN, False, "test")
    with pytest.raises(HTTPException) as caught:
        await agent_members.get_admin_conversation("agentB", uuid4(), actor, service)
    assert caught.value.status_code == 404
    repository.list_messages.assert_not_called()


@pytest.mark.asyncio
async def test_inspection_reuses_chat_history_projection_and_hydrates_payloads(
    tmp_path, monkeypatch
):
    import json
    from datetime import UTC, datetime
    from qwenpaw.app.chats.repo import MessageRecord

    conversation_id = uuid4()
    now = datetime.now(UTC)

    def record(sequence, role, content, status="completed", message_type="message"):
        return MessageRecord(
            id=uuid4(),
            conversation_id=conversation_id,
            sequence=sequence,
            role=role,
            content=content,
            status=status,
            message_type=message_type,
            created_at=now,
        )

    records = [
        record(1, "user", {"content": [{"type": "text", "text": "旧问题"}]}, "superseded"),
        record(
            2,
            "user",
            {
                "name": "user",
                "role": "user",
                "content": [{"type": "text", "text": "修改后的问题"}],
            },
            message_type="legacy_snapshot",
        ),
        record(3, "assistant", {"qwenpaw_payload_ref": {"path": "response.json"}}),
    ]
    payload_dir = tmp_path / ".qwenpaw" / "chat-event-payloads"
    payload_dir.mkdir(parents=True)
    (payload_dir / "response.json").write_text(
        json.dumps({"content": [{"type": "text", "text": "## 已还原的回答"}]}),
        encoding="utf-8",
    )
    repository = SimpleNamespace(
        get_conversation_for_admin=AsyncMock(
            return_value=SimpleNamespace(id=conversation_id)
        ),
        list_messages=AsyncMock(return_value=records),
    )
    monkeypatch.setattr(
        agent_members, "get_admin_conversation_repository", lambda actor: repository
    )
    monkeypatch.setattr(
        agent_members,
        "load_config",
        lambda: SimpleNamespace(
            agents=SimpleNamespace(
                profiles={"agentB": SimpleNamespace(workspace_dir=str(tmp_path))}
            )
        ),
    )
    service = SimpleNamespace(require_admin_agent=AsyncMock())
    actor = ActorContext(uuid4(), ActorType.USER, PlatformRole.ADMIN, False, "test")
    result = await agent_members.get_admin_conversation(
        "agentB", conversation_id, actor, service
    )
    assert [message.content[0].text for message in result["history_messages"]] == [
        "修改后的问题",
        "## 已还原的回答",
    ]
    assert len(result["messages"]) == 3
    assert result["history_messages"][1].metadata["timestamp"] == now.isoformat()
    assert result["read_only"] is True
