"""The board's Masters panel: what strong players play from any position, and the games
behind it, from the Lichess masters database.

Positions share the gap finder's explorer_cache (one lookup gives both the moves and the top
games). A position is looked up while you wait the first time, then served from the cache
for explorer_cache_days. Entries cached by the gap finder before v0.27.0 have no game list
and are looked up again once.

Opening a masters game fetches its PGN once and keeps it in masters_games, so it opens again
without Lichess and can be saved to Games.
"""

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import explorer
from app.core.pgn import parse_pgn_date
from app.core.positions import key_from_fen
from app.core.wild import read_games
from app.db.models import ExplorerCache, Game, GameMove, MastersGame
from app.repositories import gaps
from app.repositories.games import create_game
from app.repositories.repertoire import NotFound

GAME_ID = re.compile(r"^[A-Za-z0-9]{8,12}$")
RESULT = {"white": "1-0", "black": "0-1", None: "1/2-1/2"}


class NoToken(explorer.ExplorerError):
    pass


def _cached(s: Session, key: str) -> dict | None:
    row = s.scalar(
        select(ExplorerCache.data).where(
            ExplorerCache.key == key, ExplorerCache.source == gaps.SOURCE, ExplorerCache.fetched_at >= gaps._fresh_since()
        )
    )
    return row if row is not None and "topGames" in row else None


def _player(p: dict) -> tuple[str, int | None]:
    return (p.get("name") or "?", p.get("rating"))


def _out(key: str, data: dict) -> dict:
    total = data["white"] + data["draws"] + data["black"]
    moves = [
        {
            "uci": m["uci"],
            "san": m["san"],
            "white": m["white"],
            "draws": m["draws"],
            "black": m["black"],
            "games": m["white"] + m["draws"] + m["black"],
            "average_rating": m.get("averageRating"),
        }
        for m in data["moves"]
    ]
    games = []
    for g in data.get("topGames", []):
        white, white_elo = _player(g["white"])
        black, black_elo = _player(g["black"])
        games.append(
            {
                "id": g["id"],
                "white": white,
                "white_elo": white_elo,
                "black": black,
                "black_elo": black_elo,
                "result": RESULT.get(g.get("winner"), "1/2-1/2"),
                "year": g.get("year"),
                "month": g.get("month"),
                "uci": g.get("uci"),  # the move played from this position
            }
        )
    return {"key": key, "white": data["white"], "draws": data["draws"], "black": data["black"], "total": total, "moves": moves, "games": games}


def lookup(s: Session, fen: str, get=None) -> dict:
    """Masters moves and top games for a position. Raises InvalidPosition, NoToken, ExplorerError."""
    key = key_from_fen(fen)
    data = _cached(s, key)
    if data is None:
        if not explorer.token_set():
            raise NoToken("The masters explorer needs a Lichess API token: add LICHESS_TOKEN to the server's .env and restart the app.")
        raw = (get or explorer.http_get)(explorer.masters_url(key), timeout=15, wait=False)
        gaps.store(s, key, raw)
        s.flush()
        data = _cached(s, key)
    return _out(key, data)


# ---- games ---------------------------------------------------------------------------------


def _year_month(date_text: str | None) -> tuple[int | None, int | None]:
    parts = ((date_text or "").split(".") + ["", ""])[:2]
    year, month = (int(p) if p.isdigit() else None for p in parts)
    return year, month


def _pgn_date(pgn: str) -> str | None:
    m = re.search(r'^\[Date "([^"]*)"\]', pgn, re.M)
    return m.group(1) if m else None


def _game_dict(g: MastersGame) -> dict:
    return {
        "id": g.id,
        "source": "masters",
        "white": g.white,
        "black": g.black,
        "white_elo": g.white_elo,
        "black_elo": g.black_elo,
        "event": g.event,
        "site": g.site,
        "round": g.round,
        "played_on": g.played_on,
        "year": g.year,
        "month": g.month,
        "result": g.result,
        "plies": len(g.moves.split()),
        "moves": g.moves.split(),
    }


def get_game(s: Session, game_id: str, get=None) -> dict:
    """A masters game, fetched from Lichess the first time. Raises NotFound, NoToken, ExplorerError."""
    if not GAME_ID.match(game_id):
        raise NotFound("No such masters game")
    g = s.get(MastersGame, game_id)
    if g is None:
        if not explorer.token_set():
            raise NoToken("Opening masters games needs a Lichess API token: add LICHESS_TOKEN to the server's .env and restart the app.")
        try:
            pgn = (get or explorer.http_get)(explorer.masters_pgn_url(game_id), timeout=15, wait=False, text=True)
        except explorer.NotFound as exc:
            raise NotFound("Lichess has no masters game with that id") from exc
        parsed, _ = read_games(pgn)
        if not parsed:
            raise explorer.ExplorerError("Lichess sent a game MPCT couldn't read")
        p = parsed[0]
        year, month = _year_month(_pgn_date(pgn))
        g = MastersGame(
            id=game_id,
            white=p.white,
            black=p.black,
            white_elo=p.white_elo,
            black_elo=p.black_elo,
            event=p.event,
            site=p.site,
            round=p.round,
            year=year,
            month=month,
            played_on=p.played_on or parse_pgn_date(_pgn_date(pgn)),
            result=p.result,
            moves=" ".join(p.moves),
            pgn=pgn.strip() + "\n",
        )
        s.add(g)
        s.flush()
    return _game_dict(g)


def game_pgn(s: Session, game_id: str) -> tuple[str, str]:
    g = s.get(MastersGame, game_id)
    if g is None:
        raise NotFound("No such masters game")
    name = "-".join(x for x in (g.white.split(",")[0], g.black.split(",")[0], str(g.year or "")) if x)
    return g.pgn, "".join(c if c.isalnum() or c in "-_" else "_" for c in name) + ".pgn"


def save_to_games(s: Session, game_id: str) -> dict:
    """Copy a masters game into the Games tab (once: saving again opens the existing copy)."""
    g = s.get(MastersGame, game_id)
    if g is None:
        raise NotFound("No such masters game")
    competition = (g.event or "Masters game")[:150]
    moves = g.moves.split()
    candidates = s.scalars(
        select(Game.id).where(Game.white == g.white, Game.black == g.black, Game.played_on.is_not_distinct_from(g.played_on))
    ).all()
    for game_id in candidates:  # same players, date and moves (a match has many games with one date)
        if s.scalars(select(GameMove.uci).where(GameMove.game_id == game_id).order_by(GameMove.ply)).all() == moves:
            return {"game_id": game_id, "created": False}
    game = create_game(
        s,
        {
            "white": g.white,
            "black": g.black,
            "white_team": "",
            "black_team": "",
            "competition": competition,
            "played_on": g.played_on,
            "result": g.result,
            "moves": moves,
        },
    )
    return {"game_id": game["id"], "created": True}
