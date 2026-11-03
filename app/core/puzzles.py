"""Reading the Lichess puzzle database (database.lichess.org/#puzzles). Pure, no database.

Each CSV row: PuzzleId, FEN, Moves, Rating, RatingDeviation, Popularity, NbPlays, Themes,
GameUrl, OpeningTags (and, in newer files, DailyDate). The FEN is the position BEFORE the
opponent's move; the first move in Moves is that move, and the solution starts with the
second. Moves are UCI.
"""

import csv
import io
import random
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

COLUMNS = ("id", "fen", "moves", "rating", "rating_deviation", "popularity", "nb_plays", "themes", "game_url", "opening_tags", "rnd")


def _int(value: str, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def pg_array(items: list[str]) -> str:
    """A Postgres text[] literal for COPY (theme and opening names are plain words)."""
    return "{" + ",".join(items) + "}"


@dataclass(frozen=True)
class PuzzleRow:
    id: str
    fen: str
    moves: str  # UCI, space-separated, first = the opponent's move
    rating: int
    rating_deviation: int
    popularity: int
    nb_plays: int
    themes: list[str]
    game_url: str
    opening_tags: list[str]
    rnd: int  # random sort key for picking puzzles at random

    def copy_row(self) -> tuple:
        return (
            self.id, self.fen, self.moves, self.rating, self.rating_deviation, self.popularity, self.nb_plays,
            pg_array(self.themes), self.game_url, pg_array(self.opening_tags), self.rnd,
        )


def parse_row(row: list[str], rng: random.Random) -> PuzzleRow | None:
    """A CSV row as a puzzle, or None for the header or a malformed row."""
    if len(row) < 8 or row[0] == "PuzzleId":
        return None
    pid, fen, moves = row[0].strip(), row[1].strip(), row[2].strip()
    if not pid or len(pid) > 10 or fen.count("/") != 7 or len(moves.split()) < 2:
        return None
    return PuzzleRow(
        id=pid,
        fen=fen,
        moves=moves,
        rating=_int(row[3], 1500),
        rating_deviation=_int(row[4], 100),
        popularity=_int(row[5]),
        nb_plays=_int(row[6]),
        themes=[t for t in row[7].split() if t.isidentifier()],
        game_url=row[8].strip()[:100] if len(row) > 8 else "",
        opening_tags=[t for t in (row[9].split() if len(row) > 9 else []) if t.replace("_", "").isalnum()],
        rnd=rng.randrange(2**31),
    )


def read_rows(lines: Iterable[str], seed: int | None = None) -> Iterator[PuzzleRow]:
    rng = random.Random(seed)
    for row in csv.reader(lines):
        p = parse_row(row, rng)
        if p is not None:
            yield p


def text_stream(binary, compressed: bool) -> io.TextIOBase:
    """Text lines from a .csv or .csv.zst stream, decompressed on the fly."""
    if compressed:
        import zstandard

        binary = zstandard.ZstdDecompressor().stream_reader(binary)
    return io.TextIOWrapper(binary, encoding="utf-8", newline="")


# Lichess puzzle themes worth offering as filters, with readable names (from lichess.org/training/themes).
THEMES = {
    "mateIn1": "Mate in 1",
    "mateIn2": "Mate in 2",
    "mateIn3": "Mate in 3",
    "mateIn4": "Mate in 4",
    "mate": "Checkmate",
    "fork": "Fork",
    "pin": "Pin",
    "skewer": "Skewer",
    "discoveredAttack": "Discovered attack",
    "doubleCheck": "Double check",
    "sacrifice": "Sacrifice",
    "deflection": "Deflection",
    "attraction": "Attraction",
    "decoy": "Decoy",
    "clearance": "Clearance",
    "interference": "Interference",
    "intermezzo": "Intermezzo",
    "xRayAttack": "X-ray attack",
    "zugzwang": "Zugzwang",
    "quietMove": "Quiet move",
    "defensiveMove": "Defensive move",
    "trappedPiece": "Trapped piece",
    "hangingPiece": "Hanging piece",
    "capturingDefender": "Capture the defender",
    "attackingF2F7": "Attacking f2/f7",
    "kingsideAttack": "Kingside attack",
    "queensideAttack": "Queenside attack",
    "backRankMate": "Back rank mate",
    "smotheredMate": "Smothered mate",
    "advancedPawn": "Advanced pawn",
    "promotion": "Promotion",
    "underPromotion": "Underpromotion",
    "enPassant": "En passant",
    "castling": "Castling",
    "exposedKing": "Exposed king",
    "opening": "Opening",
    "middlegame": "Middlegame",
    "endgame": "Endgame",
    "rookEndgame": "Rook endgame",
    "bishopEndgame": "Bishop endgame",
    "knightEndgame": "Knight endgame",
    "pawnEndgame": "Pawn endgame",
    "queenEndgame": "Queen endgame",
    "queenRookEndgame": "Queen and rook",
    "crushing": "Crushing",
    "advantage": "Advantage",
    "equality": "Equality",
    "short": "Short (2 moves)",
    "long": "Long (3 moves)",
    "veryLong": "Very long (4+ moves)",
    "oneMove": "One move",
}
