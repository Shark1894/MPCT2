"""Lookups in the Lichess tablebase (perfect play for positions with up to 7 pieces), for the
endgame drills. A small in-memory cache keeps repeat lookups free; failures raise
TablebaseUnavailable quickly (short timeout, no waiting on 429) so a drill can fall back to
Stockfish instead of hanging."""

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict

import chess

from app import __version__
from app.config import settings

USER_AGENT = f"MPCT/{__version__} (personal chess training app)"
TIMEOUT = 8
CACHE_SIZE = 20_000
MOVE_KEYS = ("uci", "san", "category", "dtz", "dtm", "checkmate", "stalemate", "zeroing", "insufficient_material")

_cache: "OrderedDict[str, dict]" = OrderedDict()
_lock = threading.Lock()


class TablebaseUnavailable(Exception):
    pass


class NotInTablebase(ValueError):
    pass


def _fetch(fen: str) -> dict:
    url = f"{settings.lichess_tablebase_url.rstrip('/')}/standard?{urllib.parse.urlencode({'fen': fen})}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as exc:
        raise TablebaseUnavailable(f"The tablebase answered HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise TablebaseUnavailable(f"The tablebase can't be reached ({exc})") from exc


def _slim(data: dict) -> dict:
    return {
        "category": data.get("category"),
        "dtz": data.get("dtz"),
        "dtm": data.get("dtm"),
        "checkmate": bool(data.get("checkmate")),
        "stalemate": bool(data.get("stalemate")),
        "insufficient_material": bool(data.get("insufficient_material")),
        "moves": [{k: m.get(k) for k in MOVE_KEYS} for m in data.get("moves") or []],
    }


def lookup(fen: str, fetch=None) -> dict:
    """The tablebase's answer for a position (side to move's view): category win / draw / loss
    (or cursed-win, blessed-loss... with the 50-move rule), dtz, dtm (plies, may be null) and
    every legal move, best first for the side to move (each move's category is the opponent's)."""
    try:
        board = chess.Board(fen)
    except ValueError as exc:
        raise NotInTablebase(f"Not a valid FEN: {exc}") from exc
    if len(board.piece_map()) > 7:
        raise NotInTablebase("The tablebase covers positions with up to 7 pieces")
    if not board.is_valid():
        raise NotInTablebase("Not a legal position")
    key = board.fen()
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    info = _slim((fetch or _fetch)(key))
    with _lock:
        _cache[key] = info
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return info


def clear_cache() -> None:
    with _lock:
        _cache.clear()
