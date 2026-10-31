"""Opening dashboard: stats, per-line review history, and resets.

Practice reviews (retries) are left out of the history and stats, as they don't
affect the schedule.
"""

from datetime import date

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.db.models import Line, LineReview
from app.repositories.repertoire import NotFound, _opening_lines_moves, get_opening, opening_summary
from app.repositories.training import current_streaks

RECENT = 5  # results shown per line


def dashboard(s: Session, opening_id: int) -> dict:
    summary = opening_summary(s, opening_id)
    lines = s.scalars(select(Line).where(Line.opening_id == opening_id).order_by(Line.next_review_on, Line.id)).all()
    ids = [line.id for line in lines]
    moves = _opening_lines_moves(s, opening_id)
    streaks = current_streaks(s, ids)

    history: dict[int, list[tuple[bool, object]]] = {line_id: [] for line_id in ids}
    if ids:
        rows = s.execute(
            select(LineReview.line_id, LineReview.correct, LineReview.reviewed_at)
            .where(LineReview.line_id.in_(ids), LineReview.practice.is_(False))
            .order_by(LineReview.line_id, LineReview.reviewed_at, LineReview.id)
        ).all()
        for line_id, correct, reviewed_at in rows:
            history[line_id].append((correct, reviewed_at))

    total_reviews = sum(len(h) for h in history.values())
    total_correct = sum(1 for h in history.values() for correct, _ in h if correct)
    return {
        "opening": summary,
        "stats": {
            "lines": summary["lines"],
            "due": summary["due"],
            "next_review_on": summary["next_review_on"],
            "reviews": total_reviews,
            "accuracy": round(total_correct / total_reviews, 3) if total_reviews else None,
        },
        "lines": [
            {
                "id": line.id,
                "moves": [m["san"] for m in moves.get(line.id, [])],
                "next_review_on": line.next_review_on,
                "streak": streaks[line.id],
                "recent": [correct for correct, _ in history[line.id][-RECENT:]],  # oldest first
                "reviews": len(history[line.id]),
                "correct": sum(1 for correct, _ in history[line.id] if correct),
                "last_reviewed_at": history[line.id][-1][1] if history[line.id] else None,
            }
            for line in lines
        ],
    }


def reset_line(s: Session, line_id: int) -> None:
    """Forget a line's review history and make it due today (as if newly added)."""
    line = s.get(Line, line_id)
    if line is None:
        raise NotFound(f"Line {line_id} not found")
    s.execute(delete(LineReview).where(LineReview.line_id == line_id))  # move attempts cascade
    line.next_review_on = date.today()
    s.flush()


def reset_opening(s: Session, opening_id: int) -> int:
    """Reset every line in an opening. Returns how many lines were reset."""
    get_opening(s, opening_id)
    line_ids = select(Line.id).where(Line.opening_id == opening_id)
    s.execute(delete(LineReview).where(LineReview.line_id.in_(line_ids)))
    result = s.execute(update(Line).where(Line.opening_id == opening_id).values(next_review_on=date.today()))
    return result.rowcount


def delete_all_lines(s: Session, opening_id: int) -> int:
    get_opening(s, opening_id)
    result = s.execute(delete(Line).where(Line.opening_id == opening_id))  # moves + history cascade
    return result.rowcount
