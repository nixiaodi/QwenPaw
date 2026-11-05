"""会话列表条件请求：减少重复传输，同时每次重新校验权限和状态。"""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI

from qwenpaw.access.actor import ActorContext, ActorType
from qwenpaw.access.agent_repository import agent_database_id
from qwenpaw.app.chats import api
from qwenpaw.app.chats.models import ChatSpec
from qwenpaw.identity.models import PlatformRole


@pytest.fixture
def list_app(monkeypatch):
    user_id = uuid4()
    spec = ChatSpec(id=str(uuid4()), session_id="session", user_id=str(user_id))
    access = SimpleNamespace(
        access_role="owner", read_only=False, shared_by_username=None
    )
    manager = SimpleNamespace(
        list_accessible_chats=AsyncMock(
            return_value=[SimpleNamespace(chat=spec, access=access)]
        )
    )
    tracker = SimpleNamespace(get_status=AsyncMock(return_value="idle"))
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[api.get_chat_manager] = lambda: manager
    app.dependency_overrides[api.get_workspace] = lambda: SimpleNamespace(
        task_tracker=tracker, agent_id="default"
    )

    @app.middleware("http")
    async def actor(request, call_next):
        request.state.actor = ActorContext(
            user_id=user_id,
            actor_type=ActorType.USER,
            platform_role=PlatformRole.MEMBER,
            admin_mode=False,
            request_id="list-test",
        )
        return await call_next(request)

    monkeypatch.setattr(api, "is_multi_user_enabled", lambda: True)
    return app, manager, tracker, spec


@pytest.mark.asyncio
async def test_unchanged_list_returns_empty_304_after_authorization(list_app):
    app, manager, _tracker, _spec = list_app
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.get("/chats")
        assert first.status_code == 200
        assert first.json()[0]["status"] == "idle"
        etag = first.headers["etag"]
        second = await client.get("/chats", headers={"If-None-Match": etag})
        assert second.status_code == 304
        assert second.content == b""
        assert manager.list_accessible_chats.await_count == 2
        assert manager.list_accessible_chats.call_args.kwargs[
            "agent_id"
        ] == agent_database_id("default")
        assert "private" in second.headers["cache-control"]
        assert "no-cache" in second.headers["cache-control"]
        assert {"authorization", "cookie", "x-agent-id"} <= {
            part.strip().lower() for part in second.headers["vary"].split(",")
        }


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["status", "rename", "revoke"])
async def test_changes_never_reuse_an_obsolete_list(list_app, change):
    app, manager, tracker, spec = list_app
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.get("/chats")
        if change == "status":
            tracker.get_status.return_value = "running"
        elif change == "rename":
            spec.name = "Changed"
        else:
            manager.list_accessible_chats.return_value = []
        second = await client.get(
            "/chats", headers={"If-None-Match": first.headers["etag"]}
        )
        assert second.status_code == 200
        assert second.headers["etag"] != first.headers["etag"]
        if change == "revoke":
            assert second.json() == []
        elif change == "status":
            assert second.json()[0]["status"] == "running"
        else:
            assert second.json()[0]["name"] == "Changed"
