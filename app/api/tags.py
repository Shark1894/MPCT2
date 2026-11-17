"""Branch tags API."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, StringConstraints
from sqlalchemy.orm import Session

from app.db.session import get_session
from app.repositories import tags as repo

router = APIRouter(prefix="/api", tags=["tags"])
Db = Annotated[Session, Depends(get_session)]
TagName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]


class TagIn(BaseModel):
    name: TagName
    fen: str


class TagRename(BaseModel):
    name: TagName


class TagOut(BaseModel):
    id: int
    name: str
    key: str  # position: FEN without move counters (en passant only when capturable)
    path: list[str]  # SAN moves of the shortest stored route to the position
    lines: int
    due: int
    parent_id: int | None = None  # the branch it sits under (on its main line)
    rest_lines: int | None = None  # lines in none of its sub-branches (None: no sub-branches)
    rest_due: int | None = None


@router.get("/openings/{opening_id}/tags", response_model=list[TagOut])
def list_tags(opening_id: int, s: Db):
    return repo.list_tags(s, opening_id)


@router.get("/openings/{opening_id}/tags/at", response_model=list[int])
def tags_at(opening_id: int, s: Db, fen: Annotated[str, Query(min_length=1)]):
    """Ids of the branches this position is in, however it was reached (transpositions too)."""
    return repo.tags_at(s, opening_id, fen)


@router.post("/openings/{opening_id}/tags", response_model=TagOut, status_code=201)
def create_tag(opening_id: int, body: TagIn, s: Db):
    return repo.create_tag(s, opening_id, body.name, body.fen)


@router.patch("/tags/{tag_id}", response_model=TagOut)
def rename_tag(tag_id: int, body: TagRename, s: Db):
    return repo.rename_tag(s, tag_id, body.name)


@router.delete("/tags/{tag_id}", status_code=204)
def delete_tag(tag_id: int, s: Db):
    repo.delete_tag(s, tag_id)
    return Response(status_code=204)
