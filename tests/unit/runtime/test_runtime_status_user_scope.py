from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_completed_turn_clears_only_actor_status_before_terminal_yield(monkeypatch):
    from qwenpaw.runtime import runtime
    from qwenpaw.runtime.hooks import HookAction, HookResult
    from qwenpaw.artifacts import middleware
    from qwenpaw.runtime_status import broadcast, scope

    owner = "a1886e47-4c9f-4a88-af7d-2a25850b776c"
    other = "11111111-1111-4111-8111-111111111111"
    monkeypatch.setattr(scope, "is_multi_user_enabled", lambda: True)
    monkeypatch.setattr(broadcast, "_status_cache", {})
    monkeypatch.setattr(broadcast, "_queues", {})
    for user in (owner, other):
        broadcast.broadcast_runtime_status("qa", session_id="s", stage="tool_failed", status="failed", user_id=user)
    monkeypatch.setattr(middleware, "collect_safely", AsyncMock())
    hooks = SimpleNamespace(run=AsyncMock(return_value=HookResult(action=HookAction.SKIP_AGENT)))
    workspace = SimpleNamespace(plugins=SimpleNamespace(hook_registry=hooks, slash_command_registry=SimpleNamespace(dispatch=AsyncMock(return_value=None))))
    context = {"actor_context": {"user_id": owner}, "user_id": "untrusted", "chat_id": "chat"}
    ctx = SimpleNamespace(session_id="s", root_session_id="s", agent_id="qa", request=SimpleNamespace(request_context=context), agent=None, input_msgs=[], error=None)

    class Envelope:
        def __init__(self, **kwargs):
            pass

        async def finalize(self):
            yield "completed"

    monkeypatch.setattr(runtime, "Envelope", Envelope)
    instance = runtime.Runtime(workspace=workspace, app_services=None)
    monkeypatch.setattr(instance, "_normalize", lambda request: request)
    monkeypatch.setattr(instance, "_build_context", lambda request: ctx)
    stream = instance.run(ctx.request)
    assert await anext(stream) == "completed"
    owner_status_at_terminal = broadcast.get_runtime_status("qa", "s", user_id=owner)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert owner_status_at_terminal is None
    assert broadcast.get_runtime_status("qa", "s", user_id=other)["stage"] == "tool_failed"
