"""Lichess opening names (lichess-org/chess-openings, CC0) and the opening tags of the Lichess
puzzle database. Pure, no database.

A puzzle's OpeningTags are the opening of the game it came from, as Lichess named it: the
family key and the variation key, e.g. "Sicilian_Defense Sicilian_Defense_Najdorf_Variation",
or "<family>_Other_variations" when the game's opening has no variation. Keys are made like
scalachess's Opening.nameToKey: accents dropped, spaces to "_", anything but letters, digits,
"_" and "-" removed. The variation is the part of the name after ":" up to the first ",".

Lichess names a game by the deepest named position it reached, so the puzzles from games in
one of your openings are those tagged with the variation of any named position your lines
pass through.
"""

import csv
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import chess

DATA = Path(__file__).resolve().parent.parent / "data" / "chess-openings"
OTHER = "Other_variations"

_ws = re.compile(r"\s+")
_bad = re.compile(r"[^\w\-]+")


def name_to_key(name: str) -> str:
    plain = "".join(c for c in unicodedata.normalize("NFD", name) if not unicodedata.combining(c))
    return _bad.sub("", _ws.sub("_", plain))


@dataclass(frozen=True)
class Named:
    family: str
    variation: str | None

    @property
    def tag(self) -> str:
        """The most specific puzzle tag for a game whose opening is this name."""
        return name_to_key(f"{self.family} {self.variation or OTHER.replace('_', ' ')}")

    @property
    def label(self) -> str:
        return f"{self.family}: {self.variation}" if self.variation else self.family


def split_name(name: str) -> Named:
    family, _, rest = name.partition(":")
    variation = rest.split(",", 1)[0].strip() if rest else None
    return Named(family.strip(), variation or None)


def _epd_after(pgn: str) -> str:
    board = chess.Board()
    for token in pgn.split():
        if token.rstrip(".").isdigit() or token.endswith("."):
            continue
        board.push_san(token)
    return board.epd()


@lru_cache(maxsize=1)
def _load() -> tuple[dict[str, Named], dict[str, str]]:
    """(position key -> its name, puzzle tag -> readable name) from the TSV files."""
    by_key: dict[str, Named] = {}
    labels: dict[str, str] = {}
    for path in sorted(DATA.glob("*.tsv")):
        with path.open(encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                named = split_name(row["name"])
                by_key[_epd_after(row["pgn"])] = named
                labels.setdefault(name_to_key(named.family), named.family)
                if named.variation:
                    labels.setdefault(named.tag, named.label)
    return by_key, labels


def named_positions() -> dict[str, Named]:
    return _load()[0]


def label(tag: str) -> str:
    """A readable name for a puzzle opening tag."""
    labels = _load()[1]
    if tag in labels:
        return labels[tag]
    if tag.endswith("_" + OTHER):
        family = tag[: -len(OTHER) - 1]
        return f"{labels.get(family, family.replace('_', ' '))}: other variations"
    return tag.replace("_", " ")


def tags_for_positions(keys) -> dict[str, str]:
    """Puzzle tags (-> readable name) for the named positions among `keys` (position EPDs)."""
    by_key = named_positions()
    out = {}
    for k in keys:
        named = by_key.get(k)
        if named:
            out[named.tag] = named.label if named.variation else f"{named.family}: other variations"
    return out


def choices() -> list[dict]:
    """Every family and variation as a filter choice: family tags match all its puzzles."""
    labels = _load()[1]
    return sorted(
        ({"tag": t, "name": n, "family": ":" not in n} for t, n in labels.items()),
        key=lambda c: c["name"].lower(),
    )
