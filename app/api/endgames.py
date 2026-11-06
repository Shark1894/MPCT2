"""Endgame drills (Training tab): tablebase lookups, K+P v K positions, attempts and stats."""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import tablebase
from app.core.endgames import generate_kp
from app.db.session import get_session
from app.repositories import endgames as repo

router = APIRouter(prefix="/api", tags=["endgames"])
Db = Annotated[Session, Depends(get_session)]
Drill = Literal["kq", "kr", "kbb", "kbn", "kp"]
Result = Literal["mate", "promoted", "fifty", "stalemate", "material", "repetition", "thrown", "gave-up"]


class TbMove(BaseModel):
    uci: str
    san: str | None = None
    category: str | None = None  # the opponent's, after the move (their "loss" = a winning move)
    dtz: int | None = None
    dtm: int | None = None
    checkmate: bool | None = None
    stalemate: bool | None = None
    zeroing: bool | None = None
    insufficient_material: bool | None = None


class TbOut(BaseModel):
    category: str | None  # for the side to move: win / loss / draw (cursed-win, blessed-loss: 50-move rule)
    dtz: int | None
    dtm: int | None  # plies to mate, when known
    checkmate: bool
    stalemate: bool
    insufficient_material: bool
    moves: list[TbMove]  # best first for the side to move


class KpOut(BaseModel):
    fen: str
    color: str
    winning_moves: int
    tries: int


class AttemptIn(BaseModel):
    drill: Drill
    start_fen: str = Field(max_length=100)
    color: Literal["white", "black"]
    result: Result
    moves: int = Field(ge=0, le=1000)
    optimal: int | None = Field(default=None, ge=0, le=1000)
    hints: int = Field(default=0, ge=0, le=1000)
    seconds: float = Field(ge=0)


class AttemptOut(BaseModel):
    id: int
    drill: str
    start_fen: str
    color: str
    success: bool
    result: str
    moves: int
    optimal: int | None
    hints: int
    seconds: float
    finished_at: datetime


class DrillStats(BaseModel):
    attempts: int
    successes: int
    best_moves: int | None
    avg_moves: float | None
    avg_optimal: float | None
    avg_seconds: float | None
    recent: list[AttemptOut]


def _unavailable(exc: Exception):
    raise HTTPException(503, str(exc)) from exc


@router.get("/tablebase", response_model=TbOut)
def tablebase_lookup(fen: Annotated[str, Query(max_length=100)]):
    """Perfect-play information for a position with up to 7 pieces (503 if the tablebase can't be reached)."""
    try:
        return tablebase.lookup(fen)
    except tablebase.NotInTablebase as exc:
        raise HTTPException(422, str(exc)) from exc
    except tablebase.TablebaseUnavailable as exc:
        _unavailable(exc)


@router.get("/endgames/kp", response_model=KpOut)
def kp_position():
    """A K+P v K position that's won but needs the right idea (at most two winning moves)."""
    try:
        found = generate_kp(tablebase.lookup)
    except tablebase.TablebaseUnavailable as exc:
        _unavailable(exc)
    if found is None:
        raise HTTPException(503, "No suitable position found this time: try again")
    return found


@router.post("/endgames/attempts", response_model=AttemptOut)
def record_attempt(body: AttemptIn, s: Db):
    return repo.record(s, body.drill, body.start_fen, body.color, body.result, body.moves, body.optimal, body.hints, body.seconds)


@router.get("/endgames/stats", response_model=dict[str, DrillStats])
def drill_stats(s: Db):
    return repo.stats(s)
