"""Bookmarks API: star a line, with an optional note."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, StringConstraints
from sqlalchemy.orm import Session

from app.db.session import get_session
from app.repositories import bookmarks as repo

router = APIRouter(prefix="/api", tags=["bookmarks"])
Db = Annotated[Session, Depends(get_session)]

Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=repo.NOTE_MAX)]


class BookmarkIn(BaseModel):
    note: Note | None = None


class BookmarkOut(BaseModel):
    line_id: int
    bookmarked: bool
    bookmarked_at: datetime | None
    note: str | None


@router.put("/lines/{line_id}/bookmark", response_model=BookmarkOut)
def set_bookmark(line_id: int, body: BookmarkIn, s: Db):
    """Bookmark a line, or change its note (empty or missing note = no note)."""
    return repo.set_bookmark(s, line_id, body.note)


@router.delete("/lines/{line_id}/bookmark", status_code=204)
def remove_bookmark(line_id: int, s: Db):
    repo.remove_bookmark(s, line_id)
    return Response(status_code=204)
