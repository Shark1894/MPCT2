"""Puzzles from your own games: which games to scan, storing the mistakes the browser's
engine found, and practising them with spaced repetition (the repertoire's schedule).

Your side in a game is the one whose player name is one of "your names" (an app setting;
by default the name that appears in most of your games, plus "You", which games against
the engine use). The browser analyses the games (the server is too small for Stockfish)
and sends back candidate mistakes; the server drops moves that are in your repertoire and
positions you were already losing, works out the SAN and the opponent's previous move
(to show the puzzle like a Lichess one), and keeps the review history when a game is
scanned again.
"""

import hashlib
from collections import Counter
from datetime import date, datetime, timezone

import chess
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.positions import position_key
from app.core.scheduling import next_review_on, next_streak
from app.db.models import AppSetting, Game, GameMove, GamePuzzle, GameScan, Line, Move, Opening, Position
from app.repositories.repertoire import NotFound

ALREADY_LOST = 15.0  # your winning chances (with best play) below this: no puzzle
MIN_LOSS = 20.0  # mistakes and blunders (Jason's choice)
BLUNDER = 30.0
ENGINE_NAMES = ("Stockfish",)  # games vs the engine: the other side is never you
LIST_LIMIT = 200


class InvalidScan(ValueError):
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


# ---- games to scan --------------------------------------------------------------------------


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


def scan_status(s: Session) -> dict:
    """Games still to scan (new or edited since), and games where your side isn't known."""
    names, set_by_you = my_names(s)
    games = s.scalars(select(Game).order_by(Game.played_on.desc().nulls_last(), Game.id.desc())).all()
    moves = _game_moves(s, [g.id for g in games])
    scans = {sc.game_id: sc for sc in s.scalars(select(GameScan)).all()}
    todo, unknown = [], []
    for g in games:
        if len(moves[g.id]) < 4:
            continue
        color = my_color(g, names)
        if color is None:
            unknown.append({"id": g.id, "white": g.white, "black": g.black})
            continue
        h = moves_hash(g.start_fen, moves[g.id])
        if g.id in scans and scans[g.id].moves_hash == h:
            continue
        todo.append(
            {
                "id": g.id,
                "white": g.white,
                "black": g.black,
                "played_on": g.played_on,
                "competition": g.competition,
                "color": color,
                "start_fen": g.start_fen or chess.STARTING_FEN,
                "moves": moves[g.id],
                "moves_hash": h,
            }
        )
    return {
        "names": names,
        "names_set": set_by_you,
        "to_scan": todo,
        "unknown": unknown,
        "scanned": len(scans),
    }


# ---- storing a scan -------------------------------------------------------------------------------


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
        raise InvalidScan(f"'{uci}' is not a move") from exc
    if move not in board.legal_moves:
        raise InvalidScan(f"{uci} is illegal here")
    return board.san(move)


def save_scan(s: Session, game_id: int, sent_hash: str, movetime_ms: int, candidates: list[dict]) -> dict:
    """Store the mistakes found in a game. candidates: [{ply, best_uci, best_pv, before, after}]
    for your moves; everything else is worked out here from the game itself."""
    game = s.get(Game, game_id)
    if game is None:
        raise NotFound(f"Game {game_id} not found")
    names, _ = my_names(s)
    color = my_color(game, names)
    if color is None:
        raise InvalidScan("Your side in this game isn't known: check your names")
    ucis = _game_moves(s, [game_id])[game_id]
    if moves_hash(game.start_fen, ucis) != sent_hash:
        raise InvalidScan("The game has changed since it was analysed: scan it again")

    # Replay the game: the position before each move, and the move that led to it.
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
            raise InvalidScan(f"Move {ply} is not in this game")
        mover = "white" if fens[ply - 1].split()[1] == "w" else "black"
        if mover != color:
            raise InvalidScan(f"Move {ply} isn't yours")
        before, after = float(c["before"]), float(c["after"])
        if before < ALREADY_LOST:
            skipped["lost"] += 1
            continue
        if before - after < MIN_LOSS:
            skipped["small"] += 1
            continue
        b = chess.Board(fens[ply - 1])
        played = ucis[ply - 1]
        if _in_repertoire(s, position_key(b), played, color):
            skipped["repertoire"] += 1
            continue
        best_san = _san(b, c["best_uci"])
        if c["best_uci"] == played:
            continue
        keep[ply] = {
            "color": color,
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
    for ply, p in existing.items():
        if ply not in keep or keep[ply]["fen"] != p.fen or keep[ply]["played_uci"] != p.played_uci:
            s.delete(p)  # the game was edited: that puzzle no longer applies
    s.flush()
    new = 0
    for ply, data in keep.items():
        p = existing.get(ply)
        if p is not None and p.fen == data["fen"] and p.played_uci == data["played_uci"]:
            for k, v in data.items():
                setattr(p, k, v)  # fresher analysis, review history kept
        else:
            s.add(GamePuzzle(game_id=game_id, ply=ply, **data))
            new += 1
    scan = s.get(GameScan, game_id)
    if scan is None:
        s.add(GameScan(game_id=game_id, moves_hash=sent_hash, color=color, movetime_ms=movetime_ms, found=len(keep)))
    else:
        scan.moves_hash, scan.color, scan.movetime_ms, scan.found = sent_hash, color, movetime_ms, len(keep)
        scan.scanned_at = func.now()
    s.flush()
    return {"game_id": game_id, "found": len(keep), "new": new, "skipped": skipped}


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


def list_puzzles(s: Session, due: bool = False, game_id: int | None = None) -> list[dict]:
    q = select(GamePuzzle, Game).join(Game, Game.id == GamePuzzle.game_id)
    if due:
        q = q.where(GamePuzzle.next_review_on <= date.today()).order_by(GamePuzzle.next_review_on, GamePuzzle.id)
    else:
        q = q.order_by(Game.played_on.desc().nulls_last(), Game.id.desc(), GamePuzzle.ply)
    if game_id is not None:
        q = q.where(GamePuzzle.game_id == game_id)
    return [_puzzle_dict(p, g) for p, g in s.execute(q.limit(LIST_LIMIT)).all()]


def summary(s: Session) -> dict:
    total, due, blunders = s.execute(
        select(
            func.count(),
            func.count().filter(GamePuzzle.next_review_on <= date.today()),
            func.count().filter(GamePuzzle.label == "blunder"),
        )
    ).one()
    st = scan_status(s)
    return {
        "puzzles": total,
        "due": due,
        "blunders": blunders,
        "names": st["names"],
        "names_set": st["names_set"],
        "to_scan": len(st["to_scan"]),
        "unknown": len(st["unknown"]),
        "scanned": st["scanned"],
    }


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
    """Not a real mistake: remove it (a later scan of an unchanged game won't bring it back)."""
    p = s.get(GamePuzzle, puzzle_id)
    if p is None:
        raise NotFound(f"Puzzle {puzzle_id} not found")
    s.delete(p)
    s.flush()


def reset_scans(s: Session) -> int:
    """Scan every game again next time (puzzles and their history are kept where unchanged)."""
    return s.execute(delete(GameScan)).rowcount
