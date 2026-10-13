from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4
import pytest
from qwenpaw.app.channels.base import BaseChannel

@pytest.mark.asyncio
async def test_tracker_uses_platform_owner_and_wraps_channel_events_for_persistence():
    owner = uuid4()
    chat = SimpleNamespace(id=str(uuid4()))
    manager = SimpleNamespace(get_or_create_chat=AsyncMock(return_value=chat),touch_chat=AsyncMock(),persisting_stream_source=Mock(return_value="persisted-source"))
    tracker = SimpleNamespace(attach_or_start=AsyncMock(return_value=(None,False)))
    channel = SimpleNamespace(_workspace=SimpleNamespace(chat_manager=manager,task_tracker=tracker),_platform_owner_user_id=owner,channel="feishu",_extract_chat_name=lambda _:"test",_stream_with_tracker="raw-source")
    payload={"sender_id":"external-open-id","content_parts":[{"type":"text","text":"hello"}]}
    request=SimpleNamespace(session_id="feishu:chat",user_id="external-open-id",channel="feishu")
    await BaseChannel._consume_with_tracker(channel,request,payload)
    assert manager.get_or_create_chat.await_args.args[1]==str(owner)
    assert manager.persisting_stream_source.call_args.args[0] is chat
    assert callable(manager.persisting_stream_source.call_args.args[1])
    assert tracker.attach_or_start.await_args.args[2]=="persisted-source"
