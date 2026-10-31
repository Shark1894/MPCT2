import chess
import pytest

from app.core.positions import START_KEY, InvalidLine, InvalidPosition, key_from_fen, position_key, walk_line
from app.core.repertoire import LinePlan, plan_line

# ---- position keys --------------------------------------------------------


def test_key_ignores_move_counters():
    a = key_from_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
    b = key_from_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 7 30")
    assert a == b
    assert a.count(" ") == 3  # placement, side, castling, en passant


def test_key_drops_en_passant_square_when_no_capture_is_possible():
    # Legacy bug: after 1.e4 the FEN has "e3" in the en passant field, so the old
    # split(" - ") key kept the full FEN. No black pawn can capture, so it must not matter.
    after_e4 = key_from_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")
    assert after_e4 == "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"


def test_transposition_reaches_same_key():
    via_d4_nf6 = walk_line(["d2d4", "g8f6", "c2c4", "e7e6"])[-1].key_after
    via_c4_e6 = walk_line(["c2c4", "e7e6", "d2d4", "g8f6"])[-1].key_after
    assert via_d4_nf6 == via_c4_e6


def test_key_keeps_en_passant_when_capture_is_legal():
    moves = walk_line(["e2e4", "a7a6", "e4e5", "d7d5"])
    assert moves[-1].key_after.endswith(" d6")


def test_invalid_fen():
    with pytest.raises(InvalidPosition):
        key_from_fen("rubbish")
    with pytest.raises(InvalidPosition):
        key_from_fen("8/8/8/8/8/8/8/8 w - - 0 1")  # no kings


def test_start_key():
    assert START_KEY == position_key(chess.Board())


# ---- walking lines ------------------------------------------------------


def test_walk_line_generates_san_and_chained_keys():
    moves = walk_line(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"])
    assert [m.san for m in moves] == ["e4", "e5", "Nf3", "Nc6", "Bb5"]
    assert [m.ply for m in moves] == [1, 2, 3, 4, 5]
    assert moves[0].key_before == START_KEY
    for a, b in zip(moves, moves[1:]):
        assert a.key_after == b.key_before


def test_walk_line_castling_san():
    moves = walk_line(["e2e4", "e7e5", "g1f3", "g8f6", "f1c4", "f8c5", "e1g1"])
    assert moves[-1].san == "O-O"


@pytest.mark.parametrize("ucis", [[], ["e2e5"], ["zz"], ["e2e4", "e2e4"]])
def test_walk_line_rejects_bad_input(ucis):
    with pytest.raises(InvalidLine):
        walk_line(ucis)


# ---- add-line rules -----------------------------------------------------

RUY = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]
ITALIAN = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]


def test_new_line_when_nothing_matches():
    assert plan_line(RUY, {}) == LinePlan("new")
    assert plan_line(ITALIAN, {1: RUY}) == LinePlan("new")


def test_prefix_of_existing_line_already_exists():
    assert plan_line(RUY[:3], {1: RUY}) == LinePlan("exists", 1, 5)
    assert plan_line(RUY, {1: RUY}) == LinePlan("exists", 1, 5)


def test_extension_of_existing_line():
    longer = RUY + ["a7a6"]
    assert plan_line(longer, {1: ITALIAN, 2: RUY}) == LinePlan("extend", 2, 5)


def test_extension_prefers_longest_matching_line():
    # Defensive: if stored lines were ever not a clean tree, extend the deepest match.
    assert plan_line(RUY + ["a7a6"], {1: RUY[:3], 2: RUY}) == LinePlan("extend", 2, 5)


def test_exists_wins_over_extend():
    assert plan_line(RUY, {1: RUY[:3], 2: RUY + ["a7a6"]}).kind == "exists"


def test_empty_line_rejected():
    with pytest.raises(ValueError):
        plan_line([], {1: RUY})


# ---- scheduling ---------------------------------------------------------

from datetime import date as _date  # noqa: E402

from app.core.scheduling import interval_days, next_review_on, next_streak, user_plays_ply  # noqa: E402


@pytest.mark.parametrize("streak,days", [(0, 0), (1, 1), (2, 3), (3, 7), (4, 14), (5, 30), (6, 60)])
def test_intervals_match_legacy_table(streak, days):
    assert interval_days(streak) == days


@pytest.mark.parametrize("streak", [7, 8, 50])
def test_long_streaks_cap_at_60_days(streak):
    # Regression: the legacy app fell back to 0 days (due again today) after 7 in a row.
    assert interval_days(streak) == 60


def test_streak_resets_on_mistake():
    assert next_streak(5, correct=True) == 6
    assert next_streak(5, correct=False) == 0


def test_next_review_date():
    assert next_review_on(0, _date(2026, 1, 31)) == _date(2026, 1, 31)
    assert next_review_on(3, _date(2026, 1, 31)) == _date(2026, 2, 7)


def test_user_plays_ply():
    assert [p for p in range(1, 7) if user_plays_ply(p, "white")] == [1, 3, 5]
    assert [p for p in range(1, 7) if user_plays_ply(p, "black")] == [2, 4, 6]
