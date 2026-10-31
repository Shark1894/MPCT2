"""Position identity and line walking. Pure python-chess, no database.

Legacy note: the PyQt app keyed positions with ``fen.split(" - ")[0]``, which only
strips the move counters when the en passant field is ``-``. After a double pawn
push the full FEN was stored instead, so transpositions were missed. Here the key
is ``board.epd()``: placement, side to move, castling rights, and an en passant
square only when an en passant capture is actually legal.
"""

from dataclasses import dataclass

import chess


class InvalidPosition(ValueError):
    pass


class InvalidLine(ValueError):
    pass


def position_key(board: chess.Board) -> str:
    return board.epd()


START_KEY = position_key(chess.Board())


def key_from_fen(fen: str) -> str:
    """Position key for a FEN (move counters optional). Raises InvalidPosition."""
    try:
        board = chess.Board(fen.strip())
    except ValueError as exc:
        raise InvalidPosition(f"Invalid FEN: {exc}") from exc
    if not board.is_valid():
        raise InvalidPosition("Invalid FEN: not a legal chess position")
    return position_key(board)


@dataclass(frozen=True)
class LineMove:
    ply: int  # 1 = White's first move
    uci: str
    san: str
    key_before: str
    key_after: str


def walk_line(ucis: list[str]) -> list[LineMove]:
    """Play UCI moves from the initial position, returning SAN and position keys.

    SAN is always generated here from the actual move, never trusted from the client
    (the legacy extension bug stored SAN from the wrong list index).
    Raises InvalidLine for an empty list, malformed UCI or an illegal move.
    """
    if not ucis:
        raise InvalidLine("A line needs at least one move")
    board = chess.Board()
    out: list[LineMove] = []
    for ply, uci in enumerate(ucis, start=1):
        try:
            move = chess.Move.from_uci(uci)
        except ValueError as exc:
            raise InvalidLine(f"Move {ply}: '{uci}' is not a UCI move") from exc
        if move not in board.legal_moves:
            raise InvalidLine(f"Move {ply}: {uci} is illegal in this position")
        before = position_key(board)
        san = board.san(move)
        board.push(move)
        out.append(LineMove(ply, move.uci(), san, before, position_key(board)))
    return out
