from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Color = Literal["white", "black"]
Uci = Annotated[str, StringConstraints(pattern=r"^[a-h][1-8][a-h][1-8][qrbn]?$")]


class RepertoireIn(BaseModel):
    name: Name


class RepertoireOut(BaseModel):
    id: int
    name: str
    openings: int = 0


class OpeningIn(BaseModel):
    name: Name
    color: Color


class OpeningPatch(BaseModel):
    name: Name | None = None
    color: Color | None = None


class OpeningOut(BaseModel):
    id: int
    repertoire_id: int
    name: str
    color: Color
    created_on: date
    lines: int
    due: int
    next_review_on: date | None


class LineIn(BaseModel):
    moves: list[Uci] = Field(min_length=1, max_length=300, description="UCI moves from the initial position")


class AddLineOut(BaseModel):
    status: Literal["created", "extended", "exists"]
    line_id: int
    moves_added: int


class LineMoveOut(BaseModel):
    ply: int
    uci: str
    san: str


class LineOut(BaseModel):
    id: int
    created_on: date
    next_review_on: date
    moves: list[LineMoveOut]


class LineCountOut(BaseModel):
    lines: int


class ExplorerMoveOut(BaseModel):
    uci: str
    san: str
    lines: int


class CommentIn(BaseModel):
    fen: str
    comment: str = Field(max_length=10_000)


class CommentOut(BaseModel):
    fen: str
    comment: str
