"""lichess game import: games.lichess_id

Revision ID: c4d5e6f7a8b9
Revises: b1c2d3e4f5a6
Create Date: 2026-11-06 17:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'c4d5e6f7a8b9'
down_revision: Union[str, Sequence[str], None] = 'b1c2d3e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('games', sa.Column('lichess_id', sa.String(length=12), nullable=True))
    op.create_unique_constraint(op.f('uq_games_lichess_id'), 'games', ['lichess_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f('uq_games_lichess_id'), 'games', type_='unique')
    op.drop_column('games', 'lichess_id')
