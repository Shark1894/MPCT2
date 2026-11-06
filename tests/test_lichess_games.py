"""Lichess game import: username setting, recent games list, importing (fake Lichess API)."""

import urllib.error
import urllib.parse

import pytest

from app import lichess_api
from app.config import settings
from tests.conftest import count


def lgame(gid, white="JasonS", black="Opponent1", moves="e4 c6 d4 d5 e5 Bf5", winner="white", status="resign",
          variant="standard", created=1762444800000, rated=True, speed="rapid", clock=(600, 0), **extra):
    g = {
        "id": gid,
        "rated": rated,
        "variant": variant,
        "speed": speed,
        "perf": speed,
        "createdAt": created,
        "lastMoveAt": created + 600000,
        "status": status,
        "players": {
            "white": {"user": {"name": white, "id": white.lower()}, "rating": 1850},
            "black": {"user": {"name": black, "id": black.lower()}, "rating": 1790},
        },
        "moves": moves,
        "opening": {"eco": "B12", "name": "Caro-Kann Defense: Advance Variation", "ply": 5},
    }
    if winner:
        g["winner"] = winner
    if clock:
        g["clock"] = {"initial": clock[0], "increment": clock[1], "totalTime": clock[0] + 40 * clock[1]}
    g.update(extra)
    return g


GAMES = [
    lgame("game0003", white="Opponent2", black="JasonS", moves="d4 Nf6 c4 e6", winner=None, status="draw", created=1762531200000),
    lgame("game0002", variant="chess960", moves="e4 e5"),
    lgame("game0001"),
    lgame("game0000", status="aborted", winner=None, moves="e4"),
]


@pytest.fixture
def fake(client, monkeypatch):
    calls = []

    def get(path, params=None, ndjson=False, timeout=20):
        calls.append((path, params, ndjson))
        if path == "/api/games/user/nobody99":
            raise lichess_api.NotFound("no")
        if path.startswith("/api/games/user/"):
            assert ndjson
            return GAMES[: params["max"]]
        if path.startswith("/game/export/"):
            gid = path.rsplit("/", 1)[1]
            for g in GAMES + [lgame("fromposA", variant="fromPosition", initialFen="4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", moves="e4 Kd7")]:
                if g["id"] == gid:
                    return g
            raise lichess_api.NotFound("no")
        raise AssertionError(path)

    monkeypatch.setattr(lichess_api, "get", get)
    return calls


def set_user(client, name="JasonS"):
    r = client.put("/api/lichess/username", json={"username": name})
    assert r.status_code == 200, r.text
    return r


def test_username_setting(client, fake):
    assert client.get("/api/lichess/settings").json() == {"username": None}
    assert client.get("/api/lichess/games").status_code == 409  # no username yet
    assert client.put("/api/lichess/username", json={"username": "not a name!"}).status_code == 422
    set_user(client)
    assert client.get("/api/lichess/settings").json() == {"username": "JasonS"}
    assert client.put("/api/lichess/username", json={"username": ""}).json() == {"username": None}
    assert fake == []  # setting it asks Lichess nothing


def test_username_joins_your_names(client, fake):
    set_user(client)
    assert "JasonS" in client.get("/api/game-puzzles/status").json()["names"]  # automatic guess
    client.put("/api/game-puzzles/names", json={"names": ["Jason Sharkey"]})
    set_user(client, "JasonS2")
    assert client.get("/api/game-puzzles/status").json()["names"] == ["Jason Sharkey", "JasonS2"]


def test_recent_games(client, fake, db):
    set_user(client)
    r = client.get("/api/lichess/games?max=4")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["username"] == "JasonS"
    rows = {g["id"]: g for g in body["games"]}
    assert [g["id"] for g in body["games"]] == ["game0003", "game0002", "game0001", "game0000"]
    assert rows["game0003"]["my_color"] == "black" and rows["game0003"]["result"] == "1/2-1/2"
    assert rows["game0001"]["my_color"] == "white" and rows["game0001"]["result"] == "1-0"
    assert rows["game0001"]["clock"] == "10+0" and rows["game0001"]["speed"] == "Rapid" and rows["game0001"]["rated"]
    assert rows["game0001"]["white_rating"] == 1850 and rows["game0001"]["plies"] == 6
    assert rows["game0001"]["opening"].startswith("Caro-Kann")
    assert not rows["game0002"]["importable"] and rows["game0002"]["not_importable"] == "Chess960 games can't be imported"
    assert not rows["game0000"]["importable"]
    assert all(g["game_id"] is None for g in body["games"])
    path, params, _ = fake[-1]
    assert path == "/api/games/user/JasonS" and params["max"] == 4 and params["moves"] == "true"
    assert count(db, "games") == 0  # listing stores nothing


def test_unknown_user(client, fake):
    set_user(client, "nobody99")
    r = client.get("/api/lichess/games")
    assert r.status_code == 404 and "nobody99" in r.json()["detail"]


def test_import_one(client, fake, db):
    set_user(client)
    r = client.post("/api/lichess/games/game0001/import")
    assert r.status_code == 200, r.text
    first = r.json()
    assert first["created"]
    g = client.get(f"/api/games/{first['game_id']}").json()
    assert g["white"] == "JasonS" and g["black"] == "Opponent1" and g["result"] == "1-0"
    assert g["played_on"] == "2025-11-06"
    assert g["competition"] == "Lichess · Rapid 10+0 · rated"
    assert g["lichess_id"] == "game0001"
    assert [m["san"] for m in g["moves"]] == ["e4", "c6", "d4", "d5", "e5", "Bf5"]
    # again: the same copy, no second request
    n = len(fake)
    again = client.post("/api/lichess/games/game0001/import").json()
    assert again == {"game_id": first["game_id"], "created": False}
    assert len(fake) == n
    assert count(db, "games") == 1
    # the list marks it
    rows = {x["id"]: x for x in client.get("/api/lichess/games?max=4").json()["games"]}
    assert rows["game0001"]["game_id"] == first["game_id"]
    # listed in Games with its Lichess id
    assert client.get("/api/games").json()[0]["lichess_id"] == "game0001"


def test_import_errors(client, fake):
    set_user(client)
    assert client.post("/api/lichess/games/game0002/import").status_code == 422  # chess960
    assert client.post("/api/lichess/games/zzzzzzzz/import").status_code == 404
    assert client.post("/api/lichess/games/bad!/import").status_code == 404


def test_import_from_position(client, fake):
    r = client.post("/api/lichess/games/fromposA/import")
    assert r.status_code == 200, r.text
    g = client.get(f"/api/games/{r.json()['game_id']}").json()
    assert g["start_fen"].startswith("4k3/8/8/8/8/8/4P3/4K3 w")
    assert [m["san"] for m in g["moves"]] == ["e4", "Kd7"]


def test_links_a_game_already_imported_as_pgn(client, fake, db):
    pgn = '[White "JasonS"]\n[Black "Opponent1"]\n[Date "2025.11.06"]\n[Result "1-0"]\n\n1. e4 c6 2. d4 d5 3. e5 Bf5 1-0\n'
    assert client.post("/api/games/import-pgn", json={"pgn": pgn}).json()["imported"] == 1
    r = client.post("/api/lichess/games/game0001/import").json()
    assert r["created"] is False
    assert count(db, "games") == 1
    assert client.get(f"/api/games/{r['game_id']}").json()["lichess_id"] == "game0001"


def test_import_latest_and_new(client, fake, db):
    assert client.post("/api/lichess/latest").status_code == 409
    set_user(client)
    latest = client.post("/api/lichess/latest").json()
    assert latest["lichess_id"] == "game0003" and latest["created"]
    r = client.post("/api/lichess/import-new?max=4").json()
    assert r == {"imported": 1, "already": 1, "skipped": 2, "game_ids": [r["game_ids"][0]]}
    assert count(db, "games") == 2
    assert client.post("/api/lichess/import-new?max=4").json()["imported"] == 0


def test_http_client(monkeypatch):
    """The real client: token sent when set, retried without it if Lichess refuses it, errors mapped."""
    seen = []

    def fake_request(url, accept, token, timeout):
        seen.append((url, accept, token))
        if token == "bad":
            raise urllib.error.HTTPError(url, 401, "no", {}, None)
        if "missing" in url:
            raise urllib.error.HTTPError(url, 404, "no", {}, None)
        if "busy" in url:
            raise urllib.error.HTTPError(url, 429, "no", {}, None)
        return '{"id": "a"}\n{"id": "b"}\n' if accept == "application/x-ndjson" else '{"id": "a"}'

    monkeypatch.setattr(lichess_api, "_request", fake_request)
    monkeypatch.setattr(settings, "lichess_api_url", "https://lichess.example/")
    monkeypatch.setattr(settings, "lichess_token", "good")
    assert lichess_api.get("/api/games/user/x", {"max": 2}, ndjson=True) == [{"id": "a"}, {"id": "b"}]
    url, accept, token = seen[-1]
    assert urllib.parse.urlparse(url).netloc == "lichess.example" and "max=2" in url and token == "good"
    monkeypatch.setattr(settings, "lichess_token", "bad")
    assert lichess_api.get("/game/export/a") == {"id": "a"}
    assert [t for _, _, t in seen[-2:]] == ["bad", None]
    monkeypatch.setattr(settings, "lichess_token", None)
    with pytest.raises(lichess_api.NotFound):
        lichess_api.get("/missing")
    with pytest.raises(lichess_api.LichessError, match="limiting"):
        lichess_api.get("/busy")
