"""Importing your own games from lichess.org into Games.

Your Lichess username is an app setting. The Games tab lists your recent finished games straight
from Lichess (nothing is stored until you import one); importing makes a normal game in Games,
remembered by its Lichess id so each Lichess game is imported once. A game you already had from a
PGN (same players, date and moves) is linked instead of copied.

Standard games and games from a set-up position can be imported; Chess960 and other variants can't.
"""

import re
from datetime import datetime, timezone

import chess
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import lichess_api
from app.db.models import AppSetting, Game, GameMove
from app.repositories.game_puzzles import my_names, set_my_names
from app.repositories.games import create_game

SETTING = "lichess_username"
USERNAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$")
GAME_ID = re.compile(r"^[A-Za-z0-9]{8}([A-Za-z0-9]{4})?$")  # a game, or a player's 12-character link
MAX_LIST = 100
NOT_FINISHED = {"created", "started", "aborted", "noStart"}
IMPORTABLE_VARIANTS = {"standard", "fromPosition"}


class NoUsername(ValueError):
    pass


class BadUsername(ValueError):
    pass


class NotImportable(ValueError):
    pass


# ---- the username ----------------------------------------------------------------------


def username(s: Session) -> str | None:
    row = s.get(AppSetting, SETTING)
    return row.value if row and isinstance(row.value, str) and row.value else None


def set_username(s: Session, name: str) -> str | None:
    """Set (or clear, with '') your Lichess username. A new one is added to your names in games
    when you've set those yourself (otherwise the automatic guess includes it already)."""
    name = (name or "").strip()
    if name and not USERNAME.match(name):
        raise BadUsername("That isn't a Lichess username (2–30 letters, digits, - or _)")
    row = s.get(AppSetting, SETTING)
    if row is None:
        s.add(AppSetting(key=SETTING, value=name or None))
    else:
        row.value = name or None
    s.flush()
    names, set_by_you = my_names(s)
    if name and set_by_you and name.lower() not in {n.lower() for n in names}:
        set_my_names(s, [*names, name])
    return name or None


# ---- converting a Lichess game ----------------------------------------------------------


def _player(p: dict) -> tuple[str, int | None]:
    if p.get("aiLevel"):
        return f"Stockfish level {p['aiLevel']}", None
    user = p.get("user") or {}
    return (user.get("name") or user.get("id") or "Anonymous")[:100], p.get("rating")


def _user_id(p: dict) -> str | None:
    user = p.get("user") or {}
    return (user.get("id") or user.get("name") or "").lower() or None


def _result(g: dict) -> str:
    if g.get("winner") == "white":
        return "1-0"
    if g.get("winner") == "black":
        return "0-1"
    if g.get("status") in NOT_FINISHED or g.get("status") == "unknownFinish":
        return "*"
    return "1/2-1/2"  # finished with no winner: draw, stalemate, timeout vs insufficient material


def _clock(g: dict) -> str:
    c = g.get("clock")
    if c:
        minutes = c.get("initial", 0) / 60
        base = {0.25: "¼", 0.5: "½", 0.75: "¾"}.get(minutes, f"{minutes:g}")
        return f"{base}+{c.get('increment', 0)}"
    if g.get("daysPerTurn"):
        return f"{g['daysPerTurn']} day{'s' if g['daysPerTurn'] != 1 else ''}/move"
    return ""


def _speed(g: dict) -> str:
    return (g.get("perf") or g.get("speed") or "").replace("correspondence", "daily").capitalize()


def competition(g: dict) -> str:
    """'Lichess · Rapid 10+0 · rated'"""
    kind = " ".join(x for x in (_speed(g), _clock(g)) if x)
    return " · ".join(x for x in ("Lichess", kind, "rated" if g.get("rated") else "casual") if x)[:150]


def _played_at(g: dict) -> datetime | None:
    ms = g.get("createdAt")
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc) if isinstance(ms, (int, float)) else None


def why_not(g: dict) -> str | None:
    """Why a game can't be imported (None = it can)."""
    if g.get("variant", "standard") not in IMPORTABLE_VARIANTS:
        variant = str(g.get("variant"))
        return f"{variant[:1].upper()}{variant[1:]} games can't be imported"
    if g.get("status") in NOT_FINISHED:
        return "Not played to a finish, so it can't be imported"
    return None


def to_game(g: dict) -> dict:
    """A Lichess game (API JSON) as create_game data. Raises NotImportable."""
    reason = why_not(g)
    if reason:
        raise NotImportable(reason)
    start_fen = g.get("initialFen") if g.get("variant") == "fromPosition" else None
    if start_fen and start_fen.split()[:4] == chess.STARTING_FEN.split()[:4]:
        start_fen = None
    board = chess.Board(start_fen) if start_fen else chess.Board()
    ucis = []
    try:
        for san in (g.get("moves") or "").split():
            move = board.parse_san(san)
            ucis.append(move.uci())
            board.push(move)
    except ValueError as exc:
        raise NotImportable(f"Lichess sent a move MPCT couldn't read: {exc}") from exc
    white, _ = _player(g["players"]["white"])
    black, _ = _player(g["players"]["black"])
    played = _played_at(g)
    return {
        "white": white,
        "black": black,
        "white_team": "",
        "black_team": "",
        "competition": competition(g),
        "played_on": played.date() if played else None,
        "result": _result(g),
        "start_fen": start_fen,
        "moves": ucis,
        "category": "online",
    }


def summary(g: dict, me: str | None, imported: dict[str, int]) -> dict:
    """One row of the recent-games list."""
    white, white_rating = _player(g["players"]["white"])
    black, black_rating = _player(g["players"]["black"])
    me = (me or "").lower()
    color = "white" if me and _user_id(g["players"]["white"]) == me else "black" if me and _user_id(g["players"]["black"]) == me else None
    played = _played_at(g)
    return {
        "id": g["id"],
        "white": white,
        "white_rating": white_rating,
        "black": black,
        "black_rating": black_rating,
        "result": _result(g),
        "my_color": color,
        "played_at": played,
        "speed": _speed(g),
        "clock": _clock(g),
        "rated": bool(g.get("rated")),
        "opening": (g.get("opening") or {}).get("name"),
        "plies": len((g.get("moves") or "").split()),
        "status": g.get("status") or "",
        "importable": why_not(g) is None,
        "not_importable": why_not(g),
        "game_id": imported.get(g["id"]),
    }


# ---- Lichess requests -------------------------------------------------------------------


def _fetch_recent(name: str, n: int, get) -> list[dict]:
    params = {"max": n, "moves": "true", "opening": "true", "clocks": "false", "evals": "false", "finished": "true"}
    try:
        return (get or lichess_api.get)(f"/api/games/user/{name}", params, ndjson=True)
    except lichess_api.NotFound as exc:
        raise lichess_api.NotFound(f"Lichess has no player called {name}") from exc


def _fetch_game(game_id: str, get) -> dict:
    params = {"moves": "true", "opening": "true", "clocks": "false", "evals": "false"}
    try:
        return (get or lichess_api.get)(f"/game/export/{game_id}", params)
    except lichess_api.NotFound as exc:
        raise lichess_api.NotFound("Lichess has no game with that id") from exc


def _need_username(s: Session) -> str:
    name = username(s)
    if not name:
        raise NoUsername("Set your Lichess username first")
    return name


def _imported(s: Session, ids: list[str]) -> dict[str, int]:
    if not ids:
        return {}
    return dict(s.execute(select(Game.lichess_id, Game.id).where(Game.lichess_id.in_(ids))).all())


def recent(s: Session, n: int = 20, get=None) -> dict:
    """Your most recent finished Lichess games, newest first, marked with their copy in Games."""
    name = _need_username(s)
    games = _fetch_recent(name, max(1, min(n, MAX_LIST)), get)
    imported = _imported(s, [g["id"] for g in games])
    return {"username": name, "games": [summary(g, name, imported) for g in games]}


# ---- importing --------------------------------------------------------------------------


def _existing_copy(s: Session, data: dict) -> int | None:
    """A game already in Games with the same players, date and moves (e.g. imported as PGN), not yet linked."""
    candidates = s.scalars(
        select(Game.id).where(
            Game.white == data["white"],
            Game.black == data["black"],
            Game.played_on.is_not_distinct_from(data["played_on"]),
            Game.lichess_id.is_(None),
        )
    ).all()
    for game_id in candidates:
        if s.scalars(select(GameMove.uci).where(GameMove.game_id == game_id).order_by(GameMove.ply)).all() == data["moves"]:
            return game_id
    return None


def _store(s: Session, g: dict) -> dict:
    """Import one Lichess game (API JSON): {game_id, created}."""
    found = s.scalar(select(Game.id).where(Game.lichess_id == g["id"]))
    if found:
        return {"game_id": found, "created": False}
    data = to_game(g)
    game_id = _existing_copy(s, data)
    created = game_id is None
    if created:
        game_id = create_game(s, data)["id"]
    game = s.get(Game, game_id)
    game.lichess_id = g["id"]
    game.category = "online"  # a copy imported as PGN earlier moves to the Online group
    s.flush()
    return {"game_id": game_id, "created": created}


def import_game(s: Session, game_id: str, get=None) -> dict:
    """Import a Lichess game by id (or find the copy already in Games)."""
    if not GAME_ID.match(game_id):
        raise lichess_api.NotFound("That isn't a Lichess game id")
    game_id = game_id[:8]
    found = s.scalar(select(Game.id).where(Game.lichess_id == game_id))
    if found:
        return {"game_id": found, "created": False}
    return _store(s, _fetch_game(game_id, get))


def import_latest(s: Session, get=None) -> dict:
    """Your most recent finished Lichess game that can be imported: {game_id, created, lichess_id}."""
    name = _need_username(s)
    for g in _fetch_recent(name, 5, get):
        if why_not(g) is None:
            return _store(s, g) | {"lichess_id": g["id"]}
    raise lichess_api.NotFound(f"No finished games on Lichess for {name}")


def import_new(s: Session, n: int = 20, get=None) -> dict:
    """Import every game in your last n on Lichess that isn't in Games yet (one request)."""
    name = _need_username(s)
    games = _fetch_recent(name, max(1, min(n, MAX_LIST)), get)
    imported, already, skipped, ids = 0, 0, 0, []
    for g in reversed(games):  # oldest first, so newer games get higher ids
        if why_not(g):
            skipped += 1
            continue
        try:
            r = _store(s, g)
        except NotImportable:
            skipped += 1
            continue
        if r["created"]:
            imported += 1
            ids.append(r["game_id"])
        else:
            already += 1
    return {"imported": imported, "already": already, "skipped": skipped, "game_ids": ids}
