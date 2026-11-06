"""Create an opening from a Chessable course export (the browser sends the chosen lines)."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.chessable import NotALine, parse_line
from app.db.session import get_session
from app.repositories import course_import as repo

router = APIRouter(prefix="/api", tags=["repertoire"])
Db = Annotated[Session, Depends(get_session)]


class Chapter(BaseModel):
    id: int
    title: str = ""


class CourseIn(BaseModel):
    name: str = Field(max_length=100)  # the opening's name ('' = the course's)
    lines: list[dict[str, Any]] = Field(max_length=10_000)  # course lines as in the export: {"game": {...}}
    chapters: list[Chapter] = Field(default_factory=list, max_length=500)
    comments: bool = True
    tags: bool = True


class CourseOut(BaseModel):
    opening_id: int
    opening: str
    color: str
    created_opening: bool
    lines_read: int
    lines_created: int
    lines_extended: int
    lines_covered: int  # duplicates, or the start of a longer line
    comments_added: int
    comments_existing: int
    comments_too_long: int
    tags: list[str]
    tags_skipped: list[str]
    skipped: list[str]


@router.post("/repertoires/{repertoire_id}/import-course", response_model=CourseOut)
def import_course(repertoire_id: int, body: CourseIn, s: Db):
    """Lines, notes and chapter tags from a Chessable course export, into one opening."""
    lines, skipped = [], []
    for raw in body.lines:
        try:
            line = parse_line(raw)
        except NotALine as exc:
            g = raw.get("game") if isinstance(raw, dict) else None
            title = (g or {}).get("title") or (g or {}).get("oid") or "?"
            skipped.append(f"{title}: {exc}")
            continue
        if line.kind != "info":
            lines.append(line)
    report = repo.import_course(
        s, repertoire_id, body.name, lines, [c.model_dump() for c in body.chapters], body.comments, body.tags
    )
    report["skipped"] = skipped + report["skipped"]
    return report
