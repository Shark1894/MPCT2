"""Endgame drills: the drills, and positions for K+P v K that are worth practising.

Mating drills (queen, rook, two bishops, bishop and knight) are generated in the browser: any
legal placement is a win. K+P v K is different: most random positions are either trivially won
or dead drawn, so candidates are made here (realistic: the kings near the pawn) and checked in
the tablebase, keeping those that are won but have at most two winning moves (you need the
opposition or the key squares)."""

import random

import chess

DRILLS = ("kq", "kr", "kbb", "kbn", "kp")
WINNING = ("loss",)  # a move's category is the opponent's after it: their loss = our win
MAX_WINNING_MOVES = 2
MIN_MOVES = 4


def _dist(a: int, b: int) -> int:
    return chess.square_distance(a, b)


def kp_candidate(rng: random.Random, color: chess.Color) -> chess.Board | None:
    """A random K+P v K position with `color` (the pawn's side) to move, or None if the draw
    wasn't legal. From White's view: pawn on ranks 2-6, your king within two squares of the
    pawn, the defending king within three squares of the pawn's path to promotion."""
    file = rng.randrange(8)
    rank = rng.randrange(1, 6)  # rank index 1..5 = ranks 2..6
    pawn = chess.square(file, rank)
    mine = [s for s in chess.SQUARES if 0 < _dist(s, pawn) <= 2]
    path = [chess.square(file, r) for r in range(rank + 1, 8)]
    theirs = [s for s in chess.SQUARES if s != pawn and min(_dist(s, p) for p in path) <= 3]
    k = rng.choice(mine)
    d = rng.choice(theirs)
    if d in (k, pawn) or _dist(k, d) <= 1:
        return None
    board = chess.Board(None)
    board.set_piece_at(pawn, chess.Piece(chess.PAWN, chess.WHITE))
    board.set_piece_at(k, chess.Piece(chess.KING, chess.WHITE))
    board.set_piece_at(d, chess.Piece(chess.KING, chess.BLACK))
    board.turn = chess.WHITE
    if color == chess.BLACK:
        board = board.mirror()  # Black's pawn, Black to move
    if not board.is_valid() or board.is_check() or board.is_game_over():
        return None
    return board


def tricky_win(info: dict) -> int | None:
    """The number of winning moves if the position is a win worth practising, else None."""
    if info.get("category") != "win":
        return None
    moves = info.get("moves") or []
    winning = [m for m in moves if m.get("category") in WINNING]
    if len(moves) < MIN_MOVES or not winning or len(winning) > MAX_WINNING_MOVES:
        return None
    return len(winning)


def generate_kp(lookup, rng: random.Random | None = None, tries: int = 40) -> dict | None:
    """Find a tricky K+P v K win. lookup(fen) -> tablebase info. Returns {fen, color,
    winning_moves, tries} or None if none was found in `tries` candidates."""
    rng = rng or random.Random()
    for n in range(1, tries + 1):
        color = rng.choice((chess.WHITE, chess.BLACK))
        board = kp_candidate(rng, color)
        if board is None:
            continue
        count = tricky_win(lookup(board.fen()))
        if count:
            return {"fen": board.fen(), "color": "white" if color else "black", "winning_moves": count, "tries": n}
    return None
