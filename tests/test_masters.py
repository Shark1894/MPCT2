"""Masters panel: masters moves and top games for any position (fake Lichess explorer),
sharing the gap finder's cache, and opening / saving masters games."""

import urllib.parse

import chess
import pytest

from app import explorer
from app.config import settings
from tests.conftest import count

START = chess.STARTING_FEN
AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
E4_KEY = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"

ANSWER = {
    "white": 60,
    "draws": 30,
    "black": 10,
    "moves": [
        {"uci": "c7c5", "san": "c5", "white": 30, "draws": 15, "black": 5, "averageRating": 2550},
        {"uci": "e7e5", "san": "e5", "white": 30, "draws": 15, "black": 5, "averageRating": 2540},
    ],
    "topGames": [
        {"id": "abcd1234", "white": {"name": "Kasparov, G.", "rating": 2851}, "black": {"name": "Karpov, A.", "rating": 2780},
         "winner": "white", "year": 1990, "month": "1990-10", "uci": "c7c5"},
        {"id": "wxyz9876", "white": {"name": "Carlsen, M.", "rating": 2863}, "black": {"name": "Caruana, F.", "rating": 2832},
         "winner": None, "year": 2018, "month": "2018-11", "uci": "e7e5"},
    ],
}

PGN = """[Event "World Championship"]
[Site "Lyon FRA"]
[Date "1990.??.??"]
[Round "13"]
[White "Kasparov, G."]
[Black "Karpov, A."]
[Result "1-0"]
[WhiteElo "2800"]
[BlackElo "2730"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 1-0
"""


@pytest.fixture
def lichess(client, monkeypatch):
    """Fake explorer: records requests, answers the masters lookup and the PGN."""
    monkeypatch.setattr(settings, "lichess_token", "lip_test")
    calls = []

    def get(url, timeout=30, wait=True, text=False):
        calls.append((url, wait, text))
        u = urllib.parse.urlparse(url)
        if u.path.startswith("/masters/pgn/"):
            if u.path.endswith("/missing0"):
                raise explorer.NotFound("no")
            return PGN
        return ANSWER

    monkeypatch.setattr(explorer, "http_get", get)
    return calls


def test_lookup_moves_and_games(client, lichess):
    r = client.get("/api/masters", params={"fen": AFTER_E4})
    assert r.status_code == 200
    d = r.json()
    assert d["key"] == E4_KEY and d["total"] == 100
    assert [m["san"] for m in d["moves"]] == ["c5", "e5"] and d["moves"][0]["games"] == 50 and d["moves"][0]["average_rating"] == 2550
    g = d["games"][0]
    assert g == {"id": "abcd1234", "white": "Kasparov, G.", "white_elo": 2851, "black": "Karpov, A.", "black_elo": 2780,
                 "result": "1-0", "year": 1990, "month": "1990-10", "uci": "c7c5"}
    assert d["games"][1]["result"] == "1/2-1/2"
    url, wait, _ = lichess[0]
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert q["topGames"] == ["15"] and not wait  # someone is waiting: no minute-long 429 retry


def test_lookup_is_cached(client, lichess, db):
    client.get("/api/masters", params={"fen": AFTER_E4})
    client.get("/api/masters", params={"fen": E4_KEY})  # move counters optional
    assert len(lichess) == 1 and count(db, "explorer_cache") == 1


def test_gap_finder_cache_without_games_is_looked_up_again(client, lichess, db):
    from sqlalchemy.orm import Session

    from app.repositories import gaps

    with Session(db) as s, s.begin():
        gaps.store(s, E4_KEY, {"white": 1, "draws": 0, "black": 0, "moves": []})  # cached before v0.27.0
    d = client.get("/api/masters", params={"fen": AFTER_E4}).json()
    assert len(lichess) == 1 and len(d["games"]) == 2
    # and the gap finder still reads the refreshed entry
    with Session(db) as s:
        assert gaps.cached(s, [E4_KEY])[E4_KEY]["white"] == 60


def test_no_token_and_bad_fen(client, monkeypatch):
    monkeypatch.setattr(settings, "lichess_token", None)
    r = client.get("/api/masters", params={"fen": AFTER_E4})
    assert r.status_code == 409 and "LICHESS_TOKEN" in r.json()["detail"]
    assert client.get("/api/masters", params={"fen": "not a fen at all"}).status_code == 422


def test_explorer_error_is_502(client, monkeypatch):
    monkeypatch.setattr(settings, "lichess_token", "lip_test")

    def get(url, **kw):
        raise explorer.ExplorerError("Lichess is limiting requests right now; try again in a minute")

    monkeypatch.setattr(explorer, "http_get", get)
    r = client.get("/api/masters", params={"fen": AFTER_E4})
    assert r.status_code == 502 and "limiting" in r.json()["detail"]


def test_open_game_fetches_once(client, lichess, db):
    r = client.get("/api/masters/games/abcd1234")
    assert r.status_code == 200
    g = r.json()
    assert g["white"] == "Kasparov, G." and g["black_elo"] == 2730 and g["event"] == "World Championship" and g["round"] == "13"
    assert g["year"] == 1990 and g["month"] is None and g["played_on"] is None and g["result"] == "1-0"
    assert g["moves"][:2] == ["e2e4", "c7c5"] and g["plies"] == 8 and g["source"] == "masters"
    assert lichess[-1][0].endswith("/masters/pgn/abcd1234") and lichess[-1][2]  # text
    client.get("/api/masters/games/abcd1234")
    assert len(lichess) == 1 and count(db, "masters_games") == 1
    pgn = client.get("/api/masters/games/abcd1234/pgn")
    assert pgn.status_code == 200 and pgn.text.startswith('[Event "World Championship"]') and "Kasparov-Karpov-1990.pgn" in pgn.headers["content-disposition"]


def test_unknown_or_bad_game_id(client, lichess):
    assert client.get("/api/masters/games/missing0").status_code == 404
    assert client.get("/api/masters/games/bad!id").status_code == 404
    assert client.get("/api/masters/games/nope1234/pgn").status_code == 404
    assert client.post("/api/masters/games/nope1234/save").status_code == 404


def test_save_to_games_once(client, lichess, db):
    client.get("/api/masters/games/abcd1234")
    r = client.post("/api/masters/games/abcd1234/save").json()
    assert r["created"] is True
    game = client.get(f"/api/games/{r['game_id']}").json()
    assert game["white"] == "Kasparov, G." and game["competition"] == "World Championship" and len(game["moves"]) == 8
    again = client.post("/api/masters/games/abcd1234/save").json()
    assert again == {"game_id": r["game_id"], "created": False} and count(db, "games") == 1
