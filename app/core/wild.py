"""Repertoire in the wild: reading tournament PGN into compact records whose positions can
be matched against watched repertoire positions. Pure python-chess, no database or network.

Each game keeps a Zobrist (Polyglot) hash of the position after each of its first
MAX_PLY moves, so "which games reach this position?" is one indexed array lookup, and the
array index is the move where it was reached. Polyglot hashes count the side to move,
castling rights and an en passant square only when a capture is possible, the same as
the app's position keys, so transpositions match.
"""

import hashlib
import io
import logging
import re
from dataclasses import dataclass, field
from datetime import date

import chess
import chess.pgn
import chess.polyglot

from app.core.pgn import RESULTS, parse_pgn_date

MAX_PLY = 40  # positions hashed per game (20 moves): watched positions are opening positions

logging.getLogger("chess.pgn").setLevel(logging.CRITICAL)


def signed64(h: int) -> int:
    """Polyglot hashes are unsigned 64-bit; Postgres bigint is signed."""
    return h - (1 << 64) if h >= (1 << 63) else h


def board_hash(board: chess.Board) -> int:
    return signed64(chess.polyglot.zobrist_hash(board))


def key_hash(key: str) -> int:
    """Hash of a position key (EPD, as app.core.positions.position_key)."""
    return board_hash(chess.Board(f"{key} 0 1"))


@dataclass
class WildGame:
    white: str = ""
    black: str = ""
    white_elo: int | None = None
    black_elo: int | None = None
    event: str = ""
    site: str = ""
    round: str = ""
    played_on: date | None = None
    result: str = "*"
    moves: list[str] = field(default_factory=list)  # UCI, whole game
    hashes: list[int] = field(default_factory=list)  # after ply 1, 2, ... up to MAX_PLY

    @property
    def key(self) -> str:
        """Identifies a game across sources (a broadcast and TWIC often carry the same one)."""
        name = lambda s: re.sub(r"[\W_]", "", s.lower())  # noqa: E731  (ignores spaces, commas, dots)
        raw = "|".join([name(self.white), name(self.black), str(self.played_on or ""), " ".join(self.moves)])
        return hashlib.sha1(raw.encode()).hexdigest()


class _MainLine(chess.pgn.BaseVisitor):
    """Collects headers and main-line moves; skips variations, comments and bad games."""

    def begin_game(self):
        self.headers: dict[str, str] = {}
        self.moves: list[str] = []
        self.error = False

    def visit_header(self, tagname, tagvalue):
        self.headers[tagname] = tagvalue

    def begin_variation(self):
        return chess.pgn.SKIP

    def visit_move(self, board, move):
        self.moves.append(move.uci())

    def handle_error(self, error):
        self.error = True

    def result(self):
        return self


def _clean(value: str | None, size: int) -> str:
    value = (value or "").strip()
    return "" if value in ("?", "-", "??") else value[:size]


def _elo(value: str | None) -> int | None:
    try:
        elo = int((value or "").strip())
    except ValueError:
        return None
    return elo if 0 < elo < 4000 else None


def read_games(text: str) -> tuple[list[WildGame], int]:
    """Finished standard games in a PGN text. Returns (games, skipped): unfinished games
    (result *), games from a set-up position and games with errors are skipped."""
    stream = io.StringIO(text)
    games: list[WildGame] = []
    skipped = 0
    while True:
        try:
            parsed = chess.pgn.read_game(stream, Visitor=_MainLine)
        except Exception:  # unreadable from here on
            break
        if parsed is None:
            break
        h = parsed.headers
        result = h.get("Result", "*")
        variant = h.get("Variant", "Standard").lower()
        if parsed.error or result not in RESULTS or result == "*" or "FEN" in h or variant not in ("standard", "") or not parsed.moves:
            skipped += 1
            continue
        board = chess.Board()
        hashes = []
        try:
            for ply, uci in enumerate(parsed.moves, start=1):
                board.push(chess.Move.from_uci(uci))
                if ply <= MAX_PLY:
                    hashes.append(board_hash(board))
        except ValueError:
            skipped += 1
            continue
        games.append(
            WildGame(
                white=_clean(h.get("White"), 100),
                black=_clean(h.get("Black"), 100),
                white_elo=_elo(h.get("WhiteElo")),
                black_elo=_elo(h.get("BlackElo")),
                event=_clean(h.get("Event"), 200),
                site=_clean(h.get("Site"), 200),
                round=_clean(h.get("Round"), 20),
                played_on=parse_pgn_date(h.get("Date")),
                result=result,
                moves=parsed.moves,
                hashes=hashes,
            )
        )
    return games, skipped
