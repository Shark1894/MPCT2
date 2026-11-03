"""Load a PGN file (or a TWIC zip) into the "in the wild" game store by hand, e.g. if a
download is blocked on the server or to add an event that isn't broadcast.

Usage (inside the container, which has DATABASE_URL set):

    python -m app.tools.import_wild_pgn /tmp/twic1669g.zip
    python -m app.tools.import_wild_pgn /tmp/event.pgn --source lichess --ref "lichess:manual"

Games already stored (same players, date and moves) are skipped.
"""

import argparse
import io
import sys
import zipfile
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.wild import read_games
from app.db.session import get_engine
from app.repositories import wild as repo
from app.wild_fetch import _text


def load_text(path: Path) -> str:
    data = path.read_bytes()
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            return "\n".join(_text(z.read(n)) for n in z.namelist() if n.lower().endswith(".pgn"))
    return _text(data)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", type=Path)
    ap.add_argument("--source", choices=["twic", "lichess"], default="twic")
    ap.add_argument("--ref", default=None, help="label for where the games came from (default: the file name)")
    args = ap.parse_args(argv)
    games, skipped = read_games(load_text(args.file))
    with Session(get_engine()) as s, s.begin():
        new = repo.store_games(s, games, args.source, args.ref or args.file.stem[:60])
    print(f"Read {len(games)} finished games ({skipped} skipped); {new} new, {len(games) - new} already stored.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
