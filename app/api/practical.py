"""Practical tab: your-move positions in an opening, Lichess replies at 2000+, engine lines."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import explorer
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
    ratings: str
    positions: list[PracticalPosition]


class ExplorerMove(BaseModel):
    uci: str
    san: str
    white: int
    draws: int
    black: int


class ExplorerOut(BaseModel):
    key: str
    white: int
    draws: int
    black: int
    moves: list[ExplorerMove]


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


@router.get("/practical/explorer", response_model=ExplorerOut)
def explorer_lookup(fen: Annotated[str, Query(min_length=10, max_length=120)], s: Db):
    """How Lichess players at the practical ratings (2000+) continue from a position."""
    try:
        return repo.lookup(s, fen)
    except repo.NoToken as exc:
        raise HTTPException(409, str(exc)) from exc
    except explorer.ExplorerError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post("/practical/evals/lookup", response_model=EvalsLookupOut)
def evals_lookup(body: EvalsLookupIn, s: Db):
    return {"evals": repo.evals_lookup(s, body.fens, body.multipv, body.movetime_ms)}


@router.post("/practical/evals", response_model=SavedOut)
def evals_save(body: EvalsSaveIn, s: Db):
    return {"saved": repo.evals_save(s, [e.model_dump() for e in body.evals])}
