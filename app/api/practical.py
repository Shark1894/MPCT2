"""Practical tab: your-move positions in an opening, and the engine lines the browser works out."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.orm import Session

from app.api.evals import EvalLine, Fen
from app.db.session import get_session
from app.repositories import practical as repo

router = APIRouter(prefix="/api", tags=["practical"])
Db = Annotated[Session, Depends(get_session)]


class PracticalPosition(BaseModel):
    key: str
    fen: str
    sans: list[str]  # from the start
    ply: int
    repertoire: list[str]  # the move(s) your lines play here (UCI)


class PositionsOut(BaseModel):
    opening_id: int
    opening: str
    color: str
    tag_id: int | None
    positions: list[PracticalPosition]


class EvalsLookupIn(BaseModel):
    fens: list[Fen] = Field(max_length=500)
    multipv: int = Field(ge=1, le=10)
    movetime_ms: int = Field(ge=0, le=60000)


class PracticalEvalOut(BaseModel):
    multipv: int
    movetime_ms: int
    depth: int
    lines: list[EvalLine]


class EvalsLookupOut(BaseModel):
    evals: list[PracticalEvalOut | None]


class PracticalEvalIn(BaseModel):
    fen: Fen
    multipv: int = Field(ge=1, le=10)
    movetime_ms: int = Field(ge=10, le=60000)
    depth: int = Field(ge=0, le=245)
    engine: str = Field(max_length=60)
    lines: list[EvalLine] = Field(max_length=10)  # empty = no legal moves


class EvalsSaveIn(BaseModel):
    evals: list[PracticalEvalIn] = Field(max_length=500)


class SavedOut(BaseModel):
    saved: int


@router.get("/practical/positions", response_model=PositionsOut)
def positions(opening_id: int, s: Db, tag_id: int | None = None):
    """Your-move positions in an opening (from a branch tag's position on, if given)."""
    return repo.positions(s, opening_id, tag_id)


@router.post("/practical/evals/lookup", response_model=EvalsLookupOut)
def evals_lookup(body: EvalsLookupIn, s: Db):
    return {"evals": repo.evals_lookup(s, body.fens, body.multipv, body.movetime_ms)}


@router.post("/practical/evals", response_model=SavedOut)
def evals_save(body: EvalsSaveIn, s: Db):
    return {"saved": repo.evals_save(s, [e.model_dump() for e in body.evals])}


Key = Annotated[str, StringConstraints(min_length=10, max_length=100)]
Uci = Annotated[str, StringConstraints(pattern=r"^[a-h][1-8][a-h][1-8][qrbn]?$")]


class SeenLookupIn(BaseModel):
    keys: list[Key] = Field(max_length=1000)


class SeenIn(BaseModel):
    key: Key  # the position (as in /practical/positions)
    uci: Uci  # the move played there


class SeenOut(BaseModel):
    key: str
    uci: str
    seen_at: datetime


@router.post("/practical/seen/lookup", response_model=list[SeenOut])
def seen(body: SeenLookupIn, s: Db):
    """The moves you've looked at in these positions."""
    return repo.seen(s, body.keys)


@router.put("/practical/seen", response_model=SeenOut)
def mark_seen(body: SeenIn, s: Db):
    return repo.mark_seen(s, body.key, body.uci)


@router.delete("/practical/seen", status_code=204)
def unmark_seen(body: SeenIn, s: Db):
    repo.unmark_seen(s, body.key, body.uci)
    return Response(status_code=204)
