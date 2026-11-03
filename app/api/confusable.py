"""Confusable positions API: near-identical positions that need different moves."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.confusable import MAX_DISTANCE
from app.db.session import get_session
from app.repositories import confusable as repo

router = APIRouter(prefix="/api", tags=["confusable"])
Db = Annotated[Session, Depends(get_session)]


class PairSide(BaseModel):
    position_id: int
    fen: str
    ply: int  # your move here
    moves: list[str]  # SAN from the start to the position (one line that reaches it)
    expected_uci: str
    expected_san: str
    opening_id: int
    opening_name: str
    line_ids: list[int]  # lines through this move (in the selected branch, if any)


class Difference(BaseModel):
    square: str
    a: str | None  # e.g. "white bishop"; None = empty
    b: str | None


class Mixups(BaseModel):
    a_as_b: int  # times you played b's move in position a
    b_as_a: int


class Pair(BaseModel):
    a: PairSide  # the selected opening's side when only one is in it
    b: PairSide
    distance: int  # squares that differ (1 or more)
    differences: list[Difference]
    mixups: Mixups


class ConfusableOut(BaseModel):
    opening_id: int
    tag_id: int | None
    total: int  # pairs found (before the limit)
    hidden: int  # pairs marked as not confusing
    pairs: list[Pair]


class UnhideOut(BaseModel):
    pairs: int  # pairs shown again


class HideIn(BaseModel):
    position_ids: list[int] = Field(min_length=2, max_length=2)


@router.get("/openings/{opening_id}/confusable", response_model=ConfusableOut)
def confusable(
    opening_id: int,
    s: Db,
    tag_id: int | None = None,
    max_distance: Annotated[int, Query(ge=1, le=8)] = MAX_DISTANCE,
    limit: Annotated[int, Query(ge=1, le=100)] = repo.PAIR_LIMIT,
):
    return repo.confusable_pairs(s, opening_id, tag_id, max_distance, limit)


@router.post("/repertoires/{repertoire_id}/confusable/hidden", status_code=204)
def hide(repertoire_id: int, body: HideIn, s: Db):
    repo.hide_pair(s, repertoire_id, body.position_ids)
    return Response(status_code=204)


@router.delete("/repertoires/{repertoire_id}/confusable/hidden", response_model=UnhideOut)
def unhide_all(repertoire_id: int, s: Db):
    return {"pairs": repo.unhide_all(s, repertoire_id)}
