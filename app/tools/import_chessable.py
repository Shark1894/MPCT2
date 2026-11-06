"""Import Chessable course lines into MPCT (a one-off, run by hand on the server).

Each course becomes its own repertoire (named after the course, so the author's notes never mix
with your own comments), with one opening per chapter, played from the course's side. Every line's
moves are added as an MPCT line, and the author's notes go into the position comments (sidelines
written out in brackets). Review history starts fresh: every new line is due today.

Re-running is safe: lines already there are skipped, a longer version of a line extends it, and a
note already in a comment isn't added again.

Download the course first with app/tools/fetch_chessable.py (see there), then, inside the
container (which has DATABASE_URL set):

    python -m app.tools.import_chessable /tmp/chessable/156667 --dry-run   # a fetch_chessable folder
    python -m app.tools.import_chessable /tmp/chessable/156667
    python -m app.tools.import_chessable getGame.json --repertoire "Finegold 1.d4"   # single saved lines

Options: --repertoire NAME puts the course in that repertoire (created if missing) instead of one
named after the course; --no-comments skips the notes; --dry-run reads and reports, saving nothing.
"""

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.chessable import CourseLine, NotALine, parse_line
from app.core.positions import InvalidLine, walk_line
from app.db.models import Opening, Repertoire
from app.repositories import repertoire as repo


@dataclass
class Report:
    files: int = 0
    lines_read: int = 0
    lines_created: int = 0
    lines_extended: int = 0
    lines_existing: int = 0
    comments_added: int = 0
    comments_existing: int = 0
    repertoires: set[str] = field(default_factory=set)
    openings: dict[str, int] = field(default_factory=dict)  # chapter -> lines read
    skipped: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [
            f"Files read:               {self.files}",
            f"Lines read:               {self.lines_read}",
            f"  new lines:              {self.lines_created}",
            f"  extended existing line: {self.lines_extended}",
            f"  already there:          {self.lines_existing}",
            f"Notes added to comments:  {self.comments_added} ({self.comments_existing} already there)",
            f"Repertoire:               {', '.join(sorted(self.repertoires)) or '-'}",
            "Openings (chapters):",
            *[f"  {name}: {n} line{'s' if n != 1 else ''}" for name, n in self.openings.items()],
        ]
        if self.skipped:
            out.append(f"Skipped ({len(self.skipped)}):")
            out += [f"  {s}" for s in self.skipped]
        return out


def _course_files(folder: Path, report: Report) -> list[Path]:
    """A fetch_chessable folder: line files in course order (chapters, then lines as Chessable lists them)."""
    course = json.loads((folder / "course.json").read_text(encoding="utf-8"))
    files = []
    for c in sorted((course.get("course") or {}).get("data") or [], key=lambda c: c.get("order", 0)):
        listing = folder / f"chapter-{c['id']}.json"
        if not listing.exists():
            continue  # not fetched (left out)
        for oid in json.loads(listing.read_text(encoding="utf-8")).get("openings") or []:
            f = folder / f"line-{oid}.json"
            if f.exists():
                files.append(f)
            else:
                report.skipped.append(f"{c.get('title', c['id'])}: line {oid} not downloaded (run fetch_chessable again)")
    return files


def read_files(paths: list[Path], report: Report) -> list[CourseLine]:
    """getGame .json files, or folders: a fetch_chessable folder (in course order) or any .json files in it."""
    files: list[Path] = []
    for p in paths:
        if p.is_dir():
            files += _course_files(p, report) if (p / "course.json").exists() else sorted(p.glob("*.json"))
        else:
            files.append(p)
    lines = []
    for f in files:
        report.files += 1
        try:
            lines.append(parse_line(json.loads(f.read_text(encoding="utf-8"))))
        except (OSError, json.JSONDecodeError, NotALine) as exc:
            report.skipped.append(f"{f.name}: {exc}")
    return lines


def _repertoire(s: Session, name: str) -> Repertoire:
    rep = s.scalar(select(Repertoire).where(Repertoire.name == name))
    return rep or repo.create_repertoire(s, name)


def _opening(s: Session, rep: Repertoire, name: str, color: str) -> int:
    found = s.scalar(select(Opening).where(Opening.repertoire_id == rep.id, Opening.name == name))
    if found:
        if found.color != color:
            raise repo.Conflict(f"Opening {name!r} in {rep.name!r} is for {found.color}, but the course is for {color}")
        return found.id
    return repo.create_opening(s, rep.id, name, color)["id"]


def merge_comment(existing: str, note: str) -> str | None:
    """The comment with the note added, or None if it's already in there."""
    if note in existing:
        return None
    return f"{existing}\n\n{note}" if existing else note


def import_lines(
    s: Session, lines: list[CourseLine], report: Report, repertoire_name: str | None = None, comments: bool = True
) -> Report:
    for line in lines:
        rep = _repertoire(s, (repertoire_name or line.course)[:100])
        report.repertoires.add(rep.name)
        opening_name = line.chapter[:100]
        opening_id = _opening(s, rep, opening_name, line.color)
        report.openings[opening_name] = report.openings.get(opening_name, 0) + 1
        report.lines_read += 1
        try:
            result = repo.add_line(s, opening_id, line.ucis)
        except InvalidLine as exc:
            report.skipped.append(f"{line.chapter} / {line.title or line.line_id}: {exc}")
            continue
        if result.status == "created":
            report.lines_created += 1
        elif result.status == "extended":
            report.lines_extended += 1
        else:
            report.lines_existing += 1
        if not comments or not line.comments:
            continue
        walked = walk_line(line.ucis)
        fens = {0: walked[0].key_before + " 0 1", **{m.ply: m.key_after + " 0 1" for m in walked}}
        for ply, note in sorted(line.comments.items()):
            merged = merge_comment(repo.get_comment(s, rep.id, fens[ply]), note)
            if merged is None:
                report.comments_existing += 1
            else:
                repo.set_comment(s, rep.id, fens[ply], merged)
                report.comments_added += 1
    s.flush()
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import Chessable course lines (saved getGame responses) into MPCT.")
    parser.add_argument("paths", nargs="+", type=Path, help="getGame .json files, or folders of them")
    parser.add_argument("--repertoire", help="repertoire to import into (default: one named after the course)")
    parser.add_argument("--no-comments", action="store_true", help="don't import the author's notes")
    parser.add_argument("--dry-run", action="store_true", help="read and report, but save nothing")
    args = parser.parse_args(argv)

    from app.db.session import get_engine  # needs DATABASE_URL

    report = Report()
    lines = read_files(args.paths, report)
    with Session(get_engine()) as s:
        try:
            import_lines(s, lines, report, args.repertoire, comments=not args.no_comments)
        except repo.Conflict as exc:
            s.rollback()
            print(f"Nothing imported: {exc}", file=sys.stderr)
            return 1
        if args.dry_run:
            s.rollback()
            print("Dry run: nothing saved.\n")
        else:
            s.commit()
    print("\n".join(report.lines()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
