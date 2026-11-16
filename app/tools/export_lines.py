"""Print an opening's lines, one per row as UCI moves, for scripts/practical_choices.py.

Usage (inside the container, which has DATABASE_URL set):

    docker compose exec mpct python -m app.tools.export_lines "Wuss" > wuss.txt

The opening is matched by name (case-insensitive, part of the name is enough; it must match
one opening). The first row is a comment with the opening's name and colour.
"""

import argparse
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Line, Move, Opening
from app.db.session import get_engine


def export(s: Session, name: str) -> tuple[Opening, list[list[str]]]:
    matches = list(s.scalars(select(Opening).where(Opening.name.ilike(f"%{name}%")).order_by(Opening.name)))
    exact = [o for o in matches if o.name.lower() == name.lower()]
    if exact:
        matches = exact
    if not matches:
        raise SystemExit(f"No opening called '{name}'")
    if len(matches) > 1:
        raise SystemExit("More than one opening matches: " + ", ".join(f"'{o.name}'" for o in matches))
    opening = matches[0]
    lines = []
    for line in s.scalars(select(Line).where(Line.opening_id == opening.id).order_by(Line.id)):
        moves = s.scalars(select(Move.uci).where(Move.line_id == line.id).order_by(Move.ply))
        lines.append(list(moves))
    return opening, lines


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("opening", help="the opening's name (or part of it)")
    args = ap.parse_args(argv)
    with Session(get_engine()) as s:
        opening, lines = export(s, args.opening)
    print(f"# opening: {opening.name} ({opening.color})")
    for ucis in lines:
        if ucis:
            print(" ".join(ucis))
    print(f"{len(lines)} lines from '{opening.name}'", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
