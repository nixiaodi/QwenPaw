# -*- coding: utf-8 -*-
"""Coordinate latest-turn revisions without replaying superseded context."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict

from .repo import RunRecord, RepositoryConflictError
from .user_content import user_content_parts
from ...agents.context.scroll.history import HistoryStore
from ...utils.io_utils import run_sync_io

_EDIT_NAMESPACE = UUID("cbda9c19-51f6-44c2-9168-7e41d01ca477")


class TurnEditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message_id: UUID
    request_id: UUID


def text_of(parts) -> str:
    if isinstance(parts, str):
        return parts
    return "\n".join(
        str(part.get("text") or "")
        for part in parts or []
        if isinstance(part, dict) and part.get("type") == "text"
    )


def replace_text(parts: list[dict], text: str) -> list[dict]:
    return [
        {"type": "text", "text": text},
        *(deepcopy(part) for part in parts if part.get("type") != "text"),
    ]


def _normalized_media_path(value: str) -> str:
    value = unquote(urlsplit(value).path) if value.startswith("file:") else value
    value = value.replace("\\", "/")
    if len(value) > 3 and value[0] == "/" and value[2] == ":":
        value = value[1:]
    return value.casefold() if len(value) > 1 and value[1] == ":" else value


def _media_url(part: dict) -> str:
    source = part.get("source")
    if isinstance(source, dict):
        return str(source.get("url") or "")
    return str(
        next(
            (
                part[key]
                for key in ("file_url", "image_url", "audio_url", "video_url")
                if isinstance(part.get(key), str)
            ),
            "",
        )
    )


def _original_user_text(parts, attachment_paths=()) -> str:
    """Exclude only generated path hints paired with a verified media block."""
    if not isinstance(parts, list):
        return text_of(parts)
    known_paths = {_normalized_media_path(path) for path in attachment_paths}
    texts = []
    for index, part in enumerate(parts):
        if not isinstance(part, dict) or part.get("type") != "text":
            continue
        value = str(part.get("text") or "")
        previous = parts[index - 1] if index else {}
        if isinstance(previous, dict) and previous.get("type") in {
            "data",
            "file",
            "image",
            "audio",
            "video",
        }:
            media_path = _media_url(previous)
            hint_path = next(
                (
                    value[len(prefix) :]
                    for prefix in (
                        "用户上传文件，已经下载到 ",
                        "User uploaded a file, downloaded to ",
                    )
                    if value.startswith(prefix)
                ),
                None,
            )
            if (
                hint_path
                and _normalized_media_path(hint_path) in known_paths
                and (
                    not media_path
                    or _normalized_media_path(media_path)
                    == _normalized_media_path(hint_path)
                )
            ):
                continue
        texts.append(value)
    return "\n".join(texts)


def rewind_legacy_state(
    state: dict, expected_text: str, *, attachment_paths=()
) -> tuple[dict, int | None]:
    """Rewind only when the last persisted user input matches the target."""
    restored = deepcopy(state)
    agent = restored.get("agent", {})
    modern = isinstance(agent.get("state"), dict)
    messages = (
        agent["state"].get("context", [])
        if modern
        else agent.get("memory", {}).get("content", [])
    )
    for index in range(len(messages) - 1, -1, -1):
        raw = messages[index] if modern else messages[index][0]
        if not isinstance(raw, dict) or raw.get("role") != "user":
            continue
        if _original_user_text(raw.get("content"), attachment_paths) != expected_text:
            break
        if modern:
            agent["state"]["context"] = messages[:index]
        else:
            agent["memory"]["content"] = messages[:index]
        scroll = agent.get("scroll") or {}
        bounds = scroll.get("seq_by_id", {}).get(raw.get("id"))
        boundary = int(bounds[0]) - 1 if bounds else None
        if boundary is not None:
            scroll["seq_by_id"] = {
                key: value
                for key, value in scroll.get("seq_by_id", {}).items()
                if int(value[1]) <= boundary
            }
            scroll["model_turn_seq"] = {
                key: value
                for key, value in scroll.get("model_turn_seq", {}).items()
                if int(value) <= boundary
            }
        return restored, boundary
    raise ValueError("turn_context_unavailable")


def _history_cursor(workspace, chat, config) -> dict | None:
    running = getattr(config, "running", None)
    light = getattr(running, "light_context_config", None)
    scroll = getattr(light, "scroll_config", None)
    if scroll is None:
        return None
    path = Path(workspace.workspace_dir) / scroll.db_filename
    if not path.is_file():
        return (
            {"path": str(path), "sequence": 0}
            if getattr(light, "strategy", None) == "scroll"
            else None
        )
    history = HistoryStore(path)
    try:
        return {
            "path": str(path),
            "sequence": history.last_sequence(chat.session_id),
        }
    finally:
        history.close()


async def capture_console_turn(workspace, chat, run_id: str, config) -> None:
    session = getattr(workspace, "session", None)
    if session is None or not hasattr(session, "begin_turn"):
        return
    cursor = await run_sync_io(_history_cursor, workspace, chat, config)
    await session.begin_turn(
        session_id=chat.session_id,
        user_id=chat.user_id,
        channel=chat.channel,
        run_id=run_id,
        history_cursor=cursor,
    )


class LatestTurnEditor:
    def __init__(self, workspace, chat):
        self.workspace = workspace
        self.chat = chat
        repository = workspace.chat_manager.conversation_repository
        if repository is None or workspace.chat_manager.run_persistence is None:
            raise ValueError("turn_edit_storage_unavailable")
        self.repository = repository.with_user(UUID(chat.user_id))
        self.session = workspace.session
        self.persistence = workspace.chat_manager.run_persistence
        self.identity = dict(
            session_id=chat.session_id,
            user_id=chat.user_id,
            channel=chat.channel,
        )

    async def preserve_input(self, edit: TurnEditRequest, payload: dict) -> None:
        """The server retains the original attachments, not client replacements."""
        records = await self.repository.list_messages(UUID(self.chat.id))
        target = next(
            (
                message
                for message in records
                if message.id == edit.message_id and message.role == "user"
            ),
            None,
        )
        if target is None:
            raise RepositoryConflictError("latest_message_changed")
        text = text_of(
            [
                part if isinstance(part, dict) else part.model_dump(mode="json")
                for part in payload.get("content_parts") or []
            ]
        )
        if not text.strip() or len(text) > 10000:
            raise ValueError("invalid_edit_text")
        parts = user_content_parts(target)
        attachments = await self.repository.list_attachments(UUID(self.chat.id))
        protected = {
            record.storage_key: f"/api/console/attachments/{record.id}"
            for record in attachments
            if record.lifecycle != "deleted"
        }
        for part in parts:
            key = {
                "image": "image_url",
                "file": "file_url",
                "audio": "data",
            }.get(part.get("type"))
            if key and part.get(key) in protected:
                part[key] = protected[part[key]]
        payload["content_parts"] = replace_text(parts, text)
        payload["message_metadata"] = dict(
            payload.get("message_metadata") or {},
            qwenpaw_client_message_id=str(edit.request_id),
        )

    async def prepare(self, edit: TurnEditRequest, payload: dict, config) -> str:
        """Return start/attach/complete; caller holds the conversation submit lock."""
        conversation_id = UUID(self.chat.id)
        run_id = uuid5(_EDIT_NAMESPACE, f"{conversation_id}:{edit.request_id}")
        text = text_of(
            [
                part if isinstance(part, dict) else part.model_dump(mode="json")
                for part in payload["content_parts"]
            ]
        )
        records = await self.repository.list_messages(conversation_id)
        latest = next(
            (
                message
                for message in reversed(records)
                if message.role == "user" and message.status != "superseded"
            ),
            None,
        )
        target = next(
            (message for message in records if message.id == edit.message_id),
            None,
        )
        if target is None:
            raise RepositoryConflictError("latest_message_changed")
        source_run_id = str(target.run_id or target.id)
        revision = {
            "target_message_id": str(edit.message_id),
            "text": text,
            "source_run_id": source_run_id,
        }
        existing_run = await self.repository.get_run(run_id)
        if existing_run is not None:
            events = await self.repository.list_events(run_id)
            marker = next(
                (event for event in events if event.event_type == "turn_revision"),
                None,
            )
            if marker is None or marker.payload != revision:
                raise RepositoryConflictError("edit_request_conflict")
            replacement = next(
                (
                    message
                    for message in records
                    if message.run_id == run_id and message.role == "user"
                ),
                None,
            )
            if (
                replacement is None
                or replacement.status == "superseded"
                or latest is None
                or latest.id != replacement.id
            ):
                raise RepositoryConflictError("latest_message_changed")
            if existing_run.status in {"completed", "failed", "cancelled"}:
                return "complete"
            current_run_id = await self.workspace.task_tracker.get_run_id(self.chat.id)
            if current_run_id == str(run_id):
                return "attach"
            if current_run_id is not None:
                raise RepositoryConflictError("latest_message_changed")
            # The producer marks a prepared run running before calling the
            # model. Only an untouched queued admission can start safely;
            # replaying an orphaned execution could repeat completed tools.
            if existing_run.status != "queued" or [
                (event.sequence, event.event_type) for event in events
            ] != [(0, "turn_revision"), (1, "user_message")]:
                raise ValueError("edit_run_unavailable")
        else:
            if latest is None or latest.id != edit.message_id:
                raise RepositoryConflictError("latest_message_changed")
            current_run_id = await self.workspace.task_tracker.get_run_id(self.chat.id)
            if current_run_id and current_run_id != str(target.run_id):
                raise RepositoryConflictError("latest_message_changed")
            await self.workspace.task_tracker.request_stop(self.chat.id)
            try:
                await self.session.get_turn_snapshot(
                    **self.identity, run_id=source_run_id
                )
            except FileNotFoundError:
                state = await self.session.get_session_state_dict(**self.identity)
                original_parts = user_content_parts(target)
                attachments = await self.repository.list_attachments(conversation_id)
                storage_paths = {
                    f"/api/console/attachments/{item.id}": item.storage_key
                    for item in attachments
                    if item.lifecycle != "deleted"
                }
                attachment_paths = [
                    storage_paths.get(urlsplit(_media_url(part)).path, _media_url(part))
                    for part in original_parts
                    if part.get("type") != "text"
                ]
                base, boundary = rewind_legacy_state(
                    state or {},
                    _original_user_text(original_parts, attachment_paths),
                    attachment_paths=attachment_paths,
                )
                cursor = await run_sync_io(
                    _history_cursor, self.workspace, self.chat, config
                )
                if cursor is not None:
                    if boundary is None:
                        raise ValueError("turn_context_unavailable")
                    cursor["sequence"] = boundary
                await self.session.seed_turn_snapshot(
                    **self.identity,
                    run_id=source_run_id,
                    snapshot={"state": base, "history_cursor": cursor},
                )
            now = datetime.now(timezone.utc)
            run = RunRecord(
                id=run_id,
                conversation_id=conversation_id,
                initiated_by=UUID(self.chat.user_id),
                status="queued",
                started_at=now,
            )
            incoming = self.persistence._user_message(
                conversation_id=conversation_id,
                run_id=run_id,
                initiated_by=UUID(self.chat.user_id),
                sequence=0,
                payload=payload,
            )
            if incoming is None:
                raise ValueError("invalid_edit_text")
            await self.repository.revise_latest_turn(
                conversation_id=conversation_id,
                agent_id=self.persistence._agent_id,
                target_message_id=edit.message_id,
                run=run,
                message=incoming,
                revision=revision,
            )
        snapshot = await self.session.restore_turn(
            **self.identity, source_run_id=source_run_id, run_id=str(run_id)
        )
        cursor = snapshot.get("history_cursor")
        if cursor is not None:

            def truncate():
                history = HistoryStore(cursor["path"])
                try:
                    history.truncate_session_after(
                        self.chat.session_id, cursor["sequence"]
                    )
                finally:
                    history.close()

            await run_sync_io(truncate)
        payload["_qwenpaw_run_id"] = str(run_id)
        payload["_qwenpaw_prepared_edit"] = True
        payload["meta"]["request_context"]["run_id"] = str(run_id)
        return "start"

    async def replay(self, edit: TurnEditRequest):
        """Finish terminal retries by replaying the accepted run, not a new run."""
        import json

        run_id = uuid5(_EDIT_NAMESPACE, f"{self.chat.id}:{edit.request_id}")
        terminal_response = False
        for event in await self.repository.list_events(run_id):
            if event.sequence <= 1:
                continue
            wire = await self.persistence.load_event_payload(event.payload)
            if wire.get("object") == "response" and wire.get("status") in {
                "completed",
                "failed",
                "cancelled",
            }:
                terminal_response = True
            yield f"data: {json.dumps(wire, ensure_ascii=False)}\n\n"
        if not terminal_response:
            yield 'data: {"object":"response","status":"completed","qwenpaw_completion_only":true}\n\n'
