"""公用技能必须能实际安装、更新，撤销公用后不能继续取得发布内容。"""

import pytest
from tests.integration.test_skill_governance_repository import (
    skill_database,
)  # noqa: F401
from tests.integration.test_agent_skill_lifecycle import lifecycle_fixture, private_tree
from qwenpaw.access.service import AuthorizationDeniedError
from qwenpaw.access.agent_repository import agent_database_id
from qwenpaw.skills.lifecycle import SkillLifecycleService
from qwenpaw.agents.skill_system.store import get_workspace_skills_dir


@pytest.mark.asyncio
async def test_public_skill_installs_and_updates_without_explicit_grant(
    skill_database, tmp_path
):
    async with lifecycle_fixture(skill_database, tmp_path) as fixture:
        governance, (admin, _, _, owner_b), item, source, workspaces, _ = fixture
        lifecycle = SkillLifecycleService(governance, workspaces.__getitem__)
        with pytest.raises(AuthorizationDeniedError):
            await lifecycle.install(owner_b, "agentB", item["id"])
        await governance.set_item_visibility(admin, item["id"], "public")
        installed = await lifecycle.install(owner_b, "agentB", item["id"])
        assert installed["source_pool_version_id"] == str(item["version_id"])
        target = get_workspace_skills_dir(workspaces["agentB"]) / "sample" / "SKILL.md"
        assert target.read_text(encoding="utf-8") == (source / "SKILL.md").read_text(
            encoding="utf-8"
        )
        (source / "SKILL.md").write_text(
            (source / "SKILL.md").read_text(encoding="utf-8") + "\nPublished update",
            encoding="utf-8",
        )
        await governance.import_existing(
            admin, await governance.preview_existing(admin)
        )
        state = (await lifecycle.list_installed(owner_b, "agentB"))["items"][0]
        assert state["update_available"] is True
        updated = await lifecycle.update(
            owner_b, "agentB", "sample", state["content_hash"]
        )
        assert "Published update" in target.read_text(encoding="utf-8")
        await governance.set_item_visibility(admin, item["id"], "restricted")
        before = private_tree(workspaces["agentB"])
        with pytest.raises(AuthorizationDeniedError):
            await lifecycle.restore(
                owner_b, "agentB", "sample", updated["content_hash"]
            )
        assert private_tree(workspaces["agentB"]) == before
        assert all(
            row["agent_id"] != agent_database_id("agentB")
            for row in await governance.repository.list_grants(item["id"])
        )
