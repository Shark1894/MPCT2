"""practical evals: the depth asked for (a search the time limit stopped short still serves it)

Revision ID: 5c1e7a9b2d40
Revises: 3bb570e1fd99
Create Date: 2026-11-16 22:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '5c1e7a9b2d40'
down_revision: Union[str, Sequence[str], None] = '3bb570e1fd99'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('practical_evals', sa.Column('asked_depth', sa.Integer(), server_default='0', nullable=False))
    op.execute('UPDATE practical_evals SET asked_depth = depth')


def downgrade() -> None:
    op.drop_column('practical_evals', 'asked_depth')
