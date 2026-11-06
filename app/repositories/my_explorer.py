"""The board's "Your games" panel: from any position, what was played next in your own games
(over the board, optionally online too), with the results, and the games that reached it.

Positions are matched by key (python-chess EPD), so transpositions count. Every game in the
chosen groups is replayed once into an index (key -> games and the move each played from there),
kept in memory until a game in those groups is added, changed or deleted.
"""

from dataclasses import dataclass, field
from types import SimpleNamespace

import chess
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.positions import key_from_fen, position_key
from app.db.models import Game, GameMove
from app.repositories.game_puzzles import my_color, my_names
from app.repositories.games import CATEGORIES

EXPLORER_GROUPS = ("otb", "online")
MAX_GAMES_LISTED = 30


@dataclass
class Index:
    signature: tuple
    games: dict[int, SimpleNamespace] = field(default_factory=dict)  # plain copies: the index outlives the session
    # key -> [(game id, ply where the position appeared, uci played next or None, san)]
    at: dict[str, list[tuple[int, int, str | None, str | None]]] = field(default_factory=dict)


_cache: dict[tuple, Index] = {}


def _signature(s: Session, groups: tuple[str, ...]) -> tuple:
    count, latest, top = s.execute(
        select(func.count(), func.max(Game.updated_at), func.max(Game.id)).where(Game.category.in_(groups))
    ).one()
    return (count, latest, top)


def _build(s: Session, groups: tuple[str, ...], signature: tuple) -> Index:
    index = Index(signature)
    cols = ("id", "white", "black", "result", "played_on", "competition", "category", "start_fen", "created_at")
    games = [
        SimpleNamespace(**dict(zip(cols, row)))
        for row in s.execute(select(*(getattr(Game, c) for c in cols)).where(Game.category.in_(groups)))
    ]
    index.games = {g.id: g for g in games}
    moves: dict[int, list[tuple[str, str]]] = {}
    if games:
        for game_id, uci, san in s.execute(
            select(GameMove.game_id, GameMove.uci, GameMove.san)
            .where(GameMove.game_id.in_(list(index.games)))
            .order_by(GameMove.game_id, GameMove.ply)
        ):
            moves.setdefault(game_id, []).append((uci, san))
    for g in games:
        try:
            board = chess.Board(g.start_fen) if g.start_fen else chess.Board()
        except ValueError:
            continue
        seen: set[str] = set()
        line = moves.get(g.id, [])
        for ply in range(len(line) + 1):
            key = position_key(board)
            nxt = line[ply] if ply < len(line) else (None, None)
            if key not in seen:  # a repeated position counts once, at its first visit
                seen.add(key)
                index.at.setdefault(key, []).append((g.id, ply, nxt[0], nxt[1]))
            if ply < len(line):
                try:
                    board.push(chess.Move.from_uci(nxt[0]))
                except ValueError:
                    break
    return index


def _index(s: Session, groups: tuple[str, ...]) -> Index:
    sig = _signature(s, groups)
    cached = _cache.get(groups)
    if cached is None or cached.signature != sig:
        cached = _build(s, groups, sig)
        _cache[groups] = cached
    return cached


def _tally(results: list[str], colors: list[str | None]) -> dict:
    out = {"white": 0, "draws": 0, "black": 0, "won": 0, "drawn": 0, "lost": 0}
    for r, c in zip(results, colors):
        if r == "1-0":
            out["white"] += 1
        elif r == "0-1":
            out["black"] += 1
        elif r == "1/2-1/2":
            out["draws"] += 1
        if c and r != "*":
            if r == "1/2-1/2":
                out["drawn"] += 1
            elif (r == "1-0") == (c == "white"):
                out["won"] += 1
            else:
                out["lost"] += 1
    return out


def parse_groups(text: str | None) -> tuple[str, ...]:
    groups = tuple(sorted({g.strip() for g in (text or "otb").split(",") if g.strip()}))
    bad = [g for g in groups if g not in CATEGORIES]
    if bad or not groups:
        raise ValueError(f"Unknown group: {', '.join(bad) or '(none)'}")
    return groups


def lookup(s: Session, fen: str, groups: tuple[str, ...] = ("otb",)) -> dict:
    """Moves played from the position in your games in `groups`, with results, and the games."""
    key = key_from_fen(fen)
    index = _index(s, groups)
    hits = index.at.get(key, [])
    names, _ = my_names(s)
    colors = {gid: my_color(index.games[gid], names) for gid, *_ in hits}
    results = {gid: index.games[gid].result for gid, *_ in hits}

    by_move: dict[str, dict] = {}
    for gid, _ply, uci, san in hits:
        if uci is None:
            continue
        m = by_move.setdefault(uci, {"uci": uci, "san": san, "ids": []})
        m["ids"].append(gid)
    moves = []
    for m in by_move.values():
        t = _tally([results[i] for i in m["ids"]], [colors[i] for i in m["ids"]])
        moves.append({"uci": m["uci"], "san": m["san"], "games": len(m["ids"]), **t})
    moves.sort(key=lambda m: (-m["games"], m["san"]))

    ids = [gid for gid, *_ in hits]
    total = _tally([results[i] for i in ids], [colors[i] for i in ids])
    listed = sorted(hits, key=lambda h: (index.games[h[0]].played_on or index.games[h[0]].created_at.date(), h[0]), reverse=True)
    games = []
    for gid, ply, _uci, san in listed[:MAX_GAMES_LISTED]:
        g = index.games[gid]
        games.append(
            {
                "id": gid,
                "white": g.white,
                "black": g.black,
                "result": g.result,
                "played_on": g.played_on,
                "competition": g.competition,
                "category": g.category,
                "my_color": colors[gid],
                "ply": ply,  # the position is reached after this many moves
                "san": san,  # what was played next (None: the game ended here)
            }
        )
    return {"key": key, "groups": list(groups), "total": len(hits), **total, "moves": moves, "games": games}
