"""Fetching tournament games for "repertoire in the wild": Lichess broadcasts and The Week
in Chess (TWIC). Runs in a background thread every few hours (and on "Check now").

- Lichess: /api/broadcast/top lists active broadcasts and pages of past ones. Each
  tournament is downloaded whole (/api/broadcast/{id}.pgn). Finished tournaments are
  fetched once; active ones again on every run until they finish. Unfinished games are
  skipped, so a game is stored once it has a result.
- TWIC: one zip of PGN a week (theweekinchess.com/zips/twic{n}g.zip). The first run takes
  the issues covering the last `wild_days`; later runs take any newer issues.

Requests are made one at a time with a pause between them, and a 429 from Lichess waits a
minute, as its API guidelines ask. Network and parse errors are recorded in the status and
the run moves on: a bad download never stops the rest.
"""

import io
import json
import logging
import math
import re
import threading
import time
import urllib.error
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app import __version__
from app.config import settings
from app.core.wild import read_games
from app.db.session import get_engine
from app.repositories import wild as repo

log = logging.getLogger("mpct.wild")

LICHESS = "https://lichess.org"
TWIC = "https://theweekinchess.com"
USER_AGENT = f"MPCT/{__version__} (personal chess training app)"
PAUSE_S = 1.5
LICHESS_MAX_PAGES = 5  # /api/broadcast/top answers HTTP 400 past page 5 (seen on the server, Nov 2026)
# Anchor for estimating the current TWIC issue if the index page can't be read.
TWIC_ANCHOR = (1660, date(2026, 8, 31))


class HttpError(Exception):
    def __init__(self, status: int, url: str):
        super().__init__(f"HTTP {status} for {url}")
        self.status = status


def http_get(url: str, accept: str = "*/*", timeout: float = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < 2:
                time.sleep(61)  # Lichess: wait a full minute after a 429
                continue
            raise HttpError(exc.code, url) from exc
    raise HttpError(429, url)


def _text(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")  # older TWIC files


# ---- status shared with the API ------------------------------------------------------------

_lock = threading.Lock()
state: dict = {"running": False, "started_at": None, "finished_at": None, "step": "", "errors": [], "added": 0, "next_run_at": None}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _step(text: str) -> None:
    state["step"] = text
    log.info(text)


def _error(text: str) -> None:
    state["errors"] = (state["errors"] + [text])[-10:]
    log.warning(text)


# ---- Lichess ----------------------------------------------------------------------------------


def _tour_end_ms(entry: dict) -> int | None:
    tour = entry.get("tour") or {}
    dates = tour.get("dates") or []
    if dates:
        return max(dates)
    rnd = entry.get("round") or {}
    return rnd.get("finishedAt") or rnd.get("startsAt") or tour.get("createdAt")


def lichess_tours(since: datetime, get=http_get) -> list[tuple[str, str, bool]]:
    """(tour id, name, finished) for active broadcasts and past ones ending after `since`."""
    since_ms = since.timestamp() * 1000
    tours: dict[str, tuple[str, str, bool]] = {}
    page = 1
    while page and page <= LICHESS_MAX_PAGES:
        try:
            data = json.loads(get(f"{LICHESS}/api/broadcast/top?page={page}", "application/json"))
        except Exception as exc:
            if page == 1:
                raise  # nothing to go on
            log.info("Lichess broadcast list stopped at page %s: %s", page, exc)
            break  # keep the tours found on earlier pages
        if page == 1:
            for entry in data.get("active") or []:
                t = entry.get("tour") or {}
                if t.get("id"):
                    tours[t["id"]] = (t["id"], t.get("name", ""), False)
        past = data.get("past") or {}
        older = False
        for entry in past.get("currentPageResults") or []:
            t = entry.get("tour") or {}
            end = _tour_end_ms(entry)
            if end is not None and end < since_ms:
                older = True
                continue
            if t.get("id") and t["id"] not in tours:
                tours[t["id"]] = (t["id"], t.get("name", ""), True)
        if older:
            break
        page = past.get("nextPage")
        time.sleep(PAUSE_S)
    return list(tours.values())


def fetch_lichess(s_factory, since: datetime, get=http_get) -> int:
    added = 0
    try:
        tours = lichess_tours(since, get)
    except Exception as exc:
        _error(f"Lichess broadcast list: {exc}")
        return 0
    for i, (tour_id, name, finished) in enumerate(tours, start=1):
        key = f"lichess:{tour_id}"
        with s_factory() as s:
            if repo.source_done(s, key):
                continue
        _step(f"Lichess {i}/{len(tours)}: {name}")
        try:
            games, _ = read_games(_text(get(f"{LICHESS}/api/broadcast/{tour_id}.pgn", "application/x-chess-pgn")))
        except Exception as exc:
            _error(f"Lichess {name}: {exc}")
            continue
        with s_factory() as s, s.begin():
            new = repo.store_games(s, games, "lichess", key)
            repo.mark_source(s, key, finished, len(games))
        added += new
        time.sleep(PAUSE_S)
    return added


# ---- TWIC ---------------------------------------------------------------------------------------


def twic_estimate(today: date) -> int:
    n, d = TWIC_ANCHOR
    return n + max(0, (today - d).days // 7)


def twic_latest(today: date, get=http_get) -> int:
    try:
        html = _text(get(f"{TWIC}/twic", "text/html"))
        found = [int(n) for n in re.findall(r"twic(\d{3,5})g?\.zip", html)]
        if found:
            return max(found)
    except Exception as exc:
        _error(f"TWIC index: {exc} (estimating the issue number)")
    return twic_estimate(today)


def twic_pgn(issue: int, get=http_get) -> str:
    data = get(f"{TWIC}/zips/twic{issue}g.zip", "application/zip")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".pgn"))
        return _text(z.read(name))


def fetch_twic(s_factory, today: date, days: int, get=http_get) -> int:
    latest = twic_latest(today, get)
    with s_factory() as s:
        last = repo.latest_twic(s)
    first = latest - math.ceil(days / 7) + 1
    if last is not None:
        first = max(first, last + 1)
    added = 0
    failures = 0
    issue = first
    while issue <= latest + 1:  # +1: the index page may lag a new issue
        if failures >= 3:
            _error("TWIC: giving up for this run after 3 failed downloads")
            break
        key = f"twic:{issue}"
        _step(f"The Week in Chess {issue}")
        try:
            games, _ = read_games(twic_pgn(issue, get))
        except HttpError as exc:
            if exc.status == 404 and issue >= latest:
                break  # not published yet
            _error(f"TWIC {issue}: {exc}")
            failures += 1
            issue += 1
            continue
        except Exception as exc:
            _error(f"TWIC {issue}: {exc}")
            failures += 1
            issue += 1
            continue
        failures = 0
        with s_factory() as s, s.begin():
            added += repo.store_games(s, games, "twic", f"twic{issue}")
            repo.mark_source(s, key, True, len(games))
        issue += 1
        time.sleep(PAUSE_S)
    return added


# ---- a run, and the schedule ------------------------------------------------------------------


def run_once(get=http_get, today: date | None = None) -> bool:
    """Fetch everything new. Returns False if a run is already in progress."""
    if not _lock.acquire(blocking=False):
        return False
    try:
        today = today or date.today()
        state.update(running=True, started_at=_now(), step="Starting", errors=[], added=0)
        factory = lambda: Session(get_engine())  # noqa: E731
        since = datetime.combine(today - timedelta(days=settings.wild_days), datetime.min.time(), timezone.utc)
        added = fetch_lichess(factory, since, get)
        added += fetch_twic(factory, today, settings.wild_days, get)
        with factory() as s, s.begin():
            pruned = repo.prune(s, settings.wild_days, today)
        state["added"] = added
        _step(f"Done: {added} new games" + (f", {pruned} old ones pruned" if pruned else ""))
    except Exception as exc:  # never let the thread die
        _error(f"Run failed: {exc}")
        state["step"] = "Failed"
    finally:
        state.update(running=False, finished_at=_now())
        _lock.release()
    return True


def start_now() -> bool:
    """Start a run in the background (for "Check now"). False if one is already running."""
    if state["running"]:
        return False
    threading.Thread(target=run_once, name="wild-fetch-now", daemon=True).start()
    return True


_stop = threading.Event()


def _loop(first_delay: float) -> None:
    if _stop.wait(first_delay):
        return
    while True:
        run_once()
        interval = settings.wild_interval_hours * 3600
        state["next_run_at"] = _now() + timedelta(seconds=interval)
        if _stop.wait(interval):
            return


def start_schedule(first_delay: float = 60) -> None:
    if not (settings.wild_fetch and settings.database_url):
        return
    _stop.clear()
    state["next_run_at"] = _now() + timedelta(seconds=first_delay)
    threading.Thread(target=_loop, args=(first_delay,), name="wild-fetch", daemon=True).start()


def stop_schedule() -> None:
    _stop.set()
