"""Puzzles API: the Lichess puzzle database, your puzzle rating and attempts."""

from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import puzzle_import
from app.core.puzzles import THEMES
from app.db.session import get_session
from app.repositories import puzzles as repo

router = APIRouter(prefix="/api/puzzles", tags=["puzzles"])
Db = Annotated[Session, Depends(get_session)]


class PuzzleOut(BaseModel):
    id: str
    fen: str  # before the opponent's first move
    moves: list[str]  # UCI: the opponent's move, then the solution
    rating: int
    rating_deviation: int
    popularity: int
    nb_plays: int
    themes: list[str]
    theme_names: list[str]
    opening_tags: list[str]
    game_url: str
    tried: int  # your earlier attempts (a retry isn't rated)


class NextPuzzleOut(PuzzleOut):
    window: int  # how far from your rating it searched (200 unless that ran out)


class AttemptIn(BaseModel):
    solved: bool
    seconds: int | None = Field(default=None, ge=0, le=86400)


class AttemptOut(BaseModel):
    puzzle_id: str
    solved: bool
    rated: bool
    rating_before: int
    rating_after: int
    change: int
    rd: int
    provisional: bool


class HistoryPoint(BaseModel):
    date: date
    rating: int


class RecentAttempt(BaseModel):
    puzzle_id: str
    fen: str | None = None  # the position you solved from (None if the puzzle is gone)
    attempted_at: datetime
    solved: bool
    rated: bool
    puzzle_rating: int
    change: int
    themes: list[str]


class ThemeResult(BaseModel):
    theme: str
    name: str
    attempts: int
    solved: int


class Today(BaseModel):
    attempts: int
    solved: int


class SummaryOut(BaseModel):
    rating: int
    rd: int
    provisional: bool
    attempts: int
    solved: int
    rated: int
    rated_solved: int
    today: Today
    history: list[HistoryPoint]  # last rating of each day, last year
    recent: list[RecentAttempt]
    themes: list[ThemeResult]  # rated results per theme (5+ attempts), weakest first


class StatusOut(BaseModel):
    puzzles: int
    imported_at: datetime | None
    source: str | None
    importing: bool
    step: str
    loaded: int
    expected: int
    error: str | None


class ThemeOut(BaseModel):
    theme: str
    name: str


def _status(s: Session) -> dict:
    st = puzzle_import.state
    return repo.status(s) | {
        "importing": st["running"],
        "step": st["step"],
        "loaded": st["loaded"],
        "expected": puzzle_import.EXPECTED,
        "error": st["error"],
    }


@router.get("/status", response_model=StatusOut)
def status(s: Db):
    return _status(s)


@router.post("/import", response_model=StatusOut, status_code=202)
def start_import(s: Db):
    """Download the Lichess puzzle database and replace the puzzles (runs in the background)."""
    puzzle_import.start_import()
    return _status(s)


@router.get("/themes", response_model=list[ThemeOut])
def themes():
    return [{"theme": k, "name": v} for k, v in THEMES.items()]


@router.get("/summary", response_model=SummaryOut)
def summary(s: Db):
    return repo.summary(s)


@router.get("/next", response_model=NextPuzzleOut)
def next_puzzle(
    s: Db,
    theme: str | None = None,
    exclude: Annotated[str | None, Query(pattern=r"^[A-Za-z0-9]{1,10}(,[A-Za-z0-9]{1,10})*$")] = None,
):
    """A random untried puzzle near your rating (optionally with a theme)."""
    if puzzle_import.state["running"]:
        raise repo.PuzzlesUnavailable("The puzzle database is being imported: try again in a few minutes")
    return repo.next_puzzle(s, theme, exclude.split(",") if exclude else None)


@router.get("/{puzzle_id}", response_model=PuzzleOut)
def get_puzzle(puzzle_id: str, s: Db):
    return repo.get_puzzle(s, puzzle_id)


@router.post("/{puzzle_id}/attempts", response_model=AttemptOut, status_code=201)
def record_attempt(puzzle_id: str, body: AttemptIn, s: Db):
    return repo.record_attempt(s, puzzle_id, body.solved, body.seconds)
