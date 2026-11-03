"""Confusable positions: pairs of your-move positions that look almost the same but need
different moves. Pure python-chess, no database.

Two positions are compared square by square: the distance is how many of the 64 squares
hold something different (a piece standing on another square counts twice, its old
square and its new one). A pair is confusable when

  - the same side is to move,
  - at most `max_distance` squares differ,
  - the expected moves differ, and
  - each expected move is also legal in the other position (so it's a real temptation).

The same position with two different moves (distance 0) is left out: no drill can tell
those apart, it's a choice in the repertoire rather than a mix-up. Positions that lie on a common line are never paired: you don't confuse move 5 with
move 6 of the same line. Each board becomes 12 piece bitboards, so a comparison is a few
XORs and a bit count, with the occupancy XOR as a quick filter first.
"""

from dataclasses import dataclass, field

import chess

MAX_DISTANCE = 4  # about two pieces placed differently

_PIECES = [(t, c) for c in (chess.WHITE, chess.BLACK) for t in chess.PIECE_TYPES]


@dataclass
class Decision:
    """A position where you're to move, and the move your repertoire plays there."""

    key: str  # position key (EPD), as app.core.positions.position_key
    uci: str
    lines: frozenset[int] = field(default_factory=frozenset)  # lines passing through it
    board: chess.Board = field(init=False, repr=False)
    masks: tuple[int, ...] = field(init=False, repr=False)
    occupied: int = field(init=False, repr=False)

    def __post_init__(self):
        self.board = chess.Board(f"{self.key} 0 1")
        self.masks = tuple(self.board.pieces_mask(t, c) for t, c in _PIECES)
        self.occupied = self.board.occupied


@dataclass(frozen=True)
class Pair:
    a: int  # indexes into the decisions list
    b: int
    distance: int
    diff_mask: int  # squares that differ


def diff_mask(a: Decision, b: Decision) -> int:
    mask = 0
    for ma, mb in zip(a.masks, b.masks):
        mask |= ma ^ mb
    return mask


def _legal(board: chess.Board, uci: str) -> bool:
    try:
        return board.is_legal(chess.Move.from_uci(uci))
    except ValueError:
        return False


def find_pairs(decisions: list[Decision], max_distance: int = MAX_DISTANCE) -> list[Pair]:
    """Every confusable pair among the decisions, closest first."""
    found = []
    n = len(decisions)
    for i in range(n):
        a = decisions[i]
        turn = a.board.turn
        for j in range(i + 1, n):
            b = decisions[j]
            if (a.occupied ^ b.occupied).bit_count() > max_distance:  # cheap filter
                continue
            if b.board.turn != turn or a.uci == b.uci or a.lines & b.lines:
                continue
            mask = diff_mask(a, b)
            distance = mask.bit_count()
            if distance == 0 or distance > max_distance:
                continue
            if not (_legal(a.board, b.uci) and _legal(b.board, a.uci)):
                continue
            found.append(Pair(i, j, distance, mask))
    found.sort(key=lambda p: (p.distance, p.a, p.b))
    return found


def _describe(board: chess.Board, square: int) -> str | None:
    piece = board.piece_at(square)
    if piece is None:
        return None
    return f"{'white' if piece.color else 'black'} {chess.piece_name(piece.piece_type)}"


def differences(a: Decision, b: Decision, mask: int | None = None) -> list[dict]:
    """The squares that differ, with what stands there in each position (None = empty)."""
    mask = diff_mask(a, b) if mask is None else mask
    return [
        {"square": chess.square_name(sq), "a": _describe(a.board, sq), "b": _describe(b.board, sq)}
        for sq in chess.scan_forward(mask)
    ]
