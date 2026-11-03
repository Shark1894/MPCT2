"""Database schema. Mirrors the legacy SQLite layout (openings -> lines -> moves, moves
linking a before-position to an after-position) with a repertoires table instead of
one .db file per repertoire, enforced foreign keys and cascading deletes.

Review history: line_reviews (one row per finished training attempt at a line) and
move_attempts (every move tried during it, including the wrong move actually played).
"""

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
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
from sqlalchemy.dialects.postgresql import JSONB
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
    # Bookmark: set when starred; the optional note belongs to the bookmark.
    bookmarked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    bookmark_note: Mapped[str | None] = mapped_column(Text)

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


class LineReview(Base):
    """One finished training attempt at a line.

    `streak` is the line's consecutive-correct count after this review. Practice
    reviews (retries straight after a mistake) are recorded but don't change the
    streak or the schedule.
    """

    __tablename__ = "line_reviews"
    __table_args__ = (Index("ix_line_reviews_line_time", "line_id", "reviewed_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    line_id: Mapped[int] = mapped_column(ForeignKey("lines.id", ondelete="CASCADE"))
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    correct: Mapped[bool] = mapped_column(Boolean)
    practice: Mapped[bool] = mapped_column(Boolean, server_default="false")
    mistakes: Mapped[int] = mapped_column(server_default="0")
    streak: Mapped[int] = mapped_column(server_default="0")

    attempts: Mapped[list["MoveAttempt"]] = relationship(
        back_populates="review", order_by="MoveAttempt.id", passive_deletes=True
    )


class MoveAttempt(Base):
    """A move tried during a review: the expected move (move_id) and what was played."""

    __tablename__ = "move_attempts"

    id: Mapped[int] = mapped_column(primary_key=True)
    line_review_id: Mapped[int] = mapped_column(ForeignKey("line_reviews.id", ondelete="CASCADE"), index=True)
    move_id: Mapped[int] = mapped_column(ForeignKey("moves.id", ondelete="CASCADE"), index=True)
    played_uci: Mapped[str] = mapped_column(String(5))
    correct: Mapped[bool] = mapped_column(Boolean)

    review: Mapped[LineReview] = relationship(back_populates="attempts")


class OpeningTag(Base):
    """A named branch of an opening: every line in the opening that passes through
    the tagged position carries the tag (including lines added later)."""

    __tablename__ = "opening_tags"
    __table_args__ = (
        UniqueConstraint("opening_id", "name", name="uq_opening_tags_name"),
        UniqueConstraint("opening_id", "position_id", name="uq_opening_tags_position"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    opening_id: Mapped[int] = mapped_column(ForeignKey("openings.id", ondelete="CASCADE"), index=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"))
    name: Mapped[str] = mapped_column(String(60))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Game(Base):
    """A played game (over the board or online), shared across repertoires."""

    __tablename__ = "games"
    __table_args__ = (CheckConstraint("result IN ('1-0', '0-1', '1/2-1/2', '*')", name="result"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    white: Mapped[str] = mapped_column(String(100), server_default="")
    black: Mapped[str] = mapped_column(String(100), server_default="")
    white_team: Mapped[str] = mapped_column(String(100), server_default="")
    black_team: Mapped[str] = mapped_column(String(100), server_default="")
    competition: Mapped[str] = mapped_column(String(150), server_default="")
    played_on: Mapped[date | None] = mapped_column(Date, index=True)
    result: Mapped[str] = mapped_column(String(7), server_default="*")
    start_fen: Mapped[str | None] = mapped_column(Text)  # null = the normal starting position
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    moves: Mapped[list["GameMove"]] = relationship(
        back_populates="game", order_by="GameMove.ply", passive_deletes=True
    )


class GameMove(Base):
    __tablename__ = "game_moves"
    __table_args__ = (UniqueConstraint("game_id", "ply", name="uq_game_moves_game_ply"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"))
    ply: Mapped[int]
    uci: Mapped[str] = mapped_column(String(5))
    san: Mapped[str] = mapped_column(String(10))

    game: Mapped[Game] = relationship(back_populates="moves")


class PositionEval(Base):
    """Saved engine analysis of a position (any position, not only repertoire ones).

    Keyed like positions.key (python-chess EPD), so transpositions share it. `lines` are
    the engine's best moves, best first: [{"uci", "score": {"cp"|"mate"}, "pv": [uci...]}],
    scores from White's point of view. `movetime_ms` is the thinking time it got; a
    review asking for more time re-analyses, less time reuses it.
    """

    __tablename__ = "position_evals"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    movetime_ms: Mapped[int]
    depth: Mapped[int]
    lines: Mapped[list] = mapped_column(JSONB)
    engine: Mapped[str] = mapped_column(String(60))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
