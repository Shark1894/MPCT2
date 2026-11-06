"""Creating an opening from a Chessable course export (the course's lines, chapters and the
author's notes), in one go.

Lines go in as normal repertoire lines (due today, like any new line): duplicates and lines that
are the start of a longer one are merged, and a line that continues one already in the opening
extends it. Notes become position comments in the repertoire; a note already there isn't added
twice, and an existing comment of yours keeps its text with the note added under it. Each chapter
can become a branch tag, on the position where its lines part from the rest (skipped when that's
the start position or already tagged).

Done in bulk (positions, lines and comments a few queries each), so a course of a thousand lines
takes seconds, not minutes.
"""

from datetime import date

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.chessable import CourseLine
import chess

from app.core.positions import InvalidLine, LineMove, position_key, walk_line
from app.db.models import Line, Move, Opening, Position, PositionComment
from app.repositories import repertoire as repo
from app.repositories import tags as tags_repo

COMMENT_MAX = 10_000  # what the comment box can save
TAG_MAX = 60
CHUNK = 2000


def _ensure_positions(s: Session, keys: set[str]) -> dict[str, int]:
    ids: dict[str, int] = {}
    keys = sorted(keys)
    for i in range(0, len(keys), CHUNK):
        ids |= repo.ensure_positions(s, set(keys[i : i + CHUNK]))
    return ids


def walk_many(lines: list[list[str]]) -> dict[tuple, list[LineMove]]:
    """walk_line for many lines at once: lines sharing their first moves share the work (sorted, so
    each line only replays from where it parts from the one before). Raises InvalidLine."""
    out: dict[tuple, list[LineMove]] = {}
    board = chess.Board()
    path: list[LineMove] = []
    for t in sorted({tuple(m) for m in lines}):
        k = 0
        while k < len(path) and k < len(t) and path[k].uci == t[k]:
            k += 1
        while len(path) > k:
            board.pop()
            path.pop()
        for ply in range(k + 1, len(t) + 1):
            uci = t[ply - 1]
            try:
                move = chess.Move.from_uci(uci)
            except ValueError as exc:
                raise InvalidLine(f"Move {ply}: '{uci}' is not a UCI move") from exc
            if move not in board.legal_moves:
                raise InvalidLine(f"Move {ply}: {uci} is illegal in this position")
            before = path[-1].key_after if path else position_key(board)
            san = board.san(move)
            board.push(move)
            path.append(LineMove(ply, move.uci(), san, before, position_key(board)))
        out[t] = list(path)
    return out


def _common_prefix(lines: list[list[str]]) -> list[str]:
    if not lines:
        return []
    first = lines[0]
    n = len(first)
    for other in lines[1:]:
        n = min(n, len(other))
        for i in range(n):
            if other[i] != first[i]:
                n = i
                break
    return first[:n]


def merge_comment(existing: str, note: str) -> str | None:
    """The comment with the note added, or None if it's already in there."""
    if note in existing:
        return None
    return f"{existing}\n\n{note}" if existing else note


def import_course(
    s: Session,
    repertoire_id: int,
    opening_name: str,
    lines: list[CourseLine],
    chapters: list[dict],
    comments: bool = True,
    tag_chapters: bool = True,
) -> dict:
    """lines: the course lines to import (already chosen); chapters: [{id, title}] in course order."""
    if not lines:
        raise InvalidLine("No lines to import: choose at least one chapter")
    colors = {line.color for line in lines}
    if len(colors) != 1:
        raise InvalidLine("The course mixes lines for White and for Black")
    color = colors.pop()
    rep = repo.get_repertoire(s, repertoire_id)
    name = opening_name.strip()[:100] or lines[0].course[:100]
    opening = s.scalar(select(Opening).where(Opening.repertoire_id == rep.id, Opening.name == name))
    created_opening = opening is None
    if opening is None:
        opening_id = repo.create_opening(s, rep.id, name, color)["id"]
    else:
        if opening.color != color:
            raise repo.Conflict(f"'{name}' is for {opening.color}, but this course is for {color}: choose another name")
        opening_id = opening.id

    report = {"opening_id": opening_id, "opening": name, "color": color, "created_opening": created_opening,
              "lines_read": len(lines), "lines_created": 0, "lines_extended": 0, "lines_covered": 0,
              "comments_added": 0, "comments_existing": 0, "comments_too_long": 0, "tags": [], "tags_skipped": [],
              "skipped": []}

    # ---- moves: validate, then merge duplicates and prefixes ----------------------------------
    walked: dict[int, list] = {}  # index in `lines` -> LineMoves
    try:
        by_moves = walk_many([line.ucis for line in lines if line.ucis])
    except InvalidLine:  # one bad line: find it the slow way, skip it, keep the rest
        by_moves = {}
        for line in lines:
            try:
                by_moves[tuple(line.ucis)] = walk_line(line.ucis)
            except InvalidLine as exc:
                report["skipped"].append(f"{line.chapter} / {line.title or line.line_id}: {exc}")
    for i, line in enumerate(lines):
        if tuple(line.ucis) in by_moves:
            walked[i] = by_moves[tuple(line.ucis)]
    existing = repo._opening_lines_uci(s, opening_id)  # line id -> ucis
    existing_by_moves = {tuple(m): lid for lid, m in existing.items()}
    prefixes: set[tuple] = set()  # every proper prefix of every line (existing and new)
    for m in list(existing.values()) + [lines[i].ucis for i in walked]:
        t = tuple(m)
        prefixes.update(t[:k] for k in range(1, len(t)))
    plan: dict[tuple, int | None] = {}  # new lines to store -> existing line id to extend (or None)
    for i in walked:
        t = tuple(lines[i].ucis)
        if t in plan or t in existing_by_moves or t in prefixes:
            report["lines_covered"] += 1  # a duplicate, or the start of a longer line
            continue
        plan[t] = next((existing_by_moves[t[:k]] for k in range(len(t) - 1, 0, -1) if t[:k] in existing_by_moves), None)
    walked_by_moves = {tuple(lines[i].ucis): walked[i] for i in walked}
    keys: set[str] = set()
    for i in walked:
        for m in walked[i]:
            keys.update((m.key_before, m.key_after))
    ids = _ensure_positions(s, keys)

    today = date.today()
    extended_once: set[int] = set()
    to_store: list[tuple[Line, list[LineMove]]] = []
    for t, extend in plan.items():
        moves = walked_by_moves[t]
        if extend is not None and extend not in extended_once:
            line = s.get(Line, extend)
            line.next_review_on = today
            extended_once.add(extend)
            to_store.append((line, moves[len(existing[extend]) :]))
            report["lines_extended"] += 1
        else:
            line = Line(opening_id=opening_id)
            s.add(line)
            to_store.append((line, moves))
            report["lines_created"] += 1
    s.flush()  # all new lines in one batch
    s.add_all(
        Move(line_id=line.id, ply=m.ply, uci=m.uci, san=m.san,
             position_before_id=ids[m.key_before], position_after_id=ids[m.key_after])
        for line, moves in to_store
        for m in moves
    )
    s.flush()

    # ---- notes -> position comments ------------------------------------------------------------
    if comments:
        notes: dict[str, list[str]] = {}  # key -> notes in course order
        for i in walked:
            for ply, note in sorted(lines[i].comments.items()):
                key = walked[i][0].key_before if ply == 0 else walked[i][ply - 1].key_after
                bucket = notes.setdefault(key, [])
                if not any(note in n for n in bucket):
                    bucket.append(note)
        current = dict(
            s.execute(
                select(Position.key, PositionComment.comment)
                .join(PositionComment, PositionComment.position_id == Position.id)
                .where(PositionComment.repertoire_id == rep.id, Position.key.in_(list(notes)))
            ).all()
        ) if notes else {}
        writes: dict[str, str] = {}
        for key, bucket in notes.items():
            text = current.get(key, "")
            changed = False
            for note in bucket:
                merged = merge_comment(text, note)
                if merged is None:
                    report["comments_existing"] += 1
                elif len(merged) > COMMENT_MAX:
                    report["comments_too_long"] += 1
                else:
                    text, changed = merged, True
                    report["comments_added"] += 1
            if changed:
                writes[key] = text
        rows = [{"repertoire_id": rep.id, "position_id": ids[k], "comment": t} for k, t in writes.items()]
        for i in range(0, len(rows), CHUNK):  # one upsert per chunk instead of one per position
            stmt = pg_insert(PositionComment).values(rows[i : i + CHUNK])
            s.execute(stmt.on_conflict_do_update(index_elements=["repertoire_id", "position_id"],
                                                 set_={"comment": stmt.excluded.comment, "updated_at": func.now()}))

    # ---- chapters -> branch tags ---------------------------------------------------------------
    if tag_chapters:
        by_chapter: dict[int, list[list[str]]] = {}
        for i in walked:
            if tuple(lines[i].ucis) not in prefixes:  # a line that's only the start of others doesn't widen the tag
                by_chapter.setdefault(lines[i].chapter_id, []).append(lines[i].ucis)
        titles = {c["id"]: (c.get("title") or "").strip() for c in chapters}
        order = {c["id"]: n for n, c in enumerate(chapters)}
        for chapter_id, chapter_lines in sorted(by_chapter.items(), key=lambda kv: order.get(kv[0], 1_000_000)):
            title = (titles.get(chapter_id) or next(lines[i].chapter for i in walked if lines[i].chapter_id == chapter_id))[:TAG_MAX].strip()
            prefix = _common_prefix(chapter_lines)
            if not prefix:
                report["tags_skipped"].append(f"{title}: its lines part at the first move")
                continue
            fen = walk_line(prefix)[-1].key_after + " 0 1"
            try:
                tags_repo.create_tag(s, opening_id, title, fen)
                report["tags"].append(title)
            except (tags_repo.InvalidTag, repo.Conflict) as exc:
                report["tags_skipped"].append(f"{title}: {exc}")
    s.flush()
    return report
