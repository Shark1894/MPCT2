"""Training: which lines to review, and recording a finished review.

The browser runs the session; the server decides what's due and owns the schedule.
A review is recorded once, when a line is finished, so abandoning a line half-way
leaves no trace (the legacy app logged a failure the moment a line started).
"""

from datetime import date

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session

from app.core.scheduling import next_review_on, next_streak, user_plays_ply
from app.db.models import Line, LineReview, Move, MoveAttempt
from app.repositories.repertoire import NotFound, _opening_lines_moves, get_opening


class InvalidReview(ValueError):
    pass


def current_streaks(s: Session, line_ids: list[int]) -> dict[int, int]:
    """Streak after each line's latest non-practice review (0 if never reviewed)."""
    if not line_ids:
        return {}
    rows = s.execute(
        select(LineReview.line_id, LineReview.streak)
        .where(LineReview.line_id.in_(line_ids), LineReview.practice.is_(False))
        .order_by(LineReview.line_id, LineReview.reviewed_at.desc(), LineReview.id.desc())
        .ext(distinct_on(LineReview.line_id))
    ).all()
    streaks = dict.fromkeys(line_ids, 0)
    streaks.update({line_id: streak for line_id, streak in rows})
    return streaks


def training_lines(s: Session, opening_id: int, mode: str = "due", line_id: int | None = None) -> dict:
    """Lines to train, most overdue first. mode: 'due' (next review today or earlier) or 'all'."""
    opening = get_opening(s, opening_id)
    q = select(Line).where(Line.opening_id == opening_id)
    if line_id is not None:
        q = q.where(Line.id == line_id)
    elif mode == "due":
        q = q.where(Line.next_review_on <= date.today())
    lines = s.scalars(q.order_by(Line.next_review_on, Line.id)).all()
    if line_id is not None and not lines:
        raise NotFound(f"Line {line_id} not found in this opening")

    moves = _opening_lines_moves(s, opening_id)
    streaks = current_streaks(s, [line.id for line in lines])
    return {
        "opening": {"id": opening.id, "name": opening.name, "color": opening.color},
        "lines": [
            {
                "id": line.id,
                "next_review_on": line.next_review_on,
                "streak": streaks[line.id],
                "moves": moves[line.id],
            }
            for line in lines
            if moves.get(line.id)
        ],
    }


def record_review(s: Session, line_id: int, attempts: list[dict], practice: bool = False) -> dict:
    """Record a finished review of a line.

    attempts: every move the user tried, in order: [{"ply": 3, "uci": "g1f3"}, ...].
    Correctness is decided here against the stored line. The line counts as correct
    only if no wrong move was played. Every one of the user's moves must have been
    played correctly in the end (hints guarantee that), otherwise the review is
    incomplete and rejected.
    """
    line = s.get(Line, line_id)
    if line is None:
        raise NotFound(f"Line {line_id} not found")
    color = line.opening.color
    moves: dict[int, Move] = {m.ply: m for m in line.moves}
    user_plies = {ply for ply in moves if user_plays_ply(ply, color)}

    checked = []
    for a in attempts:
        ply, uci = a["ply"], a["uci"]
        if ply not in user_plies:
            raise InvalidReview(f"Ply {ply} is not one of your moves in this line")
        checked.append((moves[ply], uci, uci == moves[ply].uci))

    solved = {move.ply for move, _, ok in checked if ok}
    if user_plies - solved:
        raise InvalidReview("Review incomplete: not every move in the line was played")

    mistakes = sum(1 for _, _, ok in checked if not ok)
    correct = mistakes == 0
    previous = current_streaks(s, [line_id])[line_id]
    if practice:
        streak = previous  # retries are practice: no change to the streak or schedule
    else:
        streak = next_streak(previous, correct)
        line.next_review_on = next_review_on(streak)

    review = LineReview(line_id=line_id, correct=correct, practice=practice, mistakes=mistakes, streak=streak)
    s.add(review)
    s.flush()
    s.add_all(
        MoveAttempt(line_review_id=review.id, move_id=move.id, played_uci=uci, correct=ok) for move, uci, ok in checked
    )
    s.flush()
    return {
        "line_id": line_id,
        "correct": correct,
        "mistakes": mistakes,
        "practice": practice,
        "streak": streak,
        "next_review_on": line.next_review_on,
    }
