"""Dashboard API: an opening's stats and lines with review history; resets."""

from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.schemas import LineCountOut, OpeningOut
from app.db.session import get_session
from app.repositories import dashboard as repo

router = APIRouter(prefix="/api", tags=["dashboard"])
Db = Annotated[Session, Depends(get_session)]


class DashboardStats(BaseModel):
    lines: int
    due: int
    next_review_on: date | None
    reviews: int
    accuracy: float | None  # 0..1, share of reviews without mistakes


class DashboardLine(BaseModel):
    id: int
    moves: list[str]  # SAN
    next_review_on: date
    streak: int
    recent: list[bool]  # last 5 review results, oldest first
    reviews: int
    correct: int
    last_reviewed_at: datetime | None
    tags: list[int]  # ids of the branch tags this line passes through


class DashboardOut(BaseModel):
    opening: OpeningOut
    tag_id: int | None
    stats: DashboardStats
    lines: list[DashboardLine]


@router.get("/openings/{opening_id}/dashboard", response_model=DashboardOut)
def dashboard(opening_id: int, s: Db, tag_id: int | None = None):
    return repo.dashboard(s, opening_id, tag_id)


@router.post("/lines/{line_id}/reset", status_code=204)
def reset_line(line_id: int, s: Db):
    repo.reset_line(s, line_id)
    return Response(status_code=204)


@router.post("/openings/{opening_id}/reset", response_model=LineCountOut)
def reset_opening(opening_id: int, s: Db):
    return {"lines": repo.reset_opening(s, opening_id)}


@router.delete("/openings/{opening_id}/lines", response_model=LineCountOut)
def delete_all_lines(opening_id: int, s: Db):
    return {"lines": repo.delete_all_lines(s, opening_id)}
