"""Lichess game import API: your username, your recent Lichess games, importing them into Games."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import lichess_api
from app.db.session import get_session
from app.repositories import lichess_games as repo

router = APIRouter(prefix="/api/lichess", tags=["lichess"])
Db = Annotated[Session, Depends(get_session)]


class SettingsOut(BaseModel):
    username: str | None


class UsernameIn(BaseModel):
    username: str = Field(max_length=30)  # '' clears it


class LichessGameRow(BaseModel):
    id: str
    white: str
    white_rating: int | None
    black: str
    black_rating: int | None
    result: str
    my_color: str | None  # 'white' / 'black': which side your username played
    played_at: datetime | None
    speed: str  # 'Blitz', 'Rapid', ...
    clock: str  # '10+0', '3 days/move'
    rated: bool
    opening: str | None
    plies: int
    status: str
    importable: bool
    not_importable: str | None  # why not
    game_id: int | None  # its copy in Games, if imported


class RecentOut(BaseModel):
    username: str
    games: list[LichessGameRow]


class ImportOut(BaseModel):
    game_id: int
    created: bool


class LatestOut(ImportOut):
    lichess_id: str


class ImportNewOut(BaseModel):
    imported: int
    already: int
    skipped: int
    game_ids: list[int]


def _lichess(fn):
    try:
        return fn()
    except repo.NoUsername as exc:
        raise HTTPException(409, str(exc)) from exc
    except repo.NotImportable as exc:
        raise HTTPException(422, str(exc)) from exc
    except lichess_api.NotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except lichess_api.LichessError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/settings", response_model=SettingsOut)
def get_settings(s: Db):
    return {"username": repo.username(s)}


@router.put("/username", response_model=SettingsOut)
def set_username(body: UsernameIn, s: Db):
    try:
        return {"username": repo.set_username(s, body.username)}
    except repo.BadUsername as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/games", response_model=RecentOut)
def recent_games(s: Db, max: Annotated[int, Query(ge=1, le=repo.MAX_LIST)] = 20):
    """Your latest finished games on Lichess (fetched now; nothing is stored)."""
    return _lichess(lambda: repo.recent(s, max))


@router.post("/games/{game_id}/import", response_model=ImportOut)
def import_game(game_id: str, s: Db):
    """Copy a Lichess game into Games (or find the copy already there)."""
    return _lichess(lambda: repo.import_game(s, game_id))


@router.post("/latest", response_model=LatestOut)
def import_latest(s: Db):
    """Your most recent finished Lichess game, imported (or found) in Games."""
    return _lichess(lambda: repo.import_latest(s))


@router.post("/import-new", response_model=ImportNewOut)
def import_new(s: Db, max: Annotated[int, Query(ge=1, le=repo.MAX_LIST)] = 20):
    """Import every one of your last `max` Lichess games that isn't in Games yet."""
    return _lichess(lambda: repo.import_new(s, max))
