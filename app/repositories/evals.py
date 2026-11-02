"""Saved engine evaluations of positions (used by the move-by-move review)."""

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.positions import key_from_fen
from app.db.models import PositionEval


def _out(row: PositionEval) -> dict:
    return {
        "depth": row.depth,
        "movetime_ms": row.movetime_ms,
        "lines": row.lines,
        "engine": row.engine,
        "updated_at": row.updated_at,
    }


def lookup(s: Session, fens: list[str], min_movetime_ms: int = 0) -> list[dict | None]:
    """Saved evals for each FEN (same order), or None where there's none good enough."""
    keys = [key_from_fen(f) for f in fens]
    rows = s.scalars(select(PositionEval).where(PositionEval.key.in_(set(keys)))).all()
    by_key = {r.key: r for r in rows if r.movetime_ms >= min_movetime_ms}
    return [_out(by_key[k]) if k in by_key else None for k in keys]


def save(s: Session, items: list[dict]) -> int:
    """Insert or update evals. An existing eval that had more thinking time is kept."""
    saved = 0
    for item in items:
        values = {
            "key": key_from_fen(item["fen"]),
            "movetime_ms": item["movetime_ms"],
            "depth": item["depth"],
            "lines": item["lines"],
            "engine": item["engine"],
        }
        stmt = insert(PositionEval).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[PositionEval.key],
            set_={k: stmt.excluded[k] for k in ("movetime_ms", "depth", "lines", "engine")} | {"updated_at": stmt.excluded.updated_at},
            where=PositionEval.movetime_ms <= stmt.excluded.movetime_ms,
        ).returning(PositionEval.key)
        saved += len(s.execute(stmt).all())
    return saved
