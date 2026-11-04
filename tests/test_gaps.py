"""Repertoire gap finder: looking positions up (fake Lichess explorer), caching, and which
masters replies count as gaps."""

import urllib.parse

import chess
import pytest

from app import explorer
from app.config import settings

CARO_ADV = ["e2e4", "c7c6", "d2d4", "d7d5", "e4e5", "c8f5"]
CARO_CLASSIC = ["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4"]
CARO_EXCH = ["e2e4", "c7c6", "d2d4", "d7d5", "e4d5", "c6d5"]


def key(ucis):
    b = chess.Board()
    for u in ucis:
        b.push_uci(u)
    return b.epd()


def mv(san, games, uci="a1a1"):
    w = games // 2
    return {"uci": uci, "san": san, "white": w, "draws": games - w, "black": 0, "averageRating": 2400}


# What the fake explorer knows (masters games per reply).
DATA = {
    key([]): [mv("e4", 500), mv("d4", 400), mv("Nf3", 100)],
    key(["e2e4", "c7c6"]): [mv("d4", 800), mv("Nc3", 100), mv("Nf3", 60), mv("c4", 40)],
    key(["e2e4", "c7c6", "d2d4", "d7d5"]): [
        mv("e5", 400),
        mv("Nc3", 300),
        mv("exd5", 200),
        mv("Nd2", 80),
        mv("f3", 17),
        mv("O-O", 3),  # not legal here: ignored
    ],
}


def fake_get(calls=None, fail=()):
    def get(url):
        fen = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["fen"][0]
        k = " ".join(fen.split()[:4])
        if calls is not None:
            calls.append(k)
        if k in fail:
            raise explorer.ExplorerError("boom")
        moves = DATA.get(k, [])
        return {"white": sum(m["white"] for m in moves), "draws": sum(m["draws"] for m in moves), "black": 0, "moves": moves}

    return get


@pytest.fixture
def setup(client, monkeypatch):
    monkeypatch.setattr(settings, "lichess_token", "lip_test")
    rep = client.post("/api/repertoires", json={"name": "Main"}).json()
    caro = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Caro", "color": "black"}).json()
    exch = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Caro Exchange", "color": "black"}).json()
    for m in (CARO_ADV, CARO_CLASSIC):
        client.post(f"/api/openings/{caro['id']}/lines", json={"moves": m})
    client.post(f"/api/openings/{exch['id']}/lines", json={"moves": CARO_EXCH})
    return rep, caro, exch


def gaps(client, opening_id, **params):
    r = client.get(f"/api/openings/{opening_id}/gaps", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_nothing_checked_yet(client, setup):
    _, caro, _ = setup
    g = gaps(client, caro["id"])
    assert (g["positions"], g["checked"], g["gaps"]) == (3, 0, [])  # start, after 1...c6, after 2...d5


def test_check_then_gaps(client, setup):
    _, caro, _ = setup
    calls = []
    assert explorer.check_opening(caro["id"], get=fake_get(calls), pause=0)
    assert len(calls) == 3 and explorer.status()["done"] == 3 and explorer.status()["error"] is None
    g = gaps(client, caro["id"])
    assert g["checked"] == 3
    found = [(x["path"], x["san"], x["share"], x["meet"]) for x in g["gaps"]]
    # 3.exd5 is covered by the other Black opening; f3 is under 5%; 1.d4 at the start isn't a gap
    assert found == [
        (["e4", "c6"], "Nc3", 10.0, 5.0),  # reach 50% (1.e4) x 10%
        (["e4", "c6", "d4", "d5"], "Nd2", 8.0, 3.2),  # reach 50% x 80% x 8%
        (["e4", "c6"], "Nf3", 6.0, 3.0),
    ]
    nd2 = g["gaps"][1]
    assert nd2["uci"] == "b1d2" and nd2["reach"] == 40.0 and nd2["games"] == 80 and nd2["position_games"] == 1000
    assert nd2["covered"] == ["Nc3", "e5", "exd5"]
    assert nd2["fen"].split()[1] == "w" and nd2["fen"].endswith(" 3")
    # lower threshold brings in f3 (17 games, 1.7%) but not O-O (illegal)
    sans = [x["san"] for x in gaps(client, caro["id"], min_share=1)["gaps"]]
    assert "f3" in sans and "c4" in sans and "O-O" not in sans
    assert "f3" not in [x["san"] for x in gaps(client, caro["id"], min_share=1, min_games=20)["gaps"]]


def test_cached_positions_arent_asked_again(client, setup):
    _, caro, _ = setup
    explorer.check_opening(caro["id"], get=fake_get(), pause=0)
    calls = []
    explorer.check_opening(caro["id"], get=fake_get(calls), pause=0)
    assert calls == [] and explorer.status()["total"] == 0
    # a new line adds a position to look up
    client.post(f"/api/openings/{caro['id']}/lines", json={"moves": CARO_CLASSIC + ["c3e4", "c8f5"]})
    explorer.check_opening(caro["id"], get=fake_get(calls), pause=0)
    assert calls == [key(CARO_CLASSIC)]


def test_failures_keep_what_was_fetched(client, setup):
    _, caro, _ = setup
    explorer.check_opening(caro["id"], get=fake_get(fail={key(["e2e4", "c7c6"])}), pause=0)
    st = explorer.status()
    assert (st["done"], st["total"], st["error"]) == (2, 3, "boom")
    assert gaps(client, caro["id"])["checked"] == 2
    # Nd2 still found; its reach is unknown (the position before it wasn't looked up)
    g = gaps(client, caro["id"])["gaps"]
    assert [(x["san"], x["meet"]) for x in g] == [("Nd2", None)]
    explorer.check_opening(caro["id"], get=fake_get(), pause=0)  # the next check fills the hole
    assert gaps(client, caro["id"])["checked"] == 3 and explorer.status()["error"] is None


def test_rejected_token_stops(client, setup):
    _, caro, _ = setup

    def reject(url):
        raise explorer.TokenRejected("Lichess refused the API token")

    explorer.check_opening(caro["id"], get=reject, pause=0)
    st = explorer.status()
    assert st["done"] == 0 and "refused" in st["error"]


def test_check_endpoint(client, setup, monkeypatch):
    _, caro, _ = setup
    started = []
    monkeypatch.setattr(explorer, "start_check", lambda oid: started.append(oid) or True)
    r = client.post(f"/api/openings/{caro['id']}/gaps/check")
    assert r.status_code == 202 and started == [caro["id"]] and r.json()["token"] is True
    monkeypatch.setattr(settings, "lichess_token", None)
    r = client.post(f"/api/openings/{caro['id']}/gaps/check")
    assert r.status_code == 409 and "LICHESS_TOKEN" in r.json()["detail"]
    assert client.get("/api/explorer/status").json()["token"] is False
    assert client.post("/api/openings/999/gaps/check").status_code == 404


def test_masters_url_and_auth_header(monkeypatch):
    monkeypatch.setattr(settings, "lichess_token", " lip_abc ")
    url = explorer.masters_url(key(["e2e4"]))
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert url.startswith("https://explorer.lichess.org/masters?")
    assert q["fen"] == ["rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"] and q["moves"] == ["20"]
    seen = {}

    class Res:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"white": 1, "draws": 0, "black": 0, "moves": []}'

    def fake_urlopen(req, timeout):
        seen.update(req.headers)
        return Res()

    monkeypatch.setattr(explorer.urllib.request, "urlopen", fake_urlopen)
    assert explorer.http_get(url)["white"] == 1
    assert seen["Authorization"] == "Bearer lip_abc" and seen["User-agent"].startswith("MPCT/")
