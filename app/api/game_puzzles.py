"""Puzzles from your own games API: scanning (the browser runs the engine), practice, names."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.orm import Session

from app.api.schemas import Uci
from app.db.session import get_session
from app.repositories import game_puzzles as repo

router = APIRouter(prefix="/api/game-puzzles", tags=["game puzzles"])
Db = Annotated[Session, Depends(get_session)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class ScanGame(BaseModel):
    id: int
    white: str
    black: str
    played_on: date | None
    competition: str
    color: str  # your side
    start_fen: str
    moves: list[str]  # UCI
    moves_hash: str


class UnknownGame(BaseModel):
    id: int
    white: str
    black: str


class StatusOut(BaseModel):
    names: list[str]
    names_set: bool  # False = worked out from your games
    to_scan: list[ScanGame]
    unknown: list[UnknownGame]  # neither side (or both) is one of your names
    scanned: int


class NamesIn(BaseModel):
    names: list[Name] = Field(max_length=10)


class NamesOut(BaseModel):
    names: list[str]


class Candidate(BaseModel):
    ply: int = Field(ge=1)
    best_uci: Uci
    best_pv: list[Uci] = Field(default_factory=list, max_length=20)
    before: float = Field(ge=0, le=100)  # your winning chances with the best move
    after: float = Field(ge=0, le=100)  # after the move you played


class ScanIn(BaseModel):
    game_id: int
    moves_hash: str = Field(max_length=40)
    movetime_ms: int = Field(ge=10, le=600000)
    candidates: list[Candidate] = Field(max_length=500)


class Skipped(BaseModel):
    repertoire: int
    lost: int
    small: int


class ScanOut(BaseModel):
    game_id: int
    found: int
    new: int
    skipped: Skipped


class GamePuzzleOut(BaseModel):
    id: int
    game_id: int
    ply: int
    move_number: int
    color: str
    fen: str  # before your move
    setup_fen: str  # before the opponent's previous move (shown first)
    setup_uci: str
    played_uci: str
    played_san: str
    best_uci: str
    best_san: str
    best_pv: list[str]
    before: float
    after: float
    label: str
    opponent: str
    played_on: date | None
    competition: str
    result: str
    streak: int
    next_review_on: date
    reviews: int
    correct: int


class SummaryOut(BaseModel):
    puzzles: int
    due: int
    blunders: int
    names: list[str]
    names_set: bool
    to_scan: int
    unknown: int
    scanned: int


class ReviewIn(BaseModel):
    correct: bool


class ReviewOut(BaseModel):
    id: int
    correct: bool
    streak: int
    next_review_on: date


class CountOut(BaseModel):
    games: int


@router.get("/status", response_model=StatusOut)
def status(s: Db):
    return repo.scan_status(s)


@router.get("/summary", response_model=SummaryOut)
def summary(s: Db):
    return repo.summary(s)


@router.put("/names", response_model=NamesOut)
def set_names(body: NamesIn, s: Db):
    return {"names": repo.set_my_names(s, body.names)}


@router.post("/scans", response_model=ScanOut)
def save_scan(body: ScanIn, s: Db):
    return repo.save_scan(s, body.game_id, body.moves_hash, body.movetime_ms, [c.model_dump() for c in body.candidates])


@router.post("/rescan", response_model=CountOut)
def rescan(s: Db):
    """Scan every game again next time."""
    return {"games": repo.reset_scans(s)}


@router.get("", response_model=list[GamePuzzleOut])
def list_puzzles(s: Db, due: bool = False, game_id: int | None = None):
    return repo.list_puzzles(s, due, game_id)


@router.post("/{puzzle_id}/reviews", response_model=ReviewOut)
def review(puzzle_id: int, body: ReviewIn, s: Db):
    return repo.record_review(s, puzzle_id, body.correct)


@router.delete("/{puzzle_id}", status_code=204)
def delete(puzzle_id: int, s: Db):
    repo.delete_puzzle(s, puzzle_id)
    return Response(status_code=204)
