"""line bookmarks

Revision ID: c7d1e2f3a4b5
Revises: bb04176fa1ad
Create Date: 2026-11-02 22:10:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c7d1e2f3a4b5'
down_revision: Union[str, Sequence[str], None] = 'bb04176fa1ad'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('lines', sa.Column('bookmarked_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('lines', sa.Column('bookmark_note', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('lines', 'bookmark_note')
    op.drop_column('lines', 'bookmarked_at')
