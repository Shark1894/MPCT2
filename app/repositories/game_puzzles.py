"""Engine reviews of your games, and puzzles from your mistakes in them.

A game counts as reviewed once the browser has analysed every position in it (the server
is too small for Stockfish) and sent the result here: each side's accuracy, the counts of
inaccuracies, mistakes and blunders, and the candidate mistakes (moves that lost a lot,
where one move was clearly best). A review stays current while the game's moves are
unchanged.

Puzzles come only from reviewed games: the candidates are kept for both sides, minus moves
in your repertoire and positions already lost, and the ones shown are those on your side.
Your side in a game is the one whose player name is one of "your names" (an app setting;
by default the name in most of your games, plus "You", which games against the engine
use), so changing your names needs no new review. Puzzles are practised with spaced
repetition (the repertoire's schedule); history is kept when a game is reviewed again.
"""

import hashlib
from collections import Counter
from datetime import date, datetime, timezone

import chess
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.positions import position_key
from app.core.scheduling import next_review_on, next_streak
from app.db.models import AppSetting, Game, GameMove, GamePuzzle, GameReview, Line, Move, Opening, Position
from app.repositories.repertoire import NotFound

ALREADY_LOST = 15.0  # the mover's winning chances (with best play) below this: no puzzle
MIN_LOSS = 20.0  # mistakes and blunders (Jason's choice)
BLUNDER = 30.0
MIN_PLIES = 4  # shorter games aren't worth reviewing for puzzles
ENGINE_NAMES = ("Stockfish",)  # games vs the engine: the other side is never you
LIST_LIMIT = 200


class InvalidGameReview(ValueError):
    pass


# ---- your names -----------------------------------------------------------------------


def _auto_names(s: Session) -> list[str]:
    counts: Counter[str] = Counter()
    for white, black in s.execute(select(Game.white, Game.black)).all():
        for name in (white, black):
            name = (name or "").strip()
            if name and name.lower() != "you" and not name.startswith(ENGINE_NAMES):
                counts[name] += 1
    top = [name for name, n in counts.most_common(1) if n >= 2]
    return top + ["You"]


def my_names(s: Session) -> tuple[list[str], bool]:
    """(names, set_by_you)."""
    row = s.get(AppSetting, "my_names")
    if row and isinstance(row.value, list) and row.value:
        return [str(n) for n in row.value], True
    return _auto_names(s), False


def set_my_names(s: Session, names: list[str]) -> list[str]:
    clean = []
    for n in names:
        n = n.strip()[:100]
        if n and n.lower() not in {c.lower() for c in clean}:
            clean.append(n)
    row = s.get(AppSetting, "my_names")
    if row is None:
        s.add(AppSetting(key="my_names", value=clean or None))
    else:
        row.value = clean or None
    s.flush()
    return my_names(s)[0]


def my_color(game: Game, names: list[str]) -> str | None:
    """'white' / 'black' if exactly one side is you, else None."""
    lower = {n.lower() for n in names}
    w = (game.white or "").strip().lower() in lower
    b = (game.black or "").strip().lower() in lower
    if w and not b:
        return "white"
    if b and not w:
        return "black"
    return None


# ---- reviews ----------------------------------------------------------------------------------


def moves_hash(start_fen: str | None, ucis: list[str]) -> str:
    return hashlib.sha1(f"{start_fen or ''}|{' '.join(ucis)}".encode()).hexdigest()


def _game_moves(s: Session, game_ids: list[int]) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {g: [] for g in game_ids}
    if game_ids:
        for gid, uci in s.execute(
            select(GameMove.game_id, GameMove.uci).where(GameMove.game_id.in_(game_ids)).order_by(GameMove.game_id, GameMove.ply)
        ).all():
            out[gid].append(uci)
    return out


def _review_dict(r: GameReview) -> dict:
    return {
        "white_accuracy": r.white_accuracy,
        "black_accuracy": r.black_accuracy,
        "counts": r.counts,
        "movetime_ms": r.movetime_ms,
        "reviewed_at": r.reviewed_at,
    }


def current_reviews(s: Session, games: list[Game], moves: dict[int, list[str]] | None = None) -> dict[int, dict]:
    """game id -> its review, for games whose review still matches their moves."""
    ids = [g.id for g in games]
    if not ids:
        return {}
    reviews = {r.game_id: r for r in s.scalars(select(GameReview).where(GameReview.game_id.in_(ids))).all()}
    if not reviews:
        return {}
    moves = moves if moves is not None else _game_moves(s, list(reviews))
    return {
        g.id: _review_dict(reviews[g.id])
        for g in games
        if g.id in reviews and reviews[g.id].moves_hash == moves_hash(g.start_fen, moves.get(g.id, []))
    }


def review_queue(s: Session) -> list[dict]:
    """Games (with at least MIN_PLIES moves) that have no current review, newest first."""
    games = s.scalars(select(Game).order_by(Game.played_on.desc().nulls_last(), Game.id.desc())).all()
    moves = _game_moves(s, [g.id for g in games])
    done = current_reviews(s, games, moves)
    return [
        {
            "id": g.id,
            "white": g.white,
            "black": g.black,
            "played_on": g.played_on,
            "start_fen": g.start_fen or chess.STARTING_FEN,
            "moves": moves[g.id],
        }
        for g in games
        if g.id not in done and len(moves[g.id]) >= MIN_PLIES
    ]


def _in_repertoire(s: Session, key: str, uci: str, color: str) -> bool:
    return bool(
        s.scalar(
            select(Move.id)
            .join(Position, Position.id == Move.position_before_id)
            .join(Line, Line.id == Move.line_id)
            .join(Opening, Opening.id == Line.opening_id)
            .where(Position.key == key, Move.uci == uci, Opening.color == color)
            .limit(1)
        )
    )


def _san(board: chess.Board, uci: str) -> str:
    try:
        move = chess.Move.from_uci(uci)
    except ValueError as exc:
        raise InvalidGameReview(f"'{uci}' is not a move") from exc
    if move not in board.legal_moves:
        raise InvalidGameReview(f"{uci} is illegal here")
    return board.san(move)


def save_review(
    s: Session,
    game_id: int,
    ucis_sent: list[str],
    movetime_ms: int,
    accuracy: dict,
    counts: dict,
    candidates: list[dict],
) -> dict:
    """Store a finished review of a game. candidates: [{ply, best_uci, best_pv, before, after}]
    for either side (before/after = the mover's winning chances); the rest is worked out here."""
    game = s.get(Game, game_id)
    if game is None:
        raise NotFound(f"Game {game_id} not found")
    ucis = _game_moves(s, [game_id])[game_id]
    if ucis_sent != ucis:
        raise InvalidGameReview("These aren't the game's saved moves: save the game, then review it")

    board = chess.Board(game.start_fen or chess.STARTING_FEN)
    fens = []
    for uci in ucis:
        fens.append(board.fen())
        board.push(chess.Move.from_uci(uci))

    keep: dict[int, dict] = {}
    skipped = {"repertoire": 0, "lost": 0, "small": 0}
    for c in candidates:
        ply = int(c["ply"])
        if not (2 <= ply <= len(ucis)):
            raise InvalidGameReview(f"Move {ply} is not in this game")
        mover = "white" if fens[ply - 1].split()[1] == "w" else "black"
        before, after = float(c["before"]), float(c["after"])
        if before < ALREADY_LOST:
            skipped["lost"] += 1
            continue
        if before - after < MIN_LOSS:
            skipped["small"] += 1
            continue
        b = chess.Board(fens[ply - 1])
        played = ucis[ply - 1]
        best_san = _san(b, c["best_uci"])
        if c["best_uci"] == played:
            continue
        if _in_repertoire(s, position_key(b), played, mover):
            skipped["repertoire"] += 1
            continue
        keep[ply] = {
            "color": mover,
            "fen": fens[ply - 1],
            "setup_fen": fens[ply - 2],
            "setup_uci": ucis[ply - 2],
            "played_uci": played,
            "played_san": b.san(chess.Move.from_uci(played)),
            "best_uci": c["best_uci"],
            "best_san": best_san,
            "best_pv": " ".join(c.get("best_pv") or [])[:400],
            "before": round(before, 1),
            "after": round(after, 1),
            "label": "blunder" if before - after >= BLUNDER else "mistake",
        }

    existing = {p.ply: p for p in s.scalars(select(GamePuzzle).where(GamePuzzle.game_id == game_id)).all()}
    same = lambda p, d: p.fen == d["fen"] and p.played_uci == d["played_uci"]  # noqa: E731
    for ply, p in existing.items():
        if ply not in keep or not same(p, keep[ply]):
            s.delete(p)  # the game was edited, or the new analysis disagrees
    s.flush()
    names, _ = my_names(s)
    mine = my_color(game, names)
    found = new = 0
    for ply, data in keep.items():
        p = existing.get(ply)
        if p is not None and same(p, data):
            for k, v in data.items():
                setattr(p, k, v)  # fresher analysis; review history (and a removal) kept
            fresh = False
        else:
            s.add(GamePuzzle(game_id=game_id, ply=ply, **data))
            fresh = True
        if data["color"] == mine and not (p is not None and same(p, data) and p.dismissed):
            found += 1
            new += fresh

    review = s.get(GameReview, game_id)
    fields = {
        "moves_hash": moves_hash(game.start_fen, ucis),
        "movetime_ms": movetime_ms,
        "white_accuracy": accuracy.get("w"),
        "black_accuracy": accuracy.get("b"),
        "counts": counts,
    }
    if review is None:
        s.add(GameReview(game_id=game_id, **fields))
    else:
        for k, v in fields.items():
            setattr(review, k, v)
        review.reviewed_at = func.now()
    s.flush()
    return {"game_id": game_id, "puzzles": found, "new": new, "skipped": skipped}


def status(s: Session) -> dict:
    """Your names, and how many games are reviewed / still to review / of unknown side."""
    names, set_by_you = my_names(s)
    games = s.scalars(select(Game)).all()
    moves = _game_moves(s, [g.id for g in games])
    done = current_reviews(s, games, moves)
    reviewable = [g for g in games if len(moves[g.id]) >= MIN_PLIES]
    return {
        "names": names,
        "names_set": set_by_you,
        "games": len(reviewable),
        "reviewed": sum(1 for g in reviewable if g.id in done),
        "unreviewed": sum(1 for g in reviewable if g.id not in done),
        "unknown": sum(1 for g in reviewable if g.id in done and my_color(g, names) is None),
    }


# ---- practising ------------------------------------------------------------------------------------


def _puzzle_dict(p: GamePuzzle, g: Game) -> dict:
    opponent = g.black if p.color == "white" else g.white
    return {
        "id": p.id,
        "game_id": g.id,
        "ply": p.ply,
        "move_number": (p.ply + 1) // 2,
        "color": p.color,
        "fen": p.fen,
        "setup_fen": p.setup_fen,
        "setup_uci": p.setup_uci,
        "played_uci": p.played_uci,
        "played_san": p.played_san,
        "best_uci": p.best_uci,
        "best_san": p.best_san,
        "best_pv": p.best_pv.split() if p.best_pv else [],
        "before": p.before,
        "after": p.after,
        "label": p.label,
        "opponent": opponent,
        "played_on": g.played_on,
        "competition": g.competition,
        "result": g.result,
        "streak": p.streak,
        "next_review_on": p.next_review_on,
        "reviews": p.reviews,
        "correct": p.correct,
    }


def _visible(s: Session, game_id: int | None = None) -> list[tuple[GamePuzzle, Game]]:
    """Puzzles on your side, from games whose review is current, not removed."""
    q = select(GamePuzzle, Game).join(Game, Game.id == GamePuzzle.game_id).where(GamePuzzle.dismissed.is_(False))
    if game_id is not None:
        q = q.where(GamePuzzle.game_id == game_id)
    rows = s.execute(q).all()
    games = list({g.id: g for _, g in rows}.values())
    current = current_reviews(s, games)
    names, _ = my_names(s)
    return [(p, g) for p, g in rows if g.id in current and p.color == my_color(g, names)]


def list_puzzles(s: Session, due: bool = False, game_id: int | None = None) -> list[dict]:
    rows = _visible(s, game_id)
    if due:
        today = date.today()
        rows = sorted((r for r in rows if r[0].next_review_on <= today), key=lambda r: (r[0].next_review_on, r[0].id))
    else:
        rows.sort(key=lambda r: (-(r[1].played_on or date.min).toordinal(), -r[1].id, r[0].ply))
    return [_puzzle_dict(p, g) for p, g in rows[:LIST_LIMIT]]


def record_review(s: Session, puzzle_id: int, correct: bool) -> dict:
    p = s.get(GamePuzzle, puzzle_id)
    if p is None:
        raise NotFound(f"Puzzle {puzzle_id} not found")
    p.streak = next_streak(p.streak, correct)
    p.next_review_on = next_review_on(p.streak)
    p.reviews += 1
    p.correct += int(correct)
    p.last_reviewed_at = datetime.now(timezone.utc)
    s.flush()
    return {"id": p.id, "correct": correct, "streak": p.streak, "next_review_on": p.next_review_on}


def delete_puzzle(s: Session, puzzle_id: int) -> None:
    """Not a useful puzzle: hide it for good (a later review of the same game won't bring it back)."""
    p = s.get(GamePuzzle, puzzle_id)
    if p is None or p.dismissed:
        raise NotFound(f"Puzzle {puzzle_id} not found")
    p.dismissed = True
    s.flush()
