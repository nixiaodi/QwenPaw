"""Latest-turn replacement preserves context boundaries and rejects stale saves."""

from uuid import uuid4

import pytest

from qwenpaw.app.chats.session import SafeJSONSession


class State:
    def __init__(self, data):
        self.data = data

    def state_dict(self):
        return self.data

    def load_state_dict(self, data):
        self.data = data


@pytest.mark.asyncio
async def test_restore_turn_excludes_old_input_and_partial_answer(tmp_path):
    session = SafeJSONSession(save_dir=str(tmp_path))
    identity = dict(session_id="chat", user_id="owner", channel="console")
    before = {"state": {"context": [{"role": "user", "content": "earlier"}]}}
    await session.save_session_state(**identity, agent=State(before))
    old_run, new_run = str(uuid4()), str(uuid4())
    await session.begin_turn(**identity, run_id=old_run)
    await session.save_session_state(
        **identity,
        run_id=old_run,
        agent=State({"state": {"context": ["earlier", "old question", "partial"]}}),
    )
    await session.restore_turn(**identity, source_run_id=old_run, run_id=new_run)
    restored = State({})
    await session.load_session_state(**identity, agent=restored)
    assert restored.data == before


@pytest.mark.asyncio
async def test_old_cancel_save_cannot_overwrite_edited_turn(tmp_path):
    session = SafeJSONSession(save_dir=str(tmp_path))
    identity = dict(session_id="chat", user_id="owner", channel="console")
    old_run, new_run = str(uuid4()), str(uuid4())
    await session.begin_turn(**identity, run_id=old_run)
    await session.restore_turn(**identity, source_run_id=old_run, run_id=new_run)
    await session.save_session_state(
        **identity, run_id=new_run, agent=State({"new": True})
    )
    await session.save_session_state(
        **identity, run_id=old_run, agent=State({"old": True})
    )
    restored = State({})
    await session.load_session_state(**identity, agent=restored)
    assert restored.data == {"new": True}


@pytest.mark.asyncio
async def test_turn_snapshot_cannot_be_used_by_another_owner(tmp_path):
    session = SafeJSONSession(save_dir=str(tmp_path))
    run_id = str(uuid4())
    await session.begin_turn(
        session_id="chat", user_id="owner", channel="console", run_id=run_id
    )
    with pytest.raises(FileNotFoundError):
        await session.restore_turn(
            session_id="chat",
            user_id="other",
            channel="console",
            source_run_id=run_id,
            run_id=str(uuid4()),
        )
