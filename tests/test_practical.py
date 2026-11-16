"""Practical tab: your-move positions (whole opening or a branch) and the engine-lines cache."""

import chess
import pytest



def ucis(text):
    b, out = chess.Board(), []
    for san in text.split():
        m = b.parse_san(san)
        out.append(m.uci())
        b.push(m)
    return out


WUSS = "e4 d5 exd5 Nf6 d4 Bg4 Be2 Bxe2"
LINES = [
    WUSS + " Qxe2 Qxd5 Nf3 Nc6 O-O O-O-O",
    WUSS + " Qxe2 Qxd5 Nf3 Nc6 c4 Qf5",
    WUSS + " Nxe2 Qxd5 O-O Nc6",
    "e4 d5 exd5 Nf6 c4 c6",  # another branch
]


def fen_after(text):
    b = chess.Board()
    for san in text.split():
        b.push_san(san)
    return b.fen()


@pytest.fixture
def scandi(client):
    rep = client.post("/api/repertoires", json={"name": "Main"}).json()
    o = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Scandinavian (Modern)", "color": "black"}).json()
    for line in LINES:
        assert client.post(f"/api/openings/{o['id']}/lines", json={"moves": ucis(line)}).status_code in (200, 201)
    t = client.post(f"/api/openings/{o['id']}/tags", json={"name": "Wuss", "fen": fen_after("e4 d5 exd5 Nf6 d4 Bg4 Be2")}).json()
    return o, t


def test_positions_whole_opening_and_branch(client, scandi):
    o, t = scandi
    whole = client.get("/api/practical/positions", params={"opening_id": o["id"]}).json()
    assert (whole["opening"], whole["color"]) == ("Scandinavian (Modern)", "black")
    first = whole["positions"][0]
    assert (first["sans"], first["repertoire"]) == (["e4"], ["d7d5"])
    after_c4 = next(p for p in whole["positions"] if p["sans"] == "e4 d5 exd5 Nf6 c4".split())
    assert after_c4["repertoire"] == ["c7c6"]

    wuss = client.get("/api/practical/positions", params={"opening_id": o["id"], "tag_id": t["id"]}).json()
    got = [(" ".join(p["sans"]), p["repertoire"]) for p in wuss["positions"]]
    assert got == [
        (WUSS[: -len(" Bxe2")], ["g4e2"]),  # the tag's position itself: Black to move
        (WUSS + " Qxe2", ["d8d5"]),
        (WUSS + " Nxe2", ["d8d5"]),
        (WUSS + " Qxe2 Qxd5 Nf3", ["b8c6"]),
        (WUSS + " Nxe2 Qxd5 O-O", ["b8c6"]),
        (WUSS + " Qxe2 Qxd5 Nf3 Nc6 O-O", ["e8c8"]),
        (WUSS + " Qxe2 Qxd5 Nf3 Nc6 c4", ["d5f5"]),
    ]
    assert wuss["positions"][1]["fen"] == fen_after(WUSS + " Qxe2")
    assert client.get("/api/practical/positions", params={"opening_id": 999999}).status_code == 404


def line(uci, cp):
    return {"uci": uci, "score": {"cp": cp}, "pv": [uci]}


def test_evals_cache(client):
    fen = fen_after("e4")
    save = lambda multipv, ms, lines: client.post("/api/practical/evals", json={"evals": [
        {"fen": fen, "multipv": multipv, "movetime_ms": ms, "depth": 14, "engine": "sf", "lines": lines}]}).json()["saved"]
    look = lambda multipv, ms: client.post("/api/practical/evals/lookup", json={"fens": [fen, fen_after("d4")], "multipv": multipv, "movetime_ms": ms}).json()["evals"]

    assert look(1, 0) == [None, None]
    assert save(5, 800, [line("d7d5", -30), line("e7e5", -35)]) == 1
    hit = look(3, 500)[0]
    assert (hit["multipv"], hit["movetime_ms"], len(hit["lines"])) == (5, 800, 2)
    assert look(8, 500)[0] is None and look(5, 1000)[0] is None  # not enough lines / time
    assert save(1, 800, [line("d7d5", -30)]) == 0  # fewer lines: the saved one stays
    assert save(8, 800, [line("c7c5", -25)]) == 1
    assert look(8, 800)[0]["lines"][0]["uci"] == "c7c5"
    r = client.post("/api/practical/evals", json={"evals": [{"fen": "nonsense", "multipv": 1, "movetime_ms": 100, "depth": 1, "engine": "x", "lines": []}]})
    assert r.status_code == 422
