"""The Training tab: courses (tactics, strategy, endgames...) worked through move by move.

A course has chapters of exercises, kept in course order. Each exercise starts from its own
position; you play one side's moves and the other side's are played for you. Progress is simple
(no spaced repetition, Jason's choice): an exercise is new, solved or missed. "Continue" goes
through the unsolved ones in course order; "Retry missed" goes through the missed ones.

Importing again (same Chessable course) updates titles, moves and notes and adds what's new;
your progress is kept unless an exercise's moves changed (then it's new again).
"""

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.chessable import CourseLine
from app.db.models import Course, CourseChapter, CourseExercise
from app.repositories.repertoire import Conflict, NotFound

KINDS = ("tactics", "strategy", "endgames", "other")
EXERCISE_KINDS = {"line": "line", "alternative": "line", "reference": "reference", "info": "info"}


class InvalidCourse(ValueError):
    pass


def _course(s: Session, course_id: int) -> Course:
    course = s.get(Course, course_id)
    if course is None:
        raise NotFound(f"Course {course_id} not found")
    return course


def _exercise(s: Session, exercise_id: int) -> CourseExercise:
    ex = s.get(CourseExercise, exercise_id)
    if ex is None:
        raise NotFound(f"Exercise {exercise_id} not found")
    return ex


def _counts(rows) -> dict:
    out = {"total": 0, "new": 0, "solved": 0, "missed": 0}
    for status, n in rows:
        out[status] = n
        out["total"] += n
    return out


# ---- reading ---------------------------------------------------------------------------------


def list_courses(s: Session) -> list[dict]:
    """Every course with its progress (counts by status), newest first."""
    rows = s.execute(
        select(CourseChapter.course_id, CourseExercise.status, func.count())
        .join(CourseExercise, CourseExercise.chapter_id == CourseChapter.id)
        .group_by(CourseChapter.course_id, CourseExercise.status)
    ).all()
    by_course: dict[int, list] = {}
    for course_id, status, n in rows:
        by_course.setdefault(course_id, []).append((status, n))
    return [
        {"id": c.id, "name": c.name, "kind": c.kind, "chessable_id": c.chessable_id, **_counts(by_course.get(c.id, []))}
        for c in s.scalars(select(Course).order_by(Course.created_at.desc(), Course.id.desc()))
    ]


def get_course(s: Session, course_id: int) -> dict:
    """The course with its chapters and every exercise's title, kind and status (no moves)."""
    course = _course(s, course_id)
    chapters = []
    for ch in course.chapters:
        exercises = [
            {"id": e.id, "title": e.title, "kind": e.kind, "status": e.status, "moves": len(e.ucis.split()) if e.ucis else 0}
            for e in ch.exercises
        ]
        chapters.append({"id": ch.id, "title": ch.title, "exercises": exercises,
                         **_counts(((st, sum(1 for e in exercises if e["status"] == st)) for st in ("new", "solved", "missed")))})
    totals = _counts(((st, sum(c[st] for c in chapters)) for st in ("new", "solved", "missed")))
    return {"id": course.id, "name": course.name, "kind": course.kind, "chessable_id": course.chessable_id,
            "chapters": chapters, **totals}


def get_exercise(s: Session, exercise_id: int) -> dict:
    ex = _exercise(s, exercise_id)
    return {
        "id": ex.id,
        "course_id": ex.chapter.course_id,
        "course": ex.chapter.course.name,
        "chapter_id": ex.chapter_id,
        "chapter": ex.chapter.title,
        "title": ex.title,
        "kind": ex.kind,
        "color": ex.color,
        "start_fen": ex.start_fen,
        "ucis": ex.ucis.split() if ex.ucis else [],
        "sans": ex.sans.split() if ex.sans else [],
        "comments": {int(k): v for k, v in (ex.comments or {}).items()},
        "status": ex.status,
        "attempts": ex.attempts,
        "solved_count": ex.solved_count,
    }


# ---- progress --------------------------------------------------------------------------------


def record_attempt(s: Session, exercise_id: int, solved: bool) -> dict:
    """A finished go at an exercise (an info page counts as solved once read)."""
    ex = _exercise(s, exercise_id)
    ex.attempts += 1
    if solved:
        ex.solved_count += 1
    ex.status = "solved" if solved else "missed"
    ex.last_attempt_at = datetime.now(timezone.utc)
    s.flush()
    return {"id": ex.id, "status": ex.status, "attempts": ex.attempts, "solved_count": ex.solved_count}


def reset_progress(s: Session, course_id: int, chapter_id: int | None = None) -> int:
    """Every exercise in the course (or one chapter) back to new. Returns how many changed."""
    _course(s, course_id)
    q = select(CourseExercise).join(CourseChapter).where(CourseChapter.course_id == course_id, CourseExercise.status != "new")
    if chapter_id is not None:
        q = q.where(CourseChapter.id == chapter_id)
    n = 0
    for ex in s.scalars(q):
        ex.status = "new"
        n += 1
    s.flush()
    return n


# ---- editing ---------------------------------------------------------------------------------


def update_course(s: Session, course_id: int, name: str | None = None, kind: str | None = None) -> dict:
    course = _course(s, course_id)
    if name is not None:
        name = name.strip()[:100]
        if not name:
            raise InvalidCourse("A course needs a name")
        other = s.scalar(select(Course).where(Course.name == name, Course.id != course.id))
        if other is not None:
            raise Conflict(f"There's already a course called '{name}'")
        course.name = name
    if kind is not None:
        if kind not in KINDS:
            raise InvalidCourse(f"Unknown kind {kind!r}")
        course.kind = kind
    s.flush()
    return {"id": course.id, "name": course.name, "kind": course.kind}


def delete_course(s: Session, course_id: int) -> None:
    s.delete(_course(s, course_id))
    s.flush()


# ---- importing -------------------------------------------------------------------------------


def import_course(s: Session, name: str, kind: str, lines: list[CourseLine], chapters: list[dict]) -> dict:
    """lines: the chosen lines in course order; chapters: [{id, title}] in course order."""
    if not lines:
        raise InvalidCourse("No lines to import: choose at least one chapter")
    if kind not in KINDS:
        raise InvalidCourse(f"Unknown kind {kind!r}")
    chessable_id = lines[0].course_id or None
    name = name.strip()[:100] or lines[0].course[:100]

    course = s.scalar(select(Course).where(Course.chessable_id == chessable_id)) if chessable_id else None
    by_name = s.scalar(select(Course).where(Course.name == name))
    if course is None:
        if by_name is not None and by_name.chessable_id not in (None, chessable_id):
            raise Conflict(f"There's already a course called '{name}' (a different one): choose another name")
        course = by_name
    elif by_name is not None and by_name.id != course.id:
        raise Conflict(f"There's already a course called '{name}': choose another name")
    created = course is None
    if course is None:
        course = Course(name=name, kind=kind, chessable_id=chessable_id)
        s.add(course)
        s.flush()
    else:
        course.name, course.kind = name, kind
        if chessable_id and not course.chessable_id:
            course.chessable_id = chessable_id

    report = {"course_id": course.id, "course": course.name, "created_course": created,
              "added": 0, "updated": 0, "unchanged": 0, "reset": 0}

    # Chapters: matched by Chessable id; order from the course's contents, then the lines' own.
    titles = {c["id"]: (c.get("title") or "").strip() for c in chapters}
    order = {c["id"]: n for n, c in enumerate(chapters)}
    existing_ch = {ch.chessable_id: ch for ch in s.scalars(select(CourseChapter).where(CourseChapter.course_id == course.id))}
    next_pos = max((ch.position for ch in existing_ch.values()), default=-1) + 1
    chapter_rows: dict[int, CourseChapter] = {}
    for line in lines:
        cid = line.chapter_id
        if cid in chapter_rows:
            continue
        ch = existing_ch.get(cid)
        title = (titles.get(cid) or line.chapter)[:200]
        pos = order.get(cid, 1000 + next_pos)
        if ch is None:
            ch = CourseChapter(course_id=course.id, chessable_id=cid, title=title, position=pos)
            s.add(ch)
        else:
            ch.title, ch.position = title, pos
        chapter_rows[cid] = ch
    s.flush()

    # Exercises: matched by Chessable id within the chapter.
    existing_ex = {
        (ex.chapter_id, ex.chessable_id): ex
        for ex in s.scalars(select(CourseExercise).where(CourseExercise.chapter_id.in_([c.id for c in chapter_rows.values()])))
    }
    position_in: dict[int, int] = {}
    for line in lines:
        ch = chapter_rows[line.chapter_id]
        pos = position_in.get(ch.id, 0)
        position_in[ch.id] = pos + 1
        values = {
            "title": (line.title or f"Exercise {pos + 1}")[:200],
            "kind": EXERCISE_KINDS.get(line.kind, "line"),
            "color": line.color,
            "start_fen": line.start_fen,
            "ucis": " ".join(line.ucis),
            "sans": " ".join(line.sans),
            "comments": {str(k): v for k, v in line.comments.items()},
        }
        ex = existing_ex.get((ch.id, line.line_id or None))
        if ex is None:
            s.add(CourseExercise(chapter_id=ch.id, chessable_id=line.line_id or None, position=pos, **values))
            report["added"] += 1
            continue
        moves_changed = ex.ucis != values["ucis"] or ex.start_fen != values["start_fen"]
        changed = moves_changed or any(getattr(ex, k) != v for k, v in values.items()) or ex.position != pos
        for k, v in values.items():
            setattr(ex, k, v)
        ex.position = pos
        if moves_changed and ex.status != "new":
            ex.status = "new"
            report["reset"] += 1
        report["updated" if changed else "unchanged"] += 1
    s.flush()
    return report

