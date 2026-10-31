"""Repertoire API: repertoires, openings, lines, move explorer and position comments.

Positions are passed as FEN (`fen` query parameter or body field); move counters are ignored.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api import schemas as sch
from app.db.session import get_session
from app.repositories import repertoire as repo

router = APIRouter(prefix="/api", tags=["repertoire"])
Db = Annotated[Session, Depends(get_session)]
Fen = Annotated[str, Query(min_length=1, description="FEN of the position")]


# ---- repertoires ----------------------------------------------------------


@router.get("/repertoires", response_model=list[sch.RepertoireOut])
def list_repertoires(s: Db):
    return repo.list_repertoires(s)


@router.post("/repertoires", response_model=sch.RepertoireOut, status_code=201)
def create_repertoire(body: sch.RepertoireIn, s: Db):
    rep = repo.create_repertoire(s, body.name)
    return {"id": rep.id, "name": rep.name, "openings": 0}


@router.patch("/repertoires/{repertoire_id}", response_model=sch.RepertoireOut)
def rename_repertoire(repertoire_id: int, body: sch.RepertoireIn, s: Db):
    rep = repo.rename_repertoire(s, repertoire_id, body.name)
    return {"id": rep.id, "name": rep.name, "openings": len(rep.openings)}


@router.delete("/repertoires/{repertoire_id}", status_code=204)
def delete_repertoire(repertoire_id: int, s: Db):
    repo.delete_repertoire(s, repertoire_id)
    return Response(status_code=204)


# ---- openings ---------------------------------------------------------------


@router.get("/repertoires/{repertoire_id}/openings", response_model=list[sch.OpeningOut])
def list_openings(repertoire_id: int, s: Db):
    return repo.list_openings(s, repertoire_id)


@router.post("/repertoires/{repertoire_id}/openings", response_model=sch.OpeningOut, status_code=201)
def create_opening(repertoire_id: int, body: sch.OpeningIn, s: Db):
    return repo.create_opening(s, repertoire_id, body.name, body.color)


@router.get("/openings/{opening_id}", response_model=sch.OpeningOut)
def get_opening(opening_id: int, s: Db):
    return repo.opening_summary(s, opening_id)


@router.patch("/openings/{opening_id}", response_model=sch.OpeningOut)
def update_opening(opening_id: int, body: sch.OpeningPatch, s: Db):
    return repo.update_opening(s, opening_id, body.name, body.color)


@router.delete("/openings/{opening_id}", status_code=204)
def delete_opening(opening_id: int, s: Db):
    repo.delete_opening(s, opening_id)
    return Response(status_code=204)


# ---- lines ------------------------------------------------------------------


@router.get("/openings/{opening_id}/lines", response_model=list[sch.LineOut])
def list_lines(opening_id: int, s: Db):
    return repo.list_lines(s, opening_id)


@router.post("/openings/{opening_id}/lines", response_model=sch.AddLineOut)
def add_line(opening_id: int, body: sch.LineIn, s: Db, response: Response):
    result = repo.add_line(s, opening_id, body.moves)
    response.status_code = 201 if result.status == "created" else 200
    return result.__dict__


@router.get("/openings/{opening_id}/lines/through", response_model=sch.LineCountOut)
def count_lines_through(opening_id: int, fen: Fen, s: Db):
    """How many lines a delete at this position would remove (for the confirmation prompt)."""
    return {"lines": len(repo.lines_through(s, opening_id, fen))}


@router.delete("/openings/{opening_id}/lines/through", response_model=sch.LineCountOut)
def delete_lines_through(opening_id: int, fen: Fen, s: Db):
    return {"lines": repo.delete_lines_through(s, opening_id, fen)}


@router.delete("/lines/{line_id}", status_code=204)
def delete_line(line_id: int, s: Db):
    repo.delete_line(s, line_id)
    return Response(status_code=204)


# ---- explorer + comments ----------------------------------------------------


@router.get("/openings/{opening_id}/explorer", response_model=list[sch.ExplorerMoveOut])
def explorer(opening_id: int, fen: Fen, s: Db):
    return repo.explorer(s, opening_id, fen)


@router.get("/repertoires/{repertoire_id}/comment", response_model=sch.CommentOut)
def get_comment(repertoire_id: int, fen: Fen, s: Db):
    return {"fen": fen, "comment": repo.get_comment(s, repertoire_id, fen)}


@router.put("/repertoires/{repertoire_id}/comment", response_model=sch.CommentOut)
def set_comment(repertoire_id: int, body: sch.CommentIn, s: Db):
    return {"fen": body.fen, "comment": repo.set_comment(s, repertoire_id, body.fen, body.comment)}
