# -*- coding: utf-8 -*-
from uuid import uuid4
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from qwenpaw.access.actor import ActorContext, ActorType
from qwenpaw.identity.models import PlatformRole
from qwenpaw.personal_library.service import PersonalLibraryService
from qwenpaw.app.routers import personal_library as router
from qwenpaw.app.routers import agent_scoped
from tests.unit.personal_library.test_service import InMemoryRepository


@pytest.fixture
def client(monkeypatch, tmp_path):
    service = PersonalLibraryService(repository=InMemoryRepository(), working_dir=tmp_path)
    monkeypatch.setattr(router, "_get_service", lambda: service)

    async def workspace(request):
        return SimpleNamespace(agent_id=request.headers.get("X-Agent-Id", "a"))

    monkeypatch.setattr(router, "get_agent_for_request", workspace)
    class AllowMembership:
        async def require_role(self, **kwargs):
            return SimpleNamespace(historical_read_only=False)

    monkeypatch.setattr(agent_scoped, "is_multi_user_enabled", lambda: True)
    monkeypatch.setattr(agent_scoped, "load_config", lambda: SimpleNamespace(agents=SimpleNamespace(profiles={"a": SimpleNamespace(enabled=True)})))
    monkeypatch.setattr(agent_scoped, "_get_agent_membership_service", lambda: AllowMembership())
    app = FastAPI()

    @app.middleware("http")
    async def identity(request, call_next):
        # Only the test harness sets a trusted actor, never endpoint payloads.
        from uuid import UUID
        request.state.actor = ActorContext(
            user_id=UUID(request.headers["X-Test-Actor"]), actor_type=ActorType.USER,
            platform_role=PlatformRole.ADMIN if request.headers.get("X-Test-Admin") else PlatformRole.MEMBER,
            admin_mode=False, request_id="library-management-test",
        )
        return await call_next(request)

    app.include_router(router.router, prefix="/api")
    app.include_router(agent_scoped.create_agent_scoped_router(), prefix="/api")
    with TestClient(app) as result:
        result.headers["X-Test-Actor"] = str(uuid4())
        yield result


BASE = "/api/console/personal-library/documents"


def create(client, path):
    response = client.post(BASE + "/text", json={"path": path, "content": "private content"})
    assert response.status_code == 201
    return response.json()


def test_page_search_and_mutations_preserve_stable_id(client):
    first = create(client, "采购/合同.md")
    create(client, "notes.md")
    page = client.get(BASE + "/page", params={"query": "采购", "limit": 1}).json()
    assert page["total"] == 1 and page["items"][0]["id"] == first["id"]
    moved = client.patch(BASE + "/" + first["id"], json={
        "destination_path": "归档/合同.md", "expected_updated_at": first["updated_at"],
    })
    assert moved.status_code == 200
    assert moved.json()["id"] == first["id"]
    stale = client.delete(BASE + "/" + first["id"], params={"expected_updated_at": first["updated_at"]})
    assert stale.status_code == 409
    removed = client.delete(BASE + "/" + first["id"], params={"expected_updated_at": moved.json()["updated_at"]})
    assert removed.status_code == 204
    assert client.get(BASE + "/" + first["id"] + "/text").status_code == 404


@pytest.mark.parametrize("foreign", ["user", "agent", "admin"])
def test_foreign_scope_cannot_list_move_delete_or_download(client, foreign):
    document = create(client, "secret.md")
    if foreign == "agent":
        client.headers["X-Agent-Id"] = "b"
    else:
        client.headers["X-Test-Actor"] = str(uuid4())
        if foreign == "admin":
            client.headers["X-Test-Admin"] = "yes"
    assert client.get(BASE + "/page").json() == {"items": [], "total": 0}
    path = BASE + "/" + document["id"]
    assert client.patch(path, json={"destination_path": "stolen.md", "expected_updated_at": document["updated_at"]}).status_code == 404
    assert client.delete(path, params={"expected_updated_at": document["updated_at"]}).status_code == 404
    assert client.get(path + "/download").status_code == 404


@pytest.mark.parametrize("destination", ["../escape.md", "/escape.md", "C:/escape.md", "notes\\a.md", ".qwenpaw-index/forged.json"])
def test_invalid_destination_does_not_move_source(client, destination):
    document = create(client, "safe.md")
    path = BASE + "/" + document["id"]
    response = client.patch(path, json={"destination_path": destination, "expected_updated_at": document["updated_at"]})
    assert response.status_code == 400
    assert client.get(path + "/text").json()["content"] == "private content"


def test_page_limits_and_empty_page(client):
    for name in ["b.md", "A.md", "100%.md"]:
        create(client, name)
    assert client.get(BASE + "/page", params={"offset": 3, "limit": 1}).json() == {"items": [], "total": 3}
    assert client.get(BASE + "/page", params={"query": "%"}).json()["total"] == 1
    assert client.get(BASE + "/page", params={"limit": 101}).status_code == 422
    assert client.get(BASE + "/page", params={"offset": -1}).status_code == 422


def test_agent_path_routes_share_the_same_private_objects_and_reject_header_mismatch(client):
    document = create(client, "same.md")
    scoped = "/api/agents/a/console/personal-library/documents"
    assert client.get(scoped + "/page").json()["items"][0]["id"] == document["id"]
    moved = client.patch(scoped + "/" + document["id"], json={
        "destination_path": "renamed.md", "expected_updated_at": document["updated_at"],
    })
    assert moved.status_code == 200
    response = client.delete(scoped + "/" + document["id"], params={"expected_updated_at": moved.json()["updated_at"]}, headers={"X-Agent-Id": "b"})
    assert response.status_code == 403
    assert client.get(BASE + "/" + document["id"] + "/text").status_code == 200
