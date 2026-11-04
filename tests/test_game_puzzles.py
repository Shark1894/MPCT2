"""Puzzles from your own games: names, scan list, storing scans, spaced repetition."""

from datetime import date, timedelta

import pytest

TODAY = date.today()
# Scholar's mate trap: Black (you) blunders 3...Nf6?? (ply 6); 3...g6 holds.
SCHOLAR = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]
# A longer game where you're White: 5.Bxf7+?? (ply 9) throws a piece away (a made-up mistake).
ITALIAN = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "g8f6", "c4f7"]


def game(client, white, black, moves, played_on=None, competition="League"):
    body = {"white": white, "black": black, "white_team": "", "black_team": "", "competition": competition,
            "played_on": str(played_on or TODAY), "result": "*", "moves": moves}
    res = client.post("/api/games", json=body)
    assert res.status_code == 201, res.text
    return res.json()["id"]


@pytest.fixture
def games(client):
    g1 = game(client, "Peter Swan", "Jason Sharkey", SCHOLAR, TODAY - timedelta(days=3))
    g2 = game(client, "Jason Sharkey", "Ally McLellan", ITALIAN, TODAY - timedelta(days=1))
    g3 = game(client, "Club, A", "Club, B", ITALIAN)  # not yours
    g4 = game(client, "Jason Sharkey", "Short, Game", ["e2e4", "e7e5"])  # too short
    return g1, g2, g3, g4


def scan_of(client, gid):
    return next(g for g in client.get("/api/game-puzzles/status").json()["to_scan"] if g["id"] == gid)


def send(client, gid, candidates, movetime=1000):
    g = scan_of(client, gid)
    return client.post("/api/game-puzzles/scans", json={"game_id": gid, "moves_hash": g["moves_hash"], "movetime_ms": movetime, "candidates": candidates})


def test_names_are_worked_out_and_can_be_set(client, games):
    g1, g2, g3, g4 = games
    st = client.get("/api/game-puzzles/status").json()
    assert st["names"] == ["Jason Sharkey", "You"] and st["names_set"] is False
    todo = {g["id"]: g for g in st["to_scan"]}
    assert set(todo) == {g1, g2}  # short game and other people's game left out
    assert todo[g1]["color"] == "black" and todo[g2]["color"] == "white"
    assert todo[g1]["moves"] == SCHOLAR and todo[g1]["start_fen"].startswith("rnbqkbnr/pppppppp")
    assert [u["id"] for u in st["unknown"]] == [g3]
    assert client.put("/api/game-puzzles/names", json={"names": ["Club, A", "club, a", " "]}).status_code == 422
    assert client.put("/api/game-puzzles/names", json={"names": ["Club, A", "club, a"]}).json() == {"names": ["Club, A"]}
    st = client.get("/api/game-puzzles/status").json()
    assert st["names_set"] and [g["id"] for g in st["to_scan"]] == [g3]


def test_scan_stores_the_mistake_as_a_puzzle(client, games):
    g1, *_ = games
    res = send(client, g1, [{"ply": 6, "best_uci": "g7g6", "best_pv": ["g7g6", "h5f3"], "before": 52, "after": 0}])
    assert res.status_code == 200, res.text
    assert res.json() == {"game_id": g1, "found": 1, "new": 1, "skipped": {"repertoire": 0, "lost": 0, "small": 0}}
    (p,) = client.get("/api/game-puzzles").json()
    assert (p["ply"], p["move_number"], p["color"], p["label"]) == (6, 3, "black", "blunder")
    assert (p["played_san"], p["best_san"], p["best_pv"]) == ("Nf6", "g6", ["g7g6", "h5f3"])
    assert p["setup_uci"] == "d1h5" and p["fen"].split()[1] == "b" and p["setup_fen"].split()[1] == "w"
    assert (p["opponent"], p["competition"], p["streak"], p["next_review_on"]) == ("Peter Swan", "League", 0, str(TODAY))
    assert not any(g["id"] == g1 for g in client.get("/api/game-puzzles/status").json()["to_scan"])  # scanned


def test_scan_filters(client, games):
    g1, g2, *_ = games
    o = client.post("/api/repertoires", json={"name": "Main"}).json()
    italian = client.post(f"/api/repertoires/{o['id']}/openings", json={"name": "Italian", "color": "white"}).json()
    client.post(f"/api/openings/{italian['id']}/lines", json={"moves": ITALIAN[:7]})  # 4.c3 is your prep
    res = send(client, g2, [
        {"ply": 7, "best_uci": "d2d3", "before": 55, "after": 30},  # c3 is in your repertoire
        {"ply": 9, "best_uci": "e1g1", "before": 10, "after": 2},  # already lost
        {"ply": 5, "best_uci": "d2d4", "before": 50, "after": 40},  # only 10 points
    ]).json()
    assert res["found"] == 0 and res["skipped"] == {"repertoire": 1, "lost": 1, "small": 1}


def test_scan_validation(client, games):
    g1, g2, g3, _ = games
    assert send(client, g1, [{"ply": 5, "best_uci": "e1g1", "before": 50, "after": 10}]).status_code == 422  # White's move
    assert send(client, g1, [{"ply": 6, "best_uci": "e1g1", "before": 50, "after": 10}]).status_code == 422  # illegal best
    assert send(client, g1, [{"ply": 99, "best_uci": "g7g6", "before": 50, "after": 10}]).status_code == 422
    stale = {"game_id": g1, "moves_hash": "x" * 40, "movetime_ms": 1000, "candidates": []}
    assert client.post("/api/game-puzzles/scans", json=stale).status_code == 422
    other = {"game_id": g3, "moves_hash": "x", "movetime_ms": 1000, "candidates": []}
    assert client.post("/api/game-puzzles/scans", json=other).status_code == 422  # not your game
    assert client.post("/api/game-puzzles/scans", json={**other, "game_id": 999}).status_code == 404


def test_spaced_repetition(client, games):
    g1, *_ = games
    send(client, g1, [{"ply": 6, "best_uci": "g7g6", "before": 52, "after": 0}])
    (p,) = client.get("/api/game-puzzles", params={"due": True}).json()
    r = client.post(f"/api/game-puzzles/{p['id']}/reviews", json={"correct": True}).json()
    assert r["streak"] == 1 and r["next_review_on"] == str(TODAY + timedelta(days=1))
    assert client.get("/api/game-puzzles", params={"due": True}).json() == []
    r = client.post(f"/api/game-puzzles/{p['id']}/reviews", json={"correct": False}).json()
    assert r["streak"] == 0 and r["next_review_on"] == str(TODAY)
    s = client.get("/api/game-puzzles/summary").json()
    assert (s["puzzles"], s["due"], s["blunders"], s["to_scan"], s["unknown"], s["scanned"]) == (1, 1, 1, 1, 1, 1)
    (p,) = client.get("/api/game-puzzles").json()
    assert (p["reviews"], p["correct"]) == (2, 1)
    assert client.post("/api/game-puzzles/999/reviews", json={"correct": True}).status_code == 404


def test_rescan_keeps_history_and_edits_replace(client, games):
    g1, *_ = games
    send(client, g1, [{"ply": 6, "best_uci": "g7g6", "before": 52, "after": 0}])
    pid = client.get("/api/game-puzzles").json()[0]["id"]
    client.post(f"/api/game-puzzles/{pid}/reviews", json={"correct": True})
    assert client.post("/api/game-puzzles/rescan").json() == {"games": 1}
    res = send(client, g1, [{"ply": 6, "best_uci": "d8e7", "before": 55, "after": 0}], movetime=3000).json()
    assert res["new"] == 0
    (p,) = client.get("/api/game-puzzles").json()
    assert p["id"] == pid and p["streak"] == 1 and p["best_san"] == "Qe7"  # fresher analysis, same history
    # Editing the game's moves: it's listed again, and its old puzzle goes when it's rescanned
    client.patch(f"/api/games/{g1}", json={"moves": SCHOLAR[:5] + ["g7g6"]})
    assert any(g["id"] == g1 for g in client.get("/api/game-puzzles/status").json()["to_scan"])
    assert send(client, g1, []).json()["found"] == 0
    assert client.get("/api/game-puzzles").json() == []


def test_delete_and_game_deletion(client, games):
    g1, g2, *_ = games
    send(client, g1, [{"ply": 6, "best_uci": "g7g6", "before": 52, "after": 0}])
    send(client, g2, [{"ply": 9, "best_uci": "e1g1", "before": 55, "after": 20}])
    puzzles = client.get("/api/game-puzzles").json()
    assert [p["game_id"] for p in puzzles] == [g2, g1]  # newest game first
    assert puzzles[0]["label"] == "blunder" and puzzles[0]["best_san"] == "O-O"
    assert client.delete(f"/api/game-puzzles/{puzzles[0]['id']}").status_code == 204
    assert client.delete(f"/api/game-puzzles/{puzzles[0]['id']}").status_code == 404
    client.delete(f"/api/games/{g1}")
    assert client.get("/api/game-puzzles").json() == []
    assert client.get("/api/game-puzzles", params={"game_id": g2}).json() == []
