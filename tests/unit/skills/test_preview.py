"""Local draft previews must not apply shared publication restrictions."""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from qwenpaw.access.actor import ActorContext, ActorType
from qwenpaw.identity.models import PlatformRole
from qwenpaw.skills.service import SkillGovernanceService
from qwenpaw.skills.snapshots import SnapshotStore, directory_hash


@pytest.mark.asyncio
@pytest.mark.parametrize("private_file", ["config.json", ".env", "scripts/credentials.json"])
async def test_preview_includes_private_drafts_but_publication_still_rejects(
    tmp_path, private_file
):
    pool = tmp_path / "pool"
    for name in ["private-draft", "regular"]:
        root = pool / name
        root.mkdir(parents=True)
        (root / "SKILL.md").write_text("Example skill", encoding="utf-8")
    private_path = pool / "private-draft" / private_file
    private_path.parent.mkdir(parents=True, exist_ok=True)
    private_path.write_text("private-value", encoding="utf-8")
    repository = AsyncMock()
    snapshots = SnapshotStore(tmp_path / "snapshots")
    service = SkillGovernanceService(repository, snapshots, pool)
    admin = ActorContext(uuid4(), ActorType.USER, PlatformRole.ADMIN, False, "test")

    preview = await service.preview_existing(admin)

    assert preview == [
        {
            "name": "private-draft",
            "content_hash": directory_hash(pool / "private-draft", shared=False),
        },
        {"name": "regular", "content_hash": directory_hash(pool / "regular")},
    ]
    private_path.write_text("changed-value", encoding="utf-8")
    updated = await service.preview_existing(admin)
    assert updated[0]["content_hash"] != preview[0]["content_hash"]
    with pytest.raises(ValueError, match="private_skill_file"):
        await service.import_existing(admin, [preview[0]])
    repository.import_snapshots.assert_not_awaited()
    assert not snapshots.root.exists()
