"""Repertoire in the wild: watched branch tags, the store of tournament games, and matching.

Games are stored once for everyone (they're shared across repertoires); a watch belongs
to a branch tag and shows under its name. Matching is an indexed lookup of the watch's position hash in each game's
array of position hashes, so a new watch immediately finds games already stored.
"""

from datetime import date, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.wild import WildGame as Parsed
from app.core.wild import key_hash
from app.db.models import Game, Opening, OpeningTag, Position, WildGame, WildSource, WildWatch
from app.repositories.games import create_game
from app.repositories.repertoire import Conflict, NotFound, get_opening, get_repertoire
from app.repositories.tags import _path_to, get_tag

BATCH = 500


# ---- watches -------------------------------------------------------------------------


def _strong_enough(min_elo: int | None):
    """Games where the stronger player is rated at least min_elo (None = every game)."""
    if not min_elo:
        return True
    return func.greatest(func.coalesce(WildGame.white_elo, 0), func.coalesce(WildGame.black_elo, 0)) >= min_elo


def _watch_counts(s: Session, watches: list[WildWatch], min_elo: int | None = None) -> dict[int, tuple[int, date | None]]:
    out = {}
    for w in watches:
        n, latest = s.execute(
            select(func.count(), func.max(WildGame.played_on)).where(WildGame.hashes.contains([w.hash]), _strong_enough(min_elo))
        ).one()
        out[w.id] = (n, latest)
    return out


def _watch_dict(s: Session, w: WildWatch, tag: OpeningTag, opening: Opening, key: str, counts) -> dict:
    n, latest = counts.get(w.id, (0, None))
    return {
        "id": w.id,
        "tag_id": tag.id,
        "name": tag.name,
        "opening_id": opening.id,
        "opening_name": opening.name,
        "color": opening.color,
        "key": key,
        "path": _path_to(s, opening.id, w.position_id),
        "games": n,
        "latest_played_on": latest,
    }


def _watch_rows(s: Session, *where):
    return s.execute(
        select(WildWatch, OpeningTag, Opening, Position.key)
        .join(OpeningTag, OpeningTag.id == WildWatch.tag_id)
        .join(Opening, Opening.id == WildWatch.opening_id)
        .join(Position, Position.id == WildWatch.position_id)
        .where(*where)
    ).all()


def _dicts(s: Session, rows, min_elo: int | None) -> list[dict]:
    counts = _watch_counts(s, [w for w, _, _, _ in rows], min_elo)
    return [_watch_dict(s, w, tag, o, key, counts) for w, tag, o, key in rows]


def list_watches(s: Session, repertoire_id: int, min_elo: int | None = None) -> list[dict]:
    get_repertoire(s, repertoire_id)
    out = _dicts(s, _watch_rows(s, Opening.repertoire_id == repertoire_id), min_elo)
    return sorted(out, key=lambda w: (w["color"] != "white", w["opening_name"].lower(), len(w["path"]), w["name"].lower()))


def opening_watches(s: Session, opening_id: int, min_elo: int | None = None) -> list[dict]:
    """Watches of one opening (for the board's Branches section)."""
    get_opening(s, opening_id)
    return _dicts(s, _watch_rows(s, WildWatch.opening_id == opening_id), min_elo)


def _get_watch(s: Session, watch_id: int) -> WildWatch:
    w = s.get(WildWatch, watch_id)
    if w is None:
        raise NotFound(f"Watched position {watch_id} not found")
    return w


def watch_tag(s: Session, tag_id: int) -> dict:
    """Watch a branch tag in tournament games."""
    tag = get_tag(s, tag_id)
    if s.scalar(select(WildWatch.id).where(WildWatch.tag_id == tag_id)):
        raise Conflict(f"You're already watching “{tag.name}”")
    key = s.scalar(select(Position.key).where(Position.id == tag.position_id))
    w = WildWatch(tag_id=tag.id, opening_id=tag.opening_id, position_id=tag.position_id, hash=key_hash(key))
    s.add(w)
    s.flush()
    return _dicts(s, _watch_rows(s, WildWatch.id == w.id), None)[0]


def unwatch_tag(s: Session, tag_id: int) -> None:
    get_tag(s, tag_id)
    w = s.scalar(select(WildWatch).where(WildWatch.tag_id == tag_id))
    if w is None:
        raise NotFound("This tag isn't being watched")
    s.delete(w)
    s.flush()


def delete_watch(s: Session, watch_id: int) -> None:
    s.delete(_get_watch(s, watch_id))
    s.flush()


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
        "viewed_at": g.viewed_at,
    }


def list_games(
    s: Session,
    repertoire_id: int,
    watch_id: int | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
    min_elo: int | None = None,
    unviewed: bool = False,
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
            select(WildGame.id, func.array_position(WildGame.hashes, h)).where(WildGame.hashes.contains([h]), _strong_enough(min_elo))
        ).all():
            matches.setdefault(g_id, []).append({"watch_id": w_id, "ply": ply})
    if not matches:
        return {"total": 0, "games": []}
    gq = select(WildGame).where(WildGame.id.in_(matches))
    if unviewed:
        gq = gq.where(WildGame.viewed_at.is_(None))
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


def game_pgn(s: Session, game_id: int) -> tuple[str, str]:
    """(PGN text, file name) for a tournament game."""
    from app.core.pgn import to_pgn

    g = _get_game(s, game_id)
    text = to_pgn(
        white=g.white, black=g.black, white_team="", black_team="", competition=g.event,
        played_on=g.played_on, result=g.result, start_fen=None, moves=g.moves.split(),
    )
    extra = "".join(
        f'[{tag} "{value}"]\n'
        for tag, value in (("WhiteElo", g.white_elo), ("BlackElo", g.black_elo))
        if value
    )
    if extra:  # ratings after the seven standard tags
        head, _, body = text.partition("\n\n")
        text = f"{head}\n{extra.rstrip()}\n\n{body}"
    if g.site:
        text = text.replace('[Site "?"]', f'[Site "{g.site}"]', 1)
    if g.round:
        text = text.replace('[Round "?"]', f'[Round "{g.round}"]', 1)
    name = "-".join(x for x in (g.white.split(",")[0], g.black.split(",")[0], str(g.played_on or "")) if x)
    return text, "".join(c if c.isalnum() or c in "-_" else "_" for c in name) + ".pgn"


def mark_viewed(s: Session, game_id: int) -> dict:
    """Record that the game was opened (the first time counts)."""
    g = _get_game(s, game_id)
    if g.viewed_at is None:
        g.viewed_at = func.now()
        s.flush()
        s.refresh(g)
    return {"id": g.id, "viewed_at": g.viewed_at}


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


def done_twic(s: Session) -> set[int]:
    """TWIC issues already fetched."""
    keys = s.scalars(select(WildSource.key).where(WildSource.key.like("twic:%"), WildSource.finished)).all()
    return {int(k.split(":")[1]) for k in keys}


def stats(s: Session, repertoire_id: int | None = None, since: datetime | None = None, min_elo: int | None = None) -> dict:
    games = s.scalar(select(func.count()).select_from(WildGame))
    oldest, newest = s.execute(select(func.min(WildGame.played_on), func.max(WildGame.played_on))).one()
    last_fetch = s.scalar(select(func.max(WildSource.fetched_at)))
    twic = done_twic(s)
    out = {
        "games": games,
        "oldest_played_on": oldest,
        "newest_played_on": newest,
        "last_fetch_at": last_fetch,
        "twic_first": min(twic, default=None),
        "twic_issue": max(twic, default=None),
        "new_games": 0,
    }
    if repertoire_id is not None and since is not None:
        hashes = s.scalars(select(WildWatch.hash).join(Opening).where(Opening.repertoire_id == repertoire_id)).all()
        if hashes:
            out["new_games"] = s.scalar(
                select(func.count()).where(WildGame.imported_at > since, WildGame.hashes.overlap(list(hashes)), _strong_enough(min_elo))
            )
    return out
