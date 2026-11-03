"""Repertoire in the wild: watched positions, the store of tournament games, and matching.

Games are stored once for everyone (they're shared across repertoires); a watch belongs
to an opening. Matching is an indexed lookup of the watch's position hash in each game's
array of position hashes, so a new watch immediately finds games already stored.
"""

from datetime import date, datetime, timedelta

from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.dialects.postgresql import array, insert
from sqlalchemy.orm import Session

from app.core.positions import START_KEY, key_from_fen
from app.core.wild import WildGame as Parsed
from app.core.wild import key_hash
from app.db.models import Game, Line, Move, Opening, Position, WildGame, WildSource, WildWatch
from app.repositories.games import create_game
from app.repositories.repertoire import Conflict, NotFound, get_opening, get_repertoire
from app.repositories.tags import _path_to

BATCH = 500


class InvalidWatch(ValueError):
    pass


# ---- watches -------------------------------------------------------------------------


def _watch_counts(s: Session, watches: list[WildWatch]) -> dict[int, tuple[int, date | None]]:
    out = {}
    for w in watches:
        n, latest = s.execute(
            select(func.count(), func.max(WildGame.played_on)).where(WildGame.hashes.contains([w.hash]))
        ).one()
        out[w.id] = (n, latest)
    return out


def _watch_dict(s: Session, w: WildWatch, opening: Opening, key: str, counts) -> dict:
    n, latest = counts.get(w.id, (0, None))
    return {
        "id": w.id,
        "opening_id": opening.id,
        "opening_name": opening.name,
        "color": opening.color,
        "label": w.label,
        "key": key,
        "path": _path_to(s, opening.id, w.position_id),
        "games": n,
        "latest_played_on": latest,
    }


def list_watches(s: Session, repertoire_id: int) -> list[dict]:
    get_repertoire(s, repertoire_id)
    rows = s.execute(
        select(WildWatch, Opening, Position.key)
        .join(Opening, Opening.id == WildWatch.opening_id)
        .join(Position, Position.id == WildWatch.position_id)
        .where(Opening.repertoire_id == repertoire_id)
    ).all()
    counts = _watch_counts(s, [w for w, _, _ in rows])
    out = [_watch_dict(s, w, o, key, counts) for w, o, key in rows]
    return sorted(out, key=lambda w: (w["color"] != "white", w["opening_name"].lower(), len(w["path"]), w["id"]))


def _get_watch(s: Session, watch_id: int) -> WildWatch:
    w = s.get(WildWatch, watch_id)
    if w is None:
        raise NotFound(f"Watched position {watch_id} not found")
    return w


def _one(s: Session, w: WildWatch) -> dict:
    opening = s.get(Opening, w.opening_id)
    key = s.scalar(select(Position.key).where(Position.id == w.position_id))
    return _watch_dict(s, w, opening, key, _watch_counts(s, [w]))


def create_watch(s: Session, opening_id: int, fen: str, label: str = "") -> dict:
    get_opening(s, opening_id)
    key = key_from_fen(fen)
    if key == START_KEY:
        raise InvalidWatch("Every game starts here: watch a position after at least one move")
    position_id = s.scalar(select(Position.id).where(Position.key == key))
    reached = position_id is not None and s.scalar(
        select(func.count(Move.id)).join(Line).where(Line.opening_id == opening_id, Move.position_after_id == position_id)
    )
    if not reached:
        raise InvalidWatch("No line in this opening passes through this position yet: add a line first")
    if s.scalar(select(WildWatch.id).where(WildWatch.opening_id == opening_id, WildWatch.position_id == position_id)):
        raise Conflict("You're already watching this position")
    w = WildWatch(opening_id=opening_id, position_id=position_id, hash=key_hash(key), label=label)
    s.add(w)
    s.flush()
    return _one(s, w)


def update_watch(s: Session, watch_id: int, label: str) -> dict:
    w = _get_watch(s, watch_id)
    w.label = label
    s.flush()
    return _one(s, w)


def delete_watch(s: Session, watch_id: int) -> None:
    s.delete(_get_watch(s, watch_id))
    s.flush()


def opening_watches(s: Session, opening_id: int) -> list[dict]:
    """Watches of one opening (for the board's repertoire panel)."""
    opening = get_opening(s, opening_id)
    rows = s.execute(
        select(WildWatch, Position.key)
        .join(Position, Position.id == WildWatch.position_id)
        .where(WildWatch.opening_id == opening_id)
    ).all()
    counts = _watch_counts(s, [w for w, _ in rows])
    return [_watch_dict(s, w, opening, key, counts) for w, key in rows]


# ---- games -----------------------------------------------------------------------------


def _game_row(g: WildGame) -> dict:
    return {
        "id": g.id,
        "source": g.source,
        "white": g.white,
        "black": g.black,
        "white_elo": g.white_elo,
        "black_elo": g.black_elo,
        "event": g.event,
        "site": g.site,
        "round": g.round,
        "played_on": g.played_on,
        "result": g.result,
        "plies": g.plies,
        "imported_at": g.imported_at,
    }


def list_games(
    s: Session,
    repertoire_id: int,
    watch_id: int | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """Games reaching any watched position of the repertoire (or one watch), newest first."""
    get_repertoire(s, repertoire_id)
    wq = select(WildWatch.id, WildWatch.hash).join(Opening).where(Opening.repertoire_id == repertoire_id)
    if watch_id is not None:
        wq = wq.where(WildWatch.id == watch_id)
    watches = s.execute(wq).all()
    if watch_id is not None and not watches:
        raise NotFound(f"Watched position {watch_id} not found in this repertoire")
    matches: dict[int, list[dict]] = {}
    for w_id, h in watches:
        for g_id, ply in s.execute(
            select(WildGame.id, func.array_position(WildGame.hashes, h)).where(WildGame.hashes.contains([h]))
        ).all():
            matches.setdefault(g_id, []).append({"watch_id": w_id, "ply": ply})
    if not matches:
        return {"total": 0, "games": []}
    gq = select(WildGame).where(WildGame.id.in_(matches))
    if q and q.strip():
        like = f"%{q.strip()}%"
        gq = gq.where(or_(WildGame.white.ilike(like), WildGame.black.ilike(like), WildGame.event.ilike(like)))
    total = s.scalar(select(func.count()).select_from(gq.subquery()))
    games = s.scalars(
        gq.order_by(WildGame.played_on.desc().nulls_last(), WildGame.id.desc()).limit(limit).offset(offset)
    ).all()
    return {
        "total": total,
        "games": [_game_row(g) | {"matches": sorted(matches[g.id], key=lambda m: m["ply"])} for g in games],
    }


def _get_game(s: Session, game_id: int) -> WildGame:
    g = s.get(WildGame, game_id)
    if g is None:
        raise NotFound(f"Game {game_id} not found")
    return g


def get_game(s: Session, game_id: int) -> dict:
    g = _get_game(s, game_id)
    return _game_row(g) | {"moves": g.moves.split()}


def save_to_games(s: Session, game_id: int) -> dict:
    """Copy a tournament game into the Games tab."""
    g = _get_game(s, game_id)
    moves = g.moves.split()
    existing = s.scalar(
        select(Game.id).where(Game.white == g.white, Game.black == g.black, Game.played_on == g.played_on, Game.competition == g.event[:150])
    )
    if existing:
        return {"game_id": existing, "created": False}
    game = create_game(
        s,
        {
            "white": g.white,
            "black": g.black,
            "white_team": "",
            "black_team": "",
            "competition": g.event[:150],
            "played_on": g.played_on,
            "result": g.result,
            "moves": moves,
        },
    )
    return {"game_id": game["id"], "created": True}


# ---- storing fetched games -----------------------------------------------------------------


def store_games(s: Session, games: list[Parsed], source: str, source_ref: str) -> int:
    """Insert games not already stored (by game key). Returns how many were new."""
    new = 0
    for i in range(0, len(games), BATCH):
        rows = [
            {
                "game_key": g.key,
                "source": source,
                "source_ref": source_ref,
                "white": g.white,
                "black": g.black,
                "white_elo": g.white_elo,
                "black_elo": g.black_elo,
                "event": g.event,
                "site": g.site,
                "round": g.round,
                "played_on": g.played_on,
                "result": g.result,
                "plies": len(g.moves),
                "moves": " ".join(g.moves),
                "hashes": g.hashes,
            }
            for g in games[i : i + BATCH]
        ]
        if rows:
            stmt = insert(WildGame).values(rows).on_conflict_do_nothing(index_elements=["game_key"]).returning(WildGame.id)
            new += len(s.execute(stmt).all())
    s.flush()
    return new


def source_done(s: Session, key: str) -> bool:
    return bool(s.scalar(select(WildSource.finished).where(WildSource.key == key)))


def mark_source(s: Session, key: str, finished: bool, games: int) -> None:
    s.execute(
        insert(WildSource)
        .values(key=key, finished=finished, games=games, fetched_at=func.now())
        .on_conflict_do_update(index_elements=["key"], set_={"finished": finished, "games": games, "fetched_at": func.now()})
    )


def latest_twic(s: Session) -> int | None:
    keys = s.scalars(select(WildSource.key).where(WildSource.key.like("twic:%"))).all()
    return max((int(k.split(":")[1]) for k in keys), default=None)


def prune(s: Session, days: int, today: date | None = None) -> int:
    """Delete games older than `days` that no watched position matches."""
    cutoff = (today or date.today()) - timedelta(days=days)
    matched = exists().where(WildGame.hashes.contains(array([WildWatch.hash])))
    played = func.coalesce(WildGame.played_on, func.date(WildGame.imported_at))
    return s.execute(delete(WildGame).where(played < cutoff, ~matched)).rowcount


def stats(s: Session, repertoire_id: int | None = None, since: datetime | None = None) -> dict:
    games = s.scalar(select(func.count()).select_from(WildGame))
    newest = s.scalar(select(func.max(WildGame.played_on)))
    last_fetch = s.scalar(select(func.max(WildSource.fetched_at)))
    out = {"games": games, "newest_played_on": newest, "last_fetch_at": last_fetch, "twic_issue": latest_twic(s), "new_games": 0}
    if repertoire_id is not None and since is not None:
        hashes = s.scalars(select(WildWatch.hash).join(Opening).where(Opening.repertoire_id == repertoire_id)).all()
        if hashes:
            out["new_games"] = s.scalar(
                select(func.count()).where(WildGame.imported_at > since, WildGame.hashes.overlap(list(hashes)))
            )
    return out
