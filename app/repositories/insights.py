"""Dashboard insights: learning progress, workload forecast, problem positions,
a repertoire overview and training activity.

Practice reviews (retries of a line already played correctly) are left out, as
everywhere else on the dashboard.
"""

from collections import Counter
from datetime import date, datetime, timedelta

import chess
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Line, LineReview, Move, MoveAttempt, Opening, Position
from app.repositories.repertoire import get_repertoire
from app.repositories.training import current_streaks

# Learning stages by streak (consecutive correct reviews). Lines never reviewed are "new".
KNOWN_FROM = 2  # also when comments start being hidden in training
MASTERED_FROM = 5  # next review a month or more away
FORECAST_DAYS = 14
PROBLEM_WINDOW_DAYS = 90  # mistakes older than this don't count
PROBLEM_FIXED_AFTER = 3  # dropped once played right this many reviews in a row
PROBLEM_LIMIT = 8


def stage(streak: int, reviewed: bool) -> str:
    if not reviewed:
        return "new"
    if streak >= MASTERED_FROM:
        return "mastered"
    if streak >= KNOWN_FROM:
        return "known"
    return "learning"


def mastery(line_ids: list[int], streaks: dict[int, int], reviewed: set[int]) -> dict:
    counts = dict.fromkeys(("new", "learning", "known", "mastered"), 0)
    for line_id in line_ids:
        counts[stage(streaks.get(line_id, 0), line_id in reviewed)] += 1
    return counts


def reviewed_line_ids(s: Session, line_ids: list[int]) -> set[int]:
    if not line_ids:
        return set()
    return set(
        s.scalars(select(LineReview.line_id).where(LineReview.line_id.in_(line_ids), LineReview.practice.is_(False)).distinct())
    )


def forecast(review_dates: list[date], today: date | None = None, days: int = FORECAST_DAYS) -> dict:
    """Lines due on each of the next `days` days (overdue lines count as due today)."""
    today = today or date.today()
    counts = [0] * days
    later = 0
    for d in review_dates:
        offset = max((d - today).days, 0)
        if offset < days:
            counts[offset] += 1
        else:
            later += 1
    return {"days": [{"date": today + timedelta(days=i), "due": n} for i, n in enumerate(counts)], "later": later}


def problem_positions(s: Session, line_ids: list[int], moves_by_line: dict[int, list[dict]], now: datetime | None = None) -> list[dict]:
    """Your moves you most often get wrong, grouped by position (so the same move in
    several lines counts once), with the wrong moves you played instead."""
    if not line_ids:
        return []
    rows = s.execute(
        select(
            Move.position_before_id,
            Move.uci,
            Move.ply,
            Move.line_id,
            MoveAttempt.line_review_id,
            MoveAttempt.played_uci,
            MoveAttempt.correct,
            LineReview.reviewed_at,
        )
        .join(MoveAttempt, MoveAttempt.move_id == Move.id)
        .join(LineReview, LineReview.id == MoveAttempt.line_review_id)
        .where(Move.line_id.in_(line_ids), LineReview.practice.is_(False))
        .order_by(LineReview.reviewed_at, LineReview.id, MoveAttempt.id)
    ).all()

    now = now or datetime.now().astimezone()
    since = now - timedelta(days=PROBLEM_WINDOW_DAYS)
    groups: dict[tuple[int, str], dict] = {}
    for pos_id, uci, ply, line_id, review_id, played, correct, at in rows:
        g = groups.setdefault((pos_id, uci), {"ply": ply, "line_id": line_id, "reviews": {}, "wrong": Counter()})
        r = g["reviews"].setdefault(review_id, {"at": at, "wrong": False})
        if not correct:
            r["wrong"] = True
            if at >= since:
                g["wrong"][played] += 1

    found = []
    for (pos_id, uci), g in groups.items():
        reviews = list(g["reviews"].values())  # oldest first
        wrong_reviews = [r for r in reviews if r["wrong"] and r["at"] >= since]
        if not wrong_reviews:
            continue
        last_wrong = max(i for i, r in enumerate(reviews) if r["wrong"])
        right_since = len(reviews) - 1 - last_wrong
        if right_since >= PROBLEM_FIXED_AFTER:
            continue
        found.append(
            {
                "pos_id": pos_id,
                "uci": uci,
                "ply": g["ply"],
                "line_id": g["line_id"],
                "times_wrong": len(wrong_reviews),
                "times_seen": sum(1 for r in reviews if r["at"] >= since),
                "last_wrong_at": wrong_reviews[-1]["at"],
                "right_since": right_since,
                "wrong": g["wrong"],
            }
        )
    found.sort(key=lambda p: (-p["times_wrong"], p["right_since"], -p["last_wrong_at"].timestamp()))
    found = found[:PROBLEM_LIMIT]
    if not found:
        return []

    keys = dict(s.execute(select(Position.id, Position.key).where(Position.id.in_({p["pos_id"] for p in found}))).all())
    through: dict[tuple[int, str], list[int]] = {}
    for line_id, pos_id, uci in s.execute(
        select(Move.line_id, Move.position_before_id, Move.uci).where(
            Move.line_id.in_(line_ids), Move.position_before_id.in_({p["pos_id"] for p in found})
        )
    ).all():
        through.setdefault((pos_id, uci), []).append(line_id)

    out = []
    for p in found:
        board = chess.Board(f"{keys[p['pos_id']]} 0 1")
        line_moves = moves_by_line.get(p["line_id"], [])
        path = [m["san"] for m in line_moves if m["ply"] < p["ply"]]
        expected = next(m["san"] for m in line_moves if m["ply"] == p["ply"])
        wrong = []
        for played, count in p["wrong"].most_common(3):
            try:
                san = board.san(chess.Move.from_uci(played))
            except (ValueError, AssertionError):
                san = played
            wrong.append({"san": san, "count": count})
        out.append(
            {
                "ply": p["ply"],
                "moves": path,  # SAN from the start to the position
                "expected": expected,
                "wrong": wrong,
                "times_wrong": p["times_wrong"],
                "times_seen": p["times_seen"],
                "right_since": p["right_since"],
                "last_wrong_at": p["last_wrong_at"],
                "line_ids": sorted(through.get((p["pos_id"], p["uci"]), [p["line_id"]])),
            }
        )
    return out


def overview(s: Session, repertoire_id: int) -> list[dict]:
    """One row per opening in the repertoire: size, due, accuracy and learning stages."""
    get_repertoire(s, repertoire_id)
    openings = s.scalars(select(Opening).where(Opening.repertoire_id == repertoire_id).order_by(Opening.color.desc(), Opening.name)).all()
    lines = s.execute(
        select(Line.id, Line.opening_id, Line.next_review_on).join(Opening).where(Opening.repertoire_id == repertoire_id)
    ).all()
    ids = [line_id for line_id, _, _ in lines]
    streaks = current_streaks(s, ids)
    reviewed = reviewed_line_ids(s, ids)
    totals: dict[int, list[int]] = {}
    if ids:
        for line_id, n, n_correct in s.execute(
            select(LineReview.line_id, func.count(), func.count().filter(LineReview.correct))
            .where(LineReview.line_id.in_(ids), LineReview.practice.is_(False))
            .group_by(LineReview.line_id)
        ).all():
            totals[line_id] = [n, n_correct]

    today = date.today()
    out = []
    for o in openings:
        mine = [(line_id, due_on) for line_id, opening_id, due_on in lines if opening_id == o.id]
        mine_ids = [line_id for line_id, _ in mine]
        reviews = sum(totals.get(i, [0, 0])[0] for i in mine_ids)
        correct = sum(totals.get(i, [0, 0])[1] for i in mine_ids)
        out.append(
            {
                "id": o.id,
                "name": o.name,
                "color": o.color,
                "lines": len(mine),
                "due": sum(1 for _, d in mine if d <= today),
                "next_review_on": min((d for _, d in mine), default=None),
                "reviews": reviews,
                "accuracy": round(correct / reviews, 3) if reviews else None,
                "mastery": mastery(mine_ids, streaks, reviewed),
            }
        )
    return out


def activity(s: Session, tz: str = "UTC", days: int = 182) -> dict:
    """Reviews per day (in the browser's time zone) and runs of consecutive training days."""
    local_day = func.date(func.timezone(tz, LineReview.reviewed_at))
    today = s.scalar(select(func.date(func.timezone(tz, func.now()))))
    start = today - timedelta(days=days - 1)
    counts = {
        d: (n, ok)
        for d, n, ok in s.execute(
            select(local_day, func.count(), func.count().filter(LineReview.correct))
            .where(LineReview.practice.is_(False))
            .group_by(local_day)
        ).all()
    }
    trained = sorted(counts)
    longest = run = 0
    prev = None
    for d in trained:
        run = run + 1 if prev and (d - prev).days == 1 else 1
        longest = max(longest, run)
        prev = d
    # Current run: up to today, or up to yesterday if you haven't trained yet today.
    current = 0
    day = today if today in counts else today - timedelta(days=1)
    while day in counts:
        current += 1
        day -= timedelta(days=1)
    return {
        "today": today,
        "days": [
            {"date": start + timedelta(days=i), "reviews": counts.get(start + timedelta(days=i), (0, 0))[0],
             "correct": counts.get(start + timedelta(days=i), (0, 0))[1]}
            for i in range(days)
        ],
        "current_run": current,
        "trained_today": today in counts,
        "longest_run": longest,
        "active_days": sum(1 for d in trained if d >= start),
    }
