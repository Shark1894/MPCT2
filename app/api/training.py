"""Training API: lines to review and recording finished reviews."""

from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.schemas import Color, LineMoveOut, Uci
from app.db.session import get_session
from app.repositories import training as repo

router = APIRouter(prefix="/api", tags=["training"])
Db = Annotated[Session, Depends(get_session)]


class TrainingOpeningOut(BaseModel):
    id: int
    name: str
    color: Color


class TrainingLineOut(BaseModel):
    id: int
    next_review_on: date
    streak: int
    moves: list[LineMoveOut]


class TrainingOut(BaseModel):
    opening: TrainingOpeningOut
    lines: list[TrainingLineOut]


class AttemptIn(BaseModel):
    ply: int = Field(ge=1)
    uci: Uci


class ReviewIn(BaseModel):
    practice: bool = False
    attempts: list[AttemptIn] = Field(max_length=1000)


class ReviewOut(BaseModel):
    line_id: int
    correct: bool
    mistakes: int
    practice: bool
    streak: int
    next_review_on: date


@router.get("/openings/{opening_id}/training", response_model=TrainingOut)
def training_lines(
    opening_id: int,
    s: Db,
    mode: Annotated[Literal["due", "all"], Query()] = "due",
    line_id: int | None = None,
    tag_id: int | None = None,
):
    return repo.training_lines(s, opening_id, mode, line_id, tag_id)


@router.post("/lines/{line_id}/reviews", response_model=ReviewOut, status_code=201)
def record_review(line_id: int, body: ReviewIn, s: Db):
    return repo.record_review(s, line_id, [a.model_dump() for a in body.attempts], body.practice)
