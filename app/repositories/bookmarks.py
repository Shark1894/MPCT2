"""Line bookmarks: a star on a line with an optional short note."""

from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.db.models import Line
from app.repositories.repertoire import NotFound

NOTE_MAX = 500


def _line(s: Session, line_id: int) -> Line:
    line = s.get(Line, line_id)
    if line is None:
        raise NotFound(f"Line {line_id} not found")
    return line


def bookmark_out(line: Line) -> dict:
    return {
        "line_id": line.id,
        "bookmarked": line.bookmarked_at is not None,
        "bookmarked_at": line.bookmarked_at,
        "note": line.bookmark_note,
    }


def set_bookmark(s: Session, line_id: int, note: str | None = None) -> dict:
    """Bookmark a line (or update its note). An empty note clears it; re-bookmarking keeps the original date."""
    line = _line(s, line_id)
    if line.bookmarked_at is None:
        line.bookmarked_at = datetime.now(UTC)
    line.bookmark_note = (note or "").strip() or None
    s.flush()
    return bookmark_out(line)


def remove_bookmark(s: Session, line_id: int) -> None:
    line = _line(s, line_id)
    line.bookmarked_at = None
    line.bookmark_note = None
    s.flush()
