"""Games: CRUD, search, PGN import/export, and checking a game against a repertoire."""

from datetime import date

import chess
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.core.pgn import ParsedGame, parse_pgn, to_pgn
from app.core.positions import InvalidPosition, position_key, walk_line
from app.core.scheduling import user_plays_ply
from app.db.models import Game, GameMove, Line, Move, Position
from app.repositories.game_puzzles import current_reviews
from app.repositories.repertoire import NotFound, get_opening

META_FIELDS = ("white", "black", "white_team", "black_team", "competition", "played_on", "result")
CATEGORIES = ("otb", "online", "practice", "other")  # the Games tab's groups


def _get(s: Session, game_id: int) -> Game:
    game = s.get(Game, game_id)
    if game is None:
        raise NotFound(f"Game {game_id} not found")
    return game


def _summary(game: Game, n_moves: int, opening: list[str], review: dict | None = None) -> dict:
    return {
        "id": game.id,
        **{f: getattr(game, f) for f in META_FIELDS},
        "start_fen": game.start_fen,
        "plies": n_moves,
        "opening": opening,
        "review": review,  # the current engine review (None = not reviewed, or moves changed since)
        "lichess_id": game.lichess_id,  # imported from lichess.org
        "category": game.category,
    }


RESULTS = {"1-0", "0-1", "1/2-1/2", "*"}
RESULT_FILTERS = {"white", "black", "draw", "unfinished", "won", "lost", "drawn"}
COLOR_FILTERS = {"white", "black"}
REVIEW_FILTERS = {"yes", "no"}


class BadFilter(ValueError):
    pass


def _check_category(category: str | None) -> None:
    if category and category not in CATEGORIES:
        raise BadFilter(f"Unknown group: {category}")


def category_counts(s: Session) -> dict[str, int]:
    counts = dict(s.execute(select(Game.category, func.count()).group_by(Game.category)).all())
    return {c: counts.get(c, 0) for c in CATEGORIES}


def list_players(s: Session, category: str | None = None) -> list[dict]:
    """Every player name in the games (white or black; in one group if given), most games first.
    Names compare case-insensitively."""
    _check_category(category)
    spellings: dict[str, dict[str, int]] = {}  # lower-case name -> spelling -> games
    for col in (Game.white, Game.black):
        query = select(func.trim(col), func.count()).group_by(func.trim(col))
        if category:
            query = query.where(Game.category == category)
        for name, n in s.execute(query).all():
            if name:
                by = spellings.setdefault(name.lower(), {})
                by[name] = by.get(name, 0) + n
    counts = {
        key: {"name": max(by, key=lambda sp: (by[sp], sp)), "games": sum(by.values())}  # most used spelling
        for key, by in spellings.items()
    }
    return sorted(counts.values(), key=lambda p: (-p["games"], p["name"].lower()))


def _filter_query(query, player: str | None, color: str | None, result: str | None):
    """Player (exact name, any case), the colour they played, and the result (absolute, or theirs)."""
    player = (player or "").strip().lower() or None
    if color and color not in COLOR_FILTERS:
        raise BadFilter(f"Unknown colour filter: {color}")
    if result and result not in RESULT_FILTERS:
        raise BadFilter(f"Unknown result filter: {result}")
    if (color or result in {"won", "lost", "drawn"}) and not player:
        raise BadFilter("Choose a player to filter by their colour or their result")
    is_white = func.lower(func.trim(Game.white)) == player
    is_black = func.lower(func.trim(Game.black)) == player
    if player:
        query = query.where(is_white if color == "white" else is_black if color == "black" else or_(is_white, is_black))
    absolute = {"white": "1-0", "black": "0-1", "draw": "1/2-1/2", "drawn": "1/2-1/2", "unfinished": "*"}
    if result in absolute:
        query = query.where(Game.result == absolute[result])
    elif result in {"won", "lost"}:
        white_wins = Game.result == "1-0"
        black_wins = Game.result == "0-1"
        if result == "won":
            query = query.where(or_(is_white & white_wins, is_black & black_wins))
        else:
            query = query.where(or_(is_white & black_wins, is_black & white_wins))
    return query


def list_games(
    s: Session,
    q: str | None = None,
    player: str | None = None,
    color: str | None = None,
    result: str | None = None,
    reviewed: str | None = None,
    category: str | None = None,
) -> list[dict]:
    """All games, newest first; q searches players, teams and competition. The other filters:
    player (exact name), color (that player's colour), result (white/black/draw/unfinished, or
    won/lost/drawn for the player), reviewed (yes/no: has a current engine review) and
    category (one of the Games tab's groups)."""
    if reviewed and reviewed not in REVIEW_FILTERS:
        raise BadFilter(f"Unknown review filter: {reviewed}")
    _check_category(category)
    query = _filter_query(select(Game), player, color, result)
    if category:
        query = query.where(Game.category == category)
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.where(
            or_(
                Game.white.ilike(like),
                Game.black.ilike(like),
                Game.white_team.ilike(like),
                Game.black_team.ilike(like),
                Game.competition.ilike(like),
            )
        )
    games = s.scalars(query.order_by(Game.played_on.desc().nulls_last(), Game.id.desc())).all()
    ids = [g.id for g in games]
    counts = dict(
        s.execute(select(GameMove.game_id, func.count()).where(GameMove.game_id.in_(ids)).group_by(GameMove.game_id)).all()
    ) if ids else {}
    first: dict[int, list[str]] = {}
    if ids:
        for game_id, san in s.execute(
            select(GameMove.game_id, GameMove.san)
            .where(GameMove.game_id.in_(ids), GameMove.ply <= 6)
            .order_by(GameMove.game_id, GameMove.ply)
        ):
            first.setdefault(game_id, []).append(san)
    reviews = current_reviews(s, list(games))
    if reviewed:
        games = [g for g in games if (g.id in reviews) == (reviewed == "yes")]
    return [_summary(g, counts.get(g.id, 0), first.get(g.id, []), reviews.get(g.id)) for g in games]


def get_game(s: Session, game_id: int) -> dict:
    game = _get(s, game_id)
    moves = [{"ply": m.ply, "uci": m.uci, "san": m.san} for m in game.moves]
    review = current_reviews(s, [game], {game.id: [m["uci"] for m in moves]}).get(game.id)
    return {**_summary(game, len(moves), [m["san"] for m in moves[:6]], review), "moves": moves}


def _store_moves(s: Session, game: Game, ucis: list[str]) -> None:
    walked = walk_line(ucis, start_fen=game.start_fen, allow_empty=True)  # validates
    s.execute(delete(GameMove).where(GameMove.game_id == game.id))
    s.add_all(GameMove(game_id=game.id, ply=m.ply, uci=m.uci, san=m.san) for m in walked)


def create_game(s: Session, data: dict) -> dict:
    """data: metadata fields, optional start_fen, and moves (UCI list)."""
    category = data.get("category") or "otb"
    if category not in CATEGORIES:
        raise InvalidPosition(f"Unknown group: {category}")
    game = Game(**{f: data[f] for f in META_FIELDS if f in data}, start_fen=data.get("start_fen") or None, category=category)
    s.add(game)
    s.flush()
    _store_moves(s, game, data.get("moves", []))
    s.flush()
    return get_game(s, game.id)


def update_game(s: Session, game_id: int, data: dict) -> dict:
    """Replace metadata given in data and, if 'moves' is present, the moves."""
    game = _get(s, game_id)
    for f in META_FIELDS:
        if f in data:
            setattr(game, f, data[f])
    if data.get("category"):
        if data["category"] not in CATEGORIES:
            raise InvalidPosition(f"Unknown group: {data['category']}")
        game.category = data["category"]
    if "start_fen" in data:
        start = (data["start_fen"] or "").strip() or None
        if start and start.split()[:4] == chess.STARTING_FEN.split()[:4]:
            start = None  # the normal starting position
        if start != game.start_fen and "moves" not in data:
            raise InvalidPosition("Changing the starting position needs the moves as well")
        game.start_fen = start
    if "moves" in data:
        _store_moves(s, game, data["moves"])
    game.updated_at = func.now()
    s.flush()
    s.expire(game)
    return get_game(s, game_id)


def delete_game(s: Session, game_id: int) -> None:
    s.delete(_get(s, game_id))
    s.flush()


def _pgn(game: Game) -> str:
    return to_pgn(
        **{f: getattr(game, f) for f in META_FIELDS},
        start_fen=game.start_fen,
        moves=[m.uci for m in game.moves],
    )


def export_pgn(s: Session, game_id: int) -> str:
    return _pgn(_get(s, game_id))


def export_all_pgn(s: Session, q: str | None = None, **filters) -> str:
    """Every game (or those matching q and the filters, as list_games), oldest first, as one PGN file."""
    ids = [g["id"] for g in reversed(list_games(s, q, **filters))]
    return "\n".join(_pgn(_get(s, game_id)) for game_id in ids)


def _is_duplicate(s: Session, p: ParsedGame) -> bool:
    """Same players, date and moves as a stored game."""
    candidates = s.scalars(
        select(Game.id).where(Game.white == p.white, Game.black == p.black, Game.played_on.is_not_distinct_from(p.played_on))
    ).all()
    for game_id in candidates:
        if s.scalars(select(GameMove.uci).where(GameMove.game_id == game_id).order_by(GameMove.ply)).all() == p.moves:
            return True
    return False


def import_pgn(s: Session, text: str, category: str = "otb") -> dict:
    parsed, errors = parse_pgn(text)
    imported, duplicates = [], 0
    for p in parsed:
        if _is_duplicate(s, p):
            duplicates += 1
            continue
        try:
            game = create_game(
                s,
                {f: getattr(p, f) for f in META_FIELDS} | {"start_fen": p.start_fen, "moves": p.moves, "category": category},
            )
        except ValueError as exc:
            errors.append(f"{p.white or '?'} v {p.black or '?'}: {exc}")
            continue
        imported.append(game["id"])
    return {"imported": len(imported), "duplicates": duplicates, "game_ids": imported, "errors": errors}


# ---- repertoire check -----------------------------------------------------------


def check_against_repertoire(s: Session, opening_id: int, ucis: list[str]) -> dict:
    """Where does a game (from the initial position) leave the opening's repertoire?

    status:
      'deviation'   a move was played that the repertoire doesn't have (by you or your opponent)
      'end_of_book' the repertoire has nothing further from a position the game reached
      'in_book'     every move of the game is in the repertoire
    ply is the move that left the repertoire (1-based); the position before it is where to look.
    """
    opening = get_opening(s, opening_id)
    walked = walk_line(ucis, allow_empty=True)
    board = chess.Board()
    for m in walked:
        rows = s.execute(
            select(Move.uci, Move.san)
            .join(Line)
            .join(Position, Position.id == Move.position_before_id)
            .where(Line.opening_id == opening_id, Position.key == position_key(board))
            .distinct()
        ).all()
        mover = "you" if user_plays_ply(m.ply, opening.color) else "opponent"
        if not rows:
            return {"status": "end_of_book", "ply": m.ply, "played": m.san, "by": mover, "repertoire": []}
        if m.uci not in {uci for uci, _ in rows}:
            return {
                "status": "deviation",
                "ply": m.ply,
                "played": m.san,
                "by": mover,
                "repertoire": sorted(san for _, san in rows),
            }
        board.push(chess.Move.from_uci(m.uci))
    return {"status": "in_book", "ply": len(walked), "played": None, "by": None, "repertoire": []}
