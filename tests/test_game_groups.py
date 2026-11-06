"""Game groups (OTB / Online / Practice / Other) and the board's "Your games" explorer."""

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from tests.conftest import ROOT

E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def new(client, white, black, moves, result="*", category=None, played_on=None):
    body = {"white": white, "black": black, "moves": moves, "result": result, "played_on": played_on}
    if category:
        body["category"] = category
    r = client.post("/api/games", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_groups_filter_and_counts(client):
    a = new(client, "Jason Sharkey", "Ally", ["e2e4"])
    b = new(client, "Jason Sharkey", "Bot", ["d2d4"], category="practice")
    new(client, "Carlsen", "Caruana", ["c2c4"], category="other")
    assert a["category"] == "otb" and b["category"] == "practice"
    assert client.get("/api/games/groups").json() == {"otb": 1, "online": 0, "practice": 1, "other": 1}
    assert [g["id"] for g in client.get("/api/games?category=otb").json()] == [a["id"]]
    assert len(client.get("/api/games").json()) == 3  # no group: everything (API default)
    assert client.get("/api/games?category=nope").status_code == 422
    players = [p["name"] for p in client.get("/api/games/players?category=other").json()]
    assert sorted(players) == ["Carlsen", "Caruana"]
    # move a game to another group
    r = client.patch(f"/api/games/{b['id']}", json={"category": "otb"})
    assert r.json()["category"] == "otb"
    assert client.get("/api/games/groups").json()["otb"] == 2
    assert client.patch(f"/api/games/{b['id']}", json={"category": "bad"}).status_code == 422
    # PGN export follows the group
    pgn = client.get("/api/pgn/games?category=other").text
    assert "Carlsen" in pgn and "Sharkey" not in pgn


def test_pgn_import_into_a_group(client):
    pgn = '[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 *\n'
    assert client.post("/api/games/import-pgn", json={"pgn": pgn, "category": "online"}).json()["imported"] == 1
    assert client.get("/api/games?category=online").json()[0]["white"] == "A"


def test_migration_sorts_existing_games(db):
    """Downgrade to before the groups, add games of each kind, upgrade: each lands in its group."""
    cfg = Config(str(ROOT / "alembic.ini"))
    command.downgrade(cfg, "c4d5e6f7a8b9")
    try:
        with db.begin() as conn:
            conn.execute(text("""
                INSERT INTO games (white, black, competition, result, lichess_id) VALUES
                  ('Jason Sharkey', 'Ally', 'Glasgow League', '1-0', NULL),
                  ('JasonS', 'Opp', 'Lichess · Blitz 3+2 · rated', '1-0', 'abcdefgh'),
                  ('JasonS', 'Opp2', 'Rated Blitz game', '0-1', NULL),
                  ('Jason Sharkey', 'Stockfish level 3', 'Practice vs engine (Caro)', '0-1', NULL),
                  ('Kasparov, G.', 'Karpov, A.', 'World Championship', '1-0', NULL)
            """))
            conn.execute(text("""
                INSERT INTO masters_games (id, white, black, moves, pgn, result)
                VALUES ('abcd1234', 'Kasparov, G.', 'Karpov, A.', 'e2e4', '', '1-0')
            """))
        command.upgrade(cfg, "head")
        with db.connect() as conn:
            got = dict(conn.execute(text("SELECT competition, category FROM games")).all())
    finally:
        command.upgrade(cfg, "head")
    assert got == {
        "Glasgow League": "otb",
        "Lichess · Blitz 3+2 · rated": "online",
        "Rated Blitz game": "online",
        "Practice vs engine (Caro)": "practice",
        "World Championship": "other",
    }


def test_explorer(client):
    client.put("/api/game-puzzles/names", json={"names": ["Jason Sharkey"]})
    new(client, "Jason Sharkey", "Ally", ["e2e4", "c7c5", "g1f3"], "1-0", played_on="2026-01-10")
    new(client, "Bob", "Jason Sharkey", ["e2e4", "c7c5", "b1c3"], "1/2-1/2", played_on="2026-02-10")
    new(client, "Jason Sharkey", "Cat", ["e2e4", "e7e5"], "0-1", played_on="2026-03-10")
    new(client, "Jason Sharkey", "Online Opp", ["e2e4", "e7e5", "g1f3"], "1-0", category="online")
    new(client, "Jason Sharkey", "Stockfish level 1", ["e2e4", "e7e5"], "1-0", category="practice")
    new(client, "Nf3 first", "x", ["g1f3", "g8f6", "e2e4"], "1-0")  # never 1.e4: no transposition here

    r = client.get("/api/games-explorer", params={"fen": START})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["total"] == 4 and d["groups"] == ["otb"]
    assert [(m["san"], m["games"]) for m in d["moves"]] == [("e4", 3), ("Nf3", 1)]

    d = client.get("/api/games-explorer", params={"fen": E4}).json()
    assert d["total"] == 3
    c5, e5 = d["moves"]
    assert (c5["san"], c5["games"], c5["white"], c5["draws"]) == ("c5", 2, 1, 1)
    assert (c5["won"], c5["drawn"], c5["lost"]) == (1, 1, 0)
    assert (e5["san"], e5["lost"]) == ("e5", 1)
    assert [g["played_on"] for g in d["games"]] == ["2026-03-10", "2026-02-10", "2026-01-10"]  # newest first
    assert d["games"][0]["ply"] == 1 and d["games"][0]["san"] == "e5" and d["games"][1]["my_color"] == "black"

    both = client.get("/api/games-explorer", params={"fen": E4, "groups": "otb,online"}).json()
    assert both["total"] == 4 and both["groups"] == ["online", "otb"]
    assert client.get("/api/games-explorer", params={"fen": E4, "groups": "practice,zzz"}).status_code == 422

    # the index follows changes: a new game and a moved one
    new(client, "Jason Sharkey", "Dan", ["e2e4", "c7c5"], "1-0")
    assert client.get("/api/games-explorer", params={"fen": E4}).json()["total"] == 4
    gid = client.get("/api/games?category=otb").json()[0]["id"]
    client.patch(f"/api/games/{gid}", json={"category": "other"})
    assert client.get("/api/games-explorer", params={"fen": E4}).json()["total"] == 3


def test_explorer_transposition_and_end_of_game(client):
    new(client, "A", "B", ["g1f3", "d7d5", "d2d4"], "1-0")
    new(client, "C", "D", ["d2d4", "d7d5", "g1f3"], "0-1")
    after = "rnbqkbnr/ppp1pppp/8/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R b KQkq - 1 2"
    d = client.get("/api/games-explorer", params={"fen": after}).json()
    assert d["total"] == 2 and d["moves"] == []  # both games ended there
    assert {g["san"] for g in d["games"]} == {None}
