"""分页覆盖完整搜索、置顶、授权和游标稳定性，不使用真实业务数据。"""
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import patch

import pytest

from qwenpaw.app.chats.manager import ChatManager
from qwenpaw.app.chats.models import ChatSpec, ChatsFile
from qwenpaw.app.chats.repo import JsonChatRepository


@pytest.fixture
def paged_manager(tmp_path):
    owner, agent = uuid4(), uuid4()
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    specs = [ChatSpec(id=str(uuid4()), session_id=f"session-{i}", user_id=str(owner),
                      name=f"会话 {i}", updated_at=now + timedelta(seconds=i),
                      pinned=i == 0) for i in range(63)]
    repo = JsonChatRepository(tmp_path / "chats.json")
    repo._save_sync(ChatsFile(chats=specs))
    visible = {s.id for s in specs}
    queries = []

    class Authority:
        def with_user(self, user_id):
            assert user_id == owner
            return self

        async def list_conversations_for_user(self, **kwargs):
            assert kwargs["agent_id"] == agent
            ids = kwargs["conversation_ids"]
            queries.append(ids)
            return [SimpleNamespace(conversation=SimpleNamespace(id=id),
                                    access_role="owner", read_only=False,
                                    shared_by_username=None)
                    for id in ids if str(id) in visible]

    manager = ChatManager(repo=repo, conversation_repository=Authority())
    return manager, repo, owner, agent, specs, visible, queries


@pytest.mark.asyncio
async def test_pages_keep_pins_and_cover_all_visible_chats_once(paged_manager):
    mgr, repo, owner, agent, specs, _, queries = paged_manager
    seen, cursor = [], None
    with patch.object(repo, "_load_sync", wraps=repo._load_sync) as reads:
        while True:
            page = await mgr.list_chat_page(user_id=owner, agent_id=agent,
                                            page_size=20, cursor=cursor)
            assert len(page.items) <= 20
            seen.extend(item.chat.id for item in page.items)
            if not page.has_more:
                assert page.next_cursor is None
                break
            cursor = page.next_cursor
        assert reads.call_count == 1
    assert seen[0] == specs[0].id
    assert len(seen) == len(set(seen)) == 63
    assert all(len(ids) <= 200 for ids in queries)


@pytest.mark.asyncio
async def test_global_search_finds_old_chat_and_revocation_is_live(paged_manager):
    mgr, _, owner, agent, specs, visible, _ = paged_manager
    page = await mgr.list_chat_page(user_id=owner, agent_id=agent, search="会话 1")
    assert specs[1].id in {item.chat.id for item in page.items}
    visible.remove(specs[1].id)
    page = await mgr.list_chat_page(user_id=owner, agent_id=agent, search="会话 1")
    assert specs[1].id not in {item.chat.id for item in page.items}


@pytest.mark.asyncio
async def test_cursor_survives_deleted_anchor_and_rejects_other_query(paged_manager):
    mgr, repo, owner, agent, specs, visible, _ = paged_manager
    first = await mgr.list_chat_page(user_id=owner, agent_id=agent)
    anchor = first.items[-1].chat.id
    visible.remove(anchor)
    await repo.save(ChatsFile(chats=[s for s in specs if s.id != anchor]))
    second = await mgr.list_chat_page(user_id=owner, agent_id=agent, cursor=first.next_cursor)
    assert not {x.chat.id for x in first.items} & {x.chat.id for x in second.items}
    with pytest.raises(ValueError, match="invalid_chat_cursor"):
        await mgr.list_chat_page(user_id=owner, agent_id=agent,
                                 cursor=first.next_cursor, search="other")


@pytest.mark.asyncio
async def test_index_changes_invalidate_cache_and_copies_do_not_mutate_it(paged_manager):
    mgr, repo, owner, agent, specs, _, _ = paged_manager
    first = await mgr.list_chat_page(user_id=owner, agent_id=agent)
    first.items[0].chat.name = "caller mutation"
    again = await mgr.list_chat_page(user_id=owner, agent_id=agent)
    assert again.items[0].chat.name == "会话 0"
    specs[0].name = "renamed"
    await repo.save(ChatsFile(chats=specs))
    renamed = await mgr.list_chat_page(user_id=owner, agent_id=agent, search="renamed")
    assert [x.chat.id for x in renamed.items] == [specs[0].id]


@pytest.mark.asyncio
async def test_exact_session_resolution_does_not_depend_on_first_page(paged_manager):
    mgr, _, owner, agent, specs, visible, _ = paged_manager
    page = await mgr.list_chat_page(user_id=owner, agent_id=agent,
                                    session_id="session-1", page_size=1)
    assert [item.chat.id for item in page.items] == [specs[1].id]
    visible.remove(specs[1].id)
    page = await mgr.list_chat_page(user_id=owner, agent_id=agent,
                                    session_id="session-1", page_size=1)
    assert page.items == []
