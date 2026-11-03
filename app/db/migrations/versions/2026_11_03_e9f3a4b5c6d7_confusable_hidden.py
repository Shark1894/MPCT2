"""confusable hidden

Revision ID: e9f3a4b5c6d7
Revises: d8e2f3a4b5c6
Create Date: 2026-11-03 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e9f3a4b5c6d7'
down_revision: Union[str, Sequence[str], None] = 'd8e2f3a4b5c6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('confusable_hidden',
    sa.Column('repertoire_id', sa.Integer(), nullable=False),
    sa.Column('position_a_id', sa.Integer(), nullable=False),
    sa.Column('position_b_id', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('position_a_id < position_b_id', name=op.f('ck_confusable_hidden_ordered')),
    sa.ForeignKeyConstraint(['position_a_id'], ['positions.id'], name=op.f('fk_confusable_hidden_position_a_id_positions'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['position_b_id'], ['positions.id'], name=op.f('fk_confusable_hidden_position_b_id_positions'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['repertoire_id'], ['repertoires.id'], name=op.f('fk_confusable_hidden_repertoire_id_repertoires'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('repertoire_id', 'position_a_id', 'position_b_id', name=op.f('pk_confusable_hidden'))
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('confusable_hidden')
