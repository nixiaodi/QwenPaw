# -*- coding: utf-8 -*-
"""Require real retrieval for search skills, plus any requested artifacts."""
import json
import re

from agentscope.message import ToolCallBlock, ToolResultBlock
from .file_delivery_guard import FileDeliveryGuard


class RetrievalEvidenceGuard(FileDeliveryGuard):
    reason = "skill_retrieval_not_executed"
    continuation_message = (
        "The requested search has no successful retrieval evidence in this turn. "
        "Use web_search/web_fetch, the browser, or the loaded skill network script "
        "to retrieve real source data. Loading a skill, listing files or running "
        "--help is not search completion. Inspect actual errors. Do not invent "
        "sources, search results or completed API calls. If files were requested, "
        "also create, validate and deliver each requested format with send_file_to_user."
    )
    failure_message = "本次检索或结果交付未完成，没有取得本轮成功检索和必要文件交付的证据，不能声称已完成。请查看实际接口错误或缺少的必要信息后重试。"

    def __init__(self, required_types):
        super().__init__(required_types)
        self._retrieval_ids = set()
        self._retrieved = False

    @property
    def delivered(self):
        return self._retrieved and super().delivered

    def observe(self, context):
        super().observe(context)
        blocks = [
            block
            for message in context
            for block in message.get_content_blocks()
            if isinstance(block, (ToolCallBlock, ToolResultBlock))
            and block.id not in self._old_ids
        ]
        for block in blocks:
            if not isinstance(block, ToolCallBlock):
                continue
            if block.name in {"web_search", "web_fetch"}:
                self._retrieval_ids.add(block.id)
                continue
            try:
                arguments = json.loads(block.input)
            except (ValueError, TypeError):
                continue
            if not isinstance(arguments, dict):
                continue
            command = arguments.get("command", "")
            code = arguments.get("code", "")
            if (
                block.name == "browser"
                and isinstance(code, str)
                and re.search(r"goto|navigate|create.*[Tt]ab|get.*[Tt]ab", code)
            ):
                self._retrieval_ids.add(block.id)
            if (
                block.name == "execute_shell_command"
                and isinstance(command, str)
                and not re.search(r"--help|--dry-run|(?:^|\s)-h(?:\s|$)", command)
                and re.search(
                    r"curl\s.*https?://|requests\.|httpx\.|urllib\.request|(?:search|fetch|platform|xhs|gzh)[^\s]*\.py",
                    command,
                    re.I,
                )
            ):
                self._retrieval_ids.add(block.id)
        if any(
            isinstance(block, ToolResultBlock)
            and block.id in self._retrieval_ids
            and block.state == "success"
            for block in blocks
        ):
            self._retrieved = True
