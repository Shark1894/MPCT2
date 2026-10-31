"""Database schema. Mirrors the legacy SQLite layout (openings -> lines -> moves, moves
linking a before-position to an after-position) with a repertoires table instead of
one .db file per repertoire, enforced foreign keys and cascading deletes.

Review history tables (line_reviews, move_attempts) arrive with the trainer in Phase 4.
"""

from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


class Repertoire(Base):
    __tablename__ = "repertoires"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    openings: Mapped[list["Opening"]] = relationship(back_populates="repertoire", passive_deletes=True)


class Opening(Base):
    __tablename__ = "openings"
    __table_args__ = (
        UniqueConstraint("repertoire_id", "name", name="uq_openings_repertoire_name"),
        CheckConstraint("color IN ('white', 'black')", name="color"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    repertoire_id: Mapped[int] = mapped_column(ForeignKey("repertoires.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(5))
    created_on: Mapped[date] = mapped_column(Date, server_default=func.current_date())

    repertoire: Mapped[Repertoire] = relationship(back_populates="openings")
    lines: Mapped[list["Line"]] = relationship(back_populates="opening", passive_deletes=True)


class Line(Base):
    __tablename__ = "lines"
    __table_args__ = (Index("ix_lines_opening_review", "opening_id", "next_review_on"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    opening_id: Mapped[int] = mapped_column(ForeignKey("openings.id", ondelete="CASCADE"))
    created_on: Mapped[date] = mapped_column(Date, server_default=func.current_date())
    next_review_on: Mapped[date] = mapped_column(Date, server_default=func.current_date())

    opening: Mapped[Opening] = relationship(back_populates="lines")
    moves: Mapped[list["Move"]] = relationship(
        back_populates="line", order_by="Move.ply", passive_deletes=True
    )


class Position(Base):
    """A position shared by all repertoires, identified by app.core.positions.position_key."""

    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(Text, unique=True)


class Move(Base):
    __tablename__ = "moves"
    __table_args__ = (
        UniqueConstraint("line_id", "ply", name="uq_moves_line_ply"),
        CheckConstraint("ply >= 1", name="ply_positive"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    line_id: Mapped[int] = mapped_column(ForeignKey("lines.id", ondelete="CASCADE"))
    ply: Mapped[int]
    uci: Mapped[str] = mapped_column(String(5))
    san: Mapped[str] = mapped_column(String(10))
    position_before_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True)
    position_after_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True)

    line: Mapped[Line] = relationship(back_populates="moves")


class PositionComment(Base):
    """A note on a position, kept per repertoire."""

    __tablename__ = "position_comments"

    repertoire_id: Mapped[int] = mapped_column(ForeignKey("repertoires.id", ondelete="CASCADE"), primary_key=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id", ondelete="CASCADE"), primary_key=True)
    comment: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
