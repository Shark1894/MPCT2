"""Games API: list/search, create, update, delete, PGN import/export, repertoire check."""

import re
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.orm import Session

from app.api.schemas import LineMoveOut, Uci
from app.db.session import get_session
from app.repositories import games as repo

router = APIRouter(prefix="/api", tags=["games"])
Db = Annotated[Session, Depends(get_session)]
Text100 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
Result = Literal["1-0", "0-1", "1/2-1/2", "*"]


class GameMeta(BaseModel):
    white: Text100 = ""
    black: Text100 = ""
    white_team: Text100 = ""
    black_team: Text100 = ""
    competition: Annotated[str, StringConstraints(strip_whitespace=True, max_length=150)] = ""
    played_on: date | None = None
    result: Result = "*"


class GameIn(GameMeta):
    start_fen: str | None = None
    moves: list[Uci] = Field(default_factory=list, max_length=1000)


class GamePatch(BaseModel):
    """Only the fields sent are changed; 'moves' replaces all moves."""

    white: Text100 | None = None
    black: Text100 | None = None
    white_team: Text100 | None = None
    black_team: Text100 | None = None
    competition: Annotated[str, StringConstraints(strip_whitespace=True, max_length=150)] | None = None
    played_on: date | None = None
    result: Result | None = None
    start_fen: str | None = None  # changing it requires 'moves' too
    moves: list[Uci] | None = Field(default=None, max_length=1000)


class SideCountsOut(BaseModel):
    inaccuracy: int
    mistake: int
    blunder: int


class GameReviewInfo(BaseModel):
    white_accuracy: float | None
    black_accuracy: float | None
    counts: dict[str, SideCountsOut]
    movetime_ms: int
    reviewed_at: datetime


class GameSummary(GameMeta):
    id: int
    start_fen: str | None
    plies: int
    opening: list[str]  # first few moves (SAN)
    review: GameReviewInfo | None = None  # current engine review
    lichess_id: str | None = None  # imported from lichess.org


class GameOut(GameSummary):
    moves: list[LineMoveOut]


class PgnIn(BaseModel):
    pgn: str = Field(max_length=5_000_000)


class PgnImportOut(BaseModel):
    imported: int
    duplicates: int
    game_ids: list[int]
    errors: list[str]


class CheckIn(BaseModel):
    moves: list[Uci] = Field(max_length=1000)  # from the initial position


class CheckOut(BaseModel):
    status: Literal["deviation", "end_of_book", "in_book"]
    ply: int
    played: str | None
    by: Literal["you", "opponent"] | None
    repertoire: list[str]


class PlayerOut(BaseModel):
    name: str
    games: int


def _filters(player, color, result, reviewed) -> dict:
    return {"player": player, "color": color, "result": result, "reviewed": reviewed}


@router.get("/games", response_model=list[GameSummary])
def list_games(
    s: Db,
    q: str | None = None,
    player: str | None = None,
    color: str | None = None,
    result: str | None = None,
    reviewed: str | None = None,
):
    try:
        return repo.list_games(s, q, **_filters(player, color, result, reviewed))
    except repo.BadFilter as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/games/players", response_model=list[PlayerOut])
def list_players(s: Db):
    """Player names in the games (for the filter), most games first."""
    return repo.list_players(s)


@router.get("/pgn/games")
def export_all_pgn(
    s: Db,
    q: str | None = None,
    player: str | None = None,
    color: str | None = None,
    result: str | None = None,
    reviewed: str | None = None,
):
    """All games (or those matching q and the filters) as one PGN download."""
    try:
        text = repo.export_all_pgn(s, q, **_filters(player, color, result, reviewed))
    except repo.BadFilter as exc:
        raise HTTPException(422, str(exc)) from exc
    return Response(
        text,
        media_type="application/x-chess-pgn",
        headers={"Content-Disposition": 'attachment; filename="mpct-games.pgn"'},
    )


@router.post("/games", response_model=GameOut, status_code=201)
def create_game(body: GameIn, s: Db):
    return repo.create_game(s, body.model_dump())


@router.get("/games/{game_id}", response_model=GameOut)
def get_game(game_id: int, s: Db):
    return repo.get_game(s, game_id)


@router.patch("/games/{game_id}", response_model=GameOut)
def update_game(game_id: int, body: GamePatch, s: Db):
    return repo.update_game(s, game_id, body.model_dump(exclude_unset=True))


@router.delete("/games/{game_id}", status_code=204)
def delete_game(game_id: int, s: Db):
    repo.delete_game(s, game_id)
    return Response(status_code=204)


@router.get("/games/{game_id}/pgn")
def export_pgn(game_id: int, s: Db):
    pgn = repo.export_pgn(s, game_id)
    game = repo.get_game(s, game_id)
    name = "-".join(x for x in [str(game["played_on"] or ""), game["white"], "v", game["black"]] if x) or f"game-{game_id}"
    filename = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:80] + ".pgn"
    return Response(
        pgn,
        media_type="application/x-chess-pgn",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/games/import-pgn", response_model=PgnImportOut)
def import_pgn(body: PgnIn, s: Db):
    return repo.import_pgn(s, body.pgn)


@router.post("/openings/{opening_id}/check", response_model=CheckOut)
def check_against_repertoire(opening_id: int, body: CheckIn, s: Db):
    """Where do these moves (e.g. a game) leave the opening's repertoire?"""
    return repo.check_against_repertoire(s, opening_id, body.moves)
