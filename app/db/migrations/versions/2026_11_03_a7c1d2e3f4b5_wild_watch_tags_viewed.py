"""wild watches belong to branch tags; viewed games

Revision ID: a7c1d2e3f4b5
Revises: eb60c20dbf94
Create Date: 2026-11-03 21:15:00

A watch is now a branch tag shown in the Wild tab under the tag's name. Watches made
before this (on any position) are linked to the tag at their position; where there is no
tag, one is created, named after the watch's label or the move reaching the position
(e.g. "4.dxe6"), so nothing is lost.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7c1d2e3f4b5'
down_revision: Union[str, Sequence[str], None] = 'eb60c20dbf94'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _move_name(conn, opening_id: int, position_id: int) -> str:
    row = conn.execute(sa.text(
        "SELECT m.ply, m.san FROM moves m JOIN lines l ON l.id = m.line_id "
        "WHERE l.opening_id = :o AND m.position_after_id = :p ORDER BY m.ply, m.line_id LIMIT 1"
    ), {"o": opening_id, "p": position_id}).first()
    if row is None:
        return "Watched position"
    ply, san = row
    return f"{(ply + 1) // 2}{'.' if ply % 2 else '...'}{san}"


def upgrade() -> None:
    op.add_column('wild_watches', sa.Column('tag_id', sa.Integer(), nullable=True))
    op.add_column('wild_games', sa.Column('viewed_at', sa.DateTime(timezone=True), nullable=True))

    conn = op.get_bind()
    watches = conn.execute(sa.text("SELECT id, opening_id, position_id, label FROM wild_watches")).all()
    for w_id, opening_id, position_id, label in watches:
        tag_id = conn.execute(sa.text(
            "SELECT id FROM opening_tags WHERE opening_id = :o AND position_id = :p"
        ), {"o": opening_id, "p": position_id}).scalar()
        if tag_id is None:
            name = (label or "").strip()[:60] or _move_name(conn, opening_id, position_id)
            taken = set(conn.execute(sa.text("SELECT name FROM opening_tags WHERE opening_id = :o"), {"o": opening_id}).scalars())
            base, n = name, 2
            while name in taken:
                name = f"{base[:55]} ({n})"
                n += 1
            tag_id = conn.execute(sa.text(
                "INSERT INTO opening_tags (opening_id, position_id, name) VALUES (:o, :p, :n) RETURNING id"
            ), {"o": opening_id, "p": position_id, "n": name}).scalar()
        conn.execute(sa.text("UPDATE wild_watches SET tag_id = :t WHERE id = :w"), {"t": tag_id, "w": w_id})

    op.alter_column('wild_watches', 'tag_id', nullable=False)
    op.create_foreign_key(op.f('fk_wild_watches_tag_id_opening_tags'), 'wild_watches', 'opening_tags', ['tag_id'], ['id'], ondelete='CASCADE')
    op.create_unique_constraint(op.f('uq_wild_watches_tag_id'), 'wild_watches', ['tag_id'])
    op.drop_column('wild_watches', 'label')


def downgrade() -> None:
    op.add_column('wild_watches', sa.Column('label', sa.String(length=60), server_default='', nullable=False))
    op.execute("UPDATE wild_watches w SET label = t.name FROM opening_tags t WHERE t.id = w.tag_id")
    op.drop_constraint(op.f('uq_wild_watches_tag_id'), 'wild_watches', type_='unique')
    op.drop_constraint(op.f('fk_wild_watches_tag_id_opening_tags'), 'wild_watches', type_='foreignkey')
    op.drop_column('wild_watches', 'tag_id')
    op.drop_column('wild_games', 'viewed_at')
