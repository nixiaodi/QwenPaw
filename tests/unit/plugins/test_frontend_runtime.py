"""旧插件默认保持 legacy 标记，由严格前端加载器阻止执行。"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from starlette.requests import Request
from qwenpaw.plugins.architecture import PluginManifest
from qwenpaw.app.routers import frontend_plugin


@pytest.mark.asyncio
async def test_frontend_runtime_manifest_reaches_authorized_loader(monkeypatch):
    legacy = PluginManifest(id="old", version="1", entry={"frontend": "index.js"})
    worker = PluginManifest(id="new", version="1", entry={"frontend": "index.js", "frontend_runtime": "worker-v1"})
    assert legacy.entry.frontend_runtime == "legacy"
    app = FastAPI()
    app.state.plugin_loader = SimpleNamespace(get_all_loaded_plugins=lambda: {
        item.id: SimpleNamespace(manifest=item, enabled=True) for item in [legacy, worker]
    })
    request = Request({"type": "http", "app": app})
    monkeypatch.setattr(frontend_plugin, "_authorized_plugin_ids", AsyncMock(return_value={"new"}))
    rows = await frontend_plugin.list_frontend_plugins(request)
    assert len(rows) == 1
    assert rows[0]["id"] == "new" and rows[0]["frontend_runtime"] == "worker-v1"
