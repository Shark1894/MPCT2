from datetime import date

import pytest

from tests.conftest import count

ITALIAN = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"]
PGN_TWO = """[Event "Glasgow League"]
[Date "2026.10.01"]
[White "Jason"]
[Black "Opponent"]
[WhiteTeam "Stepps"]
[BlackTeam "Paisley"]
[Result "1-0"]

1. e4 e5 (1... c5 2. Nf3) 2. Nf3 {main line} Nc6 3. Bc4 Bc5 1-0

[Event "Online"]
[Date "2026.??.??"]
[White "Someone"]
[Black "Jason"]
[Result "0-1"]

1. d4 Nf6 2. c4 g6 0-1
"""


def make(client, **fields):
    body = {"white": "Jason", "black": "Opponent", "result": "1-0", "played_on": "2026-10-01", "moves": ITALIAN} | fields
    r = client.post("/api/games", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_get_list(client):
    g = make(client, competition="  GCL2 ", white_team="Stepps")
    assert (g["white"], g["competition"], g["white_team"], g["plies"]) == ("Jason", "GCL2", "Stepps", 6)
    assert [m["san"] for m in g["moves"]] == ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]
    assert g["opening"] == ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]
    full = client.get(f"/api/games/{g['id']}").json()
    assert full["played_on"] == "2026-10-01" and full["result"] == "1-0"
    listed = client.get("/api/games").json()
    assert [x["id"] for x in listed] == [g["id"]] and "moves" not in listed[0]


def test_list_order_and_search(client):
    old = make(client, played_on="2024-12-16", black="Peter")
    new = make(client, played_on="2026-10-22", black="Jeff", competition="DCL2")
    undated = make(client, played_on=None, black="Nobody")
    assert [g["id"] for g in client.get("/api/games").json()] == [new["id"], old["id"], undated["id"]]
    assert [g["id"] for g in client.get("/api/games", params={"q": "jeff"}).json()] == [new["id"]]
    assert [g["id"] for g in client.get("/api/games", params={"q": "dcl"}).json()] == [new["id"]]
    assert client.get("/api/games", params={"q": "zzz"}).json() == []


def test_empty_game_then_add_moves(client):
    g = make(client, moves=[])
    assert g["plies"] == 0
    r = client.patch(f"/api/games/{g['id']}", json={"moves": ITALIAN[:3], "result": "0-1"}).json()
    assert (r["plies"], r["result"], r["white"]) == (3, "0-1", "Jason")  # untouched fields kept
    r = client.patch(f"/api/games/{g['id']}", json={"black": "Renamed"}).json()
    assert (r["plies"], r["black"]) == (3, "Renamed")  # moves kept when not sent


def test_validation(client):
    assert client.post("/api/games", json={"moves": ["e2e5"]}).status_code == 422
    assert client.post("/api/games", json={"result": "2-0"}).status_code == 422
    assert client.post("/api/games", json={"white": "x" * 101}).status_code == 422
    g = make(client)
    assert client.patch(f"/api/games/{g['id']}", json={"moves": ["e2e4", "e2e4"]}).status_code == 422
    assert client.get(f"/api/games/{g['id']}").json()["plies"] == 6  # rejected change left it alone
    assert client.get("/api/games/999").status_code == 404


def test_start_from_position(client):
    fen = "8/4P1k1/8/8/8/8/8/4K3 w - - 0 1"
    g = make(client, start_fen=fen, moves=["e7e8q"])
    assert g["start_fen"] == fen and g["moves"][0]["san"] == "e8=Q"
    assert client.post("/api/games", json={"start_fen": "bad", "moves": []}).status_code == 422


def test_delete(client, db):
    g = make(client)
    assert client.delete(f"/api/games/{g['id']}").status_code == 204
    assert (count(db, "games"), count(db, "game_moves")) == (0, 0)
    assert client.delete(f"/api/games/{g['id']}").status_code == 404


def test_pgn_export(client):
    g = make(client, competition="GCL2", white_team="Stepps")
    r = client.get(f"/api/games/{g['id']}/pgn")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-chess-pgn")
    assert 'filename="2026-10-01-Jason-v-Opponent.pgn"' in r.headers["content-disposition"]
    assert '[Event "GCL2"]' in r.text and '[WhiteTeam "Stepps"]' in r.text and '[Date "2026.10.01"]' in r.text
    assert "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1-0" in r.text


def test_pgn_import_and_duplicates(client):
    r = client.post("/api/games/import-pgn", json={"pgn": PGN_TWO}).json()
    assert (r["imported"], r["duplicates"], r["errors"]) == (2, 0, [])
    games = {g["white"]: g for g in client.get("/api/games").json()}
    j = client.get(f"/api/games/{games['Jason']['id']}").json()
    assert [m["san"] for m in j["moves"]] == ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]  # variation and comment dropped
    assert (j["competition"], j["white_team"], j["black_team"], j["played_on"]) == ("Glasgow League", "Stepps", "Paisley", "2026-10-01")
    assert games["Someone"]["played_on"] is None  # partial date dropped
    again = client.post("/api/games/import-pgn", json={"pgn": PGN_TWO}).json()
    assert (again["imported"], again["duplicates"]) == (0, 2)


def test_pgn_import_reports_bad_games(client):
    bad = '[White "A"]\n[Black "B"]\n\n1. e4 e4 *\n\n' + PGN_TWO.split("\n\n[Event \"Online\"]")[0]
    r = client.post("/api/games/import-pgn", json={"pgn": bad}).json()
    assert r["imported"] == 1 and len(r["errors"]) == 1 and "A v B" in r["errors"][0]


def test_pgn_round_trip(client):
    g = make(client, moves=["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7"])
    pgn = client.get(f"/api/games/{g['id']}/pgn").text
    client.delete(f"/api/games/{g['id']}")
    r = client.post("/api/games/import-pgn", json={"pgn": pgn}).json()
    back = client.get(f"/api/games/{r['game_ids'][0]}").json()
    assert [m["uci"] for m in back["moves"]] == ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7"]
    assert (back["white"], back["result"], back["played_on"]) == ("Jason", "1-0", "2026-10-01")


# ---- repertoire check ---------------------------------------------------------


@pytest.fixture
def italian(client):
    rep = client.post("/api/repertoires", json={"name": "Main"}).json()
    o = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Italian", "color": "white"}).json()
    for moves in (ITALIAN + ["c2c3", "g8f6"], ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3"], ["e2e4", "c7c5", "c2c3"]):
        client.post(f"/api/openings/{o['id']}/lines", json={"moves": moves})
    return o


def check(client, opening, moves):
    r = client.post(f"/api/openings/{opening['id']}/check", json={"moves": moves})
    assert r.status_code == 200, r.text
    return r.json()


def test_check_you_deviated(client, italian):
    r = check(client, italian, ITALIAN + ["b2b4"])  # Evans gambit instead of 4.c3
    assert r == {"status": "deviation", "ply": 7, "played": "b4", "by": "you", "repertoire": ["c3"]}


def test_check_opponent_deviated(client, italian):
    r = check(client, italian, ["e2e4", "e7e5", "g1f3", "d7d6"])  # Philidor
    assert (r["status"], r["ply"], r["played"], r["by"]) == ("deviation", 4, "d6", "opponent")
    assert r["repertoire"] == ["Nc6"]


def test_check_end_of_book_and_in_book(client, italian):
    r = check(client, italian, ITALIAN + ["c2c3", "g8f6", "d2d4"])
    assert (r["status"], r["ply"], r["played"], r["by"], r["repertoire"]) == ("end_of_book", 9, "d4", "you", [])
    assert check(client, italian, ITALIAN)["status"] == "in_book"
    assert check(client, italian, [])["status"] == "in_book"


def test_check_follows_transpositions(client):
    rep = client.post("/api/repertoires", json={"name": "T"}).json()
    o = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "QG", "color": "white"}).json()
    # Line 1 stops after 2...e6; line 2 reaches the same position by another order and continues 3.Nc3
    client.post(f"/api/openings/{o['id']}/lines", json={"moves": ["d2d4", "g8f6", "c2c4", "e7e6"]})
    client.post(f"/api/openings/{o['id']}/lines", json={"moves": ["c2c4", "e7e6", "d2d4", "g8f6", "b1c3"]})
    r = check(client, o, ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4"])
    # 3.Nc3 counts as book via the transposition; the repertoire ends after it
    assert (r["status"], r["ply"], r["played"], r["by"]) == ("end_of_book", 6, "Bb4", "opponent")


def test_check_bad_input(client, italian):
    assert client.post(f"/api/openings/{italian['id']}/check", json={"moves": ["e2e5"]}).status_code == 422
    assert client.post("/api/openings/999/check", json={"moves": []}).status_code == 404


def test_change_start_position_with_moves(client):
    g = client.post("/api/games", json={"white": "A", "black": "B", "moves": ["e2e4"]}).json()
    fen = "8/4P1k1/8/8/8/8/8/4K3 w - - 0 1"
    assert client.patch(f"/api/games/{g['id']}", json={"start_fen": fen}).status_code == 422  # moves needed too
    r = client.patch(f"/api/games/{g['id']}", json={"start_fen": fen, "moves": ["e7e8q"]})
    assert r.status_code == 200
    assert (r.json()["start_fen"], [m["san"] for m in r.json()["moves"]]) == (fen, ["e8=Q"])
    back = client.patch(
        f"/api/games/{g['id']}",
        json={"start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "moves": ["d2d4"]},
    ).json()
    assert back["start_fen"] is None  # normal start stored as null


def test_export_all_pgn(client):
    client.post("/api/games", json={"white": "Old", "black": "X", "played_on": "2024-01-01", "result": "1-0", "moves": ["e2e4"]})
    client.post("/api/games", json={"white": "New", "black": "Y", "played_on": "2025-01-01", "result": "0-1", "moves": ["d2d4"]})
    r = client.get("/api/pgn/games")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    assert r.text.index('[White "Old"]') < r.text.index('[White "New"]')  # oldest first
    assert r.text.count("[Event ") == 2
    only = client.get("/api/pgn/games", params={"q": "new"}).text
    assert only.count("[Event ") == 1 and '[White "New"]' in only
