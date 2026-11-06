#!/usr/bin/env python3
"""Combine a per-line Chessable download into one course export that MPCT can import.

The download is a folder (or a .zip of it) with one JSON file per line ("<oid>.json", each
{"game": {...}}) plus course files such as course.json. MPCT's "Import Chessable course" reads
one file shaped like:

    {"bookData": {"course": <course.json>, "<oid>": {"game": {...}}, ...}}

Usage:
    python -m app.tools.combine_chessable book_156667_273617.zip   # -> "Starting Out - 1.d4.json" (the course's name)
    python -m app.tools.combine_chessable some/folder -o my_course.json
"""

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path


def read_entries(source: Path):
    """Yield (filename, parsed JSON) for every .json file in a folder or zip."""
    if source.is_dir():
        for p in sorted(source.rglob("*.json")):
            yield p.name, p.read_bytes()
    elif zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as z:
            for name in sorted(z.namelist()):
                if name.lower().endswith(".json") and not name.endswith("/"):
                    yield Path(name).name, z.read(name)
    else:
        sys.exit(f"{source} is neither a folder nor a zip file")


def combine(source: Path) -> tuple[dict, list[str]]:
    book: dict = {}
    lines: dict[str, dict] = {}
    problems: list[str] = []
    for name, raw in read_entries(source):
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError as exc:
            problems.append(f"{name}: not valid JSON ({exc})")
            continue
        if name == "course.json":
            book["course"] = doc
        elif isinstance(doc, dict) and isinstance(doc.get("game"), dict) and isinstance(doc["game"].get("data"), list):
            oid = str(doc["game"].get("oid") or Path(name).stem)
            if oid in lines:
                problems.append(f"{name}: duplicate line {oid}, kept the first")
                continue
            lines[oid] = doc
        # Anything else (meta.json, chapterStats.json, ...) isn't needed by the importer.

    if not lines:
        sys.exit("No Chessable lines found (files with game.data)")

    # Chapter order, then line order, so the file reads in course order even without course.json.
    order = {c.get("id"): c.get("order", 0) for c in (book.get("course") or {}).get("data", []) if isinstance(c, dict)}
    def key(item):
        g = item[1]["game"]
        return (order.get(g.get("lid"), 10_000), g.get("lid") or 0, int(item[0]) if item[0].isdigit() else 0)
    for oid, doc in sorted(lines.items(), key=key):
        book[oid] = doc

    if "course" not in book:
        problems.append("no course.json: chapters will use the names in the lines, in chapter-number order")
        name = next(iter(lines.values()))["game"].get("name")
        if name:
            book["course"] = {"name": name, "data": []}
    return {"bookData": book}, problems


def course_name(combined: dict) -> str:
    book = combined["bookData"]
    name = (book.get("course") or {}).get("name")
    if not name:
        name = next((v["game"].get("name") for k, v in book.items() if k != "course"), "")
    return (name or "").strip()


def safe_name(name: str) -> str:
    """A course name as a filename: 'Starting Out: 1.d4' -> 'Starting Out - 1.d4'."""
    name = re.sub(r'\s*[:/\\|]\s*', " - ", name)
    name = re.sub(r'[<>"?*\x00-\x1f]', "", name)
    return re.sub(r"\s+", " ", name).strip(" .")


def summary(combined: dict) -> str:
    book = combined["bookData"]
    games = [v["game"] for k, v in book.items() if k != "course"]
    chapters: dict = {}
    for g in games:
        chapters.setdefault((g.get("lid"), (g.get("lineName") or "").strip()), []).append(g)
    colors = {g.get("color") for g in games}
    out = [f"Course: {book.get('course', {}).get('name') or games[0].get('name')}  colour: {', '.join(sorted(map(str, colors)))}",
           f"{len(games)} lines in {len(chapters)} chapters:"]
    for (lid, title), gs in chapters.items():
        info = sum(1 for g in gs if g.get("isInfo"))
        ref = sum(1 for g in gs if g.get("isRef"))
        extra = ", ".join(x for x in (f"{info} info" if info else "", f"{ref} reference" if ref else "") if x)
        out.append(f"  {title or f'Chapter {lid}'}: {len(gs)}" + (f" ({extra})" if extra else ""))
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="the downloaded folder or .zip")
    ap.add_argument("-o", "--output", type=Path, help="output file (default: <course name>.json next to the source)")
    args = ap.parse_args()

    combined, problems = combine(args.source)
    out = args.output or args.source.with_name(f"{safe_name(course_name(combined)) or args.source.stem}.json")
    out.write_text(json.dumps(combined, ensure_ascii=False), encoding="utf-8")
    print(summary(combined))
    for p in problems:
        print("Note:", p)
    print(f"Wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
