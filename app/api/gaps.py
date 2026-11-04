"""Repertoire gap finder API: masters replies your repertoire doesn't cover."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import explorer
from app.api.schemas import Color
from app.db.session import get_session
from app.repositories import gaps as repo
from app.repositories.repertoire import get_opening

router = APIRouter(prefix="/api", tags=["gaps"])
Db = Annotated[Session, Depends(get_session)]


class GapOpening(BaseModel):
    id: int
    name: str
    color: Color


class GapScore(BaseModel):
    white: int
    draws: int
    black: int


class Gap(BaseModel):
    fen: str
    ply: int
    path: list[str]
    san: str
    uci: str
    share: float
    games: int
    position_games: int
    score: GapScore
    reach: float | None
    meet: float | None
    covered: list[str]


class GapsOut(BaseModel):
    opening: GapOpening
    positions: int
    checked: int
    gaps: list[Gap]


class ExplorerStatus(BaseModel):
    running: bool
    opening_id: int | None
    total: int
    done: int
    error: str | None
    token: bool


@router.get("/openings/{opening_id}/gaps", response_model=GapsOut)
def find_gaps(
    opening_id: int,
    s: Db,
    min_share: Annotated[float, Query(ge=0.5, le=50)] = repo.DEFAULT_MIN_SHARE,
    min_games: Annotated[int, Query(ge=1, le=1000)] = repo.DEFAULT_MIN_GAMES,
):
    """Uncovered masters replies, most often met first (from the positions looked up so far)."""
    return repo.find_gaps(s, opening_id, min_share, min_games)


@router.get("/explorer/status", response_model=ExplorerStatus)
def explorer_status():
    return explorer.status()


@router.post("/openings/{opening_id}/gaps/check", response_model=ExplorerStatus, status_code=202)
def check(opening_id: int, s: Db):
    """Look the opening's positions up in the masters explorer, in the background."""
    get_opening(s, opening_id)
    if not explorer.token_set():
        raise HTTPException(409, "The Lichess explorer needs an API token: add LICHESS_TOKEN to the server's .env and restart.")
    if not explorer.start_check(opening_id):
        raise HTTPException(409, "A check is already running.")
    return explorer.status()


@router.post("/explorer/stop", response_model=ExplorerStatus)
def stop():
    explorer.stop_check()
    return explorer.status()
