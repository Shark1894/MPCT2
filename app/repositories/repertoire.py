"""Database access for repertoires, openings, lines, the move explorer and comments.

Functions take a Session and never commit: the caller owns the transaction
(one per API request, see app.db.session.get_session).
"""

from dataclasses import dataclass
from datetime import date

from sqlalchemy import delete, distinct, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.positions import key_from_fen, walk_line
from app.core.repertoire import plan_line
from app.db.models import Line, Move, Opening, Position, PositionComment, Repertoire


class NotFound(LookupError):
    pass


class Conflict(ValueError):
    pass


# ---- repertoires ----------------------------------------------------------


def list_repertoires(s: Session) -> list[dict]:
    counts = (
        select(Opening.repertoire_id, func.count(Opening.id).label("n"))
        .group_by(Opening.repertoire_id)
        .subquery()
    )
    rows = s.execute(
        select(Repertoire, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.repertoire_id == Repertoire.id)
        .order_by(Repertoire.name)
    ).all()
    return [{"id": r.id, "name": r.name, "openings": n} for r, n in rows]


def get_repertoire(s: Session, repertoire_id: int) -> Repertoire:
    rep = s.get(Repertoire, repertoire_id)
    if rep is None:
        raise NotFound(f"Repertoire {repertoire_id} not found")
    return rep


def create_repertoire(s: Session, name: str) -> Repertoire:
    if s.scalar(select(Repertoire.id).where(Repertoire.name == name)):
        raise Conflict(f"A repertoire called '{name}' already exists")
    rep = Repertoire(name=name)
    s.add(rep)
    s.flush()
    return rep


def rename_repertoire(s: Session, repertoire_id: int, name: str) -> Repertoire:
    rep = get_repertoire(s, repertoire_id)
    if s.scalar(select(Repertoire.id).where(Repertoire.name == name, Repertoire.id != repertoire_id)):
        raise Conflict(f"A repertoire called '{name}' already exists")
    rep.name = name
    s.flush()
    return rep


def delete_repertoire(s: Session, repertoire_id: int) -> None:
    s.delete(get_repertoire(s, repertoire_id))  # openings, lines, moves, comments cascade in the DB
    s.flush()


# ---- openings ---------------------------------------------------------------


def _opening_summary(s: Session, opening: Opening) -> dict:
    today = date.today()
    total, due = s.execute(
        select(func.count(Line.id), func.count(Line.id).filter(Line.next_review_on <= today)).where(
            Line.opening_id == opening.id
        )
    ).one()
    next_review = s.scalar(select(func.min(Line.next_review_on)).where(Line.opening_id == opening.id))
    return {
        "id": opening.id,
        "repertoire_id": opening.repertoire_id,
        "name": opening.name,
        "color": opening.color,
        "created_on": opening.created_on,
        "lines": total,
        "due": due,
        "next_review_on": next_review,
    }


def list_openings(s: Session, repertoire_id: int) -> list[dict]:
    get_repertoire(s, repertoire_id)
    openings = s.scalars(select(Opening).where(Opening.repertoire_id == repertoire_id).order_by(Opening.name))
    return [_opening_summary(s, o) for o in openings]


def get_opening(s: Session, opening_id: int) -> Opening:
    opening = s.get(Opening, opening_id)
    if opening is None:
        raise NotFound(f"Opening {opening_id} not found")
    return opening


def opening_summary(s: Session, opening_id: int) -> dict:
    return _opening_summary(s, get_opening(s, opening_id))


def _check_opening_name(s: Session, repertoire_id: int, name: str, exclude_id: int | None = None) -> None:
    q = select(Opening.id).where(Opening.repertoire_id == repertoire_id, Opening.name == name)
    if exclude_id is not None:
        q = q.where(Opening.id != exclude_id)
    if s.scalar(q):
        raise Conflict(f"An opening called '{name}' already exists in this repertoire")


def create_opening(s: Session, repertoire_id: int, name: str, color: str) -> dict:
    get_repertoire(s, repertoire_id)
    _check_opening_name(s, repertoire_id, name)
    opening = Opening(repertoire_id=repertoire_id, name=name, color=color)
    s.add(opening)
    s.flush()
    s.refresh(opening)
    return _opening_summary(s, opening)


def update_opening(s: Session, opening_id: int, name: str | None = None, color: str | None = None) -> dict:
    opening = get_opening(s, opening_id)
    if name is not None and name != opening.name:
        _check_opening_name(s, opening.repertoire_id, name, exclude_id=opening_id)
        opening.name = name
    if color is not None:
        opening.color = color
    s.flush()
    return _opening_summary(s, opening)


def delete_opening(s: Session, opening_id: int) -> None:
    s.delete(get_opening(s, opening_id))
    s.flush()


# ---- positions --------------------------------------------------------------


def ensure_positions(s: Session, keys: set[str]) -> dict[str, int]:
    """Insert any missing positions and return {key: id} for all of them."""
    if not keys:
        return {}
    s.execute(pg_insert(Position).values([{"key": k} for k in keys]).on_conflict_do_nothing(index_elements=["key"]))
    return {key: pid for key, pid in s.execute(select(Position.key, Position.id).where(Position.key.in_(keys)))}


def _position_id(s: Session, fen: str) -> int | None:
    return s.scalar(select(Position.id).where(Position.key == key_from_fen(fen)))


# ---- lines ------------------------------------------------------------------


@dataclass
class AddLineResult:
    status: str  # "created" | "extended" | "exists"
    line_id: int
    moves_added: int


def _opening_lines_uci(s: Session, opening_id: int) -> dict[int, list[str]]:
    rows = s.execute(
        select(Move.line_id, Move.uci).join(Line).where(Line.opening_id == opening_id).order_by(Move.line_id, Move.ply)
    ).all()
    lines: dict[int, list[str]] = {}
    for line_id, uci in rows:
        lines.setdefault(line_id, []).append(uci)
    return lines


def add_line(s: Session, opening_id: int, ucis: list[str]) -> AddLineResult:
    """Save a move sequence (from the initial position) to an opening.

    Creates a new line, extends an existing one, or does nothing if it's already covered.
    An extended line is made due today, since it now contains moves not yet trained.
    """
    get_opening(s, opening_id)
    walked = walk_line(ucis)  # validates; raises InvalidLine
    plan = plan_line([m.uci for m in walked], _opening_lines_uci(s, opening_id))

    if plan.kind == "exists":
        return AddLineResult("exists", plan.line_id, 0)

    ids = ensure_positions(s, {m.key_before for m in walked} | {m.key_after for m in walked})
    if plan.kind == "new":
        line = Line(opening_id=opening_id)
        s.add(line)
        s.flush()
        start = 0
    else:
        line = s.get(Line, plan.line_id)
        line.next_review_on = date.today()
        start = plan.existing_length

    new_moves = walked[start:]
    s.add_all(
        Move(
            line_id=line.id,
            ply=m.ply,
            uci=m.uci,
            san=m.san,
            position_before_id=ids[m.key_before],
            position_after_id=ids[m.key_after],
        )
        for m in new_moves
    )
    s.flush()
    return AddLineResult("created" if plan.kind == "new" else "extended", line.id, len(new_moves))


def list_lines(s: Session, opening_id: int) -> list[dict]:
    get_opening(s, opening_id)
    lines = s.scalars(select(Line).where(Line.opening_id == opening_id).order_by(Line.id)).all()
    moves = _opening_lines_moves(s, opening_id)
    return [
        {
            "id": line.id,
            "created_on": line.created_on,
            "next_review_on": line.next_review_on,
            "moves": moves.get(line.id, []),
        }
        for line in lines
    ]


def _opening_lines_moves(s: Session, opening_id: int) -> dict[int, list[dict]]:
    rows = s.execute(
        select(Move.line_id, Move.ply, Move.uci, Move.san)
        .join(Line)
        .where(Line.opening_id == opening_id)
        .order_by(Move.line_id, Move.ply)
    ).all()
    out: dict[int, list[dict]] = {}
    for line_id, ply, uci, san in rows:
        out.setdefault(line_id, []).append({"ply": ply, "uci": uci, "san": san})
    return out


def lines_through(s: Session, opening_id: int, fen: str) -> list[int]:
    """IDs of the opening's lines that pass through the position (including the start)."""
    get_opening(s, opening_id)
    pos_id = _position_id(s, fen)
    if pos_id is None:
        return []
    return list(
        s.scalars(
            select(Move.line_id)
            .distinct()
            .join(Line)
            .where(
                Line.opening_id == opening_id,
                or_(Move.position_before_id == pos_id, Move.position_after_id == pos_id),
            )
            .order_by(Move.line_id)
        )
    )


def delete_lines_through(s: Session, opening_id: int, fen: str) -> int:
    ids = lines_through(s, opening_id, fen)
    if ids:
        s.execute(delete(Line).where(Line.id.in_(ids)))  # moves cascade in the DB
    return len(ids)


def delete_line(s: Session, line_id: int) -> None:
    line = s.get(Line, line_id)
    if line is None:
        raise NotFound(f"Line {line_id} not found")
    s.delete(line)
    s.flush()


# ---- explorer ---------------------------------------------------------------


def explorer(s: Session, opening_id: int, fen: str) -> list[dict]:
    """Repertoire moves from a position in this opening, with how many lines use each."""
    get_opening(s, opening_id)
    pos_id = _position_id(s, fen)
    if pos_id is None:
        return []
    n_lines = func.count(distinct(Move.line_id))
    rows = s.execute(
        select(Move.uci, Move.san, n_lines)
        .join(Line)
        .where(Line.opening_id == opening_id, Move.position_before_id == pos_id)
        .group_by(Move.uci, Move.san)
        .order_by(n_lines.desc(), Move.san)
    ).all()
    return [{"uci": uci, "san": san, "lines": n} for uci, san, n in rows]


# ---- comments ---------------------------------------------------------------


def get_comment(s: Session, repertoire_id: int, fen: str) -> str:
    get_repertoire(s, repertoire_id)
    return (
        s.scalar(
            select(PositionComment.comment)
            .join(Position, Position.id == PositionComment.position_id)
            .where(PositionComment.repertoire_id == repertoire_id, Position.key == key_from_fen(fen))
        )
        or ""
    )


def set_comment(s: Session, repertoire_id: int, fen: str, comment: str) -> str:
    """Save a comment for a position; an empty comment deletes it."""
    get_repertoire(s, repertoire_id)
    key = key_from_fen(fen)
    comment = comment.strip()
    if not comment:
        pos_id = s.scalar(select(Position.id).where(Position.key == key))
        if pos_id is not None:
            s.execute(
                delete(PositionComment).where(
                    PositionComment.repertoire_id == repertoire_id, PositionComment.position_id == pos_id
                )
            )
        return ""
    pos_id = ensure_positions(s, {key})[key]
    stmt = pg_insert(PositionComment).values(repertoire_id=repertoire_id, position_id=pos_id, comment=comment)
    s.execute(
        stmt.on_conflict_do_update(
            index_elements=["repertoire_id", "position_id"],
            set_={"comment": stmt.excluded.comment, "updated_at": func.now()},
        )
    )
    return comment
