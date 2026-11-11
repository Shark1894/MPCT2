"""Importing the Lichess puzzle database (CC0) into the puzzles table.

The compressed CSV (about 260 MB, 6 million puzzles) is streamed straight from
database.lichess.org, decompressed on the fly and bulk-loaded with COPY: no temporary
file. Everything happens in one transaction, so a failed or cancelled import leaves the
previous puzzles in place, and a re-import replaces them all (attempts and your rating are
kept: they don't refer to the table). The indexes are rebuilt at the end, which is faster
than keeping them up to date row by row.

Run from the Puzzles tab ("Download puzzles"), or by hand:

    python -m app.tools.import_puzzles                       # download from Lichess
    python -m app.tools.import_puzzles /tmp/lichess_db_puzzle.csv.zst
"""

import logging
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from app import __version__
from app.core.puzzles import COLUMNS, read_rows, text_stream
from app.db.session import get_engine

log = logging.getLogger("mpct.puzzles")

LICHESS_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
USER_AGENT = f"MPCT/{__version__} (personal chess training app)"
PROGRESS_EVERY = 50_000
EXPECTED = 6_000_000  # roughly, for the progress bar (Lichess had 6,057,356 in July 2026)

_lock = threading.Lock()
state: dict = {"running": False, "step": "", "loaded": 0, "error": None, "started_at": None, "finished_at": None}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _open(source: str):
    """A binary stream for a URL or a local file."""
    if source.startswith(("http://", "https://")):
        req = urllib.request.Request(source, headers={"User-Agent": USER_AGENT})
        return urllib.request.urlopen(req, timeout=120)
    return open(Path(source), "rb")


def import_puzzles(source: str = LICHESS_URL, engine=None, seed: int | None = None) -> int:
    """Replace the puzzles with those in `source` (URL or path, .csv or .csv.zst). Returns the count.
    Raises RuntimeError if an import is already running."""
    if not _lock.acquire(blocking=False):
        raise RuntimeError("A puzzle import is already running")
    engine = engine or get_engine()
    state.update(running=True, step="Downloading", loaded=0, error=None, started_at=_now(), finished_at=None)
    try:
        compressed = source.lower().endswith(".zst")
        conn = engine.raw_connection()
        try:
            with _open(source) as binary, conn.cursor() as cur:
                lines = text_stream(binary, compressed)
                cur.execute("SET LOCAL statement_timeout = 0")
                cur.execute("DROP INDEX IF EXISTS ix_puzzles_rnd")
                cur.execute("DROP INDEX IF EXISTS ix_puzzles_themes")
                cur.execute("DROP INDEX IF EXISTS ix_puzzles_opening_tags")
                cur.execute("TRUNCATE puzzles")
                n = 0
                with cur.copy(f"COPY puzzles ({', '.join(COLUMNS)}) FROM STDIN") as copy:
                    for row in read_rows(lines, seed):
                        copy.write_row(row.copy_row())
                        n += 1
                        if n % PROGRESS_EVERY == 0:
                            state.update(step="Loading puzzles", loaded=n)
                if n == 0:
                    raise ValueError("No puzzles found in the file")
                state.update(step="Building indexes", loaded=n)
                cur.execute("CREATE INDEX ix_puzzles_rnd ON puzzles (rnd)")
                cur.execute("CREATE INDEX ix_puzzles_themes ON puzzles USING gin (themes)")
                cur.execute("CREATE INDEX ix_puzzles_opening_tags ON puzzles USING gin (opening_tags)")
                cur.execute("INSERT INTO puzzle_imports (puzzles, source) VALUES (%s, %s)", (n, source[:300]))
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()
        with engine.connect() as c:  # fresh statistics for the planner
            c.execution_options(isolation_level="AUTOCOMMIT").exec_driver_sql("ANALYZE puzzles")
        state.update(step=f"Done: {n:,} puzzles", loaded=n)
        log.info("Imported %s puzzles from %s", n, source)
        return n
    except Exception as exc:
        state.update(step="Failed", error=str(exc))
        log.warning("Puzzle import failed: %s", exc)
        raise
    finally:
        state.update(running=False, finished_at=_now())
        _lock.release()


def start_import(source: str = LICHESS_URL) -> bool:
    """Start an import in the background. False if one is already running."""
    if state["running"]:
        return False

    def run():
        try:
            import_puzzles(source)
        except Exception:
            pass  # recorded in state

    state.update(running=True, step="Starting", error=None, loaded=0)
    threading.Thread(target=run, name="puzzle-import", daemon=True).start()
    time.sleep(0.05)
    return True
