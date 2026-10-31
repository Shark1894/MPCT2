"""Rules for adding a line to an opening. Pure logic, no database.

A line is a full sequence of moves from the initial position. Lines in an opening
form a tree: no stored line is a prefix of another.

When a new move sequence is saved:
  - it is already covered if it equals, or is a prefix of, a stored line  -> "exists"
  - a stored line that is a prefix of it is lengthened in place           -> "extend"
  - otherwise it becomes a new line                                        -> "new"
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class LinePlan:
    kind: Literal["new", "extend", "exists"]
    line_id: int | None = None
    existing_length: int = 0  # moves already stored in the matched line


def plan_line(new: Sequence[str], existing: Mapping[int, Sequence[str]]) -> LinePlan:
    """Decide how to store `new` (UCI moves) given existing lines {line_id: [uci, ...]}."""
    if not new:
        raise ValueError("A line needs at least one move")
    new = list(new)
    extend: tuple[int, int] | None = None
    for line_id, moves in existing.items():
        moves = list(moves)
        n = len(moves)
        if n >= len(new) and moves[: len(new)] == new:
            return LinePlan("exists", line_id, n)
        if 0 < n < len(new) and new[:n] == moves and (extend is None or n > extend[1]):
            extend = (line_id, n)
    if extend:
        return LinePlan("extend", extend[0], extend[1])
    return LinePlan("new")
