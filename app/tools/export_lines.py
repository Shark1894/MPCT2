"""Print an opening's lines, one per row as UCI moves, for scripts/practical_choices.py.

Usage (inside the container, which has DATABASE_URL set):

    docker compose exec mpct python -m app.tools.export_lines "Wuss" > wuss.txt

The opening is matched by name (case-insensitive, part of the name is enough). An opening with
exactly that name in several repertoires is exported from all of them together; --repertoire
picks one. The first row is a comment with the opening's name and colour.
"""

import argparse
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Line, Move, Opening, Repertoire
from app.db.session import get_engine


def export(s: Session, name: str, repertoire: str | None = None) -> tuple[list[Opening], list[list[str]]]:
    """The lines of the opening(s) called `name`. Openings with exactly that name in several
    repertoires are taken together (`repertoire` picks one)."""
    query = select(Opening).join(Repertoire).where(Opening.name.ilike(f"%{name}%")).order_by(Opening.name, Repertoire.name)
    if repertoire:
        query = query.where(Repertoire.name.ilike(f"%{repertoire}%"))
    matches = list(s.scalars(query))
    exact = [o for o in matches if o.name.lower() == name.lower()]
    if exact:
        matches = exact

    def label(o):
        return f"'{o.name}' ({o.color}, repertoire '{o.repertoire.name}')"

    if not matches:
        names = ", ".join(label(o) for o in s.scalars(select(Opening).join(Repertoire).order_by(Opening.name)))
        raise SystemExit(f"No opening called '{name}'. Openings: {names}")
    if len({(o.name, o.color) for o in matches}) > 1:
        raise SystemExit("More than one opening matches: " + ", ".join(label(o) for o in matches))
    lines = []
    for opening in matches:
        for line in s.scalars(select(Line).where(Line.opening_id == opening.id).order_by(Line.id)):
            moves = s.scalars(select(Move.uci).where(Move.line_id == line.id).order_by(Move.ply))
            lines.append(list(moves))
    return matches, lines


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("opening", help="the opening's name (or part of it)")
    ap.add_argument("--repertoire", help="only the opening in this repertoire (name or part of it)")
    args = ap.parse_args(argv)
    with Session(get_engine()) as s:
        openings, lines = export(s, args.opening, args.repertoire)
        first = openings[0]
        print(f"# opening: {first.name} ({first.color})")
        for ucis in lines:
            if ucis:
                print(" ".join(ucis))
        where = ", ".join(f"'{o.repertoire.name}'" for o in openings)
        print(f"{len(lines)} lines from '{first.name}' (repertoire {where})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
