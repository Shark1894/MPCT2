"""Dashboard API: an opening's stats and lines with review history; resets."""

from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.schemas import LineCountOut, OpeningOut
from app.db.session import get_session
from app.repositories import dashboard as repo
from app.repositories import insights

router = APIRouter(prefix="/api", tags=["dashboard"])
Db = Annotated[Session, Depends(get_session)]


class Mastery(BaseModel):
    new: int  # never reviewed
    learning: int  # streak 0-1
    known: int  # streak 2-4
    mastered: int  # streak 5+


class DashboardStats(BaseModel):
    lines: int
    due: int
    next_review_on: date | None
    reviews: int
    accuracy: float | None  # 0..1, share of reviews without mistakes
    mastery: Mastery


class ForecastDay(BaseModel):
    date: date
    due: int


class Forecast(BaseModel):
    days: list[ForecastDay]  # today first; overdue lines count as today
    later: int


class WrongMove(BaseModel):
    san: str
    count: int


class ProblemPosition(BaseModel):
    ply: int  # the move you keep getting wrong
    moves: list[str]  # SAN from the start up to the position
    expected: str
    wrong: list[WrongMove]  # most played wrong moves (last 90 days)
    times_wrong: int  # reviews with a mistake here (last 90 days)
    times_seen: int  # reviews reaching this move (last 90 days)
    right_since: int  # reviews right in a row since the last mistake
    last_wrong_at: datetime
    line_ids: list[int]  # lines through this move


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
    bookmarked: bool
    bookmark_note: str | None


class DashboardOut(BaseModel):
    opening: OpeningOut
    tag_id: int | None
    stats: DashboardStats
    forecast: Forecast
    problems: list[ProblemPosition]
    lines: list[DashboardLine]


class OverviewOpening(BaseModel):
    id: int
    name: str
    color: str
    lines: int
    due: int
    next_review_on: date | None
    reviews: int
    accuracy: float | None
    mastery: Mastery


class OverviewOut(BaseModel):
    openings: list[OverviewOpening]


class ActivityDay(BaseModel):
    date: date
    reviews: int
    correct: int


class ActivityOut(BaseModel):
    today: date
    days: list[ActivityDay]  # oldest first, ending today
    current_run: int  # consecutive days trained, up to today (or yesterday)
    trained_today: bool
    longest_run: int
    active_days: int


@router.get("/openings/{opening_id}/dashboard", response_model=DashboardOut)
def dashboard(opening_id: int, s: Db, tag_id: int | None = None):
    return repo.dashboard(s, opening_id, tag_id)


@router.get("/repertoires/{repertoire_id}/overview", response_model=OverviewOut)
def overview(repertoire_id: int, s: Db):
    return {"openings": insights.overview(s, repertoire_id)}


@router.get("/activity", response_model=ActivityOut)
def activity(s: Db, tz: str = "UTC", days: Annotated[int, Query(ge=7, le=371)] = 182):
    """Training activity per day in the given IANA time zone (unknown zones fall back to UTC)."""
    known = s.scalar(text("select exists(select 1 from pg_timezone_names where name = :tz)"), {"tz": tz})
    return insights.activity(s, tz if known else "UTC", days)


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
