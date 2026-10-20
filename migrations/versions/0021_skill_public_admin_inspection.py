"""Add public skill access and read-only administrator conversation inspection."""

import re
from alembic import op
import sqlalchemy as sa

revision = "0021_skill_public_admin_read"
down_revision = "0020_agent_personal_library"
branch_labels = None
depends_on = None


def _schema():
    schema = op.get_bind().execute(sa.text("SELECT current_schema()")).scalar_one()
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", schema):
        raise RuntimeError("invalid_database_schema")
    return schema


def upgrade():
    schema = _schema()
    op.add_column(
        "skill_pool_items",
        sa.Column(
            "visibility", sa.String(16), nullable=False, server_default="restricted"
        ),
    )
    op.create_check_constraint(
        "ck_skill_pool_visibility",
        "skill_pool_items",
        "visibility IN ('public', 'restricted')",
    )
    op.execute(
        f"""
        CREATE FUNCTION "{schema}".qwenpaw_is_active_admin() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
        AS $body$
            SELECT EXISTS (SELECT 1 FROM "{schema}".users
                WHERE id="{schema}".qwenpaw_current_user_id()
                  AND status='active' AND platform_role='admin')
        $body$
    """
    )
    op.execute(
        f"""CREATE POLICY conversations_admin_inspect ON conversations FOR SELECT
        USING ("{schema}".qwenpaw_is_active_admin() AND status <> 'deleted'
          AND EXISTS (SELECT 1 FROM "{schema}".agents a WHERE a.id=agent_id AND a.status <> 'deleted'))"""
    )
    op.execute(
        f"""CREATE POLICY messages_admin_inspect ON messages FOR SELECT
        USING ("{schema}".qwenpaw_is_active_admin() AND EXISTS (
          SELECT 1 FROM "{schema}".conversations c
          WHERE c.id=conversation_id AND c.status <> 'deleted'))"""
    )


def downgrade():
    schema = _schema()
    if (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT EXISTS (SELECT 1 FROM skill_pool_items WHERE visibility='public')"
            )
        )
        .scalar_one()
    ):
        raise RuntimeError("public_skill_data_prevents_downgrade")
    op.execute("DROP POLICY messages_admin_inspect ON messages")
    op.execute("DROP POLICY conversations_admin_inspect ON conversations")
    op.execute(f'DROP FUNCTION "{schema}".qwenpaw_is_active_admin()')
    op.drop_constraint("ck_skill_pool_visibility", "skill_pool_items", type_="check")
    op.drop_column("skill_pool_items", "visibility")
