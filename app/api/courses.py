"""The Training tab: courses (tactics, strategy, endgames) and their exercises."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.chessable import NotALine, parse_exercise
from app.db.session import get_session
from app.repositories import courses as repo

router = APIRouter(prefix="/api", tags=["courses"])
Db = Annotated[Session, Depends(get_session)]
Kind = Literal["tactics", "strategy", "endgames", "other"]


class Progress(BaseModel):
    total: int
    new: int
    solved: int
    missed: int


class CourseSummary(Progress):
    id: int
    name: str
    kind: str
    chessable_id: int | None


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
    return repo.list_courses(s)


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
