"""Puzzles: picking the next one near your rating, recording attempts, your rating and stats.

The next puzzle is a random one within RATING_WINDOW of your rating that you haven't tried
yet (widening if nothing is left), skipping puzzles players disliked. Random choice uses
the precomputed `rnd` key: start at a random point in its index and take the first match,
so it's quick even across 6 million puzzles.

Only the first go at a puzzle is rated, as on Lichess; retries are recorded but unrated.
"""

import random

import chess
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.core.glicko import Rating, update
from app.core.puzzles import THEMES
from app.db.models import Puzzle, PuzzleAttempt, PuzzleImport, PuzzleRating
from app.repositories.repertoire import NotFound

RATING_WINDOW = 200
WIDER = (200, 400, 800, 5000)
MIN_POPULARITY = 0  # Lichess popularity is -100..100 from player votes
MIN_PLAYS = 20
HISTORY_DAYS = 365
RECENT = 20
PROVISIONAL_RD = 110  # above this the rating is still settling


class PuzzlesUnavailable(RuntimeError):
    pass


class InvalidPuzzle(ValueError):
    pass


def get_rating(s: Session) -> Rating:
    row = s.get(PuzzleRating, 1)
    return Rating(row.rating, row.rd, row.volatility) if row else Rating()


def _set_rating(s: Session, r: Rating) -> None:
    row = s.get(PuzzleRating, 1)
    if row is None:
        s.add(PuzzleRating(id=1, rating=r.rating, rd=r.rd, volatility=r.volatility))
    else:
        row.rating, row.rd, row.volatility = r.rating, r.rd, r.volatility


def _puzzle_dict(s: Session, p: Puzzle) -> dict:
    tries = s.scalar(select(func.count()).where(PuzzleAttempt.puzzle_id == p.id))
    return {
        "id": p.id,
        "fen": p.fen,
        "moves": p.moves.split(),
        "rating": p.rating,
        "rating_deviation": p.rating_deviation,
        "popularity": p.popularity,
        "nb_plays": p.nb_plays,
        "themes": p.themes,
        "theme_names": [THEMES.get(t, t) for t in p.themes if t in THEMES],
        "opening_tags": [t.replace("_", " ") for t in p.opening_tags],
        "game_url": p.game_url,
        "tried": tries,
    }


_PICK = """
SELECT id FROM puzzles p
WHERE p.rnd {cmp} :r
  AND p.rating BETWEEN :lo AND :hi
  AND p.popularity >= :pop AND p.nb_plays >= :plays
  {theme}
  AND NOT EXISTS (SELECT 1 FROM puzzle_attempts a WHERE a.puzzle_id = p.id)
  AND NOT (p.id = ANY(:exclude))
ORDER BY p.rnd {order}
LIMIT 1
"""


def next_puzzle(s: Session, theme: str | None = None, exclude: list[str] | None = None, rng=random) -> dict:
    if not s.scalar(select(PuzzleImport.id).limit(1)):
        raise PuzzlesUnavailable("No puzzles yet: download the Lichess puzzle database first")
    if theme is not None and theme not in THEMES:
        raise InvalidPuzzle(f"Unknown theme '{theme}'")
    me = round(get_rating(s).rating)
    theme_sql = "AND p.themes @> ARRAY[CAST(:theme AS text)]" if theme else ""
    params = {"pop": MIN_POPULARITY, "plays": MIN_PLAYS, "exclude": exclude or [], "theme": theme}
    for window in WIDER:
        r = rng.randrange(2**31)
        for cmp, order in ((">=", "ASC"), ("<", "DESC")):  # wrap around the random start
            pid = s.scalar(
                text(_PICK.format(cmp=cmp, order=order, theme=theme_sql)),
                params | {"r": r, "lo": me - window, "hi": me + window},
            )
            if pid:
                return _puzzle_dict(s, s.get(Puzzle, pid)) | {"window": window}
    raise NotFound("No untried puzzles left" + (f" with the theme {THEMES[theme]}" if theme else ""))


def get_puzzle(s: Session, puzzle_id: str) -> dict:
    p = s.get(Puzzle, puzzle_id)
    if p is None:
        raise NotFound(f"Puzzle {puzzle_id} not found")
    return _puzzle_dict(s, p)


def record_attempt(s: Session, puzzle_id: str, solved: bool, seconds: int | None = None) -> dict:
    p = s.get(Puzzle, puzzle_id)
    if p is None:
        raise NotFound(f"Puzzle {puzzle_id} not found")
    rated = not s.scalar(select(PuzzleAttempt.id).where(PuzzleAttempt.puzzle_id == puzzle_id).limit(1))
    before = get_rating(s)
    after = update(before, p.rating, p.rating_deviation, 1.0 if solved else 0.0) if rated else before
    if rated:
        _set_rating(s, after)
    s.add(
        PuzzleAttempt(
            puzzle_id=puzzle_id, solved=solved, rated=rated, puzzle_rating=p.rating,
            rating_before=before.rating, rating_after=after.rating, rd_after=after.rd,
            seconds=seconds, themes=p.themes,
        )
    )
    s.flush()
    return {
        "puzzle_id": puzzle_id,
        "solved": solved,
        "rated": rated,
        "rating_before": round(before.rating),
        "rating_after": round(after.rating),
        "change": round(after.rating) - round(before.rating),
        "rd": round(after.rd),
        "provisional": after.rd > PROVISIONAL_RD,
    }


def _solver_fen(p: Puzzle | None) -> str | None:
    """The position you solve from (after the opponent's set-up move), for thumbnails; None if
    the puzzle is no longer in the database."""
    if p is None:
        return None
    try:
        board = chess.Board(p.fen)
        board.push_uci(p.moves.split()[0] if isinstance(p.moves, str) else p.moves[0])
        return board.fen()
    except (ValueError, IndexError):
        return None


def summary(s: Session, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    r = get_rating(s)
    totals = s.execute(
        select(
            func.count(),
            func.count().filter(PuzzleAttempt.solved),
            func.count().filter(PuzzleAttempt.rated),
            func.count().filter(PuzzleAttempt.rated, PuzzleAttempt.solved),
        )
    ).one()
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today = s.execute(
        select(func.count(), func.count().filter(PuzzleAttempt.solved)).where(
            PuzzleAttempt.attempted_at >= day_start, PuzzleAttempt.rated
        )
    ).one()
    # Rating history: the last rating of each day (rated attempts), for the last year
    day = func.date(func.timezone("UTC", PuzzleAttempt.attempted_at))
    last_per_day = (
        select(day.label("day"), func.max(PuzzleAttempt.id).label("id"))
        .where(PuzzleAttempt.rated, PuzzleAttempt.attempted_at >= now - timedelta(days=HISTORY_DAYS))
        .group_by(day)
        .subquery()
    )
    history = [
        {"date": d, "rating": round(rating)}
        for d, rating in s.execute(
            select(last_per_day.c.day, PuzzleAttempt.rating_after)
            .join(PuzzleAttempt, PuzzleAttempt.id == last_per_day.c.id)
            .order_by(last_per_day.c.day)
        ).all()
    ]
    attempts = list(s.scalars(select(PuzzleAttempt).order_by(PuzzleAttempt.id.desc()).limit(RECENT)))
    shown = {p.id: p for p in s.scalars(select(Puzzle).where(Puzzle.id.in_({a.puzzle_id for a in attempts})))} if attempts else {}
    recent = [
        {
            "puzzle_id": a.puzzle_id,
            "fen": _solver_fen(shown.get(a.puzzle_id)),
            "attempted_at": a.attempted_at,
            "solved": a.solved,
            "rated": a.rated,
            "puzzle_rating": a.puzzle_rating,
            "change": round(a.rating_after) - round(a.rating_before),
            "themes": [THEMES[t] for t in a.themes if t in THEMES][:3],
        }
        for a in attempts
    ]
    # Theme results (rated attempts): where you're strongest and weakest
    themes = []
    for theme, n, ok in s.execute(
        text(
            "SELECT t, count(*), count(*) FILTER (WHERE solved) FROM puzzle_attempts, unnest(themes) t "
            "WHERE rated GROUP BY t HAVING count(*) >= 5"
        )
    ).all():
        if theme in THEMES and theme not in ("short", "long", "veryLong", "oneMove", "middlegame", "endgame", "opening", "crushing", "advantage", "equality"):
            themes.append({"theme": theme, "name": THEMES[theme], "attempts": n, "solved": ok})
    themes.sort(key=lambda t: t["solved"] / t["attempts"])
    return {
        "rating": round(r.rating),
        "rd": round(r.rd),
        "provisional": r.rd > PROVISIONAL_RD,
        "attempts": totals[0],
        "solved": totals[1],
        "rated": totals[2],
        "rated_solved": totals[3],
        "today": {"attempts": today[0], "solved": today[1]},
        "history": history,
        "recent": recent,
        "themes": themes,
    }


def status(s: Session) -> dict:
    last = s.scalar(select(PuzzleImport).order_by(PuzzleImport.id.desc()).limit(1))
    return {
        "puzzles": last.puzzles if last else 0,
        "imported_at": last.finished_at if last else None,
        "source": last.source if last else None,
    }
