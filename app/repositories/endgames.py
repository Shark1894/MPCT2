"""Endgame drill attempts and their stats (per drill)."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.endgames import DRILLS
from app.db.models import EndgameAttempt

SUCCESS = ("mate", "promoted")
FAILURE = ("fifty", "stalemate", "material", "repetition", "thrown", "gave-up")
RECENT = 10


class InvalidAttempt(ValueError):
    pass


def record(s: Session, drill: str, start_fen: str, color: str, result: str, moves: int, optimal: int | None,
           hints: int, seconds: float) -> dict:
    if drill not in DRILLS:
        raise InvalidAttempt(f"Unknown drill {drill!r}")
    if result not in SUCCESS + FAILURE:
        raise InvalidAttempt(f"Unknown result {result!r}")
    a = EndgameAttempt(drill=drill, start_fen=start_fen, color=color, success=result in SUCCESS, result=result,
                       moves=moves, optimal=optimal, hints=hints, seconds=round(min(max(seconds, 0), 86400), 1))
    s.add(a)
    s.flush()
    s.refresh(a)
    return _row(a)


def _row(a: EndgameAttempt) -> dict:
    return {"id": a.id, "drill": a.drill, "start_fen": a.start_fen, "color": a.color, "success": a.success,
            "result": a.result, "moves": a.moves, "optimal": a.optimal, "hints": a.hints, "seconds": a.seconds,
            "finished_at": a.finished_at}


def stats(s: Session) -> dict:
    """Per drill: attempts, successes, best and average moves on a success (and the perfect number
    for those), average time, and the latest attempts."""
    out = {d: {"attempts": 0, "successes": 0, "best_moves": None, "avg_moves": None, "avg_optimal": None,
               "avg_seconds": None, "recent": []} for d in DRILLS}
    for drill, n, ok, secs in s.execute(
        select(EndgameAttempt.drill, func.count(), func.count().filter(EndgameAttempt.success), func.avg(EndgameAttempt.seconds))
        .group_by(EndgameAttempt.drill)
    ):
        if drill in out:
            out[drill].update(attempts=n, successes=ok, avg_seconds=round(float(secs), 1) if secs is not None else None)
    for drill, best, avg, opt in s.execute(
        select(EndgameAttempt.drill, func.min(EndgameAttempt.moves), func.avg(EndgameAttempt.moves), func.avg(EndgameAttempt.optimal))
        .where(EndgameAttempt.success)
        .group_by(EndgameAttempt.drill)
    ):
        if drill in out:
            out[drill].update(best_moves=best, avg_moves=round(float(avg), 1),
                              avg_optimal=round(float(opt), 1) if opt is not None else None)
    ranked = (
        select(EndgameAttempt, func.row_number().over(partition_by=EndgameAttempt.drill, order_by=EndgameAttempt.id.desc()).label("n"))
        .subquery()
    )
    rows = s.execute(select(EndgameAttempt).join(ranked, ranked.c.id == EndgameAttempt.id).where(ranked.c.n <= RECENT)
                     .order_by(EndgameAttempt.id.desc())).scalars()
    for a in rows:
        if a.drill in out:
            out[a.drill]["recent"].append(_row(a))
    return out
