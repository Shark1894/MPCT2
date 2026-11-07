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


# ---- named endgames --------------------------------------------------------------------------------

MATERIAL = {  # (yours, theirs) without kings, as sorted piece letters
    "lucena": ("PR", "R"), "philidor": ("R", "PR"), "vancura": ("R", "PR"), "qvp": ("Q", "P"),
    "qvr": ("Q", "R"), "rvb": ("B", "R"), "wrongb": ("", "BP"), "reti": ("P", "P"),
}


def ok_answer(drill):
    """A stand-in tablebase answer that passes the drill's check."""
    if drill in endgames.DEFEND:
        return tb_answer("draw", moves=[{"category": "draw"}, {"category": "win"}, {"category": "win"}])
    return tb_answer("win", moves=[{"category": "loss", "san": "Kd2"}, {"category": "draw", "san": "Ke2"}])


def side_material(board, colour):
    return "".join(sorted(p.symbol().upper() for p in board.piece_map().values() if p.color == colour and p.piece_type != chess.KING))


@pytest.mark.parametrize("drill", list(MATERIAL))
def test_named_endgame_templates(drill):
    rng = random.Random(11)
    seen = set()
    for _ in range(40):
        found = endgames.generate(drill, lambda fen: ok_answer(drill), rng)
        assert found, drill
        b = chess.Board(found["fen"])
        you = chess.WHITE if found["color"] == "white" else chess.BLACK
        assert b.is_valid() and not b.is_check() and b.turn == you
        assert (side_material(b, you), side_material(b, not you)) == MATERIAL[drill], found["fen"]
        seen.add(found["fen"])
    assert len(seen) >= (4 if drill == "reti" else 20), f"{drill}: {len(seen)} different"  # Réti: the study and its mirrors


def test_named_endgame_patterns():
    rng = random.Random(3)
    for _ in range(50):
        b = endgames._lucena(rng)
        if b is None:
            continue
        pawn = next(iter(b.pieces(chess.PAWN, chess.WHITE)))
        assert chess.square_rank(pawn) == 6 and b.king(chess.WHITE) == pawn + 8  # king on the queening square
        assert abs(chess.square_file(b.king(chess.BLACK)) - chess.square_file(pawn)) == 2  # cut off
    for _ in range(50):
        b = endgames._wrongb(rng)
        if b is None:
            continue
        pawn = next(iter(b.pieces(chess.PAWN, chess.BLACK)))
        corner = chess.square(chess.square_file(pawn), 0)
        bishop = next(iter(b.pieces(chess.BISHOP, chess.BLACK)))
        light = lambda s: bool(chess.BB_LIGHT_SQUARES & chess.BB_SQUARES[s])  # noqa: E731
        assert chess.square_file(pawn) in (0, 7) and light(bishop) != light(corner)  # the wrong bishop


def test_good_start_rules():
    assert endgames.good_start("philidor", tb_answer("draw", moves=[{"category": "win"}, {"category": "win"}, {"category": "draw"}]))
    assert not endgames.good_start("philidor", tb_answer("draw", moves=[{"category": "draw"}] * 3))  # nothing to get wrong
    assert not endgames.good_start("philidor", tb_answer("loss", moves=[{"category": "win"}] * 3))  # already lost
    assert endgames.good_start("lucena", tb_answer("win", moves=[{"category": "loss"}, {"category": "draw"}]))
    assert not endgames.good_start("lucena", tb_answer("win", moves=[{"category": "loss"}] * 4))  # every move wins
    assert not endgames.good_start("qvr", tb_answer("win", moves=[{"category": "loss", "san": "Qxd7+"}, {"category": "draw"}]))


def test_api_positions(client, monkeypatch):
    monkeypatch.setattr(tablebase, "_fetch", lambda fen: ok_answer("lucena"))
    r = client.get("/api/endgames/position/lucena")
    assert r.status_code == 200 and r.json()["color"] in ("white", "black")
    assert client.get("/api/endgames/position/kq").status_code == 404  # made in the browser
    tablebase.clear_cache()
    monkeypatch.setattr(tablebase, "_fetch", lambda fen: tb_answer("draw", moves=[{"category": "draw"}] * 3))
    assert client.get("/api/endgames/position/lucena").status_code == 503  # nothing suitable
    for result in ("held", "captured"):
        assert client.post("/api/endgames/attempts", json={"drill": "philidor", "start_fen": KBN, "color": "black", "result": result, "moves": 15, "seconds": 60}).json()["success"]
    assert not client.post("/api/endgames/attempts", json={"drill": "philidor", "start_fen": KBN, "color": "black", "result": "lost", "moves": 3, "seconds": 9}).json()["success"]
