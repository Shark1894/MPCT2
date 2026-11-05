"""Masters panel API: masters moves and top games for a position, and the games themselves."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import explorer
from app.db.session import get_session
from app.repositories import masters as repo

router = APIRouter(prefix="/api", tags=["masters"])
Db = Annotated[Session, Depends(get_session)]


class MastersMove(BaseModel):
    uci: str
    san: str
    white: int
    draws: int
    black: int
    games: int
    average_rating: int | None


class MastersGameRow(BaseModel):
    id: str
    white: str
    white_elo: int | None
    black: str
    black_elo: int | None
    result: str
    year: int | None
    month: str | None  # "YYYY-MM" as Lichess sends it
    uci: str | None  # the move played from this position


class MastersOut(BaseModel):
    key: str
    white: int
    draws: int
    black: int
    total: int
    moves: list[MastersMove]
    games: list[MastersGameRow]


class MastersGameFull(BaseModel):
    id: str
    source: str  # "masters"
    white: str
    black: str
    white_elo: int | None
    black_elo: int | None
    event: str
    site: str
    round: str
    played_on: date | None
    year: int | None
    month: int | None
    result: str
    plies: int
    moves: list[str]  # UCI


class SavedOut(BaseModel):
    game_id: int
    created: bool


def _explorer_errors(fn):
    try:
        return fn()
    except repo.NoToken as exc:
        raise HTTPException(409, str(exc)) from exc
    except explorer.ExplorerError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/masters", response_model=MastersOut)
def masters(fen: Annotated[str, Query(min_length=10, max_length=120)], s: Db):
    """Masters moves and top games from a position (looked up on Lichess the first time)."""
    return _explorer_errors(lambda: repo.lookup(s, fen))


@router.get("/masters/games/{game_id}", response_model=MastersGameFull)
def masters_game(game_id: str, s: Db):
    return _explorer_errors(lambda: repo.get_game(s, game_id))


@router.get("/masters/games/{game_id}/pgn", response_class=PlainTextResponse)
def masters_game_pgn(game_id: str, s: Db):
    text, name = repo.game_pgn(s, game_id)
    return PlainTextResponse(text, media_type="application/x-chess-pgn", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/masters/games/{game_id}/save", response_model=SavedOut)
def save_masters_game(game_id: str, s: Db):
    """Copy the game into Games (or find the copy already there)."""
    return repo.save_to_games(s, game_id)
