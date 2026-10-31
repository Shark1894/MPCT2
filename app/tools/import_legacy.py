"""Import openings, lines and position comments from a legacy PyQt MPCT repertoire (.db).

Review history is not imported: every line starts fresh and is due today.

Everything goes through the same code the app uses, so:
  - SAN is regenerated from each move's UCI (fixes the legacy extension bug)
  - position keys are recomputed (fixes the legacy en passant key bug)
  - duplicate lines, and lines that are a prefix of another, are merged
  - illegal lines are reported and skipped

Usage (inside the container, which has DATABASE_URL set):

    python -m app.tools.import_legacy /tmp/Main.db --repertoire Main --dry-run
    python -m app.tools.import_legacy /tmp/Main.db --repertoire Main

Options: --replace deletes an existing repertoire of that name first; --no-comments skips comments.
"""

import argparse
import sqlite3
import sys
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.positions import InvalidLine, InvalidPosition, key_from_fen, walk_line
from app.db.models import Repertoire
from app.repositories import repertoire as repo

REQUIRED_TABLES = {"openings", "lines", "moves", "positions"}


@dataclass
class Report:
    openings: int = 0
    lines_read: int = 0
    lines_created: int = 0
    lines_extended: int = 0
    lines_duplicate: int = 0  # already covered by another legacy line
    moves_added: int = 0
    san_fixed: int = 0  # legacy SAN that didn't match the move
    comments: int = 0
    comments_merged: int = 0  # legacy positions that collapse to the same key
    skipped: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [
            f"Openings imported:        {self.openings}",
            f"Legacy lines read:        {self.lines_read}",
            f"  new lines:              {self.lines_created}",
            f"  extended existing line: {self.lines_extended}",
            f"  already covered:        {self.lines_duplicate}",
            f"  skipped (invalid):      {len(self.skipped)}",
            f"Moves stored:             {self.moves_added}",
            f"Wrong legacy SAN fixed:   {self.san_fixed}",
            f"Comments imported:        {self.comments}"
            + (f" ({self.comments_merged} merged duplicates)" if self.comments_merged else ""),
        ]
        out += [f"  SKIPPED {s}" for s in self.skipped]
        return out


def legacy_fen(stored: str) -> str:
    """Rebuild a full FEN from the legacy `fen.split(" - ")[0]` value.

    The legacy key kept 2 fields when castling was '-' ("placement side"), 3 fields
    when the en passant field was '-' ("placement side castling"), and the whole FEN
    when neither split point existed.
    """
    parts = stored.split()
    if len(parts) == 2:
        parts += ["-", "-"]
    elif len(parts) == 3:
        parts += ["-"]
    return " ".join(parts[:4]) + " 0 1"


def read_legacy(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise SystemExit(f"Not found: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing = REQUIRED_TABLES - tables
    if missing:
        raise SystemExit(f"{path} doesn't look like a legacy MPCT repertoire (missing tables: {', '.join(sorted(missing))})")
    return conn


def import_legacy(
    s: Session, path: Path, repertoire_name: str, replace: bool = False, comments: bool = True
) -> Report:
    """Import into a new repertoire. The caller commits (or rolls back for a dry run)."""
    legacy = read_legacy(path)
    report = Report()

    existing = s.scalar(select(Repertoire.id).where(Repertoire.name == repertoire_name))
    if existing is not None:
        if not replace:
            raise repo.Conflict(
                f"A repertoire called '{repertoire_name}' already exists. Use --replace to overwrite it, "
                "or choose another name with --repertoire."
            )
        repo.delete_repertoire(s, existing)
    rep = repo.create_repertoire(s, repertoire_name)

    openings = legacy.execute("SELECT opening_id, name, color FROM openings ORDER BY opening_id").fetchall()
    for legacy_id, name, color in openings:
        opening = repo.create_opening(s, rep.id, name.strip()[:100], color.strip().lower())
        report.openings += 1

        line_ids = [r[0] for r in legacy.execute("SELECT line_id FROM lines WHERE opening_id = ? ORDER BY line_id", (legacy_id,))]
        for line_id in line_ids:
            moves = legacy.execute(
                "SELECT move_uci, move_san FROM moves WHERE line_id = ? ORDER BY move_number, move_id", (line_id,)
            ).fetchall()
            if not moves:
                continue
            report.lines_read += 1
            ucis = [uci for uci, _ in moves]
            try:
                walked = walk_line(ucis)
            except InvalidLine as exc:
                report.skipped.append(f"{name} line {line_id}: {exc}")
                continue
            report.san_fixed += sum(1 for w, (_, san) in zip(walked, moves) if san != w.san)

            result = repo.add_line(s, opening["id"], ucis)
            report.moves_added += result.moves_added
            if result.status == "created":
                report.lines_created += 1
            elif result.status == "extended":
                report.lines_extended += 1
            else:
                report.lines_duplicate += 1

    if comments:
        merged: dict[str, tuple[str, str]] = {}  # key -> (fen, comment)
        rows = legacy.execute(
            "SELECT position_fen, comment FROM positions WHERE comment IS NOT NULL AND trim(comment) != '' ORDER BY position_id"
        )
        for stored, comment in rows:
            fen = legacy_fen(stored)
            try:
                key = key_from_fen(fen)
            except InvalidPosition:
                report.skipped.append(f"comment on invalid position {stored!r}")
                continue
            comment = comment.strip()
            if key in merged:
                report.comments_merged += 1
                previous = merged[key][1]
                if comment != previous and comment not in previous:
                    merged[key] = (fen, f"{previous}\n\n{comment}")
            else:
                merged[key] = (fen, comment)
        for fen, comment in merged.values():
            repo.set_comment(s, rep.id, fen, comment)
            report.comments += 1

    legacy.close()
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("db", type=Path, help="legacy repertoire file, e.g. Main.db")
    parser.add_argument("--repertoire", default=None, help="name for the new repertoire (default: file name)")
    parser.add_argument("--replace", action="store_true", help="delete an existing repertoire with that name first")
    parser.add_argument("--no-comments", action="store_true", help="don't import position comments")
    parser.add_argument("--dry-run", action="store_true", help="show what would be imported, change nothing")
    args = parser.parse_args(argv)

    from app.db.session import get_engine

    name = args.repertoire or args.db.stem
    with Session(get_engine()) as s:
        try:
            report = import_legacy(s, args.db, name, replace=args.replace, comments=not args.no_comments)
        except repo.Conflict as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        if args.dry_run:
            s.rollback()
        else:
            s.commit()

    print(f"{'DRY RUN, nothing saved. ' if args.dry_run else ''}Imported {args.db.name} into repertoire '{name}':")
    print("\n".join(report.lines()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
