"""Fake Lichess tablebase for e2e tests (no internet in the build sandbox): GET /standard?fen=...
answers in the real format, from simple rules rather than real tablebases.

- The side with material is winning; the lone king is losing. Only kings, stalemate, or a piece
  the lone king can take (leaving too little to mate) = draw.
- Moves are listed best first: for the winning side, mates first, then moves that leave the lone
  king fewest moves; for the defender, captures first, then staying central.
- K+P v K: only pawn pushes win (so every candidate counts as "tricky").
- dtm is a rough guess. GET /log lists the FENs asked for.
Usage: python tests/e2e/fake_tablebase.py [port]   (default 8098)
"""

import json
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

import chess

LOG = []


VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}


def material(board, color):
    return [p for p in board.piece_map().values() if p.color == color and p.piece_type != chess.KING]


def value(board, color):
    return sum(VALUE[p.piece_type] for p in material(board, color))


def strong_side(board):
    """The winning side: the only one with material, or two points or more ahead; else None."""
    w, b = material(board, chess.WHITE), material(board, chess.BLACK)
    if w and not b:
        return chess.WHITE
    if b and not w:
        return chess.BLACK
    diff = value(board, chess.WHITE) - value(board, chess.BLACK)
    return chess.WHITE if diff >= 2 else chess.BLACK if diff <= -2 else None


def capture_result(board):
    """Best the side to move gets by taking something now: 'win', 'draw' or None (no capture helps)."""
    best = None
    for m in board.legal_moves:
        if not board.is_capture(m):
            continue
        board.push(m)
        if board.is_insufficient_material():
            out = "draw"
        else:
            strong = strong_side(board)
            out = "win" if strong == (not board.turn) else "draw" if strong is None else None
        board.pop()
        if out == "win":
            return "win"
        best = best or out
    return best


def category(board):
    """From the side to move's view."""
    if board.is_checkmate():
        return "loss"
    if board.is_stalemate() or board.is_insufficient_material():
        return "draw"
    grab = capture_result(board)
    strong = strong_side(board)
    if strong is None:
        return "win" if grab == "win" else "draw"
    if board.turn != strong:
        return grab or "loss"
    return "win"


def centre(sq):
    f, r = chess.square_file(sq), chess.square_rank(sq)
    return min(f, 7 - f) + min(r, 7 - r)


def move_category(board, move):
    board.push(move)
    cat = category(board)
    mate, stale = board.is_checkmate(), board.is_stalemate()
    insufficient = board.is_insufficient_material()
    replies = board.legal_moves.count()
    king = board.king(board.turn)
    board.pop()
    return cat, mate, stale, insufficient, replies, king


def answer(fen):
    board = chess.Board(fen)
    strong = strong_side(board)
    moves = []
    pawn_game = strong is not None and bool(board.pieces(chess.PAWN, strong)) and len(board.piece_map()) == 3
    for m in board.legal_moves:
        cat, mate, stale, insufficient, replies, king = move_category(board, m)
        if pawn_game and board.turn == strong:
            push = board.piece_type_at(m.from_square) == chess.PAWN
            cat = "loss" if push else "draw"
        moves.append({
            "uci": m.uci(), "san": board.san(m), "category": cat, "dtz": None, "dtm": None, "zeroing": board.is_zeroing(m),
            "checkmate": mate, "stalemate": stale, "insufficient_material": insufficient, "_replies": replies,
            "_capture": board.is_capture(m), "_centre": centre(king) if king is not None else 0,
        })
    if board.turn == strong:
        moves.sort(key=lambda x: (not x["checkmate"], x["category"] != "loss", x["_replies"]))
    else:
        moves.sort(key=lambda x: (not x["_capture"], -x["_centre"], -x["_replies"]))
    for x in moves:
        for k in ("_replies", "_capture", "_centre"):
            x.pop(k)
    cat = category(board)
    king = board.king(not board.turn if strong == board.turn else board.turn)
    guess = 2 * (8 + centre(king)) + (1 if cat == "win" else 0) if cat in ("win", "loss") and not board.is_checkmate() else 0
    return {
        "category": cat, "dtz": None, "precise_dtz": None, "dtm": (guess if cat == "win" else -guess) if guess else None,
        "checkmate": board.is_checkmate(), "stalemate": board.is_stalemate(), "variant_win": False, "variant_loss": False,
        "insufficient_material": board.is_insufficient_material(), "moves": moves,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/log":
            return self._send(200, LOG)
        if url.path != "/standard":
            return self._send(404, {"error": "not found"})
        fen = urllib.parse.parse_qs(url.query).get("fen", [""])[0].replace("_", " ")
        LOG.append(fen)
        try:
            return self._send(200, answer(fen))
        except ValueError as exc:
            return self._send(400, {"error": str(exc)})

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8098), Handler).serve_forever()
