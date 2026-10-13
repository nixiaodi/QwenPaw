from unittest.mock import AsyncMock

import pytest
from agentscope.message import ToolResultState


@pytest.mark.asyncio
@pytest.mark.parametrize("exit_code", [0, 1, 127])
async def test_shell_reports_nonzero_exit_as_tool_error(monkeypatch, tmp_path, exit_code):
    from qwenpaw.agents.tools import shell

    execute = AsyncMock(return_value=(exit_code, "partial output", "file not found" if exit_code else ""))
    monkeypatch.setattr(shell, "_execute_windows_host", execute)
    monkeypatch.setattr(shell, "_execute_posix_host", execute)
    result = await shell.execute_shell_command("echo check", cwd=tmp_path)
    expected = ToolResultState.SUCCESS if exit_code == 0 else ToolResultState.ERROR
    assert result.state == expected
