"""puzzles

Revision ID: ae2b5036bfc5
Revises: a7c1d2e3f4b5
Create Date: 2026-11-03 21:50:23.678402

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'ae2b5036bfc5'
down_revision: Union[str, Sequence[str], None] = 'a7c1d2e3f4b5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""

    op.create_table('puzzle_attempts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('puzzle_id', sa.String(length=10), nullable=False),
    sa.Column('attempted_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('solved', sa.Boolean(), nullable=False),
    sa.Column('rated', sa.Boolean(), nullable=False),
    sa.Column('puzzle_rating', sa.Integer(), nullable=False),
    sa.Column('rating_before', sa.Double(), nullable=False),
    sa.Column('rating_after', sa.Double(), nullable=False),
    sa.Column('rd_after', sa.Double(), nullable=False),
    sa.Column('seconds', sa.Integer(), nullable=True),
    sa.Column('themes', postgresql.ARRAY(sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_puzzle_attempts'))
    )
    op.create_index(op.f('ix_puzzle_attempts_attempted_at'), 'puzzle_attempts', ['attempted_at'], unique=False)
    op.create_index('ix_puzzle_attempts_puzzle', 'puzzle_attempts', ['puzzle_id'], unique=False)
    op.create_table('puzzle_imports',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('finished_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('puzzles', sa.Integer(), nullable=False),
    sa.Column('source', sa.Text(), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_puzzle_imports'))
    )
    op.create_table('puzzle_rating',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('rating', sa.Double(), nullable=False),
    sa.Column('rd', sa.Double(), nullable=False),
    sa.Column('volatility', sa.Double(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('id = 1', name=op.f('ck_puzzle_rating_single_row')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_puzzle_rating'))
    )
    op.create_table('puzzles',
    sa.Column('id', sa.String(length=10), nullable=False),
    sa.Column('fen', sa.Text(), nullable=False),
    sa.Column('moves', sa.Text(), nullable=False),
    sa.Column('rating', sa.Integer(), nullable=False),
    sa.Column('rating_deviation', sa.Integer(), nullable=False),
    sa.Column('popularity', sa.Integer(), nullable=False),
    sa.Column('nb_plays', sa.Integer(), nullable=False),
    sa.Column('themes', postgresql.ARRAY(sa.Text()), nullable=False),
    sa.Column('game_url', sa.Text(), server_default='', nullable=False),
    sa.Column('opening_tags', postgresql.ARRAY(sa.Text()), nullable=False),
    sa.Column('rnd', sa.Integer(), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_puzzles'))
    )
    op.create_index('ix_puzzles_rnd', 'puzzles', ['rnd'], unique=False)
    op.create_index('ix_puzzles_themes', 'puzzles', ['themes'], unique=False, postgresql_using='gin')



def downgrade() -> None:
    """Downgrade schema."""

    op.drop_index('ix_puzzles_themes', table_name='puzzles', postgresql_using='gin')
    op.drop_index('ix_puzzles_rnd', table_name='puzzles')
    op.drop_table('puzzles')
    op.drop_table('puzzle_rating')
    op.drop_table('puzzle_imports')
    op.drop_index('ix_puzzle_attempts_puzzle', table_name='puzzle_attempts')
    op.drop_index(op.f('ix_puzzle_attempts_attempted_at'), table_name='puzzle_attempts')
    op.drop_table('puzzle_attempts')

