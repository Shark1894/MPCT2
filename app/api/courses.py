"""The Training tab: courses (tactics, strategy, endgames) and their exercises."""

from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.chessable import NotALine, parse_exercise
from app.db.session import get_session
from app.repositories import courses as repo
from app.repositories import woodpecker as wp

router = APIRouter(prefix="/api", tags=["courses"])
Db = Annotated[Session, Depends(get_session)]
Kind = Literal["tactics", "strategy", "endgames", "woodpecker", "other"]


class Progress(BaseModel):
    total: int
    new: int
    solved: int
    missed: int


class CycleOut(BaseModel):
    id: int
    number: int
    chapter_ids: list[int] | None
    target_days: int | None
    started_at: datetime
    finished_at: datetime | None
    days: float  # so far, or to finish
    total: int  # puzzles in the cycle
    done: int
    solved: int
    seconds: float
    avg_seconds: float | None
    accuracy: float | None  # % of the puzzles done that were solved


class CourseSummary(Progress):
    id: int
    name: str
    kind: str
    chessable_id: int | None
    cycle: CycleOut | None = None  # Woodpecker courses: the current (or last) cycle


class ExerciseBrief(BaseModel):
    id: int
    title: str
    kind: str
    status: str
    moves: int


class ChapterOut(Progress):
    id: int
    title: str
    exercises: list[ExerciseBrief]


class CourseOut(CourseSummary):
    chapters: list[ChapterOut]


class ExerciseOut(BaseModel):
    id: int
    course_id: int
    course: str
    chapter_id: int
    chapter: str
    title: str
    kind: str  # 'line' (tested), 'reference' (stepped through), 'info' (a page to read)
    color: str  # the side you play
    start_fen: str
    ucis: list[str]
    sans: list[str]
    comments: dict[int, str]  # ply -> note (0 = start position, n = after move n)
    status: str
    attempts: int
    solved_count: int


class Chapter(BaseModel):
    id: int
    title: str = ""


class ImportIn(BaseModel):
    name: str = Field(default="", max_length=100)
    kind: Kind = "tactics"
    lines: list[dict[str, Any]] = Field(max_length=10_000)  # {"game": {...}} as in the export
    chapters: list[Chapter] = Field(default_factory=list, max_length=500)


class ImportOut(BaseModel):
    course_id: int
    course: str
    created_course: bool
    added: int
    updated: int
    unchanged: int
    reset: int  # exercises whose moves changed, so they're new again
    skipped: list[str]


class CourseIn(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    kind: Kind | None = None


class AttemptIn(BaseModel):
    solved: bool


class AttemptOut(BaseModel):
    id: int
    status: str
    attempts: int
    solved_count: int


class ResetIn(BaseModel):
    chapter_id: int | None = None


class ResetOut(BaseModel):
    reset: int


@router.get("/courses", response_model=list[CourseSummary])
def list_courses(s: Db):
    out = repo.list_courses(s)
    for c in out:
        if c["kind"] == "woodpecker":
            c["cycle"] = wp.latest_cycle(s, c["id"])
    return out


@router.post("/courses/import", response_model=ImportOut)
def import_course(body: ImportIn, s: Db):
    """A Chessable course export's chosen lines -> a course (or an update of one)."""
    lines, skipped = [], []
    for raw in body.lines:
        try:
            lines.append(parse_exercise(raw))
        except NotALine as exc:
            g = raw.get("game") if isinstance(raw, dict) else None
            skipped.append(f"{(g or {}).get('title') or (g or {}).get('oid') or '?'}: {exc}")
    if not lines:
        raise repo.InvalidCourse("Nothing to import" + (f": {skipped[0]}" if skipped else ""))
    report = repo.import_course(s, body.name, body.kind, lines, [c.model_dump() for c in body.chapters])
    return {**report, "skipped": skipped}


@router.get("/courses/{course_id}", response_model=CourseOut)
def get_course(course_id: int, s: Db):
    return repo.get_course(s, course_id)


@router.patch("/courses/{course_id}")
def update_course(course_id: int, body: CourseIn, s: Db):
    return repo.update_course(s, course_id, body.name, body.kind)


@router.delete("/courses/{course_id}", status_code=204)
def delete_course(course_id: int, s: Db):
    repo.delete_course(s, course_id)
    return Response(status_code=204)


@router.post("/courses/{course_id}/reset", response_model=ResetOut)
def reset_course(course_id: int, body: ResetIn, s: Db):
    """Progress back to new (the whole course, or one chapter)."""
    return {"reset": repo.reset_progress(s, course_id, body.chapter_id)}


@router.get("/exercises/{exercise_id}", response_model=ExerciseOut)
def get_exercise(exercise_id: int, s: Db):
    return repo.get_exercise(s, exercise_id)


@router.post("/exercises/{exercise_id}/attempt", response_model=AttemptOut)
def attempt(exercise_id: int, body: AttemptIn, s: Db):
    return repo.record_attempt(s, exercise_id, body.solved)


# ---- Woodpecker Method ------------------------------------------------------------------------


class WpChapter(BaseModel):
    id: int
    title: str
    puzzles: int
    in_cycle: bool = False  # part of the current (else the last) cycle
    done: int = 0  # puzzles tried in that cycle
    solved: int = 0


class WoodpeckerOut(BaseModel):
    course_id: int
    course: str
    puzzles: int
    chapters: list[WpChapter]
    cycles: list[CycleOut]  # oldest first
    current: CycleOut | None
    todo: list[int]  # the current cycle's puzzles still to do, in order
    suggested_target_days: int | None  # half the last finished cycle's days


class CycleIn(BaseModel):
    chapter_ids: list[int] | None = Field(default=None, max_length=500)  # None = every chapter
    target_days: int | None = Field(default=None, ge=1, le=3650)


class WpAttemptIn(BaseModel):
    exercise_id: int
    solved: bool
    seconds: float = Field(ge=0)


class WpAttemptOut(BaseModel):
    recorded: bool  # False: already tried in this cycle (a retry is practice)
    finished: bool  # this attempt finished the cycle
    cycle: CycleOut


class PuzzleTime(BaseModel):
    seconds: float
    solved: bool


class PuzzleTimes(BaseModel):
    id: int
    title: str
    chapter: str
    times: dict[int, PuzzleTime]  # cycle number -> time


class PuzzleTimesOut(BaseModel):
    cycles: list[int]
    puzzles: list[PuzzleTimes]


@router.get("/courses/{course_id}/woodpecker", response_model=WoodpeckerOut)
def woodpecker(course_id: int, s: Db):
    return wp.overview(s, course_id)


@router.post("/courses/{course_id}/woodpecker/cycles", response_model=CycleOut)
def start_cycle(course_id: int, body: CycleIn, s: Db):
    return wp.start_cycle(s, course_id, body.chapter_ids, body.target_days)


@router.delete("/woodpecker/cycles/{cycle_id}", status_code=204)
def abandon_cycle(cycle_id: int, s: Db):
    wp.abandon_cycle(s, cycle_id)
    return Response(status_code=204)


@router.post("/woodpecker/cycles/{cycle_id}/attempts", response_model=WpAttemptOut)
def woodpecker_attempt(cycle_id: int, body: WpAttemptIn, s: Db):
    return wp.record(s, cycle_id, body.exercise_id, body.solved, body.seconds)


@router.post("/woodpecker/cycles/{cycle_id}/attempts/{exercise_id}/accept", response_model=CycleOut)
def woodpecker_accept(cycle_id: int, exercise_id: int, s: Db):
    """Override a missed first go as solved (another solution the course doesn't list)."""
    return wp.accept(s, cycle_id, exercise_id)


@router.get("/courses/{course_id}/woodpecker/times", response_model=PuzzleTimesOut)
def puzzle_times(course_id: int, s: Db):
    return wp.puzzle_times(s, course_id)
