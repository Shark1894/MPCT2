"""Practical tab: moves that put a human opponent under pressure, even at an engine cost.

The server's part is small: the positions in an opening (or one branch of it) where it's your
move, how players rated 2000+ on Lichess play from a position (the Lichess opening explorer,
looked up with LICHESS_TOKEN, one request at a time, cached), and a cache of the engine lines
the browser works out. The engine and the scoring run in the browser (web/js/practical-core.js).
"""

import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

import chess
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import explorer
from app.config import settings
from app.core.positions import key_from_fen
from app.db.models import ExplorerCache, Line, Move, Opening, Position, PracticalEval
from app.repositories.repertoire import NotFound
from app.repositories.tags import tag_in_opening

SOURCE = "lichess"  # explorer_cache.source for Lichess games at settings.practical_ratings
POSITIONS_MAX = 400
PAUSE_S = 1.0  # between explorer requests, as Lichess asks

_lock = threading.Lock()
_last = [0.0]


class NoToken(explorer.ExplorerError):
    pass


# ---- positions -------------------------------------------------------------------------------


def positions(s: Session, opening_id: int, tag_id: int | None = None) -> dict:
    """Your-move positions in the opening's lines, from the branch tag's position on (or from the
    start), in the order the lines reach them; transpositions once. Each with the moves to it
    (SAN) and the move(s) your repertoire plays there."""
    opening = s.get(Opening, opening_id)
    if opening is None:
        raise NotFound(f"Opening {opening_id} not found")
    me = chess.WHITE if opening.color == "white" else chess.BLACK
    root_key = None
    if tag_id is not None:
        tag = tag_in_opening(s, opening_id, tag_id)
        root_key = s.scalar(select(Position.key).where(Position.id == tag.position_id))
    rows = s.execute(
        select(Move.line_id, Move.uci).join(Line, Line.id == Move.line_id).where(Line.opening_id == opening_id).order_by(Move.line_id, Move.ply)
    ).all()
    lines: dict[int, list[str]] = {}
    for line_id, uci in rows:
        lines.setdefault(line_id, []).append(uci)
    found: dict[str, dict] = {}
    for ucis in lines.values():
        board = chess.Board()
        sans: list[str] = []
        started = root_key is None
        for uci in ucis:
            if not started and board.epd() == root_key:
                started = True
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                break
            if started and board.turn == me:
                key = board.epd()
                p = found.get(key)
                if p is None:
                    if len(found) >= POSITIONS_MAX:
                        break
                    p = found[key] = {"key": key, "fen": board.fen(), "sans": list(sans), "ply": len(sans), "repertoire": []}
                if uci not in p["repertoire"]:
                    p["repertoire"].append(uci)
            sans.append(board.san(move))
            board.push(move)
    ordered = sorted(found.values(), key=lambda p: p["ply"])  # stable: first reached first
    return {"opening_id": opening.id, "opening": opening.name, "color": opening.color, "tag_id": tag_id,
            "ratings": settings.practical_ratings, "positions": ordered}


# ---- the Lichess explorer at 2000+ -------------------------------------------------------------


def _fresh_since() -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=settings.explorer_cache_days)


def _source() -> str:
    """Cache source per rating bands, so changing PRACTICAL_RATINGS doesn't reuse other answers."""
    return f"{SOURCE}{settings.practical_ratings.split(',')[0]}"[:10]


def _url(key: str) -> str:
    q = urllib.parse.urlencode({"variant": "standard", "fen": f"{key} 0 1", "ratings": settings.practical_ratings,
                                "moves": 30, "topGames": 0, "recentGames": 0})
    return f"{settings.lichess_explorer_url.rstrip('/')}/lichess?{q}"


def _slim(data: dict) -> dict:
    return {
        "white": int(data.get("white", 0)),
        "draws": int(data.get("draws", 0)),
        "black": int(data.get("black", 0)),
        "moves": [{k: m.get(k) for k in ("uci", "san", "white", "draws", "black")} for m in data.get("moves", [])],
    }


def lookup(s: Session, fen: str, get=None) -> dict:
    """How players at the practical ratings continue from a position: totals and moves. Looked up
    on Lichess the first time (one request a second), then cached. Raises NoToken, ExplorerError."""
    key = key_from_fen(fen)
    source = _source()
    data = s.scalar(select(ExplorerCache.data).where(
        ExplorerCache.key == key, ExplorerCache.source == source, ExplorerCache.fetched_at >= _fresh_since()))
    if data is None:
        if not explorer.token_set():
            raise NoToken("The Practical tab needs a Lichess API token: add LICHESS_TOKEN to the server's .env and restart the app.")
        with _lock:
            wait = PAUSE_S - (time.monotonic() - _last[0])
            if wait > 0:
                time.sleep(wait)
            try:
                raw = (get or explorer.http_get)(_url(key), timeout=20, wait=False)
            finally:
                _last[0] = time.monotonic()
        data = _slim(raw)
        stmt = insert(ExplorerCache).values(key=key, source=source, data=data)
        s.execute(stmt.on_conflict_do_update(index_elements=["key", "source"],
                                             set_={"data": data, "fetched_at": stmt.excluded.fetched_at}))
        s.flush()
    return {"key": key, **data}


# ---- engine lines --------------------------------------------------------------------------------


def evals_lookup(s: Session, fens: list[str], multipv: int, movetime_ms: int) -> list[dict | None]:
    """Saved lines for each FEN (same order) with at least this many lines and this much time."""
    keys = [key_from_fen(f) for f in fens]
    rows = s.scalars(select(PracticalEval).where(PracticalEval.key.in_(set(keys)))).all()
    good = {r.key: r for r in rows if r.multipv >= multipv and r.movetime_ms >= movetime_ms}
    return [
        {"multipv": good[k].multipv, "movetime_ms": good[k].movetime_ms, "depth": good[k].depth, "lines": good[k].lines}
        if k in good else None
        for k in keys
    ]


def evals_save(s: Session, items: list[dict]) -> int:
    """Save lines. They replace saved ones only with at least as many lines and as much time."""
    saved = 0
    for item in items:
        values = {"key": key_from_fen(item["fen"]), **{k: item[k] for k in ("multipv", "movetime_ms", "depth", "lines", "engine")}}
        stmt = insert(PracticalEval).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[PracticalEval.key],
            set_={k: stmt.excluded[k] for k in ("multipv", "movetime_ms", "depth", "lines", "engine")} | {"updated_at": stmt.excluded.updated_at},
            where=(PracticalEval.multipv <= stmt.excluded.multipv) & (PracticalEval.movetime_ms <= stmt.excluded.movetime_ms),
        ).returning(PracticalEval.key)
        saved += len(s.execute(stmt).all())
    return saved
