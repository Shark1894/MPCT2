"""Practical tab: your-move positions (whole opening or a branch), the Lichess explorer at 2000+
(fake, cached, needs the token), and the engine-lines cache."""

import urllib.parse

import chess
import pytest

from app import explorer
from app.config import settings
from app.repositories import practical as repo
from tests.conftest import count


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
    assert (whole["opening"], whole["color"], whole["ratings"]) == ("Scandinavian (Modern)", "black", "2000,2200,2500")
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


def test_explorer_cached_and_paced(client, db, monkeypatch):
    monkeypatch.setattr(settings, "lichess_token", "lip_test")
    monkeypatch.setattr(repo, "PAUSE_S", 0)
    asked = []

    def get(url, **kw):
        asked.append(urllib.parse.parse_qs(urllib.parse.urlparse(url).query))
        assert urllib.parse.urlparse(url).path.endswith("/lichess")
        return {"white": 50, "draws": 20, "black": 30, "topGames": [],
                "moves": [{"uci": "d7d5", "san": "d5", "white": 30, "draws": 10, "black": 20, "averageRating": 2150}]}

    monkeypatch.setattr(explorer, "http_get", get)
    fen = fen_after("e4")
    r = client.get("/api/practical/explorer", params={"fen": fen})
    assert r.status_code == 200, r.text
    assert r.json()["moves"] == [{"uci": "d7d5", "san": "d5", "white": 30, "draws": 10, "black": 20}]
    assert asked[0]["ratings"] == ["2000,2200,2500"] and asked[0]["fen"][0].endswith(" 0 1")
    client.get("/api/practical/explorer", params={"fen": fen})
    assert len(asked) == 1 and count(db, "explorer_cache") == 1  # cached

    monkeypatch.setattr(settings, "lichess_token", None)
    assert client.get("/api/practical/explorer", params={"fen": fen_after("d4")}).status_code == 409
    assert client.get("/api/practical/explorer", params={"fen": fen}).status_code == 200  # cached needs no token

    def broken(url, **kw):
        raise explorer.ExplorerError("Lichess is limiting requests right now; try again in a minute")

    monkeypatch.setattr(settings, "lichess_token", "lip_test")
    monkeypatch.setattr(explorer, "http_get", broken)
    r = client.get("/api/practical/explorer", params={"fen": fen_after("c4")})
    assert r.status_code == 502 and "limiting" in r.json()["detail"]


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
