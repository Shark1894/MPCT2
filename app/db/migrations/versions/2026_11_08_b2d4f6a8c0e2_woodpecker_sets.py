"""woodpecker sets: cycles grouped into sets, each numbered from 1 (existing cycles are set 1)

Revision ID: b2d4f6a8c0e2
Revises: a1c3e5f7b9d1
Create Date: 2026-11-08 22:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2d4f6a8c0e2'
down_revision: Union[str, Sequence[str], None] = 'a1c3e5f7b9d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('woodpecker_cycles', sa.Column('set_number', sa.Integer(), server_default='1', nullable=False))
    op.drop_constraint('uq_woodpecker_cycles_course_number', 'woodpecker_cycles', type_='unique')
    op.create_unique_constraint('uq_woodpecker_cycles_course_set_number', 'woodpecker_cycles', ['course_id', 'set_number', 'number'])


def downgrade() -> None:
    op.drop_constraint('uq_woodpecker_cycles_course_set_number', 'woodpecker_cycles', type_='unique')
    # Renumber across sets so (course, number) is unique again.
    op.execute("""
        UPDATE woodpecker_cycles y SET number = r.n
          FROM (SELECT id, row_number() OVER (PARTITION BY course_id ORDER BY set_number, number) AS n
                  FROM woodpecker_cycles) r
         WHERE r.id = y.id
    """)
    op.create_unique_constraint('uq_woodpecker_cycles_course_number', 'woodpecker_cycles', ['course_id', 'number'])
    op.drop_column('woodpecker_cycles', 'set_number')
