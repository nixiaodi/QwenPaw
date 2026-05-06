# -*- coding: utf-8 -*-
"""Runtime skill discovery, loading, and intent routing."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import frontmatter
from agentscope.message import TextBlock
from agentscope.tool import ToolResponse

from ..config.context import (
    get_current_channel_name,
    get_current_workspace_dir,
)
from ..constant import WORKING_DIR
from .skills_manager import (
    ensure_skills_initialized,
    get_workspace_skills_dir,
    resolve_effective_skills,
)
from .utils.file_handling import read_text_file_with_encoding_fallback

logger = logging.getLogger(__name__)

RouteKind = Literal["info", "list", "invoke", "clarify"]


@dataclass(frozen=True)
class SkillMeta:
    """Enabled skill metadata used by runtime routing."""

    name: str
    display_name: str
    description: str
    skill_dir: Path
    skill_md_path: Path


@dataclass(frozen=True)
class SkillRoute:
    """Resolved skill routing decision."""

    kind: RouteKind
    skill: SkillMeta | None = None
    args: str = ""
    reason: str = ""
    candidates: tuple[tuple[str, int], ...] = ()
    skills: tuple[SkillMeta, ...] = ()


_WORD_RE = re.compile(r"[a-zA-Z0-9_-]+")
_EXPLICIT_RE = re.compile(
    r"(?:调用|使用|加载|启用|invoke|use|load)\s+([a-zA-Z0-9_-]+)",
    re.IGNORECASE,
)

_IMAGE_TERMS = {
    "image",
    "images",
    "picture",
    "pictures",
    "photo",
    "photos",
    "poster",
    "illustration",
    "illustrations",
    "art",
    "bitmap",
    "visual",
    "mockup",
    "generate image",
    "edit image",
    "图片",
    "图像",
    "照片",
    "海报",
    "插画",
    "画图",
    "绘图",
    "生图",
    "生成图",
    "设计图",
    "视觉",
}

_INTENT_GROUPS = (_IMAGE_TERMS,)


def _normalize_name(value: str) -> str:
    return str(value or "").strip().lower()


def _skill_aliases(skill: SkillMeta) -> set[str]:
    return {
        _normalize_name(skill.name),
        _normalize_name(skill.display_name),
        _normalize_name(skill.skill_dir.name),
    } - {""}


def _read_skill_post(skill_dir: Path) -> tuple[str, Any]:
    skill_md_path = skill_dir / "SKILL.md"
    raw = read_text_file_with_encoding_fallback(skill_md_path)
    return raw, frontmatter.loads(raw)


def discover_enabled_skills(
    workspace_dir: Path | None,
    channel_name: str | None,
) -> list[SkillMeta]:
    """Return enabled skills for the workspace and channel."""

    workspace = Path(workspace_dir or WORKING_DIR)
    channel = channel_name or "console"
    ensure_skills_initialized(workspace)
    skill_names = resolve_effective_skills(workspace, channel)
    skills_dir = get_workspace_skills_dir(workspace)
    result: list[SkillMeta] = []
    for skill_name in skill_names:
        skill_dir = skills_dir / skill_name
        skill_md_path = skill_dir / "SKILL.md"
        if not skill_md_path.exists():
            continue
        try:
            _, post = _read_skill_post(skill_dir)
        except Exception as exc:
            logger.warning(
                "Failed to read skill metadata '%s': %s",
                skill_name,
                exc,
            )
            continue
        result.append(
            SkillMeta(
                name=skill_name,
                display_name=str(post.get("name") or skill_name),
                description=str(post.get("description") or ""),
                skill_dir=skill_dir,
                skill_md_path=skill_md_path,
            ),
        )
    return result


def resolve_enabled_skill(
    workspace_dir: Path | None,
    channel_name: str | None,
    requested: str,
) -> SkillMeta | None:
    """Resolve an enabled skill by directory name or frontmatter name."""

    wanted = _normalize_name(requested).lstrip("/$")
    if not wanted:
        return None
    for skill in discover_enabled_skills(workspace_dir, channel_name):
        if wanted in _skill_aliases(skill):
            return skill
    return None


def render_skill_list(skills: list[SkillMeta]) -> str:
    if not skills:
        return "No enabled skills are available for this channel."
    lines = ["**Enabled skills**"]
    for skill in sorted(skills, key=lambda item: item.name.lower()):
        desc = f" - {skill.description}" if skill.description else ""
        lines.append(f"- `{skill.name}`{desc}")
    return "\n".join(lines)


def render_skill_info(skill: SkillMeta) -> str:
    desc = skill.description or "No description."
    return (
        f"**{skill.name}**\n\n"
        f"- **command**: `/{skill.name} <input>` to invoke\n"
        f"- **name**: {skill.display_name}\n"
        f"- **description**: {desc}\n"
        f"- **path**: `{skill.skill_dir}`"
    )


def route_to_prompt(route: SkillRoute) -> str:
    """Build a short instruction injected before the original user text."""

    if route.kind != "invoke" or route.skill is None:
        return ""
    payload = {
        "skill": route.skill.name,
        "args": route.args,
        "reason": route.reason,
        "candidates": list(route.candidates),
    }
    return (
        "[Skill routing]\n"
        "The user's request matches an enabled local skill. "
        "Before doing the task, call the `load_skill` tool with "
        f"`skill={route.skill.name}` and `args` set to the user's task. "
        "Then follow the loaded SKILL.md instructions.\n"
        f"Routing metadata: {json.dumps(payload, ensure_ascii=False)}\n"
        "---\n"
    )


def _split_slash_invocation(query: str) -> tuple[str, str] | None:
    stripped = query.strip()
    if not stripped.startswith("/"):
        return None
    rest = stripped[1:]
    if rest.startswith("["):
        close = rest.find("]")
        if close < 0:
            return None
        name = rest[1:close].strip()
        args = rest[close + 1 :].strip()
        return (name, args) if name else None
    parts = rest.split(None, 1)
    if not parts:
        return None
    return parts[0], parts[1] if len(parts) > 1 else ""


def _first_token(text: str) -> str:
    match = _WORD_RE.match(text.strip())
    return match.group(0) if match else ""


def _contains_any(text: str, terms: set[str]) -> bool:
    lowered = text.lower()
    return any(term in lowered for term in terms)


def _score_semantic(query: str, skill: SkillMeta) -> int:
    haystack = f"{skill.name} {skill.display_name} {skill.description}".lower()
    query_lower = query.lower()
    score = 0

    query_terms = {
        term
        for term in re.split(r"[\s,，。.!?！？、:：;；()（）]+", query_lower)
        if len(term) >= 2
    }
    for term in query_terms:
        if term and term in haystack:
            score += 2

    for group in _INTENT_GROUPS:
        if _contains_any(query_lower, group) and _contains_any(haystack, group):
            score += 8

    return score


class SkillIntentRouter:
    """Resolve explicit, bare-name, and semantic skill invocations."""

    def __init__(self, skills: list[SkillMeta]) -> None:
        self._skills = skills

    def route(self, query: str | None) -> SkillRoute | None:
        text = str(query or "").strip()
        if not text:
            return None

        slash = _split_slash_invocation(text)
        if slash is not None:
            command, args = slash
            if _normalize_name(command) in {"skills", "skill"}:
                return self._route_skills_command(args)
            skill = self._find_skill(command)
            if skill is None:
                return None
            if not args:
                return SkillRoute(kind="info", skill=skill, reason="slash_info")
            return SkillRoute(
                kind="invoke",
                skill=skill,
                args=args,
                reason="slash_skill",
                candidates=((skill.name, 100),),
            )

        explicit = _EXPLICIT_RE.search(text)
        if explicit:
            skill = self._find_skill(explicit.group(1))
            if skill is not None:
                args = text[explicit.end() :].strip() or text
                return SkillRoute(
                    kind="invoke",
                    skill=skill,
                    args=args,
                    reason="explicit_skill_name",
                    candidates=((skill.name, 95),),
                )

        first = _first_token(text)
        if first:
            skill = self._find_skill(first)
            if skill is not None:
                args = text[len(first) :].strip()
                return SkillRoute(
                    kind="invoke",
                    skill=skill,
                    args=args,
                    reason="bare_skill_name",
                    candidates=((skill.name, 90),),
                )

        return self._route_semantic(text)

    def _route_skills_command(self, args: str) -> SkillRoute:
        parts = args.split(None, 1)
        if not parts or _normalize_name(parts[0]) in {"list", "ls"}:
            return SkillRoute(
                kind="list",
                reason="skills_list",
                skills=tuple(self._skills),
            )
        subcommand = _normalize_name(parts[0])
        rest = parts[1] if len(parts) > 1 else ""
        if subcommand in {"help"}:
            return SkillRoute(
                kind="list",
                reason="skills_help",
                skills=tuple(self._skills),
            )
        if subcommand in {"show", "info"}:
            skill = self._find_skill(rest)
            return (
                SkillRoute(kind="info", skill=skill, reason="skills_info")
                if skill is not None
                else SkillRoute(
                    kind="list",
                    reason="skills_info_missing",
                    skills=tuple(self._skills),
                )
            )
        skill = self._find_skill(parts[0])
        if skill is None:
            return SkillRoute(
                kind="list",
                reason="skills_unknown",
                skills=tuple(self._skills),
            )
        return SkillRoute(
            kind="invoke",
            skill=skill,
            args=rest,
            reason="skills_invoke",
            candidates=((skill.name, 100),),
        )

    def _find_skill(self, requested: str) -> SkillMeta | None:
        wanted = _normalize_name(requested).lstrip("/$")
        if not wanted:
            return None
        for skill in self._skills:
            if wanted in _skill_aliases(skill):
                return skill
        return None

    def _route_semantic(self, text: str) -> SkillRoute | None:
        scored = [
            (skill, _score_semantic(text, skill)) for skill in self._skills
        ]
        scored = [(skill, score) for skill, score in scored if score > 0]
        scored.sort(key=lambda item: (-item[1], item[0].name.lower()))
        if not scored:
            logger.info("Skill router: no semantic candidates")
            return None
        candidates = tuple((skill.name, score) for skill, score in scored[:3])
        best, best_score = scored[0]
        second_score = scored[1][1] if len(scored) > 1 else 0
        if best_score < 8:
            logger.info(
                "Skill router: semantic match not confident: %s",
                candidates,
            )
            return None
        if second_score and best_score - second_score <= 2:
            logger.info(
                "Skill router: semantic match ambiguous: %s",
                candidates,
            )
            return SkillRoute(
                kind="clarify",
                args=text,
                reason="semantic_ambiguous",
                candidates=candidates,
                skills=tuple(
                    skill
                    for skill, score in scored[:3]
                    if best_score - score <= 2
                ),
            )
        return SkillRoute(
            kind="invoke",
            skill=best,
            args=text,
            reason="semantic_description",
            candidates=candidates,
        )


async def load_skill(skill: str, args: str | None = None) -> ToolResponse:
    """Load an enabled local skill definition and its instructions.

    Call this tool before using a local skill. It only reads skills enabled
    for the current workspace and channel.

    Args:
        skill: Skill directory name or frontmatter name.
        args: Optional user task to pass through for context.
    """

    workspace_dir = get_current_workspace_dir() or WORKING_DIR
    channel_name = get_current_channel_name() or "console"
    meta = resolve_enabled_skill(workspace_dir, channel_name, skill)
    if meta is None:
        return ToolResponse(
            content=[
                TextBlock(
                    type="text",
                    text=(
                        f"Error: skill '{skill}' is not enabled for "
                        f"channel '{channel_name}' or does not exist."
                    ),
                ),
            ],
        )
    raw, post = _read_skill_post(meta.skill_dir)
    payload = {
        "skill": meta.name,
        "name": str(post.get("name") or meta.display_name),
        "description": str(post.get("description") or ""),
        "path": str(meta.skill_md_path),
        "args": args or "",
        "prompt": post.content,
        "raw": raw,
    }
    return ToolResponse(
        content=[
            TextBlock(
                type="text",
                text=json.dumps(payload, ensure_ascii=False, indent=2),
            ),
        ],
    )
