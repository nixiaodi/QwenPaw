# -*- coding: utf-8 -*-
"""个人频道绑定的独立运行时，不复用或覆盖 Agent ChannelManager。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any
from uuid import UUID

from ...config import update_last_dispatch

_EXTERNAL_IDENTITY_METADATA_FIELDS = frozenset(
    {
        "channel_id",
        "chat_id",
        "conversation_id",
        "display_name",
        "guild_id",
        "group_id",
        "is_group",
        "team_id",
        "thread_ts",
        "user_name",
        "username",
    }
)


def bind_process_identity(
    process,
    *,
    owner_user_id: UUID,
    binding_id: UUID | None,
    record_external_identity: Callable[..., Awaitable[None]] | None = None,
    workspace=None,
):
    """将外部发送者映射为绑定所有者，同时保留外部身份元数据。"""
    platform_user_id = str(owner_user_id)
    binding_key = str(binding_id) if binding_id else ""

    async def bound_process(request) -> AsyncIterator[Any]:
        external_user_id = str(getattr(request, "user_id", "") or "")
        channel_meta = dict(getattr(request, "channel_meta", None) or {})
        if external_user_id and record_external_identity is not None:
            metadata = {
                key: value
                for key, value in channel_meta.items()
                if key in _EXTERNAL_IDENTITY_METADATA_FIELDS
            }
            metadata.update(
                channel=str(getattr(request, "channel", "") or ""),
                session_id=str(
                    getattr(request, "session_id", "") or ""
                ),
            )
            try:
                json.dumps(metadata)
            except (TypeError, ValueError):
                metadata = {
                    key: str(value)
                    for key, value in metadata.items()
                    if value is not None
                }
            await record_external_identity(
                binding_id=binding_id,
                external_subject_id=external_user_id[:512],
                platform_user_id=owner_user_id,
                metadata=metadata,
            )
        if external_user_id:
            channel_meta["external_user_id"] = external_user_id
        if binding_key:
            channel_meta["channel_binding_id"] = binding_key
        request.channel_meta = channel_meta
        request.user_id = platform_user_id
        request._trusted_channel_user_id = owner_user_id
        request_context = dict(
            getattr(request, "request_context", None) or {}
        )
        request_context["user_id"] = platform_user_id
        if binding_key:
            request_context["channel_binding_id"] = binding_key
        request_context["actor_context"] = {
            "user_id": platform_user_id,
            "actor_type": "external",
            "admin_mode": False,
        }
        request.request_context = request_context
        if workspace is not None:
            await authorize_channel_model(request, workspace, owner_user_id)
        async for event in process(request):
            yield event

    return bound_process


async def authorize_channel_model(request, workspace, owner_user_id):
    """按绑定所有者校验当前用户、Agent 和会话模型，禁止外部身份冒充平台用户。"""
    from ...identity.repository import PostgresUserRepository
    from ...identity.runtime import get_identity_schema
    from ...access.actor import ActorContext, ActorType
    from ...config.config import load_agent_config
    from ...providers import ProviderManager
    from ...models.runtime import get_model_service, resolve_selection, conversation_override
    from ...models.governance import ModelAccessError
    from ...access.agent_repository import PostgresAgentRepository, LegacyAgentRecord, AgentResourceRole
    from ...access.agent_membership import AgentMembershipService
    from ...access.service import AuthorizationService
    from ...access.capabilities import Capability
    from uuid import uuid4

    user = await PostgresUserRepository(schema=get_identity_schema()).get_user(owner_user_id)
    if user is None or user.status != "active":
        raise ModelAccessError("channel_owner_unavailable")
    actor = ActorContext(user_id=owner_user_id,actor_type=ActorType.USER,platform_role=user.platform_role,admin_mode=False,request_id=str(uuid4()))
    # Model authorization also checks model grants. Agent execution authority
    # is evaluated through the same repository-backed policy as a web request.
    AuthorizationService().require(actor, Capability.AGENT_USE)
    await AgentMembershipService(PostgresAgentRepository(schema=get_identity_schema())).require_role(
        actor=actor,
        agent=LegacyAgentRecord(key=workspace.agent_id,name=workspace.agent_id,description="",workspace_key=str(workspace.workspace_dir),status="active"),
        allowed_roles={AgentResourceRole.OWNER,AgentResourceRole.COLLABORATOR,AgentResourceRole.USER},
    )
    manager = ProviderManager.get_instance()
    service = get_model_service(manager)
    context = request.request_context
    chat = await workspace.chat_manager.get_or_create_chat(request.session_id,str(owner_user_id),request.channel)
    context["conversation_id"] = chat.id
    override = await conversation_override(service,actor,workspace,chat)
    resolved = await resolve_selection(service,actor,workspace.agent_id,load_agent_config(workspace.agent_id),manager,override)
    request.model_slot_override = resolved["active_llm"]
    request._model_authority = (actor,workspace.agent_id,resolved["active_llm"])


def _build_channel_manager(
    *,
    workspace,
    binding_repository,
    channel_type: str,
    config: dict[str, Any],
    owner_user_id: UUID,
    binding_id: UUID,
):
    from ...config import Config, load_config
    from ...constant import WORKING_DIR
    from ...services.workspace_files import resolve_workspace_path
    from ...workspaces.resolver import WorkspaceKind, WorkspaceResolver
    from .manager import ChannelManager

    # Listener state must follow the authenticated binding owner, even for
    # users sharing the same Agent. Never trust client-supplied local paths.
    resolver = WorkspaceResolver(working_dir=WORKING_DIR)
    user_runtime = resolver.resolve(
        kind=WorkspaceKind.USER_RUNTIME,
        resource_id=workspace.agent_id,
        actor_user_id=owner_user_id,
    )
    resolver.ensure_standard_directories(user_runtime)
    binding_path = f"channels/{UUID(str(binding_id))}"
    state_dir = resolve_workspace_path(user_runtime.path, binding_path)
    media_dir = resolve_workspace_path(user_runtime.path, f"{binding_path}/media")
    media_dir.mkdir(parents=True, exist_ok=True)
    runtime_config = {**config, "media_dir": str(media_dir)}
    if channel_type == "wechat":
        token_file = resolve_workspace_path(
            user_runtime.path, f"{binding_path}/wechat_bot_token.json",
        )
        runtime_config["bot_token_file"] = str(token_file)

    process = bind_process_identity(
        workspace.stream_query,
        owner_user_id=owner_user_id,
        binding_id=binding_id,
        record_external_identity=(
            binding_repository.upsert_external_identity
        ),
        workspace=workspace,
    )
    root_config = load_config()
    def on_last_dispatch(channel, user_id, session_id):
        update_last_dispatch(
            channel=channel,
            user_id=user_id,
            session_id=session_id,
            agent_id=workspace.agent_id,
            platform_user_id=str(owner_user_id),
            binding_id=str(binding_id),
        )

    manager = ChannelManager.from_config(
        process=process,
        config=Config(
            channels={"console": {"enabled": False}, channel_type: runtime_config},
            show_tool_details=root_config.show_tool_details,
        ),
        on_last_dispatch=on_last_dispatch,
        workspace_dir=state_dir,
    )
    manager.set_workspace(workspace)
    language = getattr(workspace._config, "language", "zh") or "zh"
    for channel in manager.channels:
        channel._language = language
        channel._platform_owner_user_id = owner_user_id
    return manager


ManagerFactory = Callable[..., Any]


class UserChannelBindingRuntimeRegistry:
    """按 binding_id 管理个人频道监听器的启动、替换和停止。"""

    def __init__(
        self,
        *,
        workspace_manager,
        binding_repository,
        manager_factory: ManagerFactory = _build_channel_manager,
    ) -> None:
        self._workspace_manager = workspace_manager
        self._binding_repository = binding_repository
        self._manager_factory = manager_factory
        self._managers: dict[UUID, Any] = {}
        self._locks: dict[UUID, asyncio.Lock] = {}

    async def _stop(self, binding_id: UUID) -> None:
        manager = self._managers.pop(binding_id, None)
        if manager is not None:
            await manager.stop_all()

    async def reconcile(self, record) -> None:
        lock = self._locks.setdefault(record.id, asyncio.Lock())
        async with lock:
            await self._stop(record.id)
            if not record.enabled:
                return
            runtime_config = await self._binding_repository.get_runtime_config(
                binding_id=record.id,
                owner_user_id=record.owner_user_id,
            )
            if runtime_config is None:
                return
            workspace = await self._workspace_manager.get_agent(
                record.agent_key
            )
            if workspace is None:
                raise ValueError("agent_workspace_not_found")
            manager = self._manager_factory(
                workspace=workspace,
                binding_repository=self._binding_repository,
                channel_type=record.channel_type,
                config={**runtime_config, "enabled": True},
                owner_user_id=record.owner_user_id,
                binding_id=record.id,
            )
            try:
                await manager.start_all()
            except Exception:
                await manager.stop_all()
                raise
            self._managers[record.id] = manager

    async def remove(self, binding_id: UUID) -> None:
        lock = self._locks.setdefault(binding_id, asyncio.Lock())
        async with lock:
            await self._stop(binding_id)

    async def stop_all(self) -> None:
        for binding_id in list(self._managers):
            await self.remove(binding_id)
