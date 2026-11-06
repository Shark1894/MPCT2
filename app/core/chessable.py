"""Reading a Chessable course line (one entry of a course export's bookData, in the shape of the
study page's getGame answer). Pure, no database and no network.

A line's JSON has `game.data`: one entry per move (SAN), each with optional author notes in
`before` / `after` (a JSON string: {"before": fen, "after": fen, "data": [nodes]}). A node is
{"key": "C", "val": text} (a comment, with a little HTML and @@...@@ markers),
{"key": "S", "val": "8...dxc4"} (a move inside a sideline), or {"key": "V", "val": [nodes]}
(a sideline). `game.commentsByFEN` is the community forum and is ignored.

Notes become plain text: sidelines are written out in brackets, e.g.
"This defends d5 again. (8...dxc4 Black trades on c4. 9.Bxc4 Nd7 10.O-O)".
"""

import html
import json
import re
from dataclasses import dataclass, field

import chess

MARKERS = {"@@StartBracket@@": "(", "@@EndBracket@@": ")", "@@SANStart@@": "", "@@SANEnd@@": ""}


class NotALine(ValueError):
    pass


@dataclass
class CourseLine:
    course_id: int
    course: str  # "Starting Out: 1.d4"
    chapter_id: int
    chapter: str  # "1) Queen's Gambit Declined"
    line_id: int  # Chessable's oid
    title: str  # "QGD - Anti-Tartakower"
    color: str  # 'white' / 'black': the side the course trains
    ucis: list[str]
    sans: list[str]
    # Notes by ply: 0 = the start position, n = the position after move n.
    comments: dict[int, str] = field(default_factory=dict)
    kind: str = "line"  # 'line', 'info' (a page to read, not trained), 'reference' (not trained), 'alternative' (another move order)
    start_fen: str = chess.STARTING_FEN


def clean_text(text: str) -> str:
    """Chessable comment HTML -> plain text."""
    text = re.sub(r"@@StartFEN@@.*?@@EndFEN@@", "", text, flags=re.S)  # marks where the moves after it start
    for marker, plain in MARKERS.items():
        text = text.replace(marker, plain)
    text = re.sub(r"@@\w+@@", "", text)  # any marker not known yet
    text = re.sub(r"<br\s*/?>|</p>\s*<p[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text).replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r" +([,;:!?]|\.(?!\.))", r"\1", text)
    return text.strip()


def render(nodes: list, top: bool = True) -> str:
    """Comment nodes -> text. Top-level parts are separate paragraphs; a sideline is one bracket."""
    parts = []
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        key, val = n.get("key"), n.get("val")
        if key == "C" and isinstance(val, str):
            text = clean_text(val)
        elif key == "S" and isinstance(val, str):
            text = val.strip()
        elif key == "V" and isinstance(val, list):
            inner = render(val, top=False)
            first = next((x for x in val if isinstance(x, dict)), {})
            # A sideline starts with a move; a block that starts with words is prose with moves in it.
            text = f"({inner})" if inner and first.get("key") in ("S", "V") else inner
        else:
            continue
        if text:
            parts.append(text)
    if not top:
        return _tidy(" ".join(parts))
    # Paragraphs at the top level, but a comment followed by its own moves stays together.
    out: list[str] = []
    for p in parts:
        if out and not p.startswith("(") and not out[-1].startswith("("):
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return "\n\n".join(_tidy(p) for p in out)


def _tidy(text: str) -> str:
    return re.sub(r" +([,;:!?]|\.(?!\.))", r"\1", text)


def _notes(raw) -> str:
    if not raw:
        return ""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return clean_text(raw) if isinstance(raw, str) else ""
    if isinstance(data, dict):
        return render(data.get("data") or [])
    if isinstance(data, list):
        return render(data)
    return ""


def parse_line(doc: dict) -> CourseLine:
    """A getGame response -> CourseLine for a repertoire (from the initial position, with moves).
    Raises NotALine for anything that can't be trained as an opening line."""
    line = _parse(doc)
    if line.start_fen.split()[:4] != chess.STARTING_FEN.split()[:4]:
        raise NotALine("starts from a set-up position (MPCT lines start from the initial position)")
    if not line.ucis:
        raise NotALine("no moves (an information page, not a line)")
    return line


def parse_exercise(doc: dict) -> CourseLine:
    """A getGame response -> CourseLine for the Training tab: any start position, and pages with
    no moves (to read) are fine. Raises NotALine for deleted or unreadable lines."""
    return _parse(doc)


def _parse(doc: dict) -> CourseLine:
    game = doc.get("game") if isinstance(doc, dict) else None
    if not isinstance(game, dict) or not isinstance(game.get("data"), list):
        raise NotALine("not a Chessable line (no game.data)")
    if game.get("isDel"):
        raise NotALine("deleted line")
    start = (game.get("initial") or chess.STARTING_FEN).strip()
    try:
        board = chess.Board(start)
    except ValueError as exc:
        raise NotALine(f"start position isn't a valid FEN: {exc}") from exc
    color = (game.get("color") or "").lower()
    if color not in ("white", "black"):
        raise NotALine(f"unknown course colour {game.get('color')!r}")

    ucis, sans, comments = [], [], {}
    for ply, m in enumerate(game["data"], start=1):
        before = _notes(m.get("before"))
        if before:
            comments[ply - 1] = "\n\n".join(x for x in (comments.get(ply - 1), before) if x)
        try:
            move = board.parse_san(m["san"])
        except (KeyError, ValueError) as exc:
            raise NotALine(f"move {ply} ({m.get('san')!r}) isn't legal: {exc}") from exc
        sans.append(board.san(move))
        ucis.append(move.uci())
        board.push(move)
        after = _notes(m.get("after"))
        if after:
            comments[ply] = after
    return CourseLine(
        course_id=int(game.get("bid") or 0),
        course=(game.get("name") or "Chessable course").strip(),
        chapter_id=int(game.get("lid") or 0),
        chapter=(game.get("lineName") or f"Chapter {game.get('lid')}").strip(),
        line_id=int(game.get("oid") or 0),
        title=(game.get("title") or "").strip(),
        color=color,
        ucis=ucis,
        sans=sans,
        comments=comments,
        kind="info" if game.get("isInfo") or not ucis else "reference" if game.get("isRef") else "alternative" if game.get("isAlt") else "line",
        start_fen=chess.Board(start).fen(),
    )
