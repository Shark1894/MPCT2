"""Time spent in each part of the app (Stats tab).

The browser reports stretches of active time (activity_sessions). Before tracking began, the
only record of time is what some trainers saved per attempt: rated puzzles, Woodpecker puzzles
and endgame drills. Those are counted up to the first tracked stretch (so nothing counts twice),
each attempt capped at LEGACY_CAP seconds in case it was left open.
"""

from datetime import datetime, timezone

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db.models import ActivitySession

CATEGORIES = ("openings", "tactics", "endgames", "strategy", "games", "analysis")
MAX_SECONDS = 86400.0
LEGACY_CAP = 600


def record(s: Session, key: str, category: str, activity: str, detail: str | None, started_at: datetime,
           seconds: float) -> dict:
    """Create or update a stretch; a repeated report never lowers its time."""
    seconds = round(min(max(seconds, 0.0), MAX_SECONDS), 1)
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    detail = detail[:100] if detail else None
    stmt = insert(ActivitySession).values(key=key, category=category, activity=activity, detail=detail,
                                          started_at=started_at, seconds=seconds)
    stmt = stmt.on_conflict_do_update(
        index_elements=[ActivitySession.key],
        set_={"seconds": func.greatest(ActivitySession.seconds, stmt.excluded.seconds), "updated_at": func.now()},
    ).returning(ActivitySession.key, ActivitySession.seconds)
    row = s.execute(stmt).one()
    return {"key": row.key, "seconds": row.seconds}


def tracking_since(s: Session) -> datetime | None:
    return s.scalar(select(func.min(ActivitySession.started_at)))


SUMMARY = text(f"""
with t as (select min(started_at) as since from activity_sessions),
spans as (
    select started_at as at, category, activity, detail, seconds from activity_sessions
    union all
    select p.attempted_at, 'tactics', 'puzzles-rated', null, least(p.seconds, {LEGACY_CAP})
      from puzzle_attempts p, t where p.seconds is not null and (t.since is null or p.attempted_at < t.since)
    union all
    select w.attempted_at, 'tactics', 'woodpecker', c.name, least(w.seconds, {LEGACY_CAP})
      from woodpecker_attempts w
      join woodpecker_cycles y on y.id = w.cycle_id
      join courses c on c.id = y.course_id, t
     where t.since is null or w.attempted_at < t.since
    union all
    select e.finished_at, 'endgames', 'endgame-drill', e.drill, least(e.seconds, {LEGACY_CAP})
      from endgame_attempts e, t where t.since is null or e.finished_at < t.since
)
select (at at time zone :tz)::date as date, category, activity, detail,
       sum(seconds)::float as seconds, count(*)::int as sessions
  from spans
 where seconds > 0
 group by 1, 2, 3, 4
 order by 1, 2, 3, 4
""")


def summary(s: Session, tz: str) -> dict:
    """Seconds per local day, category, activity and detail (all time); the frontend makes
    the periods, the daily chart and the breakdown from these."""
    today = s.scalar(text("select (now() at time zone :tz)::date"), {"tz": tz})
    rows = [dict(r._mapping) for r in s.execute(SUMMARY, {"tz": tz})]
    return {"tz": tz, "today": today, "tracking_since": tracking_since(s), "rows": rows}
