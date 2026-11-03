"""Import the Lichess puzzle database by hand (the Puzzles tab's "Download puzzles" does the same).

Usage (inside the container, which has DATABASE_URL set):

    python -m app.tools.import_puzzles                                   # download from Lichess
    python -m app.tools.import_puzzles /tmp/lichess_db_puzzle.csv.zst    # a file you downloaded

Replaces every puzzle; your attempts and rating are kept.
"""

import argparse
import sys
import threading
import time

from app import puzzle_import


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", nargs="?", default=puzzle_import.LICHESS_URL, help="URL or path of a .csv or .csv.zst file")
    args = ap.parse_args(argv)

    done = threading.Event()

    def report():
        while not done.wait(5):
            st = puzzle_import.state
            print(f"  {st['step']}: {st['loaded']:,} puzzles", flush=True)

    threading.Thread(target=report, daemon=True).start()
    start = time.monotonic()
    try:
        n = puzzle_import.import_puzzles(args.source)
    except Exception as exc:
        done.set()
        print(f"Import failed: {exc}", file=sys.stderr)
        return 1
    done.set()
    print(f"Imported {n:,} puzzles in {time.monotonic() - start:.0f} s.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
