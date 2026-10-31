"""Branch tags: a name on a position within one opening. A line has a tag when it
passes through the tagged position, so lines added later are tagged automatically
and one line can carry several (nested) tags."""

from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.positions import START_KEY, key_from_fen
from app.db.models import Line, Move, OpeningTag, Position
from app.repositories.repertoire import Conflict, NotFound, get_opening


class InvalidTag(ValueError):
    pass


def get_tag(s: Session, tag_id: int) -> OpeningTag:
    tag = s.get(OpeningTag, tag_id)
    if tag is None:
        raise NotFound(f"Tag {tag_id} not found")
    return tag


def tag_in_opening(s: Session, opening_id: int, tag_id: int) -> OpeningTag:
    tag = get_tag(s, tag_id)
    if tag.opening_id != opening_id:
        raise NotFound(f"Tag {tag_id} not found in this opening")
    return tag


def tagged_line_ids(s: Session, opening_id: int) -> dict[int, set[int]]:
    """{tag_id: {line_id, ...}} for every tag in the opening."""
    rows = s.execute(
        select(OpeningTag.id, Move.line_id)
        .join(Move, Move.position_after_id == OpeningTag.position_id)
        .join(Line, Line.id == Move.line_id)
        .where(OpeningTag.opening_id == opening_id, Line.opening_id == opening_id)
        .distinct()
    ).all()
    out: dict[int, set[int]] = {
        tag_id: set() for tag_id in s.scalars(select(OpeningTag.id).where(OpeningTag.opening_id == opening_id))
    }
    for tag_id, line_id in rows:
        out[tag_id].add(line_id)
    return out


def lines_with_tag(s: Session, opening_id: int, tag_id: int) -> set[int]:
    tag_in_opening(s, opening_id, tag_id)
    return tagged_line_ids(s, opening_id)[tag_id]


def _path_to(s: Session, opening_id: int, position_id: int) -> list[str]:
    """SAN moves of the shortest stored route to the position within the opening."""
    first = s.execute(
        select(Move.line_id, Move.ply)
        .join(Line)
        .where(Line.opening_id == opening_id, Move.position_after_id == position_id)
        .order_by(Move.ply, Move.line_id)
        .limit(1)
    ).first()
    if first is None:
        return []
    return list(
        s.scalars(select(Move.san).where(Move.line_id == first.line_id, Move.ply <= first.ply).order_by(Move.ply))
    )


def list_tags(s: Session, opening_id: int) -> list[dict]:
    get_opening(s, opening_id)
    tags = s.execute(
        select(OpeningTag, Position.key)
        .join(Position, Position.id == OpeningTag.position_id)
        .where(OpeningTag.opening_id == opening_id)
    ).all()
    lines = tagged_line_ids(s, opening_id)
    due_ids = set(
        s.scalars(select(Line.id).where(Line.opening_id == opening_id, Line.next_review_on <= date.today()))
    )
    out = [
        {
            "id": tag.id,
            "name": tag.name,
            "key": key,
            "path": _path_to(s, opening_id, tag.position_id),
            "lines": len(lines[tag.id]),
            "due": len(lines[tag.id] & due_ids),
        }
        for tag, key in tags
    ]
    # Shallow branches first, then by name; tags whose lines were all deleted go last
    return sorted(out, key=lambda t: (len(t["path"]) or 999, t["name"].lower()))


def create_tag(s: Session, opening_id: int, name: str, fen: str) -> dict:
    get_opening(s, opening_id)
    key = key_from_fen(fen)
    if key == START_KEY:
        raise InvalidTag("Every line starts here: tag a position after at least one move")
    position_id = s.scalar(select(Position.id).where(Position.key == key))
    reached = position_id is not None and s.scalar(
        select(func.count(Move.id))
        .join(Line)
        .where(Line.opening_id == opening_id, Move.position_after_id == position_id)
    )
    if not reached:
        raise InvalidTag("No line in this opening passes through this position yet: add a line first")
    if s.scalar(select(OpeningTag.id).where(OpeningTag.opening_id == opening_id, OpeningTag.name == name)):
        raise Conflict(f"This opening already has a tag called '{name}'")
    existing = s.scalar(
        select(OpeningTag.name).where(OpeningTag.opening_id == opening_id, OpeningTag.position_id == position_id)
    )
    if existing:
        raise Conflict(f"This position is already tagged as '{existing}'")
    tag = OpeningTag(opening_id=opening_id, position_id=position_id, name=name)
    s.add(tag)
    s.flush()
    return next(t for t in list_tags(s, opening_id) if t["id"] == tag.id)


def rename_tag(s: Session, tag_id: int, name: str) -> dict:
    tag = get_tag(s, tag_id)
    clash = s.scalar(
        select(OpeningTag.id).where(
            OpeningTag.opening_id == tag.opening_id, OpeningTag.name == name, OpeningTag.id != tag_id
        )
    )
    if clash:
        raise Conflict(f"This opening already has a tag called '{name}'")
    tag.name = name
    s.flush()
    return next(t for t in list_tags(s, tag.opening_id) if t["id"] == tag_id)


def delete_tag(s: Session, tag_id: int) -> None:
    s.delete(get_tag(s, tag_id))  # the lines themselves are untouched
    s.flush()
