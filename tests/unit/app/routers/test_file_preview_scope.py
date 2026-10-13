from types import SimpleNamespace
from uuid import uuid4
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from qwenpaw.app.routers import files
from qwenpaw.access.agent_repository import agent_database_id
from qwenpaw.app.chats.repo import AttachmentRecord


@pytest.mark.parametrize("foreign", [False, True])
def test_multi_user_preview_is_limited_to_own_runtime(tmp_path, monkeypatch, foreign):
    owner = uuid4()
    path_owner = uuid4() if foreign else owner
    target = tmp_path / "user_workspaces" / str(path_owner) / "default" / "report.pdf"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"%PDF-private-report")
    monkeypatch.setattr(files, "WORKING_DIR", tmp_path)
    monkeypatch.setattr(files, "_ALLOWED_ROOT", tmp_path)
    monkeypatch.setattr(files, "_check_path", lambda path: None)
    monkeypatch.setattr("qwenpaw.identity.runtime.is_multi_user_enabled", lambda: True)
    monkeypatch.setattr(
        "qwenpaw.access.dependencies.get_actor",
        lambda request: SimpleNamespace(user_id=owner),
    )
    app = FastAPI()
    app.include_router(files.router, prefix="/api")
    client = TestClient(app)
    response = client.get("/api/files/preview/" + target.as_posix())
    assert response.status_code == (403 if foreign else 200)
    if foreign:
        assert b"%PDF-private-report" not in response.content


@pytest.mark.parametrize("case", ["owned", "owned_saved", "foreign", "unregistered", "deleted", "wrong_agent", "outside_media", "symlink"])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_legacy_media_preview_requires_matching_live_attachment(tmp_path, monkeypatch, case, method):
    owner = uuid4()
    relative = "AGENTS.md" if case == "outside_media" else ("documents/image.png" if case == "owned_saved" else "media/image.png")
    target = tmp_path / "workspaces" / "designer" / relative
    target.parent.mkdir(parents=True)
    target.write_bytes(b"owned-legacy-image")
    now = datetime.now(UTC)
    record = AttachmentRecord(
        id=uuid4(), owner_user_id=uuid4() if case == "foreign" else owner,
        agent_id=agent_database_id("default" if case == "wrong_agent" else "designer"),
        storage_key=str(target), original_name=target.name, media_type="image/png",
        size=18, content_hash="sha256:test", created_at=now,
        lifecycle="deleted" if case == "deleted" else ("saved" if case == "owned_saved" else "temporary"),
    )
    repository = SimpleNamespace(list_owned_attachments=AsyncMock(return_value=[] if case == "unregistered" else [record]))
    repository.with_user = lambda user_id: repository
    monkeypatch.setattr("qwenpaw.app.chats.repo.PostgresConversationRepository", lambda **kwargs: repository)
    monkeypatch.setattr(files, "WORKING_DIR", tmp_path)
    monkeypatch.setattr(files, "_ALLOWED_ROOT", tmp_path)
    monkeypatch.setattr(files, "_check_path", lambda path: None)
    monkeypatch.setattr("qwenpaw.identity.runtime.is_multi_user_enabled", lambda: True)
    monkeypatch.setattr("qwenpaw.access.dependencies.get_actor", lambda request: SimpleNamespace(user_id=owner))
    if case == "symlink":
        def reject(path):
            raise ValueError("artifact_symlink_denied")
        monkeypatch.setattr("qwenpaw.artifacts.service.reject_symlink_path", reject)
    app = FastAPI()
    app.include_router(files.router, prefix="/api")
    response = TestClient(app).request(method, "/api/files/preview/" + target.as_posix())
    owned = case in {"owned", "owned_saved"}
    assert response.status_code == (200 if owned else 403)
    if owned and method == "GET":
        assert response.content == b"owned-legacy-image"
    elif not owned:
        assert b"owned-legacy-image" not in response.content
