"""Practical tab: moves that take the opponent into sharp territory, even at an engine cost.

The server's part is small: the positions in an opening (or one branch of it) where it's your
move, and a cache of the engine lines the browser works out. The engine and the measures run in
the browser (web/js/practical-core.js).
"""

import chess
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.positions import key_from_fen
from app.db.models import Line, Move, Opening, Position, PracticalEval, PracticalSeen
from app.repositories.repertoire import NotFound
from app.repositories.tags import tag_in_opening

POSITIONS_MAX = 400


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
    return {"opening_id": opening.id, "opening": opening.name, "color": opening.color, "tag_id": tag_id, "positions": ordered}


# ---- engine lines --------------------------------------------------------------------------------


def evals_lookup(s: Session, fens: list[str], multipv: int, movetime_ms: int = 0, depth: int = 0) -> list[dict | None]:
    """Saved lines for each FEN (same order) with at least this many lines, this much time and
    this depth."""
    keys = [key_from_fen(f) for f in fens]
    rows = s.scalars(select(PracticalEval).where(PracticalEval.key.in_(set(keys)))).all()
    good = {r.key: r for r in rows if r.multipv >= multipv and r.movetime_ms >= movetime_ms and r.depth >= depth}
    return [
        {"multipv": good[k].multipv, "movetime_ms": good[k].movetime_ms, "depth": good[k].depth, "lines": good[k].lines}
        if k in good else None
        for k in keys
    ]


def evals_save(s: Session, items: list[dict]) -> int:
    """Save lines. They replace saved ones only with at least as many lines and as deep a search."""
    saved = 0
    for item in items:
        values = {"key": key_from_fen(item["fen"]), **{k: item[k] for k in ("multipv", "movetime_ms", "depth", "lines", "engine")}}
        stmt = insert(PracticalEval).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[PracticalEval.key],
            set_={k: stmt.excluded[k] for k in ("multipv", "movetime_ms", "depth", "lines", "engine")} | {"updated_at": stmt.excluded.updated_at},
            where=(PracticalEval.multipv <= stmt.excluded.multipv) & (PracticalEval.depth <= stmt.excluded.depth),
        ).returning(PracticalEval.key)
        saved += len(s.execute(stmt).all())
    return saved


# ---- moves looked at ---------------------------------------------------------------------------


def seen(s: Session, keys: list[str]) -> list[dict]:
    """The moves looked at in these positions."""
    if not keys:
        return []
    rows = s.scalars(select(PracticalSeen).where(PracticalSeen.key.in_(set(keys))))
    return [{"key": r.key, "uci": r.uci, "seen_at": r.seen_at} for r in rows]


def mark_seen(s: Session, key: str, uci: str) -> dict:
    stmt = insert(PracticalSeen).values(key=key, uci=uci).on_conflict_do_nothing()
    s.execute(stmt)
    s.flush()
    row = s.get(PracticalSeen, (key, uci))
    return {"key": row.key, "uci": row.uci, "seen_at": row.seen_at}


def unmark_seen(s: Session, key: str, uci: str) -> None:
    row = s.get(PracticalSeen, (key, uci))
    if row is not None:
        s.delete(row)
        s.flush()
