"""Looking positions up in the Lichess opening explorer (masters database): the
repertoire gap finder (below) and the board's Masters panel (app.repositories.masters).
The gap finder runs in a background thread when "Check with Lichess masters" is
pressed, one request at a time with a pause between them; a 429 waits a minute, as the
Lichess API guidelines ask. Each answer is saved as it arrives, so a stopped or failed
check keeps what it got and the next one carries on.

The explorer needs a personal API token (LICHESS_TOKEN in .env).
"""

import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app import __version__
from app.config import settings
from app.db.session import get_engine
from app.repositories import gaps as repo

log = logging.getLogger("mpct.explorer")

USER_AGENT = f"MPCT/{__version__} (personal chess training app)"
PAUSE_S = 1.0
MAX_FAILURES = 3  # in a row, then the check stops


class ExplorerError(Exception):
    pass


class TokenRejected(ExplorerError):
    pass


class NotFound(ExplorerError):
    pass


def token_set() -> bool:
    return bool((settings.lichess_token or "").strip())


def http_get(url: str, timeout: float = 30, wait: bool = True, text: bool = False):
    """GET from the explorer with the token. JSON (or the text when text=True). A 429 waits a
    minute and tries again (twice), unless wait=False: a request someone is waiting on fails at once."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/x-chess-pgn" if text else "application/json",
            "Authorization": f"Bearer {settings.lichess_token.strip()}",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                body = res.read().decode("utf-8")
                return body if text else json.loads(body)
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and not wait:
                raise ExplorerError("Lichess is limiting requests right now; try again in a minute") from exc
            if exc.code == 404:
                raise NotFound("Lichess doesn't have that") from exc
            if exc.code == 429 and attempt < 2:
                time.sleep(61)
                continue
            if exc.code in (401, 403):
                raise TokenRejected(f"Lichess refused the API token (HTTP {exc.code}). Check LICHESS_TOKEN in the server's .env.") from exc
            raise ExplorerError(f"HTTP {exc.code} from the Lichess explorer") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise ExplorerError(f"Couldn't reach the Lichess explorer: {exc}") from exc
    raise ExplorerError("Lichess kept answering 429 (too many requests); try again later")


TOP_GAMES = 15  # the most Lichess gives; the board's Masters panel lists them


def masters_url(key: str) -> str:
    """One lookup serves both the gap finder (moves) and the Masters panel (moves + top games)."""
    q = urllib.parse.urlencode({"fen": f"{key} 0 1", "moves": 20, "topGames": TOP_GAMES, "recentGames": 0})
    return f"{settings.lichess_explorer_url.rstrip('/')}/masters?{q}"


def masters_pgn_url(game_id: str) -> str:
    return f"{settings.lichess_explorer_url.rstrip('/')}/masters/pgn/{urllib.parse.quote(game_id)}"


# ---- status shared with the API --------------------------------------------------------

_lock = threading.Lock()
state: dict = {"running": False, "opening_id": None, "total": 0, "done": 0, "error": None, "finished_at": None, "stop": False}


def status() -> dict:
    return {k: state[k] for k in ("running", "opening_id", "total", "done", "error", "finished_at")} | {"token": token_set()}


def check_opening(opening_id: int, get=http_get, pause: float | None = None) -> bool:
    """Look up the opening's positions that aren't cached yet. False if a check is already running."""
    if not _lock.acquire(blocking=False):
        return False
    pause = PAUSE_S if pause is None else pause
    try:
        state.update(running=True, opening_id=opening_id, total=0, done=0, error=None, stop=False)
        with Session(get_engine()) as s:
            todo = repo.missing(s, opening_id)
        state["total"] = len(todo)
        failures = 0
        for i, key in enumerate(todo):
            if state["stop"]:
                break
            if i:
                time.sleep(pause)
            try:
                data = get(masters_url(key))
            except TokenRejected as exc:
                state["error"] = str(exc)
                break
            except ExplorerError as exc:
                failures += 1
                state["error"] = str(exc)
                if failures >= MAX_FAILURES:
                    break
                continue
            failures = 0
            with Session(get_engine()) as s, s.begin():
                repo.store(s, key, data)
            state["done"] += 1
        if state["done"] == state["total"]:
            state["error"] = None  # a passing failure that a retry got past
    except Exception as exc:  # never let the thread die
        log.exception("explorer check failed")
        state["error"] = f"Check failed: {exc}"
    finally:
        state.update(running=False, finished_at=datetime.now(timezone.utc))
        _lock.release()
    return True


def start_check(opening_id: int) -> bool:
    if state["running"]:
        return False
    threading.Thread(target=check_opening, args=(opening_id,), name="explorer-check", daemon=True).start()
    return True


def stop_check() -> None:
    state["stop"] = True
