"""game reviews

Revision ID: 0dfcaf58c9a1
Revises: a7caf977b968
Create Date: 2026-11-04 19:26:23.940830

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0dfcaf58c9a1'
down_revision: Union[str, Sequence[str], None] = 'a7caf977b968'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('game_reviews',
    sa.Column('game_id', sa.Integer(), nullable=False),
    sa.Column('moves_hash', sa.String(length=40), nullable=False),
    sa.Column('movetime_ms', sa.Integer(), nullable=False),
    sa.Column('white_accuracy', sa.Double(), nullable=True),
    sa.Column('black_accuracy', sa.Double(), nullable=True),
    sa.Column('counts', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('reviewed_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['game_id'], ['games.id'], name=op.f('fk_game_reviews_game_id_games'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('game_id', name=op.f('pk_game_reviews'))
    )
    op.drop_table('game_scans')
    op.add_column('game_puzzles', sa.Column('dismissed', sa.Boolean(), server_default='false', nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('game_puzzles', 'dismissed')
    op.create_table('game_scans',
    sa.Column('game_id', sa.INTEGER(), autoincrement=False, nullable=False),
    sa.Column('moves_hash', sa.VARCHAR(length=40), autoincrement=False, nullable=False),
    sa.Column('color', sa.VARCHAR(length=5), autoincrement=False, nullable=False),
    sa.Column('movetime_ms', sa.INTEGER(), autoincrement=False, nullable=False),
    sa.Column('found', sa.INTEGER(), autoincrement=False, nullable=False),
    sa.Column('scanned_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), autoincrement=False, nullable=False),
    sa.ForeignKeyConstraint(['game_id'], ['games.id'], name=op.f('fk_game_scans_game_id_games'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('game_id', name=op.f('pk_game_scans'))
    )
    op.drop_table('game_reviews')
