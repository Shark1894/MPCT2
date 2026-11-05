"""Repertoire gap finder: replies that strong players actually play but your repertoire
doesn't cover, from the Lichess opening explorer's masters database (cached in
explorer_cache by app.explorer).

For one opening:
- Positions checked: every position in its lines where it's the opponent's move and the
  repertoire already answers at least one reply. Line ends are left out (that's where you
  chose to stop) and so is the starting position (an opening for Black answers one first move
  on purpose). The starting position is still looked up, for how often the first move is played.
- Covered: a reply is covered if ANY opening of the same colour in the repertoire has it from
  that position, so transpositions into your other openings aren't gaps.
- How often you'd meet a gap: the chance of reaching the position (the masters share of each
  opponent move on the way, your moves always played) times the reply's share there.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import chess
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.config import settings
from app.core.scheduling import user_plays_ply
from app.db.models import ExplorerCache, Line, Move, Opening, Position
from app.repositories.repertoire import get_opening

SOURCE = "masters"
DEFAULT_MIN_SHARE = 5.0  # percent of the position's masters games
DEFAULT_MIN_GAMES = 5


def _san_key(san: str) -> str:
    return san.rstrip("+#")


@dataclass
class _Node:
    key: str
    ply: int  # ply of the opponent move from here (first time reached)
    path: list[str]  # SAN from the start
    replies: set[str] = field(default_factory=set)  # SAN keys this opening plays from here


def _opening_tree(s: Session, opening: Opening):
    """The opening's opponent-to-move positions (by key) and its moves as (before, after, ply, san) per line."""
    rows = s.execute(
        select(Move.line_id, Move.ply, Move.san, Move.position_before_id, Move.position_after_id)
        .join(Line, Line.id == Move.line_id)
        .where(Line.opening_id == opening.id)
        .order_by(Move.line_id, Move.ply)
    ).all()
    keys = dict(s.execute(select(Position.id, Position.key).where(Position.id.in_({r.position_before_id for r in rows} | {r.position_after_id for r in rows} or {-1}))).all())
    lines: dict[int, list] = {}
    for r in rows:
        lines.setdefault(r.line_id, []).append(r)
    nodes: dict[str, _Node] = {}
    for moves in lines.values():
        path: list[str] = []
        for m in moves:
            if not user_plays_ply(m.ply, opening.color):
                k = keys[m.position_before_id]
                node = nodes.setdefault(k, _Node(k, m.ply, list(path)))
                if m.ply < node.ply:
                    node.ply, node.path = m.ply, list(path)
                node.replies.add(_san_key(m.san))
            path.append(m.san)
    return nodes, lines, keys


def _covered_elsewhere(s: Session, opening: Opening, keys: set[str]) -> dict[str, set[str]]:
    """Replies (SAN keys) from these positions in every opening of the same colour in the repertoire."""
    if not keys:
        return {}
    rows = s.execute(
        select(Position.key, Move.san, Move.ply)
        .join(Move, Move.position_before_id == Position.id)
        .join(Line, Line.id == Move.line_id)
        .join(Opening, Opening.id == Line.opening_id)
        .where(Opening.repertoire_id == opening.repertoire_id, Opening.color == opening.color, Position.key.in_(keys))
    ).all()
    out: dict[str, set[str]] = {}
    for key, san, ply in rows:
        if not user_plays_ply(ply, opening.color):
            out.setdefault(key, set()).add(_san_key(san))
    return out


def _fresh_since() -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=settings.explorer_cache_days)


def cached(s: Session, keys: list[str]) -> dict[str, dict]:
    if not keys:
        return {}
    rows = s.execute(
        select(ExplorerCache.key, ExplorerCache.data).where(
            ExplorerCache.source == SOURCE, ExplorerCache.key.in_(keys), ExplorerCache.fetched_at >= _fresh_since()
        )
    ).all()
    return dict(rows)


def store(s: Session, key: str, data: dict) -> None:
    keep = {
        "white": int(data.get("white", 0)),
        "draws": int(data.get("draws", 0)),
        "black": int(data.get("black", 0)),
        "moves": [
            {k: m.get(k) for k in ("uci", "san", "white", "draws", "black", "averageRating")} for m in data.get("moves", [])
        ],
    }
    if "topGames" in data:  # the Masters panel's game list (absent in entries cached before v0.27.0)
        keep["topGames"] = [
            {
                "id": g.get("id"),
                "white": {"name": (g.get("white") or {}).get("name"), "rating": (g.get("white") or {}).get("rating")},
                "black": {"name": (g.get("black") or {}).get("name"), "rating": (g.get("black") or {}).get("rating")},
                "winner": g.get("winner"),
                "year": g.get("year"),
                "month": g.get("month"),
                "uci": g.get("uci"),
            }
            for g in data["topGames"]
            if g.get("id")
        ]
    stmt = insert(ExplorerCache).values(key=key, source=SOURCE, data=keep)
    s.execute(stmt.on_conflict_do_update(index_elements=["key", "source"], set_={"data": keep, "fetched_at": stmt.excluded.fetched_at}))


def positions_to_look_up(s: Session, opening_id: int) -> list[str]:
    """Every opponent-to-move position of the opening (the start included, for move shares)."""
    opening = get_opening(s, opening_id)
    nodes, _, _ = _opening_tree(s, opening)
    return sorted(nodes, key=lambda k: (nodes[k].ply, k))


def missing(s: Session, opening_id: int) -> list[str]:
    keys = positions_to_look_up(s, opening_id)
    have = cached(s, keys)
    return [k for k in keys if k not in have]


def _total(d: dict) -> int:
    return d["white"] + d["draws"] + d["black"]


def _reach(opening: Opening, lines: dict, keys: dict, data: dict[str, dict]) -> dict[str, float | None]:
    """Chance of reaching each position (max over the routes the lines take). None = unknown
    (a position on the way hasn't been looked up, or masters never reached it)."""
    reach: dict[str, float | None] = {}
    for moves in lines.values():
        p: float | None = 1.0
        for m in moves:
            before = keys[m.position_before_id]
            if before not in reach or (p is not None and (reach[before] is None or p > reach[before])):
                reach[before] = p
            if not user_plays_ply(m.ply, opening.color):
                d = data.get(before)
                if p is None or d is None or _total(d) == 0:
                    p = None
                else:
                    games = next((_count(x) for x in d["moves"] if _san_key(x["san"]) == _san_key(m.san)), 0)
                    p = p * games / _total(d)
    return reach


def _count(m: dict) -> int:
    return (m.get("white") or 0) + (m.get("draws") or 0) + (m.get("black") or 0)


def find_gaps(s: Session, opening_id: int, min_share: float = DEFAULT_MIN_SHARE, min_games: int = DEFAULT_MIN_GAMES) -> dict:
    opening = get_opening(s, opening_id)
    nodes, lines, keys = _opening_tree(s, opening)
    data = cached(s, list(nodes))
    checkable = [n for n in nodes.values() if n.ply > 1]  # not the starting position
    covered = _covered_elsewhere(s, opening, {n.key for n in checkable})
    reach = _reach(opening, lines, keys, data)

    gaps = []
    for n in checkable:
        d = data.get(n.key)
        if not d or _total(d) == 0:
            continue
        total = _total(d)
        have = n.replies | covered.get(n.key, set())
        board = chess.Board(f"{n.key} 0 1")
        for m in d["moves"]:
            games = _count(m)
            share = 100 * games / total
            if _san_key(m["san"]) in have or share < min_share or games < min_games:
                continue
            try:
                uci = board.parse_san(m["san"]).uci()  # our UCI (Lichess writes castling as king-takes-rook)
            except ValueError:
                continue
            r = reach.get(n.key)
            gaps.append(
                {
                    "fen": f"{n.key} 0 {(n.ply - 1) // 2 + 1}",
                    "ply": n.ply,
                    "path": n.path,  # SAN from the start to the position
                    "san": m["san"],
                    "uci": uci,
                    "share": round(share, 1),
                    "games": games,
                    "position_games": total,
                    "score": {"white": m.get("white") or 0, "draws": m.get("draws") or 0, "black": m.get("black") or 0},
                    "reach": None if r is None else round(100 * r, 2),  # % of masters games reaching the position
                    "meet": None if r is None else round(r * share, 2),  # % of games where you'd face this reply
                    "covered": sorted(n.replies | covered.get(n.key, set())),
                }
            )
    gaps.sort(key=lambda g: (g["meet"] is None, -(g["meet"] or 0), -g["share"]))
    return {
        "opening": {"id": opening.id, "name": opening.name, "color": opening.color},
        "positions": len(nodes),
        "checked": len(data),
        "gaps": gaps,
    }
