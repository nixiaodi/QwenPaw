"""Model errors report the selected model across SDK wrapper versions."""
from types import SimpleNamespace

import pytest

from qwenpaw.hooks.error.error_hook import ErrorNormalizeHook


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "identity",
    [{"model": "gpt-5.6-sol"}, {"model_name": "legacy-model"}, {"name": "named-model"}],
)
async def test_error_names_actual_model(monkeypatch, identity):
    openai = pytest.importorskip("openai")
    monkeypatch.setattr(
        "qwenpaw.app.chats.query_error_dump.write_query_error_dump", lambda *_: None
    )
    ctx = SimpleNamespace(
        error=openai.APIError(
            "stream closed before response.completed", request=None, body=None
        ),
        agent=SimpleNamespace(model=SimpleNamespace(**identity)),
        request=SimpleNamespace(),
        extras={},
    )
    await ErrorNormalizeHook().run(ctx)
    assert next(iter(identity.values())) in ctx.extras["_error_text"]
    assert "'unknown'" not in ctx.extras["_error_text"]
