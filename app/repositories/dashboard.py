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


def dashboard(s: Session, opening_id: int, tag_id: int | None = None) -> dict:
    """Stats and lines for an opening, or for one branch of it when tag_id is given."""
    from app.repositories.tags import tag_in_opening, tagged_line_ids

    summary = opening_summary(s, opening_id)
    tag_lines = tagged_line_ids(s, opening_id)
    q = select(Line).where(Line.opening_id == opening_id)
    if tag_id is not None:
        tag_in_opening(s, opening_id, tag_id)
        q = q.where(Line.id.in_(tag_lines[tag_id] or {-1}))
    lines = s.scalars(q.order_by(Line.next_review_on, Line.id)).all()
    ids = [line.id for line in lines]
    line_tags: dict[int, list[int]] = {line_id: [] for line_id in ids}
    for t_id, members in tag_lines.items():
        for line_id in members & set(ids):
            line_tags[line_id].append(t_id)
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

    from app.repositories.insights import forecast, mastery, problem_positions, reviewed_line_ids

    today = date.today()
    reviewed = reviewed_line_ids(s, ids)
    total_reviews = sum(len(h) for h in history.values())
    total_correct = sum(1 for h in history.values() for correct, _ in h if correct)
    return {
        "opening": summary,
        "tag_id": tag_id,
        "stats": {
            "lines": len(lines),
            "due": sum(1 for line in lines if line.next_review_on <= today),
            "next_review_on": min((line.next_review_on for line in lines), default=None),
            "reviews": total_reviews,
            "accuracy": round(total_correct / total_reviews, 3) if total_reviews else None,
            "mastery": mastery(ids, streaks, reviewed),
        },
        "forecast": forecast([line.next_review_on for line in lines], today),
        "problems": problem_positions(s, ids, moves),
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
                "tags": sorted(line_tags[line.id]),
                "bookmarked": line.bookmarked_at is not None,
                "bookmark_note": line.bookmark_note,
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
