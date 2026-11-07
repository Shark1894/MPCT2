"""activity sessions: time spent in each part of the app (Stats tab)

Revision ID: a1c3e5f7b9d1
Revises: 7722ac271b1b
Create Date: 2026-11-07 10:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1c3e5f7b9d1'
down_revision: Union[str, Sequence[str], None] = '7722ac271b1b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('activity_sessions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('key', sa.String(length=36), nullable=False),
    sa.Column('category', sa.String(length=10), nullable=False),
    sa.Column('activity', sa.String(length=20), nullable=False),
    sa.Column('detail', sa.String(length=100), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('seconds', sa.Double(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_activity_sessions')),
    sa.UniqueConstraint('key', name=op.f('uq_activity_sessions_key')),
    )
    op.create_index(op.f('ix_activity_sessions_started_at'), 'activity_sessions', ['started_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_activity_sessions_started_at'), table_name='activity_sessions')
    op.drop_table('activity_sessions')
