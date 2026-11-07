"""Time spent (Stats tab): the browser reports active stretches; the summary adds up all of them."""

from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import get_session
from app.repositories import time_spent as repo

router = APIRouter(prefix="/api", tags=["time"])
Db = Annotated[Session, Depends(get_session)]
Category = Literal["openings", "tactics", "endgames", "strategy", "games", "analysis"]


class StretchIn(BaseModel):
    key: str = Field(min_length=8, max_length=36, pattern=r"^[A-Za-z0-9-]+$")
    category: Category
    activity: str = Field(min_length=1, max_length=20, pattern=r"^[a-z-]+$")
    detail: str | None = Field(default=None, max_length=200)
    started_at: datetime
    seconds: float = Field(ge=0)


class StretchOut(BaseModel):
    key: str
    seconds: float


class TimeRow(BaseModel):
    date: date
    category: str
    activity: str
    detail: str | None
    seconds: float
    sessions: int


class TimeSummary(BaseModel):
    tz: str
    today: date
    tracking_since: datetime | None  # before this, only puzzle, Woodpecker and endgame attempt times exist
    rows: list[TimeRow]


@router.post("/time", response_model=StretchOut)
def record_time(body: StretchIn, s: Db):
    return repo.record(s, body.key, body.category, body.activity, body.detail, body.started_at, body.seconds)


@router.get("/time", response_model=TimeSummary)
def time_summary(s: Db, tz: str = "UTC"):
    """Seconds per local day (in the given IANA time zone; unknown zones fall back to UTC),
    category, activity and detail."""
    known = s.scalar(text("select exists(select 1 from pg_timezone_names where name = :tz)"), {"tz": tz})
    return repo.summary(s, tz if known else "UTC")
