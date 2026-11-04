"""game puzzles

Revision ID: a7caf977b968
Revises: ae2b5036bfc5
Create Date: 2026-11-04 18:55:08.434425

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'a7caf977b968'
down_revision: Union[str, Sequence[str], None] = 'ae2b5036bfc5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""

    op.create_table('app_settings',
    sa.Column('key', sa.String(length=60), nullable=False),
    sa.Column('value', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.PrimaryKeyConstraint('key', name=op.f('pk_app_settings'))
    )
    op.create_table('game_puzzles',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('game_id', sa.Integer(), nullable=False),
    sa.Column('ply', sa.Integer(), nullable=False),
    sa.Column('color', sa.String(length=5), nullable=False),
    sa.Column('fen', sa.Text(), nullable=False),
    sa.Column('setup_fen', sa.Text(), nullable=False),
    sa.Column('setup_uci', sa.String(length=5), nullable=False),
    sa.Column('played_uci', sa.String(length=5), nullable=False),
    sa.Column('played_san', sa.String(length=10), nullable=False),
    sa.Column('best_uci', sa.String(length=5), nullable=False),
    sa.Column('best_san', sa.String(length=10), nullable=False),
    sa.Column('best_pv', sa.Text(), server_default='', nullable=False),
    sa.Column('before', sa.Double(), nullable=False),
    sa.Column('after', sa.Double(), nullable=False),
    sa.Column('label', sa.String(length=10), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('streak', sa.Integer(), server_default='0', nullable=False),
    sa.Column('next_review_on', sa.Date(), server_default=sa.text('CURRENT_DATE'), nullable=False),
    sa.Column('reviews', sa.Integer(), server_default='0', nullable=False),
    sa.Column('correct', sa.Integer(), server_default='0', nullable=False),
    sa.Column('last_reviewed_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['game_id'], ['games.id'], name=op.f('fk_game_puzzles_game_id_games'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_game_puzzles')),
    sa.UniqueConstraint('game_id', 'ply', name='uq_game_puzzles_game_ply')
    )
    op.create_index('ix_game_puzzles_due', 'game_puzzles', ['next_review_on'], unique=False)
    op.create_index(op.f('ix_game_puzzles_game_id'), 'game_puzzles', ['game_id'], unique=False)
    op.create_table('game_scans',
    sa.Column('game_id', sa.Integer(), nullable=False),
    sa.Column('moves_hash', sa.String(length=40), nullable=False),
    sa.Column('color', sa.String(length=5), nullable=False),
    sa.Column('movetime_ms', sa.Integer(), nullable=False),
    sa.Column('found', sa.Integer(), nullable=False),
    sa.Column('scanned_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['game_id'], ['games.id'], name=op.f('fk_game_scans_game_id_games'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('game_id', name=op.f('pk_game_scans'))
    )



def downgrade() -> None:
    """Downgrade schema."""

    op.drop_table('game_scans')
    op.drop_index(op.f('ix_game_puzzles_game_id'), table_name='game_puzzles')
    op.drop_index('ix_game_puzzles_due', table_name='game_puzzles')
    op.drop_table('game_puzzles')
    op.drop_table('app_settings')

