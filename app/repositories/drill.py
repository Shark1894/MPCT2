"""Position drill: random repertoire positions where it's your move, shown without the
moves that led there, and the record of how you answered.

Practice only: nothing here touches a line's streak or schedule. Answers are kept in
drill_attempts so mistakes still show up as problem positions on the dashboard.
"""

import random
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.scheduling import user_plays_ply
from app.db.models import DrillAttempt, Line, Move, Opening, OpeningTag, Position
from app.repositories.repertoire import NotFound, get_opening, get_repertoire

MAX_COUNT = 200
MAX_WRONG = 20


class InvalidDrill(ValueError):
    pass


@dataclass
class _Candidate:
    opening_id: int
    position_id: int
    ply: int  # the earliest ply this position is reached at with you to move
    expected: dict[str, str] = field(default_factory=dict)  # uci -> san
    lines: list[int] = field(default_factory=list)


def _scope(s: Session, repertoire_id: int | None, opening_id: int | None, tag_id: int | None) -> tuple[list[Opening], OpeningTag | None]:
    if tag_id is not None:
        tag = s.get(OpeningTag, tag_id)
        if tag is None:
            raise NotFound(f"Tag {tag_id} not found")
        return [get_opening(s, tag.opening_id)], tag
    if opening_id is not None:
        return [get_opening(s, opening_id)], None
    if repertoire_id is not None:
        get_repertoire(s, repertoire_id)
        return list(s.scalars(select(Opening).where(Opening.repertoire_id == repertoire_id).order_by(Opening.id))), None
    raise InvalidDrill("Choose a repertoire, an opening or a branch tag")


def _line_moves(s: Session, opening_ids: list[int]) -> dict[int, list]:
    """line id -> its moves in order (ply, uci, san, position before, position after, opening id)."""
    out: dict[int, list] = {}
    if not opening_ids:
        return out
    rows = s.execute(
        select(Move.line_id, Move.ply, Move.uci, Move.san, Move.position_before_id, Move.position_after_id, Line.opening_id)
        .join(Line, Line.id == Move.line_id)
        .where(Line.opening_id.in_(opening_ids))
        .order_by(Move.line_id, Move.ply)
    ).all()
    for row in rows:
        out.setdefault(row.line_id, []).append(row)
    return out


def drill_positions(
    s: Session,
    repertoire_id: int | None = None,
    opening_id: int | None = None,
    tag_id: int | None = None,
    count: int = 10,
    rng: random.Random | None = None,
) -> dict:
    """Up to `count` different positions, in random order, where it's your move in a line of
    the scope (a whole repertoire, one opening, or the part of a branch from its tagged
    position on). The starting position is left out (it's always your first move).

    Each comes with the move(s) your repertoire plays there, and one line through it
    (picked at random) for "play the rest of the line" and for showing it on the board."""
    if not 1 <= count <= MAX_COUNT:
        raise InvalidDrill(f"count must be 1–{MAX_COUNT}")
    rng = rng or random.Random()
    openings, tag = _scope(s, repertoire_id, opening_id, tag_id)
    by_id = {o.id: o for o in openings}
    lines = _line_moves(s, list(by_id))

    candidates: dict[tuple[int, int], _Candidate] = {}
    for line_id, moves in lines.items():
        opening = by_id[moves[0].opening_id]
        start = 0
        if tag is not None:
            reached = next((i for i, m in enumerate(moves) if m.position_after_id == tag.position_id), None)
            if reached is None:
                continue  # the line doesn't pass through the branch
            start = reached + 1
        for m in moves[start:]:
            if m.ply == 1 and opening.color == "white":
                continue  # the starting position
            if not user_plays_ply(m.ply, opening.color):
                continue
            c = candidates.setdefault((opening.id, m.position_before_id), _Candidate(opening.id, m.position_before_id, m.ply))
            c.ply = min(c.ply, m.ply)
            c.expected.setdefault(m.uci, m.san)
            c.lines.append(line_id)

    picked = rng.sample(list(candidates.values()), min(count, len(candidates)))
    keys = dict(s.execute(select(Position.id, Position.key).where(Position.id.in_({c.position_id for c in picked} or {-1}))).all())
    out = []
    for c in picked:
        opening = by_id[c.opening_id]
        line_id = rng.choice(c.lines)
        moves = lines[line_id]
        at = next(i for i, m in enumerate(moves) if m.position_before_id == c.position_id)
        ply = moves[at].ply
        out.append(
            {
                "opening": {"id": opening.id, "name": opening.name, "color": opening.color},
                "position_id": c.position_id,
                # The stored key has no move counters: add the move number this line reaches it at.
                "fen": f"{keys[c.position_id]} 0 {(ply - 1) // 2 + 1}",
                "ply": ply,
                "expected": [{"uci": u, "san": san} for u, san in c.expected.items()],
                "line_id": line_id,
                "path": [m.san for m in moves[:at]],  # SAN from the start, for Show
                "rest": [{"ply": m.ply, "uci": m.uci, "san": m.san} for m in moves[at:]],  # from this position to the line's end
            }
        )
    return {"total": len(candidates), "positions": out}


def record_results(s: Session, results: list[dict]) -> int:
    """results: [{opening_id, position_id, expected_uci, correct, wrong: [uci, ...]}].
    Each must be a position in the opening where your repertoire plays expected_uci."""
    for r in results:
        opening = get_opening(s, r["opening_id"])
        ply = s.scalar(
            select(Move.ply)
            .join(Line, Line.id == Move.line_id)
            .where(Line.opening_id == opening.id, Move.position_before_id == r["position_id"], Move.uci == r["expected_uci"])
            .limit(1)
        )
        if ply is None or not user_plays_ply(ply, opening.color):
            raise InvalidDrill(f"{r['expected_uci']} isn't your repertoire move in that position of {opening.name}")
        if len(r.get("wrong", [])) > MAX_WRONG:
            raise InvalidDrill(f"At most {MAX_WRONG} wrong moves per position")
        s.add(
            DrillAttempt(
                opening_id=opening.id,
                position_id=r["position_id"],
                expected_uci=r["expected_uci"],
                correct=bool(r["correct"]),
                wrong=list(r.get("wrong", [])),
            )
        )
    s.flush()
    return len(results)
