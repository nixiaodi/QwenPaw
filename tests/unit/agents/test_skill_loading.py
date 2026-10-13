import json
from unittest.mock import Mock

import pytest
from agentscope.message import TextBlock, ToolCallBlock
from agentscope.tool import ToolResponse

from qwenpaw.agents.skill_loading import SkillLoadingMiddleware


@pytest.mark.asyncio
async def test_scripts_are_blocked_until_a_real_successful_skill_load():
    middleware = SkillLoadingMiddleware(['my-custom-skill'], required=True)
    ran = Mock()

    async def next_handler():
        ran()
        yield ToolResponse(content=[TextBlock(text='executed')])

    call = ToolCallBlock(id='script', name='execute_shell_command', input=json.dumps({'command':'python make.py'}))
    blocked = [item async for item in middleware.on_acting(None, {'tool_call':call}, next_handler)]
    ran.assert_not_called()
    assert blocked[0].state == 'error'

    async def loaded():
        yield ToolResponse(content=[TextBlock(text=json.dumps({'skill':'my-custom-skill','prompt':'Instructions'}))])

    load = ToolCallBlock(id='load',name='load_skill', input=json.dumps({'skill':'my-custom-skill'}))
    _ = [item async for item in middleware.on_acting(None, {'tool_call':load}, loaded)]
    _ = [item async for item in middleware.on_acting(None, {'tool_call':call}, next_handler)]
    ran.assert_called_once()


@pytest.mark.asyncio
async def test_failed_or_disabled_skill_load_cannot_unlock_execution():
    middleware = SkillLoadingMiddleware(['enabled'], required=True)
    async def failed():
        yield ToolResponse(state='error', content=[TextBlock(text='not enabled')])
    call = ToolCallBlock(id='load',name='load_skill',input='{"skill":"disabled"}')
    _ = [item async for item in middleware.on_acting(None, {'tool_call':call}, failed)]
    assert not middleware.loaded


@pytest.mark.asyncio
async def test_loading_one_skill_does_not_unlock_another_skill_script():
    middleware = SkillLoadingMiddleware(['first', 'second'], skill_directories={'second':'/skills/second'})
    middleware.loaded.add('first')
    ran = Mock()
    async def next_handler():
        ran()
        yield ToolResponse(content=[TextBlock(text='executed')])
    call=ToolCallBlock(id='script',name='execute_shell_command',input='{"command":"python /skills/second/scripts/run.py"}')
    response=[item async for item in middleware.on_acting(None,{'tool_call':call},next_handler)]
    ran.assert_not_called()
    assert response[0].state == 'error'
