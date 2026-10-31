"""PGN reading and writing for games. Pure python-chess, no database.

Only the main line is kept: variations and comments are dropped on import.
"""

import io
import logging
from dataclasses import dataclass, field
from datetime import date

import chess
import chess.pgn

RESULTS = ("1-0", "0-1", "1/2-1/2", "*")

# python-chess logs each PGN error itself; we report them to the user instead.
logging.getLogger("chess.pgn").setLevel(logging.CRITICAL)


@dataclass
class ParsedGame:
    white: str = ""
    black: str = ""
    white_team: str = ""
    black_team: str = ""
    competition: str = ""
    played_on: date | None = None
    result: str = "*"
    start_fen: str | None = None
    moves: list[str] = field(default_factory=list)  # UCI


def _header(value: str | None) -> str:
    value = (value or "").strip()
    return "" if value in ("?", "-") else value


def parse_pgn_date(value: str | None) -> date | None:
    """PGN dates are YYYY.MM.DD with '??' for unknown parts; only full dates are kept."""
    try:
        y, m, d = (value or "").strip().split(".")
        return date(int(y), int(m), int(d))
    except ValueError:
        return None


def parse_pgn(text: str) -> tuple[list[ParsedGame], list[str]]:
    """Parse every game in a PGN text. Returns (games, errors)."""
    games, errors = [], []
    stream = io.StringIO(text)
    number = 0
    while True:
        try:
            game = chess.pgn.read_game(stream)
        except Exception as exc:  # malformed PGN
            errors.append(f"Game {number + 1}: could not be read ({exc})")
            break
        if game is None:
            break
        number += 1
        h = game.headers
        if game.errors:
            errors.append(f"Game {number} ({_header(h.get('White')) or '?'} v {_header(h.get('Black')) or '?'}): {game.errors[0]}")
            continue
        start_fen = h.get("FEN") if h.get("SetUp") == "1" or "FEN" in h else None
        result = h.get("Result", "*")
        games.append(
            ParsedGame(
                white=_header(h.get("White"))[:100],
                black=_header(h.get("Black"))[:100],
                white_team=_header(h.get("WhiteTeam"))[:100],
                black_team=_header(h.get("BlackTeam"))[:100],
                competition=_header(h.get("Event"))[:150],
                played_on=parse_pgn_date(h.get("Date")),
                result=result if result in RESULTS else "*",
                start_fen=start_fen if start_fen and start_fen != chess.STARTING_FEN else None,
                moves=[m.uci() for m in game.mainline_moves()],
            )
        )
    return games, errors


def to_pgn(
    *,
    white: str,
    black: str,
    white_team: str,
    black_team: str,
    competition: str,
    played_on: date | None,
    result: str,
    start_fen: str | None,
    moves: list[str],
) -> str:
    game = chess.pgn.Game()
    game.headers["Event"] = competition or "?"
    game.headers["Site"] = "?"
    game.headers["Date"] = played_on.strftime("%Y.%m.%d") if played_on else "????.??.??"
    game.headers["Round"] = "?"
    game.headers["White"] = white or "?"
    game.headers["Black"] = black or "?"
    game.headers["Result"] = result
    if white_team:
        game.headers["WhiteTeam"] = white_team
    if black_team:
        game.headers["BlackTeam"] = black_team
    if start_fen:
        game.setup(chess.Board(start_fen))
    node = game
    for uci in moves:
        node = node.add_variation(chess.Move.from_uci(uci))
    exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
    return game.accept(exporter) + "\n"
