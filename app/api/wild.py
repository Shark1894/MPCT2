"""Repertoire in the wild API: watched positions, matching tournament games, fetch status."""

from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, StringConstraints
from sqlalchemy.orm import Session

from app import wild_fetch
from app.config import settings
from app.db.session import get_session
from app.repositories import wild as repo

router = APIRouter(prefix="/api", tags=["wild"])
MinElo = Annotated[int | None, Query(ge=0, le=3500, description="Only games where the stronger player is rated at least this")]
Db = Annotated[Session, Depends(get_session)]
Label = Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)]


class WatchIn(BaseModel):
    fen: str
    label: Label = ""


class WatchPatch(BaseModel):
    label: Label


class WatchOut(BaseModel):
    id: int
    opening_id: int
    opening_name: str
    color: str
    label: str
    key: str  # the position (FEN without move counters)
    path: list[str]  # SAN moves of the shortest stored route to it
    games: int  # stored games reaching it
    latest_played_on: date | None


class Match(BaseModel):
    watch_id: int
    ply: int  # the move that reached the watched position


class WildGameOut(BaseModel):
    id: int
    source: str  # "lichess" | "twic"
    white: str
    black: str
    white_elo: int | None
    black_elo: int | None
    event: str
    site: str
    round: str
    played_on: date | None
    result: str
    plies: int
    imported_at: datetime


class WildGameRow(WildGameOut):
    matches: list[Match]


class WildGamesOut(BaseModel):
    total: int
    games: list[WildGameRow]


class WildGameFull(WildGameOut):
    moves: list[str]  # UCI


class SavedOut(BaseModel):
    game_id: int
    created: bool


class StatusOut(BaseModel):
    enabled: bool
    running: bool
    step: str
    errors: list[str]
    started_at: datetime | None
    finished_at: datetime | None
    next_run_at: datetime | None
    added: int  # new games in the last run
    games: int  # games stored
    oldest_played_on: date | None
    newest_played_on: date | None
    last_fetch_at: datetime | None
    twic_first: int | None  # TWIC issues fetched: first..
    twic_issue: int | None  # ..latest
    new_games: int  # games for this repertoire's watches imported after `since`


@router.get("/repertoires/{repertoire_id}/watches", response_model=list[WatchOut])
def list_watches(repertoire_id: int, s: Db, min_elo: MinElo = None):
    return repo.list_watches(s, repertoire_id, min_elo)


@router.get("/openings/{opening_id}/watches", response_model=list[WatchOut])
def opening_watches(opening_id: int, s: Db, min_elo: MinElo = None):
    return repo.opening_watches(s, opening_id, min_elo)


@router.post("/openings/{opening_id}/watches", response_model=WatchOut, status_code=201)
def create_watch(opening_id: int, body: WatchIn, s: Db):
    return repo.create_watch(s, opening_id, body.fen, body.label)


@router.patch("/watches/{watch_id}", response_model=WatchOut)
def update_watch(watch_id: int, body: WatchPatch, s: Db):
    return repo.update_watch(s, watch_id, body.label)


@router.delete("/watches/{watch_id}", status_code=204)
def delete_watch(watch_id: int, s: Db):
    repo.delete_watch(s, watch_id)
    return Response(status_code=204)


@router.get("/repertoires/{repertoire_id}/wild-games", response_model=WildGamesOut)
def wild_games(
    repertoire_id: int,
    s: Db,
    watch_id: int | None = None,
    q: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    min_elo: MinElo = None,
):
    return repo.list_games(s, repertoire_id, watch_id, q, limit, offset, min_elo)


@router.get("/wild-games/{game_id}", response_model=WildGameFull)
def wild_game(game_id: int, s: Db):
    return repo.get_game(s, game_id)


@router.post("/wild-games/{game_id}/save", response_model=SavedOut)
def save_wild_game(game_id: int, s: Db):
    return repo.save_to_games(s, game_id)


def _status(s: Session, repertoire_id: int | None, since: datetime | None, min_elo: int | None = None) -> dict:
    st = wild_fetch.state
    return {
        "enabled": settings.wild_fetch,
        "running": st["running"],
        "step": st["step"],
        "errors": st["errors"],
        "started_at": st["started_at"],
        "finished_at": st["finished_at"],
        "next_run_at": st["next_run_at"],
        "added": st["added"],
    } | repo.stats(s, repertoire_id, since, min_elo)


@router.get("/wild/status", response_model=StatusOut)
def status(s: Db, repertoire_id: int | None = None, since: datetime | None = None, min_elo: MinElo = None):
    return _status(s, repertoire_id, since, min_elo)


@router.post("/wild/refresh", response_model=StatusOut, status_code=202)
def refresh(s: Db, repertoire_id: int | None = None):
    """Start fetching new games now (no-op if a fetch is already running)."""
    wild_fetch.start_now()
    return _status(s, repertoire_id, None)
