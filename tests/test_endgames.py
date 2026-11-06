"""Endgame drills: tablebase lookups (with a fake tablebase), K+P v K positions, attempts, stats."""

import random

import chess
import pytest

from app import tablebase
from app.core import endgames
from app.core.endgames import generate_kp, kp_candidate, tricky_win

KBN = "8/8/3k4/8/8/2N5/1B6/4K3 w - - 0 1"


def tb_answer(category="win", moves=None, dtm=55):
    return {"category": category, "dtz": 10, "dtm": dtm, "checkmate": False, "stalemate": False,
            "moves": moves or [{"uci": "e1d2", "san": "Kd2", "category": "loss", "dtz": -9, "dtm": -54}], "extra": "dropped"}


@pytest.fixture(autouse=True)
def clean_cache():
    tablebase.clear_cache()
    yield
    tablebase.clear_cache()


def test_lookup_slims_caches_and_checks():
    calls = []

    def fetch(fen):
        calls.append(fen)
        return tb_answer()

    info = tablebase.lookup(KBN.replace(" ", " "), fetch)
    assert info["category"] == "win" and info["dtm"] == 55 and "extra" not in info
    assert info["moves"][0]["uci"] == "e1d2" and set(info["moves"][0]) == set(tablebase.MOVE_KEYS)
    tablebase.lookup(KBN, fetch)
    assert len(calls) == 1  # cached
    with pytest.raises(tablebase.NotInTablebase):
        tablebase.lookup(chess.STARTING_FEN, fetch)  # 32 pieces
    with pytest.raises(tablebase.NotInTablebase):
        tablebase.lookup("8/8/8/8/8/8/8/K6k w - - 0 1 x", fetch)


def test_kp_candidates_are_legal_and_realistic():
    rng = random.Random(1)
    seen = 0
    for _ in range(300):
        color = rng.choice((chess.WHITE, chess.BLACK))
        b = kp_candidate(rng, color)
        if b is None:
            continue
        seen += 1
        assert b.is_valid() and not b.is_check() and b.turn == color
        pawns = list(b.pieces(chess.PAWN, color))
        assert len(pawns) == 1 and len(b.piece_map()) == 3
        assert chess.square_distance(b.king(color), pawns[0]) <= 2
    assert seen > 200


def test_tricky_win_filter():
    win1 = tb_answer(moves=[{"category": "loss"}, {"category": "draw"}, {"category": "draw"}, {"category": "draw"}])
    assert tricky_win(win1) == 1
    easy = tb_answer(moves=[{"category": "loss"}] * 3 + [{"category": "draw"}])
    assert tricky_win(easy) is None  # three winning moves: too easy
    assert tricky_win(tb_answer("draw", win1["moves"])) is None
    assert tricky_win(tb_answer(moves=[{"category": "loss"}, {"category": "draw"}])) is None  # too few moves


def test_generate_kp_keeps_trying():
    answers = iter([tb_answer("draw"), tb_answer(moves=[{"category": "loss"}] * 5)] + [tb_answer(moves=[{"category": "loss"}] + [{"category": "draw"}] * 4)] * 50)
    found = generate_kp(lambda fen: next(answers), random.Random(5))
    assert found and found["winning_moves"] == 1 and found["tries"] >= 3 and chess.Board(found["fen"]).is_valid()
    assert generate_kp(lambda fen: tb_answer("draw"), random.Random(5), tries=10) is None


def test_api_tablebase_and_kp(client, monkeypatch):
    monkeypatch.setattr(tablebase, "_fetch", lambda fen: tb_answer(moves=[{"uci": "a", "category": "loss"}] + [{"uci": "b", "category": "draw"}] * 4))
    r = client.get("/api/tablebase", params={"fen": KBN})
    assert r.status_code == 200 and r.json()["dtm"] == 55
    assert client.get("/api/tablebase", params={"fen": chess.STARTING_FEN}).status_code == 422
    kp = client.get("/api/endgames/kp").json()
    assert kp["winning_moves"] == 1 and kp["color"] in ("white", "black")

    def down(fen):
        raise tablebase.TablebaseUnavailable("The tablebase can't be reached (offline)")

    tablebase.clear_cache()
    monkeypatch.setattr(tablebase, "_fetch", down)
    r = client.get("/api/tablebase", params={"fen": KBN})
    assert r.status_code == 503 and "can't be reached" in r.json()["detail"]
    assert client.get("/api/endgames/kp").status_code == 503


def test_attempts_and_stats(client, db):
    def post(**kw):
        body = {"drill": "kbn", "start_fen": KBN, "color": "white", "result": "mate", "moves": 30, "optimal": 27, "hints": 0, "seconds": 120, **kw}
        r = client.post("/api/endgames/attempts", json=body)
        assert r.status_code == 200, r.text
        return r.json()

    assert post()["success"] is True
    post(moves=40, optimal=33, seconds=200)
    assert post(result="fifty", moves=50, optimal=30)["success"] is False
    post(drill="kq", moves=9, optimal=7, seconds=20)
    st = client.get("/api/endgames/stats").json()
    assert set(st) == set(endgames.DRILLS)
    kbn = st["kbn"]
    assert (kbn["attempts"], kbn["successes"], kbn["best_moves"], kbn["avg_moves"], kbn["avg_optimal"]) == (3, 2, 30, 35.0, 30.0)
    assert [a["result"] for a in kbn["recent"]] == ["fifty", "mate", "mate"]
    assert st["kp"]["attempts"] == 0 and st["kp"]["recent"] == []
    assert client.post("/api/endgames/attempts", json={"drill": "krr", "start_fen": KBN, "color": "white", "result": "mate", "moves": 1, "seconds": 1}).status_code == 422
