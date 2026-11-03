"""Confusable positions: the pair finder (app.core.confusable) run over a repertoire,
ranked by the mix-ups you've actually made in training, plus hiding pairs that aren't
really confusing.

The search covers every opening of the same colour in the repertoire, because a mix-up
can cross openings. The dashboard shows the pairs with at least one side in the selected
opening (or branch).
"""

from collections import Counter
from dataclasses import dataclass, field

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.confusable import MAX_DISTANCE, Decision, differences, find_pairs
from app.core.scheduling import user_plays_ply
from app.db.models import ConfusableHidden, Line, Move, MoveAttempt, Opening, Position
from app.repositories.repertoire import NotFound, get_opening, get_repertoire

PAIR_LIMIT = 30


class InvalidPair(ValueError):
    pass


@dataclass
class _Node:
    position_id: int
    uci: str
    san: str
    ply: int  # the earliest ply this decision is reached at
    first_line: int  # a line reaching it at that ply (for the moves leading there)
    lines: set[int] = field(default_factory=set)
    openings: set[int] = field(default_factory=set)


def _nodes(s: Session, opening_ids: list[int], color: str) -> dict[tuple[int, str], _Node]:
    """Your-move positions in these openings, one per (position, expected move)."""
    rows = s.execute(
        select(Move.position_before_id, Move.uci, Move.san, Move.ply, Move.line_id, Line.opening_id)
        .join(Line, Line.id == Move.line_id)
        .where(Line.opening_id.in_(opening_ids))
        .order_by(Move.ply, Move.line_id)
    ).all()
    nodes: dict[tuple[int, str], _Node] = {}
    for pos_id, uci, san, ply, line_id, opening_id in rows:
        if not user_plays_ply(ply, color):
            continue
        node = nodes.get((pos_id, uci))
        if node is None:
            node = nodes[(pos_id, uci)] = _Node(pos_id, uci, san, ply, line_id)
        node.lines.add(line_id)
        node.openings.add(opening_id)
    return nodes


def _mixups(s: Session, opening_ids: list[int]) -> Counter:
    """(position, expected move, move played instead) -> how often, over all training."""
    rows = s.execute(
        select(Move.position_before_id, Move.uci, MoveAttempt.played_uci, func.count())
        .join(MoveAttempt, MoveAttempt.move_id == Move.id)
        .join(Line, Line.id == Move.line_id)
        .where(Line.opening_id.in_(opening_ids), MoveAttempt.correct.is_(False))
        .group_by(Move.position_before_id, Move.uci, MoveAttempt.played_uci)
    ).all()
    return Counter({(pos, uci, played): n for pos, uci, played, n in rows})


def _hidden(s: Session, repertoire_id: int) -> set[tuple[int, int]]:
    return set(
        s.execute(
            select(ConfusableHidden.position_a_id, ConfusableHidden.position_b_id).where(
                ConfusableHidden.repertoire_id == repertoire_id
            )
        ).all()
    )


def _fen(key: str, ply: int) -> str:
    return f"{key} 0 {(ply + 1) // 2}"


def confusable_pairs(
    s: Session,
    opening_id: int,
    tag_id: int | None = None,
    max_distance: int = MAX_DISTANCE,
    limit: int = PAIR_LIMIT,
) -> dict:
    from app.repositories.tags import lines_with_tag

    opening = get_opening(s, opening_id)
    openings = dict(
        s.execute(
            select(Opening.id, Opening.name).where(
                Opening.repertoire_id == opening.repertoire_id, Opening.color == opening.color
            )
        ).all()
    )
    focus = lines_with_tag(s, opening_id, tag_id) if tag_id is not None else None

    nodes = list(_nodes(s, list(openings), opening.color).values())
    keys = dict(s.execute(select(Position.id, Position.key).where(Position.id.in_({n.position_id for n in nodes}))).all()) if nodes else {}
    decisions = [Decision(keys[n.position_id], n.uci, frozenset(n.lines)) for n in nodes]

    def in_focus(n: _Node) -> bool:
        return bool(n.lines & focus) if focus is not None else opening_id in n.openings

    hidden = _hidden(s, opening.repertoire_id)
    mixups = _mixups(s, list(openings))
    found = []
    hidden_count = 0
    for pair in find_pairs(decisions, max_distance):
        a, b = nodes[pair.a], nodes[pair.b]
        if not (in_focus(a) or in_focus(b)):
            continue
        if (min(a.position_id, b.position_id), max(a.position_id, b.position_id)) in hidden:
            hidden_count += 1
            continue
        if in_focus(b) and not in_focus(a):
            a, b = b, a  # the selected opening's side first
            pair = type(pair)(pair.b, pair.a, pair.distance, pair.diff_mask)
        a_as_b = mixups[(a.position_id, a.uci, b.uci)]
        b_as_a = mixups[(b.position_id, b.uci, a.uci)]
        found.append((pair, a, b, a_as_b, b_as_a))

    total = len(found)
    found.sort(key=lambda f: (-(f[3] + f[4]), f[0].distance, min(f[1].ply, f[2].ply)))
    found = found[:limit]

    line_ids = {n.first_line for _, a, b, _, _ in found for n in (a, b)}
    paths: dict[int, list[str]] = {}
    if line_ids:
        for line_id, san in s.execute(
            select(Move.line_id, Move.san).where(Move.line_id.in_(line_ids)).order_by(Move.line_id, Move.ply)
        ).all():
            paths.setdefault(line_id, []).append(san)

    def side(n: _Node) -> dict:
        main = opening_id if opening_id in n.openings else min(n.openings)
        return {
            "position_id": n.position_id,
            "fen": _fen(keys[n.position_id], n.ply),
            "ply": n.ply,
            "moves": paths[n.first_line][: n.ply - 1],
            "expected_uci": n.uci,
            "expected_san": n.san,
            "opening_id": main,
            "opening_name": openings[main],
            "line_ids": sorted(n.lines & focus) if focus is not None and n.lines & focus else sorted(n.lines),
        }

    return {
        "opening_id": opening_id,
        "tag_id": tag_id,
        "total": total,
        "hidden": hidden_count,
        "pairs": [
            {
                "a": side(a),
                "b": side(b),
                "distance": pair.distance,
                "differences": differences(decisions[pair.a], decisions[pair.b], pair.diff_mask),
                "mixups": {"a_as_b": a_as_b, "b_as_a": b_as_a},
            }
            for pair, a, b, a_as_b, b_as_a in found
        ],
    }


def hide_pair(s: Session, repertoire_id: int, position_ids: list[int]) -> None:
    get_repertoire(s, repertoire_id)
    a, b = sorted(position_ids)
    if a == b:
        raise InvalidPair("A pair needs two different positions")
    if len(s.scalars(select(Position.id).where(Position.id.in_({a, b}))).all()) != 2:
        raise NotFound("Position not found")
    s.execute(
        insert(ConfusableHidden)
        .values(repertoire_id=repertoire_id, position_a_id=a, position_b_id=b)
        .on_conflict_do_nothing()
    )
    s.flush()


def unhide_all(s: Session, repertoire_id: int) -> int:
    get_repertoire(s, repertoire_id)
    return s.execute(delete(ConfusableHidden).where(ConfusableHidden.repertoire_id == repertoire_id)).rowcount
