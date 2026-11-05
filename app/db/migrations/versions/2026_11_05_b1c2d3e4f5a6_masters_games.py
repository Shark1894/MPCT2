"""masters games

Revision ID: b1c2d3e4f5a6
Revises: ad3e86895c7e
Create Date: 2026-11-05 23:40:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, Sequence[str], None] = 'ad3e86895c7e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('masters_games',
    sa.Column('id', sa.String(length=12), nullable=False),
    sa.Column('white', sa.String(length=100), server_default='', nullable=False),
    sa.Column('black', sa.String(length=100), server_default='', nullable=False),
    sa.Column('white_elo', sa.Integer(), nullable=True),
    sa.Column('black_elo', sa.Integer(), nullable=True),
    sa.Column('event', sa.String(length=200), server_default='', nullable=False),
    sa.Column('site', sa.String(length=200), server_default='', nullable=False),
    sa.Column('round', sa.String(length=20), server_default='', nullable=False),
    sa.Column('year', sa.Integer(), nullable=True),
    sa.Column('month', sa.Integer(), nullable=True),
    sa.Column('played_on', sa.Date(), nullable=True),
    sa.Column('result', sa.String(length=7), nullable=False),
    sa.Column('moves', sa.Text(), nullable=False),
    sa.Column('pgn', sa.Text(), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_masters_games'))
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('masters_games')
