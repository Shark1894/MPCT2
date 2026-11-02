"""position evals

Revision ID: d8e2f3a4b5c6
Revises: c7d1e2f3a4b5
Create Date: 2026-11-02 22:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'd8e2f3a4b5c6'
down_revision: Union[str, Sequence[str], None] = 'c7d1e2f3a4b5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('position_evals',
    sa.Column('key', sa.Text(), nullable=False),
    sa.Column('movetime_ms', sa.Integer(), nullable=False),
    sa.Column('depth', sa.Integer(), nullable=False),
    sa.Column('lines', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('engine', sa.String(length=60), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('key', name=op.f('pk_position_evals'))
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('position_evals')
