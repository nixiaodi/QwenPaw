# -*- coding: utf-8 -*-
"""发送给用户的生成文件应发布到标准产物目录。"""

from pathlib import Path
from urllib.parse import unquote

import pytest

from qwenpaw.agents.tools.send_file import send_file_to_user
from qwenpaw.config.context import (
    set_current_request_context,
    set_current_project_dir,
    set_current_workspace_dir,
)


@pytest.fixture(autouse=True)
def _reset_workspace_context():
    set_current_project_dir(None)
    set_current_workspace_dir(None)
    set_current_request_context(None)
    yield
    set_current_project_dir(None)
    set_current_workspace_dir(None)
    set_current_request_context(None)


@pytest.mark.asyncio
async def test_send_root_generated_file_publishes_it_to_outputs(tmp_path: Path):
    source = tmp_path / "爱护环境.md"
    source.write_text("爱护环境", encoding="utf-8")
    set_current_project_dir(tmp_path)
    set_current_workspace_dir(tmp_path)

    result = await send_file_to_user("爱护环境.md")

    published = tmp_path / "artifacts" / "爱护环境.md"
    assert published.read_text(encoding="utf-8") == "爱护环境"
    assert source.exists()
    assert "artifacts" in unquote(str(result.content[0].source.url))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,content",
    [
        ("report.pdf", b"not a PDF"),
        ("poster.png", b"not an image"),
        ("report.docx", b"not a Word file"),
        ("slides.pptx", b"not a presentation"),
        ("sheet.xlsx", b"not a workbook"),
        ("empty.txt", b""),
    ],
)
async def test_invalid_artifact_is_not_published_as_success(tmp_path, name, content):
    from agentscope.message import ToolResultState

    source = tmp_path / name
    source.write_bytes(content)
    set_current_project_dir(tmp_path)
    set_current_workspace_dir(tmp_path)
    result = await send_file_to_user(str(source))
    assert result.state == ToolResultState.ERROR
    assert source.exists()
    assert not (tmp_path / "artifacts" / name).exists()


@pytest.mark.asyncio
async def test_valid_generated_pdf_is_published(tmp_path):
    from pypdf import PdfWriter
    from agentscope.message import ToolResultState

    source = tmp_path / "report.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    with source.open("wb") as stream:
        writer.write(stream)
    set_current_project_dir(tmp_path)
    set_current_workspace_dir(tmp_path)
    result = await send_file_to_user(str(source))
    assert result.state == ToolResultState.SUCCESS
    assert (tmp_path / "artifacts" / "report.pdf").is_file()


@pytest.mark.asyncio
async def test_send_existing_output_keeps_the_same_file(tmp_path: Path):
    published = tmp_path / "artifacts" / "报告.md"
    published.parent.mkdir()
    published.write_text("报告", encoding="utf-8")
    set_current_project_dir(tmp_path)
    set_current_workspace_dir(tmp_path)

    result = await send_file_to_user("artifacts/报告.md")

    assert published.read_text(encoding="utf-8") == "报告"
    assert unquote(str(result.content[0].source.url)).endswith(
        "/artifacts/报告.md",
    )


@pytest.mark.asyncio
async def test_send_shared_agent_output_stays_in_the_users_project(tmp_path: Path):
    user_project = tmp_path / "user-runtime"
    published_agent = tmp_path / "published-agent"
    user_project.mkdir()
    published_agent.mkdir()
    (user_project / "用户报告.md").write_text("个人产物", encoding="utf-8")
    set_current_project_dir(user_project)
    set_current_workspace_dir(published_agent)

    result = await send_file_to_user("用户报告.md")

    assert (user_project / "artifacts" / "用户报告.md").is_file()
    assert not (published_agent / "artifacts" / "用户报告.md").exists()
    assert "user-runtime/artifacts" in unquote(
        str(result.content[0].source.url),
    )


@pytest.mark.asyncio
async def test_multi_user_missing_identity_never_sends_shared_file(
    tmp_path, monkeypatch
):
    from agentscope.message import ToolResultState

    monkeypatch.setattr("qwenpaw.identity.runtime.is_multi_user_enabled", lambda: True)
    source = tmp_path / "report.md"
    source.write_text("private", encoding="utf-8")
    set_current_project_dir(tmp_path)
    result = await send_file_to_user(str(source))
    assert result.state == ToolResultState.ERROR
    assert all(getattr(item, "type", None) != "data" for item in result.content)
    assert source.exists()
    assert not (tmp_path / "artifacts" / source.name).exists()


@pytest.mark.asyncio
async def test_private_registration_denied_never_falls_back(tmp_path, monkeypatch):
    from agentscope.message import ToolResultState
    from qwenpaw.artifacts.service import ArtifactService, ArtifactSourceDenied

    monkeypatch.setattr("qwenpaw.identity.runtime.is_multi_user_enabled", lambda: True)

    async def deny(*args, **kwargs):
        raise ArtifactSourceDenied("artifact_source_denied")

    monkeypatch.setattr(ArtifactService, "publish", deny)
    source = tmp_path / "report.md"
    source.write_bytes(b"report")
    set_current_project_dir(tmp_path)
    set_current_request_context(
        {
            "user_id": "11111111-1111-4111-8111-111111111111",
            "agent_id": "agent-a",
            "conversation_id": "22222222-2222-4222-8222-222222222222",
        }
    )
    result = await send_file_to_user(str(source))
    assert result.state == ToolResultState.ERROR
    assert "retry" in result.content[0].text
    assert source.exists() and not (tmp_path / "artifacts").exists()


@pytest.mark.asyncio
async def test_private_file_returns_portable_authenticated_artifact_url(
    tmp_path, monkeypatch
):
    from types import SimpleNamespace
    from uuid import UUID
    from qwenpaw.artifacts.service import ArtifactService

    source = tmp_path / "report.pdf"
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    with source.open("wb") as stream:
        writer.write(stream)
    artifact_id = UUID("11111111-1111-4111-8111-111111111111")

    async def publish(*args, **kwargs):
        return SimpleNamespace(id=artifact_id)

    async def download(*args, **kwargs):
        return SimpleNamespace(id=artifact_id), source

    monkeypatch.setattr(ArtifactService, "publish", publish)
    monkeypatch.setattr(ArtifactService, "download_path", download)
    monkeypatch.setattr("qwenpaw.identity.runtime.is_multi_user_enabled", lambda: True)
    set_current_project_dir(tmp_path)
    set_current_request_context(
        {
            "user_id": str(artifact_id),
            "agent_id": "default",
            "conversation_id": str(artifact_id),
        }
    )
    result = await send_file_to_user(str(source))
    expected = f"/api/console/artifacts/{artifact_id}/download"
    assert str(result.content[0].source.url).startswith("file:")
    assert expected in result.content[1].text
    assert "sandbox:" not in result.content[1].text
