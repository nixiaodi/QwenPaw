# -*- coding: utf-8 -*-
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import unquote
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import FileResponse

from qwenpaw.constant import WORKING_DIR
from qwenpaw.security.tool_guard.guardians.file_guardian import (
    FilePathToolGuardian,
    _normalize_path,
)

router = APIRouter(prefix="/files", tags=["files"])

_ALLOWED_ROOT: Path = WORKING_DIR.resolve()

# Reuse the FileGuard sensitive path detection for the preview endpoint.
_file_guardian = FilePathToolGuardian()


def _is_preview_outside_workspace_allowed() -> bool:
    """Check ``security.file_guard.allow_preview_outside_workspace``."""
    try:
        from qwenpaw.platform_ops.security_policy import (
            load_effective_security_policy,
        )

        return bool(
            load_effective_security_policy().file_guard.allow_preview_outside_workspace
        )
    except Exception:
        return False


def _check_path(path: Path) -> str | None:
    """Return ``None`` when *path* is allowed, or an error reason string.

    When ``allow_preview_outside_workspace`` is enabled, skip the
    WORKING_DIR containment check so that console can preview files
    (e.g. media produced by tools) stored outside the workspace.
    The sensitive-file guard is **always** enforced.
    """
    resolved = path.resolve()
    # 1. Must not be a FileGuard-sensitive path.
    normalized = _normalize_path(str(resolved))
    guardian = _file_guardian
    try:
        from qwenpaw.identity.runtime import is_multi_user_enabled

        if is_multi_user_enabled():
            guardian = FilePathToolGuardian()
    except Exception:
        pass
    # pylint: disable-next=protected-access
    if guardian._is_sensitive(normalized):
        return "SENSITIVE_FILE_BLOCKED"
    # 2. Workspace scope check (skippable via config).
    if not _is_preview_outside_workspace_allowed():
        if not (resolved == _ALLOWED_ROOT or resolved.is_relative_to(_ALLOWED_ROOT)):
            return "OUTSIDE_WORKSPACE"
    return None


async def _is_owned_legacy_attachment(path: Path, user_id) -> bool:
    """旧附件目录中的文件必须有匹配用户和 Agent 的有效归属记录。"""
    try:
        relative = path.relative_to(WORKING_DIR.resolve() / "workspaces")
    except ValueError:
        return False
    if len(relative.parts) < 3 or relative.parts[1] not in {"media", "documents", "资料"}:
        return False
    from qwenpaw.access.agent_repository import agent_database_id
    from qwenpaw.app.chats.repo import PostgresConversationRepository
    from qwenpaw.identity.runtime import get_identity_schema
    from qwenpaw.artifacts.service import reject_symlink_path

    agent_id = agent_database_id(relative.parts[0])
    repository = PostgresConversationRepository(
        schema=get_identity_schema(),
    ).with_user(user_id)
    attachments = await repository.list_owned_attachments(
        owner_user_id=user_id, agent_id=agent_id,
    )
    for record in attachments:
        if (record.owner_user_id != user_id or record.agent_id != agent_id
                or record.lifecycle == "deleted"):
            continue
        source = Path(record.storage_key)
        try:
            reject_symlink_path(source)
        except ValueError:
            continue
        if source.resolve() == path:
            return True
    return False


@router.api_route(
    "/preview/{filepath:path}",
    methods=["GET", "HEAD"],
    summary="Preview file",
)
async def preview_file(
    filepath: str,
    request: Request,
):
    """Preview file."""
    normalized = unquote(filepath)

    # Normalize /C:/... to C:/... on Windows.
    if (
        len(normalized) >= 4
        and normalized[0] == "/"
        and normalized[2] == ":"
        and normalized[1].isalpha()
    ):
        normalized = normalized[1:]

    path = Path(normalized).expanduser()
    if not path.is_absolute():
        path = Path("/" + normalized)
    unresolved_path = path.absolute()
    path = path.resolve()
    from qwenpaw.identity.runtime import is_multi_user_enabled

    if is_multi_user_enabled():
        from qwenpaw.access.dependencies import get_actor
        from qwenpaw.artifacts.service import reject_symlink_path

        actor = get_actor(request)
        if actor.user_id is None:
            raise HTTPException(status_code=401, detail="not_authenticated")
        user_root = WORKING_DIR.resolve() / "user_workspaces" / str(actor.user_id)
        try:
            reject_symlink_path(unresolved_path)
            reject_symlink_path(user_root)
            if not path.is_relative_to(user_root) and not await _is_owned_legacy_attachment(
                path, actor.user_id,
            ):
                raise ValueError()
        except ValueError:
            raise HTTPException(
                status_code=403, detail="OUTSIDE_USER_WORKSPACE"
            ) from None
    reason = _check_path(path)
    if reason:
        raise HTTPException(status_code=403, detail=reason)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    if not os.access(path, os.R_OK):
        raise HTTPException(status_code=500, detail="Permission denied")
    return FileResponse(path, filename=path.name)
