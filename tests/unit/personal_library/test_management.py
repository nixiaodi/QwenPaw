# -*- coding: utf-8 -*-
"""资料管理保持私有隔离，失败时保留原文件。"""
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from qwenpaw.personal_library.service import PersonalLibraryConflict, PersonalLibraryService
from tests.unit.personal_library.test_service import InMemoryRepository


@pytest.mark.asyncio
async def test_move_conflict_and_stale_delete_preserve_both_files(tmp_path):
    service = PersonalLibraryService(repository=InMemoryRepository(), working_dir=tmp_path)
    owner = uuid4()
    first = await service.create_text(owner_user_id=owner, relative_path="a.md", content="a")
    second = await service.create_text(owner_user_id=owner, relative_path="b.md", content="b")
    with pytest.raises(PersonalLibraryConflict, match="library_document_exists"):
        await service.move(owner_user_id=owner, document_id=first.id, destination_path="b.md")
    with pytest.raises(PersonalLibraryConflict, match="library_document_changed"):
        await service.delete(owner_user_id=owner, document_id=first.id,
                             expected_updated_at=first.updated_at - timedelta(seconds=1))
    assert (await service.read_text(owner_user_id=owner, document_id=first.id)).content == "a"
    assert (await service.read_text(owner_user_id=owner, document_id=second.id)).content == "b"


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["move", "delete"])
async def test_metadata_failure_keeps_source_readable(tmp_path, monkeypatch, operation):
    repository = InMemoryRepository()
    service = PersonalLibraryService(repository=repository, working_dir=tmp_path)
    owner = uuid4()
    document = await service.create_text(owner_user_id=owner, relative_path="a.md", content="keep")

    async def fail(*args, **kwargs):
        raise RuntimeError("metadata unavailable")

    monkeypatch.setattr(repository, "save_document" if operation == "move" else "delete_document", fail)
    with pytest.raises(RuntimeError, match="metadata unavailable"):
        if operation == "move":
            await service.move(owner_user_id=owner, document_id=document.id, destination_path="notes/b.md")
        else:
            await service.delete(owner_user_id=owner, document_id=document.id)
    assert (await service.read_text(owner_user_id=owner, document_id=document.id)).content == "keep"
    assert not list(tmp_path.rglob("*.deleting"))
    assert not list(tmp_path.rglob("b.md"))


@pytest.mark.asyncio
async def test_same_path_move_does_not_rewrite_or_remove_file(tmp_path, monkeypatch):
    repository = InMemoryRepository()
    service = PersonalLibraryService(repository=repository, working_dir=tmp_path)
    owner = uuid4()
    document = await service.create_text(owner_user_id=owner, relative_path="a.md", content="keep")

    async def fail(*args, **kwargs):
        raise AssertionError("no metadata write expected")

    monkeypatch.setattr(repository, "save_document", fail)
    moved = await service.move(owner_user_id=owner, document_id=document.id, destination_path="a.md")
    assert moved == document
    assert (await service.read_text(owner_user_id=owner, document_id=document.id)).content == "keep"


@pytest.mark.asyncio
async def test_delete_restores_metadata_when_file_removal_fails(tmp_path, monkeypatch):
    service = PersonalLibraryService(repository=InMemoryRepository(), working_dir=tmp_path)
    owner = uuid4()
    document = await service.create_text(owner_user_id=owner, relative_path="a.md", content="keep")
    original_unlink = Path.unlink

    def fail_staged_file(path, *args, **kwargs):
        if path.suffix == ".deleting":
            raise PermissionError("file is busy")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_staged_file)
    with pytest.raises(PermissionError, match="file is busy"):
        await service.delete(owner_user_id=owner, document_id=document.id)
    assert (await service.read_text(owner_user_id=owner, document_id=document.id)).content == "keep"
