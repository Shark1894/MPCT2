"""Database schema. Mirrors the legacy SQLite layout (openings -> lines -> moves, moves
linking a before-position to an after-position) with a repertoires table instead of
one .db file per repertoire, enforced foreign keys and cascading deletes.

Review history: line_reviews (one row per finished training attempt at a line) and
move_attempts (every move tried during it, including the wrong move actually played).
"""

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
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
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
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


class DrillAttempt(Base):
    """One position answered in the position drill (practice: never touches the schedule).

    `correct` = right on the first try; `wrong` = the wrong moves tried, in order. These
    feed the dashboard's problem positions alongside training mistakes.
    """

    __tablename__ = "drill_attempts"
    __table_args__ = (Index("ix_drill_attempts_opening_position", "opening_id", "position_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    opening_id: Mapped[int] = mapped_column(ForeignKey("openings.id", ondelete="CASCADE"))
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id", ondelete="CASCADE"))
    expected_uci: Mapped[str] = mapped_column(String(5))
    correct: Mapped[bool] = mapped_column(Boolean)
    wrong: Mapped[list[str]] = mapped_column(ARRAY(String(5)), server_default="{}")
    attempted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ExplorerCache(Base):
    """A position's statistics from the Lichess opening explorer (masters games), cached so
    each position is asked about once. `data` keeps the totals and the moves list as Lichess
    sends them: {white, draws, black, moves: [{uci, san, white, draws, black, averageRating}]}."""

    __tablename__ = "explorer_cache"

    key: Mapped[str] = mapped_column(Text, primary_key=True)  # EPD, like positions.key
    source: Mapped[str] = mapped_column(String(10), primary_key=True)  # "masters"
    data: Mapped[dict] = mapped_column(JSONB)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MastersGame(Base):
    """A game from the Lichess masters database, fetched when it's opened from the board's
    Masters panel (kept so it opens again without asking Lichess). `pgn` is the text Lichess
    sent; `moves` the main line in UCI. Dates there are often just a year (played_on is then
    None and year/month say what is known)."""

    __tablename__ = "masters_games"

    id: Mapped[str] = mapped_column(String(12), primary_key=True)  # Lichess masters game id
    white: Mapped[str] = mapped_column(String(100), server_default="")
    black: Mapped[str] = mapped_column(String(100), server_default="")
    white_elo: Mapped[int | None]
    black_elo: Mapped[int | None]
    event: Mapped[str] = mapped_column(String(200), server_default="")
    site: Mapped[str] = mapped_column(String(200), server_default="")
    round: Mapped[str] = mapped_column(String(20), server_default="")
    year: Mapped[int | None]
    month: Mapped[int | None]
    played_on: Mapped[date | None] = mapped_column(Date)
    result: Mapped[str] = mapped_column(String(7))
    moves: Mapped[str] = mapped_column(Text)
    pgn: Mapped[str] = mapped_column(Text)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


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


class WildWatch(Base):
    """A branch tag you want to see in tournament games ("in the wild"); its name is the tag's.
    opening_id and position_id copy the tag's; `hash` is the position's Polyglot hash
    (app.core.wild.key_hash), as stored per game. Removing the tag removes the watch."""

    __tablename__ = "wild_watches"
    __table_args__ = (UniqueConstraint("opening_id", "position_id", name="uq_wild_watches_position"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("opening_tags.id", ondelete="CASCADE"), unique=True)
    opening_id: Mapped[int] = mapped_column(ForeignKey("openings.id", ondelete="CASCADE"), index=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"))
    hash: Mapped[int] = mapped_column(BigInteger, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WildGame(Base):
    """A tournament game fetched from Lichess broadcasts or The Week in Chess.

    `moves` is the whole game in UCI (space-separated); `hashes` holds the Polyglot hash of
    the position after each of the first moves (hashes[1] = after White's first move), so
    `hashes @> ARRAY[h]` finds games reaching a position and array_position gives the ply.
    """

    __tablename__ = "wild_games"
    __table_args__ = (Index("ix_wild_games_hashes", "hashes", postgresql_using="gin"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    game_key: Mapped[str] = mapped_column(String(40), unique=True)
    source: Mapped[str] = mapped_column(String(10))  # "lichess" | "twic"
    source_ref: Mapped[str] = mapped_column(String(60))  # e.g. "twic1669", "lichess:abcd1234"
    white: Mapped[str] = mapped_column(String(100), server_default="")
    black: Mapped[str] = mapped_column(String(100), server_default="")
    white_elo: Mapped[int | None]
    black_elo: Mapped[int | None]
    event: Mapped[str] = mapped_column(String(200), server_default="")
    site: Mapped[str] = mapped_column(String(200), server_default="")
    round: Mapped[str] = mapped_column(String(20), server_default="")
    played_on: Mapped[date | None] = mapped_column(Date, index=True)
    result: Mapped[str] = mapped_column(String(7))
    plies: Mapped[int]
    moves: Mapped[str] = mapped_column(Text)
    hashes: Mapped[list[int]] = mapped_column(ARRAY(BigInteger))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # first opened on the board


class WildSource(Base):
    """One fetched download: a TWIC issue ("twic:1669") or a Lichess broadcast ("lichess:<tour id>")."""

    __tablename__ = "wild_sources"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    finished: Mapped[bool] = mapped_column(Boolean, server_default="false")  # no need to fetch again
    games: Mapped[int] = mapped_column(server_default="0")
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())



class Puzzle(Base):
    """A puzzle from the Lichess puzzle database (CC0). `fen` is the position before the
    opponent's move; `moves` (UCI) starts with that move, then the solution. `rnd` is a
    random key for picking puzzles at random quickly. Replaced wholesale on re-import, so
    nothing refers to it by foreign key."""

    __tablename__ = "puzzles"
    __table_args__ = (
        Index("ix_puzzles_rnd", "rnd"),
        Index("ix_puzzles_themes", "themes", postgresql_using="gin"),
    )

    id: Mapped[str] = mapped_column(String(10), primary_key=True)
    fen: Mapped[str] = mapped_column(Text)
    moves: Mapped[str] = mapped_column(Text)
    rating: Mapped[int]
    rating_deviation: Mapped[int]
    popularity: Mapped[int]
    nb_plays: Mapped[int]
    themes: Mapped[list[str]] = mapped_column(ARRAY(Text))
    game_url: Mapped[str] = mapped_column(Text, server_default="")
    opening_tags: Mapped[list[str]] = mapped_column(ARRAY(Text))
    rnd: Mapped[int]


class PuzzleAttempt(Base):
    """One go at a puzzle. Only the first go at a puzzle is rated (rated=true)."""

    __tablename__ = "puzzle_attempts"
    __table_args__ = (Index("ix_puzzle_attempts_puzzle", "puzzle_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    puzzle_id: Mapped[str] = mapped_column(String(10))
    attempted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    solved: Mapped[bool] = mapped_column(Boolean)
    rated: Mapped[bool] = mapped_column(Boolean)
    puzzle_rating: Mapped[int]
    rating_before: Mapped[float]
    rating_after: Mapped[float]
    rd_after: Mapped[float]
    seconds: Mapped[int | None]
    themes: Mapped[list[str]] = mapped_column(ARRAY(Text))  # copied, so stats survive a re-import


class PuzzleRating(Base):
    """Your current puzzle rating (one row)."""

    __tablename__ = "puzzle_rating"
    __table_args__ = (CheckConstraint("id = 1", name="single_row"),)

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    rating: Mapped[float]
    rd: Mapped[float]
    volatility: Mapped[float]
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PuzzleImport(Base):
    """A finished import of the Lichess puzzle database."""

    __tablename__ = "puzzle_imports"

    id: Mapped[int] = mapped_column(primary_key=True)
    finished_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    puzzles: Mapped[int]
    source: Mapped[str] = mapped_column(Text)


class AppSetting(Base):
    """Small app-wide settings (key -> JSON), e.g. your names in games."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[dict | list | str | None] = mapped_column(JSONB)


class GameReview(Base):
    """A finished engine review of one of your games (every position analysed). It counts only
    while `moves_hash` matches the game's moves; editing the moves makes the game unreviewed."""

    __tablename__ = "game_reviews"

    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), primary_key=True)
    moves_hash: Mapped[str] = mapped_column(String(40))
    movetime_ms: Mapped[int]
    white_accuracy: Mapped[float | None]
    black_accuracy: Mapped[float | None]
    counts: Mapped[dict] = mapped_column(JSONB)  # {"w": {"inaccuracy", "mistake", "blunder"}, "b": {...}}
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class GamePuzzle(Base):
    """A mistake of yours in one of your games, as a puzzle: from `fen` (before your move) find
    `best_uci`. The puzzle is shown like a Lichess one: from `setup_fen` the opponent's last
    move `setup_uci` is played first. Practised with spaced repetition, like repertoire lines."""

    __tablename__ = "game_puzzles"
    __table_args__ = (
        UniqueConstraint("game_id", "ply", name="uq_game_puzzles_game_ply"),
        Index("ix_game_puzzles_due", "next_review_on"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    ply: Mapped[int]  # your move in the game (1 = White's first)
    color: Mapped[str] = mapped_column(String(5))
    fen: Mapped[str] = mapped_column(Text)
    setup_fen: Mapped[str] = mapped_column(Text)
    setup_uci: Mapped[str] = mapped_column(String(5))
    played_uci: Mapped[str] = mapped_column(String(5))
    played_san: Mapped[str] = mapped_column(String(10))
    best_uci: Mapped[str] = mapped_column(String(5))
    best_san: Mapped[str] = mapped_column(String(10))
    best_pv: Mapped[str] = mapped_column(Text, server_default="")  # UCI, the engine's line
    before: Mapped[float]  # your winning chances with the best move (0-100)
    after: Mapped[float]  # after the move you played
    label: Mapped[str] = mapped_column(String(10))  # mistake | blunder
    dismissed: Mapped[bool] = mapped_column(server_default="false")  # removed by you: not shown again
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    streak: Mapped[int] = mapped_column(server_default="0")
    next_review_on: Mapped[date] = mapped_column(Date, server_default=func.current_date())
    reviews: Mapped[int] = mapped_column(server_default="0")
    correct: Mapped[int] = mapped_column(server_default="0")
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
