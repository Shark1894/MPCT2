"""Endgame drills: the drills, and positions for K+P v K that are worth practising.

Mating drills (queen, rook, two bishops, bishop and knight) are generated in the browser: any
legal placement is a win. K+P v K is different: most random positions are either trivially won
or dead drawn, so candidates are made here (realistic: the kings near the pawn) and checked in
the tablebase, keeping those that are won but have at most two winning moves (you need the
opposition or the key squares)."""

import random

import chess

DRILLS = ("kq", "kr", "kbb", "kbn", "kp", "lucena", "philidor", "vancura", "qvp", "qvr", "rvb", "wrongb", "reti")
# Drills whose positions come from here (the mates are made in the browser).
SERVER_DRILLS = ("kp", "lucena", "philidor", "vancura", "qvp", "qvr", "rvb", "wrongb", "reti")
# Defend drills: you hold a draw (the rest are wins).
DEFEND = ("philidor", "vancura", "rvb", "wrongb", "reti")
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


# ---- named endgames: random variations of a pattern, checked in the tablebase -------------------
#
# Each template builds the pattern with the side to train as White, on files and squares picked at
# random, then the position is mirrored left-right and/or colour-for-colour at random. The
# tablebase must agree it's the expected result (a win, or a draw for the defend drills) and that
# some of your moves throw it away, so the idea has to be known.

W, B = chess.WHITE, chess.BLACK
K, Q, R, Bp, N, P = chess.KING, chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN


def _board(pieces: dict, turn: chess.Color = W) -> chess.Board | None:
    """pieces: {square: (piece_type, colour)}; None if two share a square or it's illegal."""
    board = chess.Board(None)
    for sq, (pt, colour) in pieces.items():
        if board.piece_at(sq) is not None:
            return None
        board.set_piece_at(sq, chess.Piece(pt, colour))
    board.turn = turn
    if not board.is_valid() or board.is_game_over():
        return None
    return board


def _sq(f: int, r: int) -> int | None:
    return chess.square(f, r) if 0 <= f < 8 and 0 <= r < 8 else None


def _free(*squares) -> bool:
    return all(s is not None for s in squares) and len(set(squares)) == len(squares)


def _lucena(rng):
    # Pawn on the 7th, your king on its queening square, their king cut off by your rook two files
    # away, their rook checking from the other side. Win by building a bridge.
    f = rng.randrange(1, 7)  # b..g
    side = rng.choice((-1, 1))
    k, pawn = _sq(f, 7), _sq(f, 6)
    dk = _sq(f + 2 * side, rng.randrange(4, 7))
    cut = _sq(f + side, rng.randrange(0, 4))
    their_r = _sq(f - side, rng.randrange(0, 3)) if 0 <= f - side < 8 else None
    if their_r is None:
        their_r = _sq(rng.randrange(0, 8), rng.randrange(0, 2))
    if not _free(k, pawn, dk, cut, their_r):
        return None
    return _board({k: (K, W), pawn: (P, W), cut: (R, W), dk: (K, B), their_r: (R, B)})


def _philidor(rng):
    # You defend (White here): king on the queening square, rook on the third rank; their pawn and
    # king on your fourth rank (their fifth), their rook on your second rank (their seventh).
    f = rng.randrange(1, 7)
    pawn = _sq(f, 3)
    ak = _sq(f + rng.choice((-1, 1)), 3)
    ar = _sq(rng.randrange(0, 8), 1)
    k = _sq(f + rng.choice((-1, 0, 0, 1)), 0)
    r = _sq(rng.randrange(0, 8), 2)
    if not _free(pawn, ak, ar, k, r):
        return None
    return _board({k: (K, W), r: (R, W), pawn: (P, B), ak: (K, B), ar: (R, B)})


def _vancura(rng):
    # You defend (White): their rook pawn on your 3rd rank (their 6th) with their rook in front of
    # it; your king far on the other wing; your rook on the third rank attacking the pawn from the side.
    edge = rng.choice((0, 7))
    away = 1 if edge == 0 else -1
    pawn = _sq(edge, 2)
    ar = _sq(edge, 0)
    ak = _sq(edge + away * rng.randrange(4, 7), rng.randrange(3, 8))
    k = _sq(edge + away * rng.randrange(5, 8), rng.randrange(0, 2))
    r = _sq(edge + away * rng.randrange(2, 6), 2)
    if not _free(pawn, ar, ak, k, r):
        return None
    return _board({k: (K, W), r: (R, W), pawn: (P, B), ar: (R, B), ak: (K, B)})


def _qvp(rng):
    # Their pawn on its 7th rank (a centre or knight pawn: a win), their king beside it; your queen
    # somewhere, your king far away.
    f = rng.choice((1, 3, 4, 6))
    pawn = _sq(f, 1)
    dk = _sq(f + rng.choice((-1, 1)), rng.choice((0, 1, 2)))
    q = _sq(rng.randrange(0, 8), rng.randrange(3, 8))
    k = _sq(rng.randrange(0, 8), rng.randrange(5, 8))
    if not _free(pawn, dk, q, k) or chess.square_distance(k, pawn) < 4:
        return None
    return _board({k: (K, W), q: (Q, W), pawn: (P, B), dk: (K, B)})


def _qvr(rng):
    # Their rook beside its king (the hardest defence), your king and queen anywhere sensible.
    dk = _sq(rng.randrange(0, 8), rng.randrange(4, 8))
    nbrs = [s for s in chess.SQUARES if chess.square_distance(s, dk) == 1]
    r = rng.choice(nbrs)
    k = _sq(rng.randrange(0, 8), rng.randrange(0, 5))
    q = _sq(rng.randrange(0, 8), rng.randrange(0, 8))
    if not _free(dk, r, k, q) or chess.square_distance(k, dk) < 3:
        return None
    return _board({k: (K, W), q: (Q, W), dk: (K, B), r: (R, B)})


def _rvb(rng):
    # You defend with the bishop (White): your king near a corner, their king and rook close by.
    corner = rng.choice((0, 7, 56, 63))
    cf, cr = chess.square_file(corner), chess.square_rank(corner)
    k = _sq(abs(cf - rng.randrange(0, 2)), abs(cr - rng.randrange(0, 2)))
    b = _sq(rng.randrange(0, 8), rng.randrange(0, 8))
    ak = _sq(abs(cf - rng.randrange(2, 4)), abs(cr - rng.randrange(1, 4)))
    ar = _sq(rng.randrange(0, 8), rng.randrange(0, 8))
    if not _free(k, b, ak, ar):
        return None
    return _board({k: (K, W), b: (Bp, W), ak: (K, B), ar: (R, B)})


def _wrongb(rng):
    # You have only a king (White here): their rook pawn and a bishop that can't control its queening
    # square; get to (or stay in) the corner.
    edge = rng.choice((0, 7))
    queen_sq = _sq(edge, 0)  # Black's pawn queens on rank 1
    pawn = _sq(edge, rng.randrange(2, 5))
    wrong = not chess.BB_LIGHT_SQUARES & chess.BB_SQUARES[queen_sq]  # the bishop's colour: not the corner's
    bsq = [s for s in chess.SQUARES if bool(chess.BB_LIGHT_SQUARES & chess.BB_SQUARES[s]) == wrong and chess.square_rank(s) >= 2]
    b = rng.choice(bsq)
    ak = _sq(rng.randrange(1, 7), rng.randrange(2, 6))
    k = _sq(abs(edge - rng.randrange(0, 4)), rng.randrange(0, 3))
    if not _free(pawn, b, ak, k) or chess.square_distance(ak, k) < 2:
        return None
    return _board({k: (K, W), pawn: (P, B), b: (Bp, B), ak: (K, B)})


RETI = chess.Board("7K/8/k1P5/7p/8/8/8/8 w - - 0 1")


def _reti(rng):
    # Réti's study (White to move draws) and its mirror images.
    return RETI.copy()


TEMPLATES = {"lucena": _lucena, "philidor": _philidor, "vancura": _vancura, "qvp": _qvp, "qvr": _qvr,
             "rvb": _rvb, "wrongb": _wrongb, "reti": _reti}


def _orient(board: chess.Board, rng) -> tuple[chess.Board, chess.Color]:
    """Mirror at random: left-right, and colours (the trained side then plays Black)."""
    if rng.random() < 0.5:
        board = board.transform(chess.flip_horizontal)
    colour = board.turn
    if rng.random() < 0.5:
        board = board.mirror()
        colour = not colour
    return board, colour


def good_start(drill: str, info: dict) -> bool:
    """The tablebase agrees: a win (or a draw for defend drills), and some of your moves spoil it."""
    moves = info.get("moves") or []
    if drill in DEFEND:
        losing = [m for m in moves if m.get("category") in ("win", "cursed-win")]  # the opponent's, after the move
        return info.get("category") == "draw" and len(losing) >= (1 if drill in ("reti", "wrongb") else 2)
    spoiling = [m for m in moves if m.get("category") not in ("loss",)]
    if info.get("category") != "win" or not spoiling:
        return False
    if drill == "qvr":  # no instant rook win (a fork or skewer on move one)
        return not any(m.get("category") == "loss" and "x" in (m.get("san") or "") for m in moves[:1])
    return True


def generate(drill: str, lookup, rng: random.Random | None = None, tries: int = 60) -> dict | None:
    """A starting position for a server-made drill: {fen, color, tries} or None if none found."""
    rng = rng or random.Random()
    if drill == "kp":
        return generate_kp(lookup, rng)
    template = TEMPLATES[drill]
    for n in range(1, tries + 1):
        board = template(rng)
        if board is None:
            continue
        board, colour = _orient(board, rng)
        if not board.is_valid() or board.is_check() or board.is_game_over():
            continue
        if good_start(drill, lookup(board.fen())):
            return {"fen": board.fen(), "color": "white" if colour else "black", "tries": n}
    return None
