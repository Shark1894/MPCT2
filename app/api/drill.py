"""Position drill API: random repertoire positions to answer, and the answers given."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.schemas import Color, LineMoveOut, Uci
from app.db.session import get_session
from app.repositories import drill as repo

router = APIRouter(prefix="/api", tags=["drill"])
Db = Annotated[Session, Depends(get_session)]


class DrillOpeningOut(BaseModel):
    id: int
    name: str
    color: Color


class ExpectedOut(BaseModel):
    uci: str
    san: str


class DrillPositionOut(BaseModel):
    opening: DrillOpeningOut
    position_id: int
    fen: str
    ply: int
    expected: list[ExpectedOut]
    line_id: int
    path: list[str]
    rest: list[LineMoveOut]


class DrillOut(BaseModel):
    total: int  # different positions in the scope
    positions: list[DrillPositionOut]


class ResultIn(BaseModel):
    opening_id: int
    position_id: int
    expected_uci: Uci
    correct: bool
    wrong: list[Uci] = Field(default_factory=list, max_length=repo.MAX_WRONG)


class ResultsIn(BaseModel):
    results: list[ResultIn] = Field(min_length=1, max_length=repo.MAX_COUNT)


class ResultsOut(BaseModel):
    saved: int


@router.get("/drill", response_model=DrillOut)
def drill_positions(
    s: Db,
    repertoire_id: int | None = None,
    opening_id: int | None = None,
    tag_id: int | None = None,
    count: Annotated[int, Query(ge=1, le=repo.MAX_COUNT)] = 10,
):
    """Random positions where it's your move: the whole repertoire, one opening, or a branch."""
    return repo.drill_positions(s, repertoire_id=repertoire_id, opening_id=opening_id, tag_id=tag_id, count=count)


@router.post("/drill/results", response_model=ResultsOut)
def record_results(body: ResultsIn, s: Db):
    """How each drilled position went (practice: schedules are untouched)."""
    return {"saved": repo.record_results(s, [r.model_dump() for r in body.results])}
