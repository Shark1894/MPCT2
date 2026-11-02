"""Evals API: saved engine analysis of positions, so a review never analyses a position twice."""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, StringConstraints, model_validator
from sqlalchemy.orm import Session

from app.api.schemas import Uci
from app.db.session import get_session
from app.repositories import evals as repo

router = APIRouter(prefix="/api", tags=["evals"])
Db = Annotated[Session, Depends(get_session)]

Fen = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=100)]


class Score(BaseModel):
    """From White's point of view: centipawns, or moves to mate (negative = Black mates)."""

    cp: int | None = Field(default=None, ge=-100000, le=100000)
    mate: int | None = Field(default=None, ge=-500, le=500)

    @model_validator(mode="after")
    def one_kind(self):
        if (self.cp is None) == (self.mate is None):
            raise ValueError("score needs exactly one of cp or mate")
        return self


class EvalLine(BaseModel):
    uci: Uci
    score: Score
    pv: list[Uci] = Field(min_length=1, max_length=40)


class EvalIn(BaseModel):
    fen: Fen
    movetime_ms: int = Field(ge=10, le=600000)
    depth: int = Field(ge=0, le=245)
    engine: str = Field(max_length=60)
    lines: list[EvalLine] = Field(max_length=5)  # empty = no legal moves (mate/stalemate)


class EvalOut(BaseModel):
    depth: int
    movetime_ms: int
    lines: list[EvalLine]
    engine: str
    updated_at: datetime


class LookupIn(BaseModel):
    fens: list[Fen] = Field(max_length=1000)
    min_movetime_ms: int = Field(default=0, ge=0)


class LookupOut(BaseModel):
    evals: list[EvalOut | None]  # same order as the FENs asked for


class SaveIn(BaseModel):
    evals: list[EvalIn] = Field(max_length=1000)


class SaveOut(BaseModel):
    saved: int


@router.post("/evals/lookup", response_model=LookupOut)
def lookup(body: LookupIn, s: Db):
    return {"evals": repo.lookup(s, body.fens, body.min_movetime_ms)}


@router.post("/evals", response_model=SaveOut)
def save(body: SaveIn, s: Db):
    return {"saved": repo.save(s, [e.model_dump(exclude_none=True) for e in body.evals])}
