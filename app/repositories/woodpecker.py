"""The Woodpecker Method in the Training tab.

A Woodpecker course is a set of puzzles solved in cycles: the whole set (or the chapters chosen for
the cycle), in course order, then again, each cycle ideally in half the days of the one before.
Every puzzle is timed and only its first go in a cycle counts (a retry in the same cycle is
practice). A cycle ends by itself when every puzzle in it has been tried. Information pages and
reference lines aren't puzzles and are left out.
"""

import math
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Course, CourseChapter, CourseExercise, WoodpeckerAttempt, WoodpeckerCycle
from app.repositories import courses as courses_repo
from app.repositories.courses import InvalidCourse
from app.repositories.repertoire import Conflict, NotFound


def _course(s: Session, course_id: int) -> Course:
    course = s.get(Course, course_id)
    if course is None:
        raise NotFound(f"Course {course_id} not found")
    return course


def _cycle(s: Session, cycle_id: int) -> WoodpeckerCycle:
    cycle = s.get(WoodpeckerCycle, cycle_id)
    if cycle is None:
        raise NotFound(f"Cycle {cycle_id} not found")
    return cycle


def scope(s: Session, course_id: int, chapter_ids: list[int] | None) -> list[int]:
    """The puzzles of a cycle, in course order (tested exercises only)."""
    q = (
        select(CourseExercise.id)
        .join(CourseChapter, CourseChapter.id == CourseExercise.chapter_id)
        .where(CourseChapter.course_id == course_id, CourseExercise.kind == "line")
        .order_by(CourseChapter.position, CourseChapter.id, CourseExercise.position, CourseExercise.id)
    )
    if chapter_ids:
        q = q.where(CourseChapter.id.in_(chapter_ids))
    return list(s.scalars(q))


def _days(start: datetime, end: datetime | None) -> float:
    return round(((end or datetime.now(timezone.utc)) - start).total_seconds() / 86400, 2)


def _stats(s: Session, cycle: WoodpeckerCycle, total: int | None = None) -> dict:
    done, solved, seconds = s.execute(
        select(func.count(), func.count().filter(WoodpeckerAttempt.solved), func.coalesce(func.sum(WoodpeckerAttempt.seconds), 0))
        .where(WoodpeckerAttempt.cycle_id == cycle.id)
    ).one()
    if total is None:
        total = len(scope(s, cycle.course_id, cycle.chapter_ids))
    return {
        "id": cycle.id,
        "number": cycle.number,
        "chapter_ids": cycle.chapter_ids,
        "target_days": cycle.target_days,
        "started_at": cycle.started_at,
        "finished_at": cycle.finished_at,
        "days": _days(cycle.started_at, cycle.finished_at),
        "total": total,
        "done": done,
        "solved": solved,
        "seconds": round(float(seconds), 1),
        "avg_seconds": round(float(seconds) / done, 1) if done else None,
        "accuracy": round(100 * solved / done, 1) if done else None,
    }


def suggested_target(cycles: list[dict]) -> int | None:
    """Half the days the last finished cycle took (rounded up, at least 1); None before any."""
    finished = [c for c in cycles if c["finished_at"]]
    if not finished:
        return None
    return max(1, math.ceil(finished[-1]["days"] / 2))


def overview(s: Session, course_id: int) -> dict:
    """Everything the Woodpecker page shows: chapters (with puzzle counts), every cycle's stats,
    the current cycle and the puzzles still to do in it (in order)."""
    course = _course(s, course_id)
    counts = dict(
        s.execute(
            select(CourseExercise.chapter_id, func.count())
            .where(CourseExercise.kind == "line")
            .group_by(CourseExercise.chapter_id)
        ).all()
    )
    chapters = [{"id": ch.id, "title": ch.title, "puzzles": counts.get(ch.id, 0)} for ch in course.chapters]
    rows = list(s.scalars(select(WoodpeckerCycle).where(WoodpeckerCycle.course_id == course.id).order_by(WoodpeckerCycle.number)))
    cycles = [_stats(s, c) for c in rows]
    current = next((c for c in cycles if not c["finished_at"]), None)
    # The current cycle (else the last one) by chapter: puzzles done and solved in it.
    shown = current or (cycles[-1] if cycles else None)
    by_chapter: dict[int, tuple[int, int]] = {}
    if shown:
        for chapter_id, done, solved in s.execute(
            select(CourseExercise.chapter_id, func.count(), func.count().filter(WoodpeckerAttempt.solved))
            .join(WoodpeckerAttempt, WoodpeckerAttempt.exercise_id == CourseExercise.id)
            .where(WoodpeckerAttempt.cycle_id == shown["id"])
            .group_by(CourseExercise.chapter_id)
        ):
            by_chapter[chapter_id] = (done, solved)
    for ch in chapters:
        done, solved = by_chapter.get(ch["id"], (0, 0))
        ch["in_cycle"] = bool(shown) and (not shown["chapter_ids"] or ch["id"] in shown["chapter_ids"])
        ch["done"], ch["solved"] = done, solved
    todo: list[int] = []
    if current:
        tried = set(s.scalars(select(WoodpeckerAttempt.exercise_id).where(WoodpeckerAttempt.cycle_id == current["id"])))
        todo = [i for i in scope(s, course.id, current["chapter_ids"]) if i not in tried]
    return {
        "course_id": course.id,
        "course": course.name,
        "puzzles": sum(c["puzzles"] for c in chapters),
        "chapters": chapters,
        "cycles": cycles,
        "current": current,
        "todo": todo,
        "suggested_target_days": suggested_target(cycles),
    }


def start_cycle(s: Session, course_id: int, chapter_ids: list[int] | None = None, target_days: int | None = None) -> dict:
    course = _course(s, course_id)
    if course.kind != "woodpecker":
        raise InvalidCourse("Cycles are for Woodpecker courses: set the course's kind to Woodpecker first")
    if s.scalar(select(WoodpeckerCycle).where(WoodpeckerCycle.course_id == course.id, WoodpeckerCycle.finished_at.is_(None))):
        raise Conflict("Finish (or abandon) the current cycle first")
    if chapter_ids:
        own = set(s.scalars(select(CourseChapter.id).where(CourseChapter.course_id == course.id)))
        if not set(chapter_ids) <= own:
            raise InvalidCourse("Those chapters aren't in this course")
    chapter_ids = sorted(set(chapter_ids)) if chapter_ids else None
    puzzles = scope(s, course.id, chapter_ids)
    if not puzzles:
        raise InvalidCourse("No puzzles in the chosen chapters")
    if target_days is not None and target_days < 1:
        raise InvalidCourse("A target is at least one day")
    number = (s.scalar(select(func.max(WoodpeckerCycle.number)).where(WoodpeckerCycle.course_id == course.id)) or 0) + 1
    cycle = WoodpeckerCycle(course_id=course.id, number=number, chapter_ids=chapter_ids, target_days=target_days)
    s.add(cycle)
    s.flush()
    s.refresh(cycle)
    return _stats(s, cycle, len(puzzles))


def abandon_cycle(s: Session, cycle_id: int) -> None:
    """Delete the latest cycle (and its attempts), e.g. one started by mistake."""
    cycle = _cycle(s, cycle_id)
    latest = s.scalar(select(func.max(WoodpeckerCycle.number)).where(WoodpeckerCycle.course_id == cycle.course_id))
    if cycle.number != latest:
        raise Conflict("Only the latest cycle can be removed")
    s.delete(cycle)
    s.flush()


def record(s: Session, cycle_id: int, exercise_id: int, solved: bool, seconds: float) -> dict:
    """A puzzle's first go in the cycle. A second go isn't stored (recorded: false). The cycle
    finishes with its last puzzle."""
    cycle = _cycle(s, cycle_id)
    if cycle.finished_at is not None:
        raise Conflict(f"Cycle {cycle.number} is finished")
    puzzles = scope(s, cycle.course_id, cycle.chapter_ids)
    if exercise_id not in puzzles:
        raise InvalidCourse("That puzzle isn't in this cycle")
    existing = s.scalar(select(WoodpeckerAttempt).where(WoodpeckerAttempt.cycle_id == cycle.id, WoodpeckerAttempt.exercise_id == exercise_id))
    recorded = existing is None
    if recorded:
        s.add(WoodpeckerAttempt(cycle_id=cycle.id, exercise_id=exercise_id, solved=solved, seconds=round(max(0.0, min(seconds, 86400.0)), 1)))
        courses_repo.record_attempt(s, exercise_id, solved)  # the course's own progress too
        s.flush()
    stats = _stats(s, cycle, len(puzzles))
    finished = recorded and stats["done"] >= stats["total"]
    if finished:
        cycle.finished_at = datetime.now(timezone.utc)
        s.flush()
        stats = _stats(s, cycle, len(puzzles))
    return {"recorded": recorded, "finished": finished, "cycle": stats}


def accept(s: Session, cycle_id: int, exercise_id: int) -> dict:
    """Count a missed first go as solved: an alternative solution the course doesn't give. The time
    stays as recorded; the exercise's own progress is corrected too. Works in a finished cycle."""
    cycle = _cycle(s, cycle_id)
    attempt = s.scalar(select(WoodpeckerAttempt).where(WoodpeckerAttempt.cycle_id == cycle.id, WoodpeckerAttempt.exercise_id == exercise_id))
    if attempt is None:
        raise NotFound("That puzzle hasn't been tried in this cycle")
    if not attempt.solved:
        attempt.solved = True
        ex = s.get(CourseExercise, exercise_id)
        ex.solved_count += 1
        ex.status = "solved"
        s.flush()
    return _stats(s, cycle)


def puzzle_times(s: Session, course_id: int) -> dict:
    """Every puzzle with its time and result in each cycle: {cycles: [numbers], puzzles: [...]}."""
    course = _course(s, course_id)
    numbers = {c.id: c.number for c in s.scalars(select(WoodpeckerCycle).where(WoodpeckerCycle.course_id == course.id))}
    times: dict[int, dict[int, dict]] = {}
    if numbers:
        for a in s.scalars(select(WoodpeckerAttempt).where(WoodpeckerAttempt.cycle_id.in_(list(numbers)))):
            times.setdefault(a.exercise_id, {})[numbers[a.cycle_id]] = {"seconds": a.seconds, "solved": a.solved}
    rows = s.execute(
        select(CourseExercise.id, CourseExercise.title, CourseChapter.title)
        .join(CourseChapter, CourseChapter.id == CourseExercise.chapter_id)
        .where(CourseChapter.course_id == course.id, CourseExercise.kind == "line")
        .order_by(CourseChapter.position, CourseChapter.id, CourseExercise.position, CourseExercise.id)
    ).all()
    return {
        "cycles": sorted(numbers.values()),
        "puzzles": [{"id": i, "title": t, "chapter": ch, "times": times.get(i, {})} for i, t, ch in rows],
    }


def latest_cycle(s: Session, course_id: int) -> dict | None:
    """The current cycle, or the last finished one (for the course list), or None."""
    cycle = s.scalar(
        select(WoodpeckerCycle).where(WoodpeckerCycle.course_id == course_id).order_by(WoodpeckerCycle.number.desc()).limit(1)
    )
    return _stats(s, cycle) if cycle else None
