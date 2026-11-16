"""scripts/practical_choices.py (sharpness prototype): win%, reply weighting and scoring, with a
fake engine and explorer (no Stockfish or Lichess needed)."""

import argparse
import importlib.util
import pathlib
import sys
from typing import ClassVar

import chess
import chess.engine
import pytest

spec = importlib.util.spec_from_file_location("practical", pathlib.Path(__file__).parents[1] / "scripts/practical_choices.py")
pc = importlib.util.module_from_spec(spec)
sys.modules["practical"] = pc
spec.loader.exec_module(pc)

ROOT = "e4 e5 Nf3"  # Black to move: "you" are Black


def cp(n):
    return chess.engine.PovScore(chess.engine.Cp(n), chess.WHITE)


class FakeEngine:
    """Scores (White's view) by the moves played after the root."""

    SCORES: ClassVar[dict] = {
        (): [("b8c6", 30), ("d7d6", 40)],  # your moves: Nc6 is best (+0.30 for White), d6 a bit worse
        ("b8c6",): [("f1b5", 30), ("d2d4", 25), ("f1c4", 20)],  # three fine replies
        ("d7d6",): [("d2d4", 40), ("f1c4", -150), ("b1c3", 35)],  # Bc4 is a mistake here
    }

    def __init__(self):
        self.calls = 0

    def _after_root(self, board):
        return tuple(m.uci() for m in board.move_stack[3:])

    def lines(self, board, multipv):
        return [(u, cp(v)) for u, v in self.SCORES[self._after_root(board)][:multipv]]

    def best_for(self, board, color):
        return pc.win_pct(cp(0), color)


class FakeExplorer:
    def __init__(self, data):
        self.data = data
        self.calls = 0

    def lookup(self, board):
        return self.data.get(tuple(m.uci() for m in board.move_stack[3:]))


def stats(w, d, b, moves=()):
    return {"white": w, "draws": d, "black": b, "moves": [
        {"uci": u, "san": "", "white": mw, "draws": md, "black": mb} for u, mw, md, mb in moves]}


def args(**kw):
    a = {"candidates": 8, "replies": 5, "cap": 15, "good": 7, "min_games": 30, "min_move_games": 10, "min_share": 0.02, "temperature": 6}
    return argparse.Namespace(**{**a, **kw})


def board():
    b = chess.Board()
    for u in pc.parse_root(ROOT):
        b.push_uci(u)
    return b


def test_win_pct():
    assert pc.win_pct(cp(0), chess.WHITE) == pytest.approx(50)
    assert pc.win_pct(cp(100), chess.WHITE) == pytest.approx(59.1, abs=0.1)
    assert pc.win_pct(cp(100), chess.BLACK) == pytest.approx(40.9, abs=0.1)
    mate = chess.engine.PovScore(chess.engine.Mate(3), chess.BLACK)
    assert (pc.win_pct(mate, chess.BLACK), pc.win_pct(mate, chess.WHITE)) == (100, 0)


def test_parse_root_and_positions():
    assert pc.parse_root("1.e4 d5 2.exd5 Nf6") == ["e2e4", "d7d5", "e4d5", "g8f6"]
    assert pc.parse_root("e2e4 e7e5") == ["e2e4", "e7e5"]
    lines = [pc.parse_root("e4 e5 Nf3 Nc6 Bb5 a6"), pc.parse_root("e4 e5 Nf3 Nc6 Bc4 Nf6"), pc.parse_root("d4 d5 c4 e6")]
    ps = pc.positions(lines, pc.parse_root(ROOT), chess.BLACK, 30)
    assert [(pc.movetext(sans), rep) for _, sans, rep in ps] == [
        ("1.e4 e5 2.Nf3", "b8c6"), ("1.e4 e5 2.Nf3 Nc6 3.Bb5", "a7a6"), ("1.e4 e5 2.Nf3 Nc6 3.Bc4", "g8f6")]


def test_practical_value_from_explorer_shares():
    exp = FakeExplorer({
        (): stats(500, 100, 400, [("b8c6", 300, 60, 240), ("d7d6", 100, 20, 80)]),
        ("b8c6",): stats(300, 60, 240, [("f1b5", 200, 40, 160), ("d2d4", 100, 20, 80)]),
        ("d7d6",): stats(100, 20, 80, [("f1c4", 70, 14, 56), ("d2d4", 30, 6, 24)]),  # 70% play the mistake
    })
    cands = pc.analyse_position(board(), chess.BLACK, "b8c6", FakeEngine(), exp, args())
    by = {c.san: c for c in cands}
    nc6, d6 = by["Nc6"], by["d6"]
    assert nc6.repertoire and nc6.source == "data" and nc6.wrong == 0 and nc6.good_replies == 3
    assert d6.cost == pytest.approx(pc.win_pct(cp(40), chess.WHITE) - pc.win_pct(cp(30), chess.WHITE))
    assert d6.good_replies == 2 and d6.wrong == pytest.approx(0.7)
    # practical = 70% x (Black after the mistake) + 30% x (Black after d4)
    expect = 0.7 * pc.win_pct(cp(-150), chess.BLACK) + 0.3 * pc.win_pct(cp(40), chess.BLACK)
    assert d6.practical == pytest.approx(expect)
    assert cands[0].san == "d6"  # sorted by practical value
    assert d6.actual == pytest.approx(100 * (80 + 10) / 200) and d6.actual_games == 200


def test_model_when_few_games():
    cands = pc.analyse_position(board(), chess.BLACK, None, FakeEngine(), FakeExplorer({}), args())
    d6 = next(c for c in cands if c.san == "d6")
    assert d6.source == "model" and sum(r.prob for r in d6.replies) == pytest.approx(1)
    assert max(d6.replies, key=lambda r: r.prob).san == "d4"  # the model favours the best reply
    assert not cands[0].actual_games


def test_cost_cap():
    cands = pc.analyse_position(board(), chess.BLACK, None, FakeEngine(), FakeExplorer({}), args(cap=0.5))
    assert [c.san for c in cands] == ["Nc6"]


def test_report_flags_the_weapon():
    exp = FakeExplorer({
        (): stats(500, 100, 400, [("b8c6", 300, 60, 240), ("d7d6", 100, 20, 80)]),
        ("b8c6",): stats(300, 60, 240, [("f1b5", 200, 40, 160), ("d2d4", 100, 20, 80)]),
        ("d7d6",): stats(100, 20, 80, [("f1c4", 70, 14, 56), ("d2d4", 30, 6, 24)]),
    })
    b = board()
    cands = pc.analyse_position(b, chess.BLACK, "b8c6", FakeEngine(), exp, args())
    a = args(margin=3, min_wrong=0.3, ratings="2000,2200,2500", speeds=None, depth=18)
    text = pc.report([(b, ["e4", "e5", "Nf3"], "b8c6", cands)], chess.BLACK, a)
    worth = text.split("## Positions")[0]
    assert "**1.e4 e5 2.Nf3 … d6**" in worth and "They go wrong 70%" in worth and "only d4 or Nc3 holds" in worth
