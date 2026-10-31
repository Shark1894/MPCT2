"""Spaced-repetition rules. Pure logic, no database.

A line's streak is how many times in a row it has been reviewed without a mistake.
Any mistake resets the streak to 0, which makes the line due again today.

Legacy note: the PyQt app looked the interval up with INTERVALS[count] inside a bare
try/except that fell back to 0 days, so after 7 correct reviews in a row a line became
due again *today*. Here the last interval is the cap.
"""

from datetime import date, timedelta

# streak (consecutive correct reviews) -> days until the next review
INTERVALS = (0, 1, 3, 7, 14, 30, 60)


def interval_days(streak: int) -> int:
    return INTERVALS[min(max(streak, 0), len(INTERVALS) - 1)]


def next_streak(previous_streak: int, correct: bool) -> int:
    return previous_streak + 1 if correct else 0


def next_review_on(streak: int, today: date | None = None) -> date:
    return (today or date.today()) + timedelta(days=interval_days(streak))


def user_plays_ply(ply: int, color: str) -> bool:
    """Ply 1 is White's first move."""
    return (ply % 2 == 1) == (color == "white")
