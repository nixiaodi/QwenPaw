"""用内存 SQL 执行会话查询，验证范围和 JOIN 基数；不替代 PostgreSQL RLS 测试。"""

import sqlite3
from types import SimpleNamespace
from uuid import uuid4

import pytest

from qwenpaw.app.chats.repo.postgres_repo import PostgresConversationRepository


@pytest.mark.asyncio
async def test_list_filters_agent_and_does_not_expand_owner_rows_per_viewer():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE conversations (id TEXT, agent_id TEXT, owner_user_id TEXT,
            title TEXT, status TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE conversation_members (conversation_id TEXT, user_id TEXT,
            role TEXT, granted_by TEXT);
        CREATE TABLE agents (id TEXT, owner_user_id TEXT, status TEXT, visibility TEXT);
        CREATE TABLE agent_members (agent_id TEXT, user_id TEXT, revoked_at TEXT);
        CREATE TABLE users (id TEXT, username TEXT);
    """
    )
    user, other, viewer = [uuid4() for _ in range(3)]
    agent_a, agent_b = uuid4(), uuid4()
    owned, shared, outside = [uuid4() for _ in range(3)]
    db.executemany(
        "INSERT INTO agents VALUES (?, ?, 'active', 'public')",
        [(str(a), str(other)) for a in (agent_a, agent_b)],
    )
    db.execute("INSERT INTO users VALUES (?, 'owner')", (str(other),))
    for chat, agent, owner in (
        (owned, agent_a, user),
        (shared, agent_a, other),
        (outside, agent_b, user),
    ):
        db.execute(
            "INSERT INTO conversations VALUES (?, ?, ?, 'Chat', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            (str(chat), str(agent), str(owner)),
        )
    for chat, member in ((owned, other), (owned, viewer), (shared, user)):
        db.execute(
            "INSERT INTO conversation_members VALUES (?, ?, 'viewer', ?)",
            (str(chat), str(member), str(other)),
        )

    raw_counts = []

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def execute(self, statement, params):
            rows = db.execute(
                str(statement), {key: str(value) for key, value in params.items()}
            ).fetchall()
            raw_counts.append(len(rows))
            return SimpleNamespace(mappings=lambda: SimpleNamespace(all=lambda: rows))

    repo = PostgresConversationRepository(schema="main", session_factory=Session)
    try:
        rows = await repo.list_conversations_for_user(user_id=user, agent_id=agent_a)
        assert {row.conversation.id: row.access_role for row in rows} == {
            owned: "owner",
            shared: "viewer",
        }
        assert raw_counts == [2]
        rows = await repo.list_conversations_for_user(
            user_id=user, agent_id=agent_a, scope="shared"
        )
        assert [row.conversation.id for row in rows] == [shared]
        # Revoking the user's access to a private agent also removes its shares.
        db.execute("UPDATE agents SET visibility='private' WHERE id=?", (str(agent_a),))
        rows = await repo.list_conversations_for_user(user_id=user, agent_id=agent_a)
        assert [row.conversation.id for row in rows] == [owned]
        rows = await repo.list_conversations_for_user(user_id=user, agent_id=agent_b)
        assert [row.conversation.id for row in rows] == [outside]
    finally:
        db.close()
