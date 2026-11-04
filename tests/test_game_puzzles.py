"""Engine reviews of your games and the puzzles from them: names, review queue, storing reviews,
which puzzles show, spaced repetition."""

from datetime import date, timedelta

import pytest

TODAY = date.today()
# Scholar's mate trap: Black blunders 3...Nf6?? (ply 6); 3...g6 holds.
SCHOLAR = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]
# A longer game: 5.Bxf7+?? (ply 9) throws a piece away (a made-up mistake).
ITALIAN = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "g8f6", "c4f7"]
COUNTS = {"w": {"inaccuracy": 1, "mistake": 0, "blunder": 0}, "b": {"inaccuracy": 0, "mistake": 0, "blunder": 1}}
NF6 = {"ply": 6, "best_uci": "g7g6", "best_pv": ["g7g6", "h5f3"], "before": 52, "after": 0}


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
    g4 = game(client, "Jason Sharkey", "Short, Game", ["e2e4", "e7e5"])  # too short to review
    return g1, g2, g3, g4


def review(client, gid, moves, candidates, movetime=1000, accuracy=None):
    body = {"moves": moves, "movetime_ms": movetime, "accuracy": accuracy or {"w": 91.5, "b": 40.2},
            "counts": COUNTS, "candidates": candidates}
    return client.post(f"/api/game-reviews/{gid}", json=body)


def test_names_and_status(client, games):
    g1, g2, g3, g4 = games
    st = client.get("/api/game-puzzles/status").json()
    assert st == {"names": ["Jason Sharkey", "You"], "names_set": False, "games": 3, "reviewed": 0, "unreviewed": 3, "unknown": 0}
    queue = client.get("/api/game-reviews/queue").json()
    assert [g["id"] for g in queue] == [g3, g2, g1]  # newest first; the short game is left out
    assert queue[2]["moves"] == SCHOLAR and queue[2]["start_fen"].startswith("rnbqkbnr/pppppppp")
    review(client, g3, ITALIAN, [])
    st = client.get("/api/game-puzzles/status").json()
    assert (st["reviewed"], st["unreviewed"], st["unknown"]) == (1, 2, 1)  # g3 is nobody's you
    assert client.put("/api/game-puzzles/names", json={"names": ["Club, A", " "]}).status_code == 422
    assert client.put("/api/game-puzzles/names", json={"names": ["Club, A", "club, a"]}).json() == {"names": ["Club, A"]}
    st = client.get("/api/game-puzzles/status").json()
    assert st["names_set"] and st["unknown"] == 0


def test_review_marks_the_game_and_stores_puzzles(client, games):
    g1, *_ = games
    assert client.get(f"/api/games/{g1}").json()["review"] is None
    res = review(client, g1, SCHOLAR, [NF6])
    assert res.status_code == 200, res.text
    assert res.json() == {"game_id": g1, "puzzles": 1, "new": 1, "skipped": {"repertoire": 0, "lost": 0, "small": 0}}
    info = client.get(f"/api/games/{g1}").json()["review"]
    assert (info["white_accuracy"], info["black_accuracy"], info["movetime_ms"]) == (91.5, 40.2, 1000)
    assert info["counts"]["b"]["blunder"] == 1
    listed = next(g for g in client.get("/api/games").json() if g["id"] == g1)
    assert listed["review"]["black_accuracy"] == 40.2
    assert g1 not in [g["id"] for g in client.get("/api/game-reviews/queue").json()]
    (p,) = client.get("/api/game-puzzles").json()
    assert (p["ply"], p["move_number"], p["color"], p["label"]) == (6, 3, "black", "blunder")
    assert (p["played_san"], p["best_san"], p["best_pv"]) == ("Nf6", "g6", ["g7g6", "h5f3"])
    assert p["setup_uci"] == "d1h5" and p["fen"].split()[1] == "b" and p["setup_fen"].split()[1] == "w"
    assert (p["opponent"], p["competition"], p["streak"], p["next_review_on"]) == ("Peter Swan", "League", 0, str(TODAY))


def test_only_your_side_shows_and_names_switch_it(client, games):
    g1, *_ = games
    # The opponent's mistake (5.Qh5 isn't one, but say 7.Qxf7 was) is kept but not shown as yours.
    res = review(client, g1, SCHOLAR, [NF6, {"ply": 5, "best_uci": "g1f3", "before": 55, "after": 30}]).json()
    assert res["puzzles"] == 1
    assert [p["ply"] for p in client.get("/api/game-puzzles").json()] == [6]
    client.put("/api/game-puzzles/names", json={"names": ["Peter Swan"]})
    assert [p["ply"] for p in client.get("/api/game-puzzles").json()] == [5]  # no new review needed


def test_review_filters(client, games):
    g1, g2, *_ = games
    o = client.post("/api/repertoires", json={"name": "Main"}).json()
    italian = client.post(f"/api/repertoires/{o['id']}/openings", json={"name": "Italian", "color": "white"}).json()
    client.post(f"/api/openings/{italian['id']}/lines", json={"moves": ITALIAN[:7]})  # 4.c3 is your prep
    res = review(client, g2, ITALIAN, [
        {"ply": 7, "best_uci": "d2d3", "before": 55, "after": 30},  # c3 is in your repertoire
        {"ply": 9, "best_uci": "e1g1", "before": 10, "after": 2},  # already lost
        {"ply": 5, "best_uci": "d2d4", "before": 50, "after": 40},  # only 10 points
    ]).json()
    assert res["puzzles"] == 0 and res["skipped"] == {"repertoire": 1, "lost": 1, "small": 1}


def test_review_validation(client, games):
    g1, *_ = games
    assert review(client, g1, SCHOLAR, [{"ply": 6, "best_uci": "e1g1", "before": 50, "after": 10}]).status_code == 422  # illegal
    assert review(client, g1, SCHOLAR, [{"ply": 99, "best_uci": "g7g6", "before": 50, "after": 10}]).status_code == 422
    assert review(client, g1, SCHOLAR[:6], []).status_code == 422  # not the saved moves
    assert review(client, 999, SCHOLAR, []).status_code == 404
    assert client.get(f"/api/games/{g1}").json()["review"] is None


def test_spaced_repetition(client, games):
    g1, *_ = games
    review(client, g1, SCHOLAR, [NF6])
    (p,) = client.get("/api/game-puzzles", params={"due": True}).json()
    r = client.post(f"/api/game-puzzles/{p['id']}/reviews", json={"correct": True}).json()
    assert r["streak"] == 1 and r["next_review_on"] == str(TODAY + timedelta(days=1))
    assert client.get("/api/game-puzzles", params={"due": True}).json() == []
    r = client.post(f"/api/game-puzzles/{p['id']}/reviews", json={"correct": False}).json()
    assert r["streak"] == 0 and r["next_review_on"] == str(TODAY)
    (p,) = client.get("/api/game-puzzles").json()
    assert (p["reviews"], p["correct"]) == (2, 1)
    assert client.post("/api/game-puzzles/999/reviews", json={"correct": True}).status_code == 404


def test_review_again_keeps_history_and_edits_make_it_stale(client, games):
    g1, *_ = games
    review(client, g1, SCHOLAR, [NF6])
    pid = client.get("/api/game-puzzles").json()[0]["id"]
    client.post(f"/api/game-puzzles/{pid}/reviews", json={"correct": True})
    res = review(client, g1, SCHOLAR, [{"ply": 6, "best_uci": "d8e7", "before": 55, "after": 0}], movetime=3000).json()
    assert res["new"] == 0
    (p,) = client.get("/api/game-puzzles").json()
    assert p["id"] == pid and p["streak"] == 1 and p["best_san"] == "Qe7"  # fresher analysis, same history
    # Editing the moves: the game is unreviewed again and its puzzles are hidden until it's reviewed
    new_moves = SCHOLAR[:5] + ["g7g6"]
    client.patch(f"/api/games/{g1}", json={"moves": new_moves})
    assert client.get(f"/api/games/{g1}").json()["review"] is None
    assert client.get("/api/game-puzzles").json() == []
    assert g1 in [g["id"] for g in client.get("/api/game-reviews/queue").json()]
    assert review(client, g1, new_moves, []).json()["puzzles"] == 0


def test_remove_and_game_deletion(client, games):
    g1, g2, *_ = games
    review(client, g1, SCHOLAR, [NF6])
    review(client, g2, ITALIAN, [{"ply": 9, "best_uci": "e1g1", "before": 55, "after": 20}])
    puzzles = client.get("/api/game-puzzles").json()
    assert [p["game_id"] for p in puzzles] == [g2, g1]  # newest game first
    assert puzzles[0]["label"] == "blunder" and puzzles[0]["best_san"] == "O-O"
    assert client.delete(f"/api/game-puzzles/{puzzles[0]['id']}").status_code == 204
    assert client.delete(f"/api/game-puzzles/{puzzles[0]['id']}").status_code == 404
    # Reviewing the game again doesn't bring a removed puzzle back
    assert review(client, g2, ITALIAN, [{"ply": 9, "best_uci": "e1g1", "before": 55, "after": 20}]).json()["puzzles"] == 0
    assert [p["game_id"] for p in client.get("/api/game-puzzles").json()] == [g1]
    client.delete(f"/api/games/{g1}")
    assert client.get("/api/game-puzzles").json() == []
