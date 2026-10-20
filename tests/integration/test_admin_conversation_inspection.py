"""真实运行角色下验证管理员只读排查及普通用户隔离。"""

from contextlib import asynccontextmanager
from uuid import uuid4
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.pool import NullPool
from tests.integration.test_skill_governance_repository import (
    skill_database,
)  # noqa: F401
from qwenpaw.app.chats.repo.postgres_repo import PostgresConversationRepository


@pytest.mark.asyncio
async def test_admin_inspection_is_agent_scoped_read_only_and_checks_live_role(
    skill_database,
):
    schema = skill_database.name
    engine = create_async_engine(skill_database.async_url(), poolclass=NullPool)
    factory = async_sessionmaker(engine)
    admin, owner, outsider, agent_a, agent_b, chat_a, chat_b = [
        uuid4() for _ in range(7)
    ]
    try:
        async with factory.begin() as session:
            await session.execute(
                text(f'GRANT USAGE ON SCHEMA "{schema}" TO qwenpaw_runtime')
            )
            await session.execute(
                text(
                    f'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "{schema}" TO qwenpaw_runtime'
                )
            )
            for user, name, role in [
                (admin, "admin", "admin"),
                (owner, "owner", "member"),
                (outsider, "outsider", "member"),
            ]:
                await session.execute(
                    text(
                        f"""INSERT INTO "{schema}".users
                    (id,username,password_hash,status,platform_role) VALUES (:id,:name,'x','active',:role)"""
                    ),
                    {"id": user, "name": name, "role": role},
                )
            for agent in [agent_a, agent_b]:
                await session.execute(
                    text(
                        f"""INSERT INTO "{schema}".agents
                    (id,owner_user_id,name,status,visibility,default_model_mode,draft_workspace_key)
                    VALUES (:id,:owner,'Private Agent','active','private','inherit','fixture')"""
                    ),
                    {"id": agent, "owner": owner},
                )
            for chat, agent in [(chat_a, agent_a), (chat_b, agent_b)]:
                await session.execute(
                    text(
                        f"""INSERT INTO "{schema}".conversations
                    (id,agent_id,owner_user_id,title,status) VALUES (:id,:agent,:owner,'Private history','active')"""
                    ),
                    {"id": chat, "agent": agent, "owner": owner},
                )
                await session.execute(
                    text(
                        f"""INSERT INTO "{schema}".messages
                    (id,conversation_id,sequence,role,message_type,content,status)
                    VALUES (:id,:chat,1,'user','message','{{"text":"private"}}','completed')"""
                    ),
                    {"id": uuid4(), "chat": chat},
                )

        @asynccontextmanager
        async def runtime_sessions():
            async with factory.begin() as session:
                await session.execute(text("SET LOCAL ROLE qwenpaw_runtime"))
                yield session

        repo = PostgresConversationRepository(
            schema=schema, session_factory=runtime_sessions
        )
        admin_repo = repo.with_user(admin)
        assert [
            row["id"] for row in await admin_repo.list_conversations_for_admin(agent_a)
        ] == [chat_a]
        assert await admin_repo.get_conversation_for_admin(agent_a, chat_b) is None
        assert (
            await admin_repo.get_conversation_for_admin(agent_a, chat_a)
        ).id == chat_a
        assert len(await admin_repo.list_messages(chat_a)) == 1
        assert (
            await repo.with_user(outsider).list_conversations_for_admin(agent_a) == []
        )
        assert await repo.with_user(owner).list_conversations_for_admin(agent_a) == []
        assert await repo.with_user(outsider).list_messages(chat_a) == []
        assert len(await repo.with_user(owner).list_messages(chat_a)) == 1
        # 管理员获得 SELECT 权限，不获得其他用户消息的写权限。
        async with admin_repo._session() as session:
            result = await session.execute(
                text(
                    f"""UPDATE "{schema}".messages SET content='{{}}'
                WHERE conversation_id=:chat RETURNING id"""
                ),
                {"chat": chat_a},
            )
            assert result.all() == []
        async with factory.begin() as session:
            await session.execute(
                text(f"UPDATE \"{schema}\".users SET status='disabled' WHERE id=:id"),
                {"id": admin},
            )
        assert await admin_repo.list_conversations_for_admin(agent_a) == []
        assert await admin_repo.list_messages(chat_a) == []
    finally:
        await engine.dispose()
