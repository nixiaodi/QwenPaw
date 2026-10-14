"""插件治理 PostgreSQL 仓储的事务和授权矩阵测试。"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from qwenpaw.access.actor import ActorContext, ActorType
from qwenpaw.identity.models import PlatformRole
from qwenpaw.plugins.governance import (
    AppAudience,
    PluginAccessError,
    PluginGovernanceService,
    PluginInstallation,
    PostgresPluginGovernanceRepository,
)


@pytest.fixture
def plugin_governance_database(postgres_test_schema):
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", postgres_test_schema.async_url())
    config.attributes["target_schema"] = postgres_test_schema.name
    command.upgrade(config, "head")
    engine = create_async_engine(postgres_test_schema.async_url(), poolclass=NullPool)
    factory = async_sessionmaker(engine)

    @asynccontextmanager
    async def session_factory():
        async with factory.begin() as session:
            yield session

    yield postgres_test_schema.name, session_factory


async def _seed_users_and_agent(schema, session_factory):
    admin_id, allowed_id, denied_id, inactive_id, agent_id = (
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
    )
    async with session_factory() as session:
        for user_id, username, role, status in (
            (admin_id, "plugin-admin", "admin", "active"),
            (allowed_id, "plugin-allowed", "member", "active"),
            (denied_id, "plugin-denied", "member", "active"),
            (inactive_id, "plugin-inactive", "member", "disabled"),
        ):
            await session.execute(
                text(
                    f'INSERT INTO "{schema}".users '
                    "(id,username,password_hash,status,platform_role) "
                    "VALUES (:id,:username,'hash',:status,:role)"
                ),
                {"id": user_id, "username": username, "status": status, "role": role},
            )
        await session.execute(
            text(
                f'INSERT INTO "{schema}".agents '
                "(id,owner_user_id,name,status,visibility,default_model_mode,draft_workspace_key) "
                "VALUES (:id,:owner,'Plugin Agent','active','private','inherit','workspaces/plugin')"
            ),
            {"id": agent_id, "owner": allowed_id},
        )
    return admin_id, allowed_id, denied_id, inactive_id, agent_id


def _actor(user_id, role):
    return ActorContext(
        user_id=user_id,
        actor_type=ActorType.USER,
        platform_role=role,
        admin_mode=False,
        request_id="plugin-postgres-test",
    )


def _candidate():
    return PluginInstallation(
        id=uuid4(),
        plugin_id="database-demo",
        version="1.0.0",
        plugin_type="app",
        status="active",
    )


@pytest.mark.asyncio
async def test_selected_user_status_and_agent_setting_round_trip(
    plugin_governance_database,
):
    schema, session_factory = plugin_governance_database
    admin_id, allowed_id, denied_id, _, agent_id = await _seed_users_and_agent(
        schema, session_factory
    )
    repository = PostgresPluginGovernanceRepository(
        schema=schema, session_factory=session_factory
    )
    service = PluginGovernanceService(repository)
    candidate = _candidate()
    admin = _actor(admin_id, PlatformRole.ADMIN)
    allowed = _actor(allowed_id, PlatformRole.MEMBER)
    denied = _actor(denied_id, PlatformRole.MEMBER)

    saved = await service.register_installation(
        admin,
        candidate,
        source_type="upload",
        source_ref="database-demo.zip",
        content_hash="a" * 64,
        audience=AppAudience(mode="selected_users", selected_user_ids=(allowed_id,)),
    )

    assert saved.id == candidate.id
    assert [item.plugin_id for item in await service.list_authorized(allowed)] == [
        "database-demo"
    ]
    assert await service.list_authorized(denied) == []
    projected = await repository.get_installation("database-demo")
    assert projected is not None
    assert projected.audience_mode == "selected_users"
    assert projected.selected_user_ids == (allowed_id,)

    setting = await repository.save_agent_setting(
        agent_id, candidate.id, True, {"mode": "safe"}, allowed_id
    )
    assert setting["config"] == {"mode": "safe"}
    projected_setting = await repository.get_agent_setting(agent_id, candidate.id)
    assert projected_setting["enabled"] is True
    assert projected_setting["config"] == {"mode": "safe"}
    async with session_factory() as session:
        stored = (
            (
                await session.execute(
                    text(
                        f'SELECT enabled,config FROM "{schema}".agent_plugin_settings '
                        "WHERE agent_id=:agent AND plugin_installation_id=:plugin"
                    ),
                    {"agent": agent_id, "plugin": candidate.id},
                )
            )
            .mappings()
            .one()
        )
    assert stored["enabled"] is True
    assert stored["config"] == {"mode": "safe"}

    await service.set_status(admin, candidate.plugin_id, enabled=False)
    assert await service.list_authorized(allowed) == []
    await service.set_status(admin, candidate.plugin_id, enabled=True)
    assert [item.plugin_id for item in await service.list_authorized(allowed)] == [
        "database-demo"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("upload", [False, True], ids=["path-or-market", "zip-upload"])
async def test_default_app_install_is_visible_only_to_installer(
    plugin_governance_database,
    monkeypatch,
    tmp_path,
    upload,
):
    """未选择分享范围的安装应立即出现在安装者的应用中心。"""
    from qwenpaw.app.routers import pawapps, plugins

    schema, session_factory = plugin_governance_database
    admin_id, allowed_id, _, _, _ = await _seed_users_and_agent(schema, session_factory)
    repository = PostgresPluginGovernanceRepository(
        schema=schema, session_factory=session_factory
    )
    service = PluginGovernanceService(repository)
    manifest = {
        "id": "installer-app",
        "name": "Installer App",
        "version": "1.0.0",
        "meta": {"pawapp": {"entry_page": "/apps/installer-app"}},
    }
    source = tmp_path / "plugin.json"
    source.write_text(json.dumps(manifest), encoding="utf-8")
    record = SimpleNamespace(
        manifest=SimpleNamespace(
            **manifest, description="", author="", plugin_type="app"
        ),
        source_path=source,
    )

    async def loaded(*_args, **_kwargs):
        return record

    app = FastAPI()
    app.state.plugin_loader = object()
    app.state.plugin_registry = SimpleNamespace(
        get_all_plugin_manifests=lambda: {"installer-app": manifest}
    )

    @app.middleware("http")
    async def test_identity(request, call_next):
        request.state.actor = (
            _actor(allowed_id, PlatformRole.MEMBER)
            if request.headers.get("X-Test-User") == "other"
            else _actor(admin_id, PlatformRole.ADMIN)
        )
        return await call_next(request)

    monkeypatch.setattr(plugins, "_load_plugin_with_optional_force_reinstall", loaded)
    monkeypatch.setattr(plugins, "_extract_plugin_zip_bytes", lambda *_args: source)
    for module in (plugins, pawapps):
        monkeypatch.setattr(module, "is_multi_user_enabled", lambda: True)
        monkeypatch.setattr(module, "get_plugin_governance_service", lambda: service)
    app.include_router(plugins.router)
    app.include_router(pawapps.router)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = (
            await client.post(
                "/plugins/upload", files={"file": ("app.zip", b"fixture")}
            )
            if upload
            else await client.post("/plugins/install", json={"source": str(source)})
        )
        assert response.status_code == 200
        mine = await client.get("/pawapps")
        other = await client.get("/pawapps", headers={"X-Test-User": "other"})
        assert mine.status_code == 200 and mine.json()["total"] == 1
        assert mine.json()["apps"][0]["id"] == "installer-app"
        assert other.status_code == 200 and other.json()["total"] == 0
        projected = await repository.get_installation("installer-app")
        assert projected.selected_user_ids == (admin_id,)


@pytest.mark.asyncio
@pytest.mark.parametrize("initial_audience", ["selected_users", "all_members", "empty"])
async def test_reinstall_without_audience_preserves_existing_access(
    plugin_governance_database,
    initial_audience,
):
    """升级重装不能清空或扩大已有授权，包括管理员明确设置的空范围。"""
    schema, session_factory = plugin_governance_database
    admin_id, allowed_id, denied_id, _, _ = await _seed_users_and_agent(
        schema, session_factory
    )
    repository = PostgresPluginGovernanceRepository(
        schema=schema, session_factory=session_factory
    )
    service = PluginGovernanceService(repository)
    admin = _actor(admin_id, PlatformRole.ADMIN)
    audience = (
        AppAudience(mode="all_members")
        if initial_audience == "all_members"
        else AppAudience(mode="selected_users", selected_user_ids=(allowed_id,))
        if initial_audience == "selected_users"
        else AppAudience(mode="selected_users")
    )
    first = _candidate()
    await service.register_installation(
        admin,
        first,
        source_type="path",
        source_ref="fixture",
        content_hash="a" * 64,
        audience=audience,
    )
    await service.register_installation(
        admin,
        replace(first, id=uuid4(), version="2.0.0"),
        source_type="path",
        source_ref="fixture",
        content_hash="b" * 64,
    )
    after = await repository.get_installation(first.plugin_id)
    assert after.id == first.id and after.version == "2.0.0"
    assert after.audience_mode == audience.mode
    assert after.selected_user_ids == audience.selected_user_ids
    assert await repository.is_user_granted(after.id, allowed_id) is (
        initial_audience != "empty"
    )
    assert await repository.is_user_granted(after.id, denied_id) is (
        initial_audience == "all_members"
    )
    assert await repository.is_user_granted(after.id, admin_id) is (
        initial_audience == "all_members"
    )


@pytest.mark.asyncio
async def test_registration_and_audience_are_one_transaction(
    plugin_governance_database,
):
    schema, session_factory = plugin_governance_database
    admin_id, _, _, inactive_id, _ = await _seed_users_and_agent(
        schema, session_factory
    )
    repository = PostgresPluginGovernanceRepository(
        schema=schema, session_factory=session_factory
    )
    service = PluginGovernanceService(repository)

    with pytest.raises(PluginAccessError, match="plugin_audience_user_invalid"):
        await service.register_installation(
            _actor(admin_id, PlatformRole.ADMIN),
            _candidate(),
            source_type="path",
            source_ref="/isolated/database-demo",
            content_hash="b" * 64,
            audience=AppAudience(
                mode="selected_users", selected_user_ids=(inactive_id,)
            ),
        )

    assert await repository.get_installation("database-demo") is None


@pytest.mark.asyncio
async def test_uninstall_removes_all_plugin_owned_rows(plugin_governance_database):
    schema, session_factory = plugin_governance_database
    admin_id, allowed_id, _, _, agent_id = await _seed_users_and_agent(
        schema, session_factory
    )
    repository = PostgresPluginGovernanceRepository(
        schema=schema, session_factory=session_factory
    )
    service = PluginGovernanceService(repository)
    candidate = _candidate()
    admin = _actor(admin_id, PlatformRole.ADMIN)
    await service.register_installation(
        admin,
        candidate,
        source_type="upload",
        source_ref="database-demo.zip",
        content_hash="c" * 64,
        audience=AppAudience(mode="all_members"),
    )
    await repository.save_agent_setting(
        agent_id, candidate.id, True, {"mode": "safe"}, allowed_id
    )
    async with session_factory() as session:
        await session.execute(
            text(
                f'INSERT INTO "{schema}".app_user_data '
                "(plugin_installation_id,user_id,agent_id,namespace,key,value) "
                "VALUES (:plugin,:user,:agent,'settings','theme',CAST(:value AS jsonb))"
            ),
            {
                "plugin": candidate.id,
                "user": allowed_id,
                "agent": agent_id,
                "value": json.dumps({"color": "blue"}),
            },
        )

    await service.begin_uninstall(admin, candidate.plugin_id)
    await service.complete_uninstall(admin, candidate.plugin_id)

    assert await repository.get_installation(candidate.plugin_id) is None
    async with session_factory() as session:
        for table in ("app_grants", "agent_plugin_settings", "app_user_data"):
            count = await session.scalar(
                text(
                    f'SELECT count(*) FROM "{schema}"."{table}" '
                    "WHERE plugin_installation_id=:plugin"
                ),
                {"plugin": candidate.id},
            )
            assert count == 0


@pytest.mark.asyncio
async def test_reconcile_registers_only_missing_disk_plugins_for_all_members(
    plugin_governance_database,
):
    schema, session_factory = plugin_governance_database
    admin_id, *_ = await _seed_users_and_agent(schema, session_factory)
    repository = PostgresPluginGovernanceRepository(
        schema=schema, session_factory=session_factory
    )
    existing = _candidate()
    await repository.register_installation(
        existing,
        "path",
        "/plugins/database-demo",
        "d" * 64,
        admin_id,
        AppAudience(mode="selected_users"),
    )
    legacy = PluginInstallation(
        id=uuid4(),
        plugin_id="legacy-disk-app",
        version="0.9.0",
        plugin_type="app",
        status="active",
    )

    count = await repository.reconcile_discovered_installations(
        [
            (existing, "/plugins/database-demo", "d" * 64),
            (legacy, "/plugins/legacy-disk-app", "e" * 64),
        ]
    )

    assert count == 1
    rows = {row.plugin_id: row for row in await repository.list_installations()}
    assert rows["database-demo"].audience_mode == "selected_users"
    assert rows["legacy-disk-app"].audience_mode == "all_members"
