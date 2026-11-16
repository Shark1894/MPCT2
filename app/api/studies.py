"""Endgame studies (Training tab): import from PGN, browse, solve, favourites."""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_session
from app.repositories import studies as repo

router = APIRouter(prefix="/api", tags=["studies"])
Db = Annotated[Session, Depends(get_session)]
Group = Literal["pawn", "minor", "rook", "rook_minor", "queen", "many"]
Stipulation = Literal["win", "draw"]
Status = Literal["new", "solved", "missed", "unsolved"]
PGN_MAX = 60_000_000  # characters: HHdb-sized files (about 100k studies) fit


class PgnIn(BaseModel):
    pgn: str = Field(max_length=PGN_MAX)


class GroupCount(BaseModel):
    group: str
    title: str
    count: int


class PreviewOut(BaseModel):
    studies: int
    groups: list[GroupCount]
    skipped: list[str]


class ImportIn(PgnIn):
    collection: str = Field(max_length=100)
    groups: list[Group] | None = None  # None = every group


class ImportOut(BaseModel):
    collection: str
    added: int
    updated: int
    unchanged: int
    skipped: list[str]


class GroupSummary(BaseModel):
    group: str
    title: str
    total: int
    new: int
    solved: int
    missed: int


class Collection(BaseModel):
    name: str
    count: int


class SummaryOut(BaseModel):
    total: int
    new: int
    solved: int
    missed: int
    favourites: int
    wins: int
    draws: int
    groups: list[GroupSummary]
    collections: list[Collection]


class StudyBrief(BaseModel):
    id: int
    title: str
    composer: str
    year: int | None
    source: str
    stipulation: str
    material: str
    group: str
    color: str
    start_fen: str
    moves: int
    status: str
    attempts: int
    favourite: bool
    favourite_note: str
    collection: str


class ListOut(BaseModel):
    total: int
    items: list[StudyBrief]


class StudyOut(StudyBrief):
    course: str
    chapter: str
    kind: str
    ucis: list[str]
    sans: list[str]
    comments: dict[int, str]
    solved_count: int


class AttemptIn(BaseModel):
    solved: bool


class AttemptOut(BaseModel):
    id: int
    status: str
    attempts: int
    solved_count: int


class FavouriteIn(BaseModel):
    note: str | None = Field(default=None, max_length=repo.NOTE_MAX)


class FavouriteOut(BaseModel):
    id: int
    favourite: bool
    favourite_note: str


class DeletedOut(BaseModel):
    deleted: int


def _filters(group, stipulation, status, favourites, q, collection) -> dict:
    return {"group": group, "stipulation": stipulation, "status": status, "favourites": favourites, "q": q,
            "collection": collection}


Q = Annotated[str | None, Query(max_length=100)]


@router.post("/studies/preview", response_model=PreviewOut)
def preview(body: PgnIn):
    """What a PGN file holds: studies by material group, and the games that can't be used."""
    return repo.preview(body.pgn)


@router.post("/studies/import", response_model=ImportOut)
def import_studies(body: ImportIn, s: Db):
    """Add a PGN file's studies (only some material groups, if given). Studies already there are
    updated and keep their progress and favourites."""
    return repo.import_studies(s, body.pgn, body.collection, body.groups)


@router.get("/studies/summary", response_model=SummaryOut)
def summary(s: Db):
    return repo.summary(s)


@router.get("/studies", response_model=ListOut)
def list_studies(
    s: Db,
    group: Group | None = None,
    stipulation: Stipulation | None = None,
    status: Status | None = None,
    favourites: bool = False,
    q: Q = None,
    collection: Q = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=repo.LIST_MAX)] = 50,
):
    return repo.list_studies(s, offset, limit, **_filters(group, stipulation, status, favourites, q, collection))


@router.get("/studies/queue", response_model=list[int])
def queue(
    s: Db,
    group: Group | None = None,
    stipulation: Stipulation | None = None,
    status: Status | None = None,
    favourites: bool = False,
    q: Q = None,
    collection: Q = None,
    random: bool = False,
    limit: Annotated[int, Query(ge=1, le=repo.QUEUE_MAX)] = 50,
):
    """Ids to solve in order: new first, then missed, then solved (or shuffled)."""
    return repo.queue(s, limit, random, **_filters(group, stipulation, status, favourites, q, collection))


@router.get("/studies/{study_id}", response_model=StudyOut)
def get_study(study_id: int, s: Db):
    return repo.get_study(s, study_id)


@router.post("/studies/{study_id}/attempt", response_model=AttemptOut)
def attempt(study_id: int, body: AttemptIn, s: Db):
    return repo.record_attempt(s, study_id, body.solved)


@router.put("/studies/{study_id}/favourite", response_model=FavouriteOut)
def favourite(study_id: int, body: FavouriteIn, s: Db):
    return repo.set_favourite(s, study_id, body.note)


@router.delete("/studies/{study_id}/favourite", response_model=FavouriteOut)
def unfavourite(study_id: int, s: Db):
    return repo.clear_favourite(s, study_id)


@router.delete("/studies/collections/{name}", response_model=DeletedOut)
def delete_collection(name: str, s: Db):
    return {"deleted": repo.delete_collection(s, name)}
