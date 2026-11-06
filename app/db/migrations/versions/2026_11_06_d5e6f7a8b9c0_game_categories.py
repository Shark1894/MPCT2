"""game categories: games.category (otb / online / practice / other), existing games sorted

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-11-06 19:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'd5e6f7a8b9c0'
down_revision: Union[str, Sequence[str], None] = 'c4d5e6f7a8b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('games', sa.Column('category', sa.String(length=10), server_default='otb', nullable=False))
    op.create_check_constraint(op.f('ck_games_category'), 'games', "category IN ('otb', 'online', 'practice', 'other')")
    op.create_index(op.f('ix_games_category'), 'games', ['category'], unique=False)
    # Sort the games already there (anything left is over the board; moving a game is one click).
    op.execute("""
        UPDATE games SET category = 'online'
        WHERE lichess_id IS NOT NULL
           OR competition ~* '^(rated|casual) .*game$'      -- Lichess PGN events, e.g. "Rated Blitz game"
           OR competition ~* '^(live chess|daily chess)$'   -- chess.com PGN events
    """)
    op.execute("""
        UPDATE games SET category = 'practice'
        WHERE category = 'otb' AND (competition ILIKE 'Practice vs engine%' OR white ILIKE 'Stockfish%' OR black ILIKE 'Stockfish%')
    """)
    op.execute("""
        UPDATE games g SET category = 'other'
        WHERE g.category = 'otb' AND (
            EXISTS (SELECT 1 FROM masters_games m WHERE m.white = g.white AND m.black = g.black)
            OR EXISTS (SELECT 1 FROM wild_games w WHERE w.white = g.white AND w.black = g.black
                       AND w.played_on IS NOT DISTINCT FROM g.played_on)
        )
    """)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_games_category'), table_name='games')
    op.drop_constraint(op.f('ck_games_category'), 'games', type_='check')
    op.drop_column('games', 'category')
