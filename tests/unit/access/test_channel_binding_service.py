# -*- coding: utf-8 -*-
"""用户频道绑定服务的 Agent ACL 契约。"""

from __future__ import annotations

from uuid import uuid4

import pytest

from qwenpaw.access.actor import ActorContext, ActorType
from qwenpaw.access.agent_repository import (
    AgentAccessRecord,
    AgentResourceRole,
    AgentVisibility,
)
from qwenpaw.access import channel_bindings
from qwenpaw.identity.models import PlatformRole


def _actor(user_id) -> ActorContext:
    return ActorContext(
        user_id=user_id,
        actor_type=ActorType.USER,
        platform_role=PlatformRole.MEMBER,
        admin_mode=False,
        request_id="req-channel-binding",
    )


class FakeAgentRepository:
    def __init__(self, access) -> None:
        self.access = access

    async def get_accessible(self, *, agent_key, user_id):
        del agent_key, user_id
        return self.access


class RecordingBindingRepository:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def upsert(self, **kwargs):
        self.calls.append(("upsert", kwargs))
        return kwargs

    async def delete(self, **kwargs):
        self.calls.append(("delete", kwargs))
        return True

    async def list_enabled_runtime_configs(self, **kwargs):
        self.calls.append(("conflicts", kwargs))
        return self.runtime_configs

    runtime_configs = []


@pytest.mark.asyncio
async def test_public_agent_user_can_create_only_their_own_binding() -> None:
    """错误限制 user 角色或信任请求 owner_user_id 时，本测试必须失败。"""
    user_id = uuid4()
    repository = RecordingBindingRepository()
    service = channel_bindings.ChannelBindingService(
        binding_repository=repository,
        agent_repository=FakeAgentRepository(
            AgentAccessRecord(
                agent_key="public-agent",
                owner_user_id=uuid4(),
                role=AgentResourceRole.USER,
                status="active",
                visibility=AgentVisibility.PUBLIC,
            )
        ),
    )

    await service.upsert(
        actor=_actor(user_id),
        agent_key="public-agent",
        channel_type="console",
        display_name="我的控制台",
        enabled=True,
        config={"bot_prefix": "mine"},
        secrets={},
    )

    assert repository.calls == [
        (
            "upsert",
            {
                "agent_key": "public-agent",
                "owner_user_id": user_id,
                "channel_type": "console",
                "display_name": "我的控制台",
                "enabled": True,
                "config": {"bot_prefix": "mine"},
                "secrets": {},
            },
        )
    ]


@pytest.mark.asyncio
async def test_bot_conflict_compares_other_users_encrypted_runtime_config() -> None:
    """冲突检测忽略个人绑定或把本人当前绑定算作冲突时，本测试必须失败。"""
    user_id = uuid4()
    repository = RecordingBindingRepository()
    repository.runtime_configs = [
        {
            "agent_id": channel_bindings.agent_database_id("other-agent"),
            "owner_user_id": uuid4(),
            "config": {"bot_token": "same-token"},
        }
    ]
    service = channel_bindings.ChannelBindingService(
        binding_repository=repository,
        agent_repository=FakeAgentRepository(
            AgentAccessRecord(
                agent_key="public-agent",
                owner_user_id=uuid4(),
                role=AgentResourceRole.USER,
                status="active",
                visibility=AgentVisibility.PUBLIC,
            )
        ),
    )

    conflict = await service.has_bot_conflict(
        actor=_actor(user_id),
        agent_key="public-agent",
        channel_type="telegram",
        config={"bot_token": "same-token"},
    )

    assert conflict is True
    assert repository.calls == [
        ("conflicts", {"channel_type": "telegram"})
    ]


@pytest.mark.asyncio
async def test_inaccessible_agent_is_rejected_before_binding_write() -> None:
    """移除 Agent 可访问性校验时，本测试必须失败。"""
    repository = RecordingBindingRepository()
    service = channel_bindings.ChannelBindingService(
        binding_repository=repository,
        agent_repository=FakeAgentRepository(None),
    )

    with pytest.raises(channel_bindings.ChannelBindingDeniedError):
        await service.upsert(
            actor=_actor(uuid4()),
            agent_key="private-agent",
            channel_type="console",
            display_name="越权绑定",
            enabled=True,
            config={},
            secrets={},
        )

    assert repository.calls == []


@pytest.mark.asyncio
async def test_delete_is_scoped_to_authenticated_user() -> None:
    """删除条件缺少 owner_user_id 时，本测试必须失败。"""
    user_id = uuid4()
    repository = RecordingBindingRepository()
    service = channel_bindings.ChannelBindingService(
        binding_repository=repository,
        agent_repository=FakeAgentRepository(
            AgentAccessRecord(
                agent_key="public-agent",
                owner_user_id=uuid4(),
                role=AgentResourceRole.USER,
                status="active",
                visibility=AgentVisibility.PUBLIC,
            )
        ),
    )

    deleted = await service.delete(
        actor=_actor(user_id),
        agent_key="public-agent",
        channel_type="telegram",
    )

    assert deleted is True
    assert repository.calls == [
        (
            "delete",
            {
                "agent_key": "public-agent",
                "owner_user_id": user_id,
                "channel_type": "telegram",
            },
        )
    ]


@pytest.mark.asyncio
async def test_same_agent_users_create_and_list_independent_channel_bindings() -> None:
    """共用智能体的用户分别拥有自己的同类型频道，不能读到另一人的配置。"""
    owners = [uuid4(), uuid4()]

    class Repository:
        records = {}

        async def upsert(self, **kwargs):
            self.records[(kwargs["agent_key"], kwargs["owner_user_id"], kwargs["channel_type"])] = kwargs
            return kwargs

        async def list_for_user(self, *, agent_key, owner_user_id):
            return [record for (agent, owner, _), record in self.records.items()
                    if agent == agent_key and owner == owner_user_id]

    service = channel_bindings.ChannelBindingService(
        binding_repository=Repository(),
        agent_repository=FakeAgentRepository(AgentAccessRecord(
            agent_key="shared-agent", owner_user_id=uuid4(),
            role=AgentResourceRole.USER, status="active", visibility=AgentVisibility.PUBLIC,
        )),
    )
    for index, owner in enumerate(owners):
        await service.upsert(
            actor=_actor(owner), agent_key="shared-agent", channel_type="feishu",
            display_name=f"user-{index}", enabled=True,
            config={"app_id": f"bot-{index}"}, secrets={"app_secret": f"fake-secret-{index}"},
        )
    for index, owner in enumerate(owners):
        records = await service.list_bindings(actor=_actor(owner), agent_key="shared-agent")
        assert len(records) == 1
        assert records[0]["owner_user_id"] == owner
        assert records[0]["config"] == {"app_id": f"bot-{index}"}
        assert records[0]["secrets"] == {"app_secret": f"fake-secret-{index}"}
