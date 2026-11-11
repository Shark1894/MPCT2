"""puzzles: GIN index on opening_tags, for the openings filter

Building it over the full Lichess puzzle database (about 6 million rows) takes a minute
or two on the first start after this upgrade.

Revision ID: c3e5a7b9d1f3
Revises: b2d4f6a8c0e2
Create Date: 2026-11-11 00:30:00

"""
from typing import Sequence, Union

from alembic import op


revision: str = 'c3e5a7b9d1f3'
down_revision: Union[str, Sequence[str], None] = 'b2d4f6a8c0e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("SET LOCAL statement_timeout = 0")
    op.create_index('ix_puzzles_opening_tags', 'puzzles', ['opening_tags'], postgresql_using='gin')


def downgrade() -> None:
    op.drop_index('ix_puzzles_opening_tags', table_name='puzzles', postgresql_using='gin')
