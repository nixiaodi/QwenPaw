"""Require an observed skill load before executing a routed skill task."""

import json
from agentscope.message import TextBlock, ToolCallBlock
from agentscope.middleware import MiddlewareBase
from agentscope.tool import ToolResponse


class SkillLoadingMiddleware(MiddlewareBase):
    """Use the same progressive loading contract for every enabled skill."""

    def __init__(self, enabled_skills, *, required=False, skill_directories=None, pending_task=None):
        self.enabled = set(enabled_skills)
        self.required = required
        self.loaded = set()
        self.pending_task = pending_task
        self.directories = {
            str(path).replace('\\', '/'): name
            for name, path in (skill_directories or {}).items()
        }

    async def on_acting(self, agent, input_kwargs, next_handler):
        call = input_kwargs.get('tool_call')
        if not isinstance(call, ToolCallBlock):
            async for chunk in next_handler():
                yield chunk
            return
        needs_load = self.required and not self.loaded
        if call.name == 'execute_shell_command':
            try:
                command = json.loads(call.input).get('command', '').replace('\\', '/')
            except (ValueError, AttributeError):
                command = ''
            needs_load |= any(
                path in command and name not in self.loaded
                for path, name in self.directories.items()
            )
        if needs_load and call.name not in {
            'load_skill', 'read_file', 'glob_search', 'grep_search',
            'ask_user_input', 'list_tools',
        }:
            yield ToolResponse(state='error', content=[TextBlock(text=(
                'Before executing this skill task, inspect the enabled skill '
                'descriptions and call load_skill for the matching skill. '
                'A successful load is required; instructions from a previous '
                'turn do not replace loading the current enabled skill.'
            ))])
            return
        async for chunk in next_handler():
            if call.name == 'load_skill' and isinstance(chunk, ToolResponse) and chunk.state == 'success':
                for block in chunk.content:
                    try:
                        payload = json.loads(getattr(block, 'text', ''))
                    except (ValueError, TypeError):
                        continue
                    if isinstance(payload, dict) and payload.get('skill') in self.enabled and payload.get('prompt'):
                        if not self.loaded and self.pending_task is not None:
                            self.pending_task['skill'] = payload['skill']
                        self.loaded.add(payload['skill'])
            yield chunk
