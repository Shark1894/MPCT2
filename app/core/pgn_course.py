"""Reading a PGN file as a Training course: endgame studies, or any set of exercises from set-up
positions. Pure python-chess, no database.

Each game becomes one exercise: from its start position (the FEN tag, else the initial position)
you play the side to move, and the other side's moves are played for you. The main line is the
solution. Comments become notes by ply (0 = before the first move, n = after move n); a sideline
is written out in brackets on the note after the main move it replaces, so it never gives the
answer away. The start note says what to do ("White to play and win") and where the study is
from (composer, source, year).

Chapters come from the games: by material (pawn endings, rook endings ... for endgame studies),
by the Event tag, or one chapter for everything.
"""

import hashlib
import io
import logging
import re
import zlib
from dataclasses import dataclass, field

import chess
import chess.pgn

from app.core.chessable import CourseLine

logging.getLogger("chess.pgn").setLevel(logging.CRITICAL)

GROUPS = ("material", "event", "none")
# Material chapters, in course order (the number is the chapter's stable id).
MATERIAL = {
    "pawn": (1, "Pawn endings"),
    "minor": (2, "Minor piece endings"),
    "rook": (3, "Rook endings"),
    "rook_minor": (4, "Rook and minor piece endings"),
    "queen": (5, "Queen endings"),
    "many": (6, "Many pieces"),
}
MANY = 8  # more pieces than this (kings and pawns not counted) -> "Many pieces"
STIPULATIONS = {"win": "win", "+": "win", "draw": "draw", "=": "draw"}
LETTERS = {chess.QUEEN: "Q", chess.ROOK: "R", chess.BISHOP: "B", chess.KNIGHT: "N", chess.PAWN: "P"}


class NotACourse(ValueError):
    pass


@dataclass
class PgnCourse:
    lines: list[CourseLine]
    chapters: list[dict]  # [{id, title, count}] in course order
    group: str
    skipped: list[str] = field(default_factory=list)


def _header(game: chess.pgn.Game, key: str) -> str:
    v = (game.headers.get(key) or "").strip()
    return "" if v in ("?", "-", "*", "????.??.??") else v


def _year(game: chess.pgn.Game) -> str:
    m = re.match(r"(\d{4})", _header(game, "Date"))
    return m.group(1) if m else ""


def _clean(comment: str) -> str:
    """A PGN comment as plain text: [%clk ...]-style commands dropped, whitespace tidied."""
    text = re.sub(r"\[%[^\]]*\]", "", comment or "")
    return re.sub(r"\s+", " ", text).strip()


def material_text(board: chess.Board) -> str:
    """'R+P v B' (side to move's pieces first would hide who's who: always White v Black)."""
    def side(color):
        parts = []
        for pt in (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN):
            n = len(board.pieces(pt, color))
            if n:
                parts.append(LETTERS[pt] if n == 1 else f"{n}{LETTERS[pt]}")
        return "+".join(parts) or "K"
    return f"{side(chess.WHITE)} v {side(chess.BLACK)}"


def material_group(board: chess.Board) -> str:
    def count(*types):
        return sum(len(board.pieces(t, c)) for t in types for c in (chess.WHITE, chess.BLACK))
    queens, rooks, minors = count(chess.QUEEN), count(chess.ROOK), count(chess.BISHOP, chess.KNIGHT)
    if queens + rooks + minors > MANY:
        return "many"
    if queens:
        return "queen"
    if rooks and minors:
        return "rook_minor"
    if rooks:
        return "rook"
    if minors:
        return "minor"
    return "pawn"


def stipulation(game: chess.pgn.Game, turn: chess.Color) -> str:
    """'win' / 'draw' / '' from the Black tag (HHdb style: Black = "Win"/"Draw") or the result."""
    tag = _header(game, "Black").lower()
    if tag in STIPULATIONS:
        return STIPULATIONS[tag]
    result = _header(game, "Result")
    if result == "1/2-1/2":
        return "draw"
    if (result == "1-0" and turn == chess.WHITE) or (result == "0-1" and turn == chess.BLACK):
        return "win"
    return ""


def _title(game: chess.pgn.Game, number: int, material: str) -> str:
    white, black, year = _header(game, "White"), _header(game, "Black"), _year(game)
    if black.lower() in STIPULATIONS:
        black = ""  # a study: White is the composer
    who = f"{white} – {black}" if white and black else white or black or f"Study {number}"
    return " · ".join(x for x in (", ".join(x for x in (who, year) if x), material) if x)


def _start_note(game: chess.pgn.Game, turn: chess.Color, stip: str) -> str:
    side = "White" if turn == chess.WHITE else "Black"
    task = f"{side} to play and {stip}." if stip else f"{side} to play."
    black = _header(game, "Black")
    who = _header(game, "White") if black.lower() in STIPULATIONS or not black else ""
    source = ", ".join(x for x in (who, _header(game, "Event"), _year(game)) if x)
    return f"{task}\n\n{source}" if source else task


def _sideline(node: chess.pgn.ChildNode) -> str:
    """A variation from `node` on, as text: '3...Kxc6 4.Kf4 (comment)'. Nested ones in brackets."""
    parts = []
    board = node.parent.board()
    first = True
    while node is not None:
        move = node.move
        n = board.fullmove_number
        prefix = f"{n}." if board.turn == chess.WHITE else (f"{n}..." if first else "")
        parts.append(f"{prefix}{board.san(move)}")
        if node.comment and _clean(node.comment):
            parts.append(_clean(node.comment))
        board.push(move)
        for alt in node.variations[1:]:
            parts.append(f"({_sideline(alt)})")
        first = bool(node.variations[1:]) or bool(node.comment)
        node = node.variations[0] if node.variations else None
    return " ".join(parts)


def _exercise_id(start_fen: str, ucis: list[str]) -> int:
    """Stable id for a study (so importing the file again updates it): its position and moves."""
    digest = hashlib.sha1(f"{start_fen}|{' '.join(ucis)}".encode()).hexdigest()
    return int(digest[:15], 16)  # 60 bits: fits a signed bigint


def _chapter(group: str, game: chess.pgn.Game, board: chess.Board, course: str) -> tuple[int, str]:
    if group == "material":
        return MATERIAL[material_group(board)]
    if group == "event":
        event = _header(game, "Event") or "Other"
        return zlib.crc32(event.encode()) & 0x7FFFFFFF, event[:200]
    return 1, course[:200] or "Studies"


def read_games(text: str) -> tuple[list[chess.pgn.Game], list[str]]:
    games, errors = [], []
    stream = io.StringIO(text)
    while True:
        try:
            game = chess.pgn.read_game(stream)
        except Exception as exc:  # noqa: BLE001 - a malformed file: keep what was read
            errors.append(f"Game {len(games) + 1}: could not be read ({exc})")
            break
        if game is None:
            break
        games.append(game)
    return games, errors


def auto_group(games: list[chess.pgn.Game]) -> str:
    """Material when most games start from a set-up position (studies), else by event."""
    setup = sum(1 for g in games if g.headers.get("FEN"))
    return "material" if games and setup * 2 >= len(games) else "event"


def parse_course(text: str, course: str = "", group: str = "auto") -> PgnCourse:
    """A PGN text -> exercises and chapters. Raises NotACourse if nothing in it can be used."""
    games, skipped = read_games(text)
    if not games:
        raise NotACourse(skipped[0] if skipped else "No games in this file")
    if group == "auto":
        group = auto_group(games)
    if group not in GROUPS:
        raise NotACourse(f"Unknown grouping {group!r}")
    lines: list[CourseLine] = []
    chapters: dict[int, dict] = {}
    seen: set[tuple[int, int]] = set()
    for number, game in enumerate(games, start=1):
        label = f"Game {number}"
        if game.errors:
            skipped.append(f"{label}: {game.errors[0]}")
            continue
        try:
            board = game.board()
        except ValueError as exc:
            skipped.append(f"{label}: start position isn't valid ({exc})")
            continue
        if not board.is_valid():
            skipped.append(f"{label}: start position isn't legal")
            continue
        start_fen, turn = board.fen(), board.turn
        material = material_text(board)
        stip = stipulation(game, turn)
        ucis, sans = [], []
        comments: dict[int, str] = {}
        start_note = _start_note(game, turn, stip)
        intro = _clean(game.comment)
        comments[0] = f"{start_note}\n\n{intro}" if intro else start_note
        node = game
        ply = 0
        while node.variations:
            main = node.variations[0]
            sans.append(node.board().san(main.move))
            ucis.append(main.move.uci())
            ply += 1
            notes = []
            if _clean(main.comment):
                notes.append(_clean(main.comment))
            for alt in node.variations[1:]:  # instead of this move: shown once it's been played
                notes.append(f"({_sideline(alt)})")
            if notes:
                comments[ply] = " ".join(notes)
            node = main
        if not ucis:
            skipped.append(f"{label}: no moves")
            continue
        chapter_id, chapter = _chapter(group, game, board, course)
        line_id = _exercise_id(start_fen, ucis)
        if (chapter_id, line_id) in seen:
            skipped.append(f"{label}: the same as an earlier study")
            continue
        seen.add((chapter_id, line_id))
        chapters.setdefault(chapter_id, {"id": chapter_id, "title": chapter, "count": 0})["count"] += 1
        lines.append(CourseLine(
            course_id=0,
            course=course,
            chapter_id=chapter_id,
            chapter=chapter,
            line_id=line_id,
            title=_title(game, number, material)[:200],
            color="white" if turn == chess.WHITE else "black",
            ucis=ucis,
            sans=sans,
            comments=comments,
            start_fen=start_fen,
        ))
    if not lines:
        raise NotACourse(f"Nothing to import: {skipped[0]}" if skipped else "Nothing to import")
    if group == "material":
        order = sorted(chapters.values(), key=lambda c: c["id"])
    else:  # first appearance in the file
        firsts: dict[int, int] = {}
        for i, line in enumerate(lines):
            firsts.setdefault(line.chapter_id, i)
        order = sorted(chapters.values(), key=lambda c: firsts[c["id"]])
    return PgnCourse(lines=lines, chapters=order, group=group, skipped=skipped)
