"""附件保存与删除的受控生命周期操作。"""
from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from ...services.workspace_files import resolve_workspace_path
from ...utils.io_utils import run_sync_io

DOCUMENTS_DIRECTORY = "documents"
LEGACY_DOCUMENTS_DIRECTORY = "资料"


async def resolve_attachment_runtime_root(*, user_id: UUID, agent_key: str) -> Path:
    """聊天附件按上传者隔离，目录规则不随 Agent 编辑角色变化。"""
    from ...identity.runtime import get_identity_schema
    from ...persistence.agent_user_workspaces import AgentUserWorkspaceRepository
    from ...services import workspace_files
    from ...workspaces import WorkspaceKind, WorkspaceResolver

    resolver = WorkspaceResolver(working_dir=workspace_files.WORKING_DIR)
    runtime = resolver.resolve(
        kind=WorkspaceKind.USER_RUNTIME,
        resource_id=agent_key,
        actor_user_id=user_id,
    )
    root = await run_sync_io(resolver.ensure_standard_directories, runtime)
    await AgentUserWorkspaceRepository(schema=get_identity_schema()).ensure_private(
        user_id=user_id, agent_key=agent_key, workspace_key=runtime.workspace_key,
    )
    return root


class AttachmentLifecycleError(RuntimeError):
    """附件当前状态不允许执行所请求的转换。"""


class AttachmentLifecycleService:
    def __init__(self, *, repository, runtime_root: Path, legacy_media_root: Path | None = None) -> None:
        self._repository, self._root = repository, Path(runtime_root)
        self._legacy_media_root = legacy_media_root

    async def save(self, *, attachment_id: UUID, owner_user_id: UUID, target_path: str | None = None):
        record = await self._repository.get_attachment(attachment_id=attachment_id, owner_user_id=owner_user_id)
        if record is None:
            raise FileNotFoundError("attachment_not_found")
        if record.lifecycle != "temporary":
            raise AttachmentLifecycleError("attachment_not_temporary")
        source = self._source_path(record.storage_key, lifecycle="temporary")
        target_path = target_path or record.original_name
        target = resolve_workspace_path(self._documents_root(), target_path, portable=True)
        if not source.is_file() or target.exists():
            raise AttachmentLifecycleError("attachment_source_missing" if not source.is_file() else "attachment_target_exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
        now = datetime.now(UTC)
        updated = await self._repository.update_attachment_lifecycle(attachment_id=attachment_id, owner_user_id=owner_user_id, lifecycle="saved", storage_key=str(target), saved_path=target_path, saved_at=now, deleted_at=None, updated_at=now)
        if updated is None:
            os.replace(target, source)
            raise FileNotFoundError("attachment_not_found")
        return updated

    async def move(self, *, attachment_id: UUID, owner_user_id: UUID, target_path: str):
        record = await self._repository.get_attachment(attachment_id=attachment_id, owner_user_id=owner_user_id)
        if record is None:
            raise FileNotFoundError("attachment_not_found")
        if record.lifecycle != "saved":
            raise AttachmentLifecycleError("attachment_not_saved")
        source = self._source_path(record.storage_key, lifecycle="saved")
        target = resolve_workspace_path(self._documents_root(), target_path, portable=True)
        if not source.is_file() or target.exists():
            raise AttachmentLifecycleError("attachment_source_missing" if not source.is_file() else "attachment_target_exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
        now = datetime.now(UTC)
        updated = await self._repository.update_attachment_lifecycle(attachment_id=attachment_id, owner_user_id=owner_user_id, lifecycle="saved", storage_key=str(target), saved_path=target_path, saved_at=record.saved_at, deleted_at=None, updated_at=now)
        if updated is None:
            os.replace(target, source)
            raise FileNotFoundError("attachment_not_found")
        return updated

    async def delete(self, *, attachment_id: UUID, owner_user_id: UUID):
        record = await self._repository.get_attachment(attachment_id=attachment_id, owner_user_id=owner_user_id)
        if record is None:
            raise FileNotFoundError("attachment_not_found")
        if record.lifecycle == "deleted":
            return record
        source = self._source_path(record.storage_key, lifecycle=record.lifecycle)
        if source.is_file():
            source.unlink()
        now = datetime.now(UTC)
        updated = await self._repository.update_attachment_lifecycle(attachment_id=attachment_id, owner_user_id=owner_user_id, lifecycle="deleted", storage_key=record.storage_key, saved_path=record.saved_path, saved_at=record.saved_at, deleted_at=now, updated_at=now)
        if updated is None:
            raise FileNotFoundError("attachment_not_found")
        return updated

    def _source_path(self, storage_key: str, *, lifecycle: str) -> Path:
        try:
            from ...artifacts.service import reject_symlink_path
            source = Path(storage_key)
            reject_symlink_path(source)
            source = source.resolve(strict=False)
            roots = (
                tuple(root.resolve() for root in (self._root / "media", self._legacy_media_root) if root is not None)
                if lifecycle == "temporary" else self._saved_roots()
            )
        except OSError as exc:
            raise AttachmentLifecycleError("attachment_source_missing") from exc
        if not any(source.is_relative_to(root) for root in roots) or source.is_symlink():
            raise AttachmentLifecycleError("attachment_source_denied")
        return source

    def _documents_root(self) -> Path:
        """返回新建已保存附件的标准英文目录。"""
        return self._root / DOCUMENTS_DIRECTORY

    def _saved_roots(self) -> tuple[Path, ...]:
        """允许读取历史中文目录，所有新写入仍固定落在 documents/。"""
        roots = [self._root]
        if self._legacy_media_root is not None:
            roots.append(self._legacy_media_root.parent)
        return tuple(
            (root / directory).resolve()
            for root in roots
            for directory in (DOCUMENTS_DIRECTORY, LEGACY_DOCUMENTS_DIRECTORY)
        )
