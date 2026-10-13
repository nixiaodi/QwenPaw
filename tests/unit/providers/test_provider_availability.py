from types import SimpleNamespace
import pytest

from qwenpaw.providers.openai_provider import OpenAIProvider
from qwenpaw.providers.provider import ModelInfo
from qwenpaw.agents.effective_model import resolve_effective_model
from qwenpaw.exceptions import ProviderError


def test_disabling_provider_preserves_credentials_and_is_projected():
    provider=OpenAIProvider(id='test',name='test',api_key='fixture-secret',models=[ModelInfo(id='one',name='one')])
    provider.update_config({'enabled':False})
    assert provider.enabled is False
    assert provider.api_key == 'fixture-secret'


def test_disabled_model_is_retained_but_cannot_be_resolved():
    provider=OpenAIProvider(id='test',name='test',models=[ModelInfo(id='one',name='one')])
    provider.update_model_config('one',{'enabled':False})
    assert provider.get_model_info('one').enabled is False
    manager=SimpleNamespace(get_provider=lambda _:provider)
    with pytest.raises(ProviderError,match='disabled'):
        resolve_effective_model(SimpleNamespace(active_model={'provider_id':'test','model':'one'}),manager)


@pytest.mark.asyncio
async def test_provider_info_keeps_disabled_state():
    provider=OpenAIProvider(id='test',name='test',enabled=False)
    assert (await provider.get_info()).enabled is False


@pytest.mark.asyncio
async def test_runtime_catalog_excludes_disabled_providers_and_models():
    from qwenpaw.models.governance import ModelGovernanceService
    provider=OpenAIProvider(id='test',name='test',base_url='https://example.com',require_api_key=False,models=[ModelInfo(id='one',name='one'),ModelInfo(id='two',name='two',enabled=False)])
    async def list_info(): return [await provider.get_info()]
    manager=SimpleNamespace(list_provider_info=list_info,get_provider=lambda _:provider)
    service=ModelGovernanceService(None,manager)
    assert [row['model'] for row in await service._runtime_catalog(manager)] == ['one']
    provider.enabled=False
    assert await service._runtime_catalog(manager) == []


@pytest.mark.asyncio
async def test_builtin_disabled_state_survives_reload_and_model_discovery(tmp_path,monkeypatch):
    import copy
    from unittest.mock import AsyncMock
    from qwenpaw.providers import provider_manager as module
    from qwenpaw.providers.provider_manager import ProviderManager
    prototype=OpenAIProvider(id='fixture',name='fixture',require_api_key=False,models=[ModelInfo(id='one',name='one')])
    monkeypatch.setattr(module,'SECRET_DIR',tmp_path)
    monkeypatch.setattr(ProviderManager,'_init_builtins',lambda manager:manager._add_builtin(copy.deepcopy(prototype)))
    manager=ProviderManager()
    manager.update_provider('fixture',{'enabled':False})
    await manager.update_model_config('fixture','one',{'enabled':False})
    reloaded=ProviderManager()
    provider=reloaded.get_provider('fixture')
    assert provider.enabled is False
    assert provider.get_model_info('one').enabled is False
    monkeypatch.setattr(type(provider),'fetch_models',AsyncMock(return_value=[ModelInfo(id='one',name='one')]))
    await reloaded.fetch_provider_models('fixture')
    assert provider.extra_models[0].enabled is False
