from __future__ import annotations

from pathlib import Path
from uuid import UUID
import pytest

from qwenpaw.app.attachments.service import AttachmentLifecycleService


def test_new_saved_attachment_paths_use_english_documents_directory(tmp_path: Path) -> None:
    service = AttachmentLifecycleService(repository=object(), runtime_root=tmp_path)

    assert service._documents_root().name == "documents"
    assert service._source_path(str(tmp_path / "documents" / "note.md"), lifecycle="saved") == (tmp_path / "documents" / "note.md").resolve()


def test_legacy_chinese_documents_directory_remains_readable(tmp_path: Path) -> None:
    service = AttachmentLifecycleService(repository=object(), runtime_root=tmp_path)
    legacy_path = tmp_path / "资料" / "legacy.md"

    assert service._source_path(str(legacy_path), lifecycle="saved") == legacy_path.resolve()


@pytest.mark.parametrize("section,lifecycle", [("media", "temporary"), ("documents", "saved"), ("资料", "saved")])
def test_owned_legacy_attachment_sources_remain_readable_after_private_upload_switch(tmp_path, section, lifecycle):
    private_root = tmp_path / "private"
    legacy_root = tmp_path / "workspaces" / "designer"
    service = AttachmentLifecycleService(repository=object(), runtime_root=private_root, legacy_media_root=legacy_root / "media")
    target = legacy_root / section / "image.png"
    assert service._source_path(str(target), lifecycle=lifecycle) == target.resolve()
