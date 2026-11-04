"""Engine reviews of your games (the browser runs the engine) and the puzzles from them: practice, names."""

from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.orm import Session

from app.api.schemas import Uci
from app.db.session import get_session
from app.repositories import game_puzzles as repo

router = APIRouter(prefix="/api/game-puzzles", tags=["game puzzles"])
reviews_router = APIRouter(prefix="/api/game-reviews", tags=["game puzzles"])
Db = Annotated[Session, Depends(get_session)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class StatusOut(BaseModel):
    names: list[str]
    names_set: bool  # False = worked out from your games
    games: int  # with enough moves to review
    reviewed: int  # with a current engine review
    unreviewed: int
    unknown: int  # reviewed, but neither side (or both) is one of your names


class NamesIn(BaseModel):
    names: list[Name] = Field(max_length=10)


class NamesOut(BaseModel):
    names: list[str]


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


class ReviewIn(BaseModel):
    correct: bool


class ReviewOut(BaseModel):
    id: int
    correct: bool
    streak: int
    next_review_on: date


@router.get("/status", response_model=StatusOut)
def status(s: Db):
    return repo.status(s)


@router.put("/names", response_model=NamesOut)
def set_names(body: NamesIn, s: Db):
    return {"names": repo.set_my_names(s, body.names)}


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


# ---- reviews ---------------------------------------------------------------------------------


class QueueGame(BaseModel):
    id: int
    white: str
    black: str
    played_on: date | None
    start_fen: str
    moves: list[str]  # UCI


class SideCounts(BaseModel):
    inaccuracy: int = Field(ge=0)
    mistake: int = Field(ge=0)
    blunder: int = Field(ge=0)


class Candidate(BaseModel):
    ply: int = Field(ge=1)
    best_uci: Uci
    best_pv: list[Uci] = Field(default_factory=list, max_length=20)
    before: float = Field(ge=0, le=100)  # the mover's winning chances with the best move
    after: float = Field(ge=0, le=100)  # after the move played


class Accuracy(BaseModel):
    w: float | None = Field(default=None, ge=0, le=100)
    b: float | None = Field(default=None, ge=0, le=100)


class GameReviewIn(BaseModel):
    moves: list[Uci] = Field(max_length=1000)  # the moves reviewed: must be the game's saved moves
    movetime_ms: int = Field(ge=10, le=600000)
    accuracy: Accuracy
    counts: dict[Literal["w", "b"], SideCounts]
    candidates: list[Candidate] = Field(max_length=1000)


class Skipped(BaseModel):
    repertoire: int
    lost: int
    small: int


class GameReviewOut(BaseModel):
    game_id: int
    puzzles: int  # on your side
    new: int
    skipped: Skipped


@reviews_router.get("/queue", response_model=list[QueueGame])
def review_queue(s: Db):
    """Games without a current engine review, newest first."""
    return repo.review_queue(s)


@reviews_router.post("/{game_id}", response_model=GameReviewOut)
def save_review(game_id: int, body: GameReviewIn, s: Db):
    return repo.save_review(
        s,
        game_id,
        body.moves,
        body.movetime_ms,
        body.accuracy.model_dump(),
        {k: v.model_dump() for k, v in body.counts.items()},
        [c.model_dump() for c in body.candidates],
    )
