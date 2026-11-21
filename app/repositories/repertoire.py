"""Database access for repertoires, openings, lines, the move explorer and comments.

Functions take a Session and never commit: the caller owns the transaction
(one per API request, see app.db.session.get_session).
"""

from dataclasses import dataclass
from datetime import date

import chess
from sqlalchemy import delete, distinct, func, insert, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.positions import key_from_fen, position_key, walk_line
from app.core.repertoire import plan_line
from app.db.models import (
    DrillAttempt,
    Line,
    LineReview,
    Move,
    MoveAttempt,
    Opening,
    OpeningTag,
    Position,
    PositionComment,
    Repertoire,
)


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


def _insert_rows(s: Session, model, rows: list[dict]) -> list[int]:
    """Insert rows and return their new ids, in the same order as `rows`."""
    if not rows:
        return []
    return list(s.scalars(insert(model).returning(model.id, sort_by_parameter_order=True), rows))


def copy_opening(s: Session, opening_id: int, repertoire_id: int, name: str | None = None) -> dict:
    """Copy an opening into a repertoire (usually another one) as a new opening.

    Everything about it comes along, so it trains exactly as before: lines and moves,
    each line's schedule, bookmark and review history (with the moves tried), branch
    tags and position drill attempts. Position comments on its positions are copied
    into the target repertoire where that repertoire has none for the position yet.
    Branch tags aren't watched in tournament games in the copy (watch them again if
    wanted). The original opening is left untouched.
    """
    src = get_opening(s, opening_id)
    get_repertoire(s, repertoire_id)
    name = (name or "").strip() or src.name
    _check_opening_name(s, repertoire_id, name)

    new = Opening(repertoire_id=repertoire_id, name=name, color=src.color)
    s.add(new)
    s.flush()

    # lines
    lines = s.scalars(select(Line).where(Line.opening_id == src.id).order_by(Line.id)).all()
    new_line_ids = _insert_rows(
        s,
        Line,
        [
            {
                "opening_id": new.id,
                "created_on": ln.created_on,
                "next_review_on": ln.next_review_on,
                "bookmarked_at": ln.bookmarked_at,
                "bookmark_note": ln.bookmark_note,
            }
            for ln in lines
        ],
    )
    line_map = {ln.id: nid for ln, nid in zip(lines, new_line_ids)}

    # moves
    moves = s.scalars(select(Move).join(Line).where(Line.opening_id == src.id).order_by(Move.id)).all()
    new_move_ids = _insert_rows(
        s,
        Move,
        [
            {
                "line_id": line_map[m.line_id],
                "ply": m.ply,
                "uci": m.uci,
                "san": m.san,
                "position_before_id": m.position_before_id,
                "position_after_id": m.position_after_id,
            }
            for m in moves
        ],
    )
    move_map = {m.id: nid for m, nid in zip(moves, new_move_ids)}

    # review history (keeps each line's streak, so the schedule carries on as before)
    reviews = s.scalars(
        select(LineReview).join(Line).where(Line.opening_id == src.id).order_by(LineReview.id)
    ).all()
    new_review_ids = _insert_rows(
        s,
        LineReview,
        [
            {
                "line_id": line_map[r.line_id],
                "reviewed_at": r.reviewed_at,
                "correct": r.correct,
                "practice": r.practice,
                "mistakes": r.mistakes,
                "streak": r.streak,
            }
            for r in reviews
        ],
    )
    review_map = {r.id: nid for r, nid in zip(reviews, new_review_ids)}
    if review_map:
        attempts = s.scalars(
            select(MoveAttempt).where(MoveAttempt.line_review_id.in_(review_map)).order_by(MoveAttempt.id)
        ).all()
        _insert_rows(
            s,
            MoveAttempt,
            [
                {
                    "line_review_id": review_map[a.line_review_id],
                    "move_id": move_map[a.move_id],
                    "played_uci": a.played_uci,
                    "correct": a.correct,
                }
                for a in attempts
                if a.move_id in move_map
            ],
        )

    # branch tags
    tags = s.scalars(select(OpeningTag).where(OpeningTag.opening_id == src.id).order_by(OpeningTag.id)).all()
    _insert_rows(
        s,
        OpeningTag,
        [{"opening_id": new.id, "position_id": t.position_id, "name": t.name, "created_at": t.created_at} for t in tags],
    )

    # position drill attempts
    drills = s.scalars(select(DrillAttempt).where(DrillAttempt.opening_id == src.id).order_by(DrillAttempt.id)).all()
    _insert_rows(
        s,
        DrillAttempt,
        [
            {
                "opening_id": new.id,
                "position_id": d.position_id,
                "expected_uci": d.expected_uci,
                "correct": d.correct,
                "wrong": d.wrong,
                "attempted_at": d.attempted_at,
            }
            for d in drills
        ],
    )

    # position comments, without overwriting the target repertoire's own
    comments_copied = 0
    if src.repertoire_id != repertoire_id and moves:
        position_ids = {m.position_before_id for m in moves} | {m.position_after_id for m in moves}
        comments = s.execute(
            select(PositionComment.position_id, PositionComment.comment).where(
                PositionComment.repertoire_id == src.repertoire_id,
                PositionComment.position_id.in_(position_ids),
            )
        ).all()
        if comments:
            result = s.execute(
                pg_insert(PositionComment)
                .values([{"repertoire_id": repertoire_id, "position_id": pid, "comment": c} for pid, c in comments])
                .on_conflict_do_nothing(index_elements=["repertoire_id", "position_id"])
                .returning(PositionComment.position_id)
            )
            comments_copied = len(result.all())

    s.flush()
    s.refresh(new)
    return {**_opening_summary(s, new), "tags": len(tags), "comments": comments_copied}


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
    """Repertoire moves from a position in this opening, with how many lines use each; then the
    transpositions: other legal moves that reach a position somewhere in the opening's lines (by
    another move order), with how many lines pass through it; then the moves that lead into a
    position of another opening of the same repertoire and colour (`opening` = {id, name},
    lines = that opening's lines through the position). On their move, last: their other moves
    after which you have a move (`reply`) back into the lines or another opening."""
    opening = get_opening(s, opening_id)
    out: list[dict] = []
    pos_id = _position_id(s, fen)
    if pos_id is not None:
        n_lines = func.count(distinct(Move.line_id))
        rows = s.execute(
            select(Move.uci, Move.san, n_lines)
            .join(Line)
            .where(Line.opening_id == opening_id, Move.position_before_id == pos_id)
            .group_by(Move.uci, Move.san)
            .order_by(n_lines.desc(), Move.san)
        ).all()
        out = [{"uci": uci, "san": san, "lines": n, "transposes": False, "opening": None} for uci, san, n in rows]
    after = _moves_after(fen, {m["uci"] for m in out})
    out += _transpositions(s, opening_id, after)
    for m in out:
        after.pop(m.get("key"), None)
        m.pop("key", None)
    out += _opening_transpositions(s, opening, after)
    if chess.Board(fen).turn != (opening.color == "white"):  # their move: look one move further
        out += _replies_back(s, opening, fen, {m["uci"] for m in out})
    _add_tags(s, opening_id, fen, out)
    return out


def _add_tags(s: Session, opening_id: int, fen: str, moves: list[dict]) -> None:
    """Set each row's `tag`: the branch tag on the position it leads to (after your reply on a
    their-move-then-yours row), in the opening that position belongs to (the other opening for a
    purple row). None when that exact position isn't tagged."""
    board = chess.Board(fen)
    wanted: dict[int, tuple[int, str]] = {}  # row index -> (opening id, position key)
    for i, m in enumerate(moves):
        m["tag"] = None
        board.push_uci(m["uci"])
        if m.get("reply"):
            board.push_uci(m["reply"]["uci"])
            wanted[i] = ((m["opening"] or {}).get("id", opening_id), position_key(board))
            board.pop()
        else:
            wanted[i] = ((m["opening"] or {}).get("id", opening_id), position_key(board))
        board.pop()
    if not wanted:
        return
    rows = s.execute(
        select(OpeningTag.opening_id, Position.key, OpeningTag.name)
        .join(Position, Position.id == OpeningTag.position_id)
        .where(
            OpeningTag.opening_id.in_({oid for oid, _ in wanted.values()}),
            Position.key.in_({key for _, key in wanted.values()}),
        )
    ).all()
    names = {(oid, key): name for oid, key, name in rows}
    for i, target in wanted.items():
        moves[i]["tag"] = names.get(target)


def _moves_after(fen: str, known: set[str]) -> dict[str, tuple[str, str]]:
    """{position key: (uci, san)} for the legal moves not in `known` (first move per position)."""
    board = chess.Board(fen)
    after: dict[str, tuple[str, str]] = {}
    for move in board.legal_moves:
        uci = move.uci()
        if uci in known:
            continue
        san = board.san(move)
        board.push(move)
        after.setdefault(position_key(board), (uci, san))
        board.pop()
    return after


def _transpositions(s: Session, opening_id: int, after: dict[str, tuple[str, str]]) -> list[dict]:
    if not after:
        return []
    n_lines = func.count(distinct(Move.line_id))
    rows = s.execute(
        select(Position.key, n_lines)
        .join(Move, Move.position_after_id == Position.id)
        .join(Line, Line.id == Move.line_id)
        .where(Line.opening_id == opening_id, Position.key.in_(list(after)))
        .group_by(Position.key)
    ).all()
    found = [
        {"uci": after[k][0], "san": after[k][1], "lines": n, "transposes": True, "opening": None, "key": k}
        for k, n in rows
    ]
    return sorted(found, key=lambda m: (-m["lines"], m["san"]))


def _opening_transpositions(s: Session, opening: Opening, after: dict[str, tuple[str, str]]) -> list[dict]:
    """Moves into a position of another opening of the same repertoire and colour: either by
    another move order or because the two openings share the moves so far and split here
    (1.d4 Nf6 2.Nc3 c5 in one opening, 2...d5 in another)."""
    if not after:
        return []
    n_lines = func.count(distinct(Move.line_id))
    rows = s.execute(
        select(Opening.id, Opening.name, Position.key, n_lines)
        .join(Line, Line.opening_id == Opening.id)
        .join(Move, Move.line_id == Line.id)
        .join(Position, Position.id == Move.position_after_id)
        .where(
            Opening.repertoire_id == opening.repertoire_id,
            Opening.color == opening.color,
            Opening.id != opening.id,
            Position.key.in_(list(after)),
        )
        .group_by(Opening.id, Opening.name, Position.key)
    ).all()
    best: dict[str, dict] = {}  # per move: the other opening with the most lines through it
    for oid, name, key, n in rows:
        uci, san = after[key]
        cur = best.get(uci)
        if cur is None or n > cur["lines"] or (n == cur["lines"] and name < cur["opening"]["name"]):
            best[uci] = {"uci": uci, "san": san, "lines": n, "transposes": False, "opening": {"id": oid, "name": name}}
    return sorted(best.values(), key=lambda m: (-m["lines"], m["san"]))


def _replies_back(s: Session, opening: Opening, fen: str, known: set[str]) -> list[dict]:
    """On their move: their moves not otherwise listed after which you have a move back into
    a position of this opening's lines (blue) or of another opening of the same repertoire and
    colour (purple). `reply` is your move that gets there; `lines` the lines through it. A way
    back into this opening wins over another opening, then the one with the most lines. Only
    positions the lines reach at least two plies on count (the FEN's move number gives the
    ply), so retreating to an earlier position isn't offered."""
    board = chess.Board(fen)
    paths: dict[str, list[tuple[chess.Move, chess.Move]]] = {}  # key after both moves -> [(theirs, yours)]
    for theirs in list(board.legal_moves):
        if theirs.uci() in known:
            continue
        board.push(theirs)
        for yours in list(board.legal_moves):
            board.push(yours)
            paths.setdefault(position_key(board), []).append((theirs, yours))
            board.pop()
        board.pop()
    if not paths:
        return []
    n_lines = func.count(distinct(Move.line_id))
    rows = s.execute(
        select(Opening.id, Opening.name, Position.key, n_lines)
        .join(Line, Line.opening_id == Opening.id)
        .join(Move, Move.line_id == Line.id)
        .join(Position, Position.id == Move.position_after_id)
        .where(
            Opening.repertoire_id == opening.repertoire_id,
            Opening.color == opening.color,
            Position.key.in_(list(paths)),
            # further on in the lines, not back to an earlier position (…Ng8 Nb1 after 1.d4 Nf6 2.Nc3)
            Move.ply >= board.ply() + 2,
        )
        .group_by(Opening.id, Opening.name, Position.key)
    ).all()
    best: dict[str, tuple] = {}  # their uci -> (rank, theirs, yours, opening_id, name, lines)
    for oid, name, key, n in rows:
        own = oid == opening.id
        rank = (own, n, name if own else "")  # own opening first, then most lines
        for theirs, yours in paths[key]:
            cur = best.get(theirs.uci())
            if cur is None or rank[:2] > cur[0][:2] or (rank[:2] == cur[0][:2] and name < cur[4]):
                best[theirs.uci()] = (rank, theirs, yours, oid, name, n)
    out = []
    for _, theirs, yours, oid, name, n in best.values():
        their_san = board.san(theirs)
        board.push(theirs)
        your_san = board.san(yours)
        board.pop()
        out.append(
            {
                "uci": theirs.uci(),
                "san": their_san,
                "lines": n,
                "transposes": oid == opening.id,
                "opening": None if oid == opening.id else {"id": oid, "name": name},
                "reply": {"uci": yours.uci(), "san": your_san},
            }
        )
    return sorted(out, key=lambda m: (not m["transposes"], -m["lines"], m["san"]))


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
