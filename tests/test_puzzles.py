"""Puzzles: Glicko-2, reading the Lichess CSV, importing, picking, attempts and stats."""

import io
import math
import random

import pytest
import zstandard
from sqlalchemy import text

from app import puzzle_import
from app.core import glicko
from app.core.puzzles import parse_row, read_rows
from app.db.session import get_engine

HEADER = "PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate"
ROWS = [
    "00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1500,76,94,6000,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#48,,",
    "0000D,5rk1/1p3ppp/pq3b2/8/8/1P1Q1N2/P4PPP/3R2K1 w - - 2 27,d3d6 f8d8 d6d8 f6d8,1600,74,96,25000,advantage endgame short,https://lichess.org/F8M8OS71#53,,",
    "0009B,r2qr1k1/b1p2ppp/pp4n1/P1P1p3/4P1n1/B2P2Pb/3NBP1P/RN1QR1K1 b - - 1 16,b6c5 e2g4 h3g4 d1g4,1450,74,95,1000,advantage middlegame short,https://lichess.org/4MWQCxQ6/black#32,Kings_Pawn_Game Kings_Pawn_Game_Leonardis_Variation,",
    "000aY,r4rk1/pp3ppp/2n1b3/q1pp2B1/8/P1Q2NP1/1PP1PP1P/2KR3R w - - 0 15,g5e7 a5c3 b2c3 c6e7,1700,74,-50,600,advantage master middlegame short,https://lichess.org/iihZGl6t#29,,",  # disliked
    "000hf,r1bqk2r/pp1nbNp1/2p1p2p/8/2BP4/1PN3P1/P3QP1P/3R1RK1 b kq - 0 19,e8f7 e2e6 f7f8 e6f7,1350,75,99,800,mate mateIn2 middlegame short,https://lichess.org/71ygsFeE/black#38,Horwitz_Defense Horwitz_Defense_Other_variations,",
]


def zst(text_: str) -> bytes:
    return zstandard.ZstdCompressor().compress(text_.encode())


# ---- Glicko-2 ---------------------------------------------------------------------------


def test_glicko_matches_the_papers_example_terms():
    # Glickman's example: 1500/200 vs 1400/30. Expected score and g() from the paper.
    p = glicko.Rating(1500, 200, 0.06)
    assert math.isclose(glicko.expected(p, 1400, 30), 0.639, abs_tol=0.001)
    assert math.isclose(glicko._g(30 / glicko.SCALE), 0.9955, abs_tol=0.0001)


def test_glicko_win_raises_loss_lowers_and_certainty_grows():
    start = glicko.Rating()
    win = glicko.update(start, 1500, 80, 1)
    loss = glicko.update(start, 1500, 80, 0)
    assert win.rating > 1500 > loss.rating
    assert math.isclose(win.rating - 1500, 1500 - loss.rating, rel_tol=0.01)  # symmetric against an equal puzzle
    assert win.rd < start.rd
    beating_weaker = glicko.update(glicko.Rating(1800, 60, 0.06), 1200, 80, 1)
    assert 0 < beating_weaker.rating - 1800 < 3  # expected result: barely moves


def test_glicko_rd_settles_once_established():
    r = glicko.Rating()
    for i in range(300):
        r = glicko.update(r, 1500, 75, i % 2)
    assert glicko.MIN_RD <= r.rd < 100  # volatility keeps a little uncertainty
    assert r.rd < 110  # no longer provisional
    assert abs(r.rating - 1500) < 60


# ---- CSV ----------------------------------------------------------------------------------


def test_parse_row():
    rng = random.Random(1)
    assert parse_row(HEADER.split(","), rng) is None
    p = next(read_rows([ROWS[2]]))
    assert p.id == "0009B" and p.rating == 1450 and p.moves.split()[0] == "b6c5"
    assert p.themes == ["advantage", "middlegame", "short"]
    assert p.opening_tags == ["Kings_Pawn_Game", "Kings_Pawn_Game_Leonardis_Variation"]
    assert p.copy_row()[7] == "{advantage,middlegame,short}"
    assert parse_row(["x", "not a fen", "e2e4"], rng) is None
    assert list(read_rows(["bad,row"])) == []


# ---- import -------------------------------------------------------------------------------


@pytest.fixture
def imported(db, tmp_path):
    f = tmp_path / "lichess_db_puzzle.csv.zst"
    f.write_bytes(zst("\n".join([HEADER, *ROWS]) + "\n"))
    assert puzzle_import.import_puzzles(str(f), engine=get_engine(), seed=1) == 5
    return f


def test_import_and_reimport(client, imported, tmp_path):
    st = client.get("/api/puzzles/status").json()
    assert st["puzzles"] == 5 and st["imported_at"] and st["importing"] is False and st["step"] == "Done: 5 puzzles"
    # A re-import replaces the puzzles; attempts are kept
    client.post("/api/puzzles/0000D/attempts", json={"solved": True})
    plain = tmp_path / "small.csv"
    plain.write_text("\n".join([HEADER, ROWS[0], ROWS[1]]))
    assert puzzle_import.import_puzzles(str(plain), engine=get_engine()) == 2
    assert client.get("/api/puzzles/status").json()["puzzles"] == 2
    assert client.get("/api/puzzles/summary").json()["attempts"] == 1


def test_failed_import_keeps_the_old_puzzles(client, imported, tmp_path):
    broken = tmp_path / "broken.csv.zst"
    broken.write_bytes(zst("\n".join([HEADER, *ROWS]))[:-20])  # truncated download
    with pytest.raises(Exception):
        puzzle_import.import_puzzles(str(broken), engine=get_engine())
    assert puzzle_import.state["error"] and puzzle_import.state["running"] is False
    with get_engine().connect() as c:
        assert c.execute(text("SELECT count(*) FROM puzzles")).scalar() == 5
        indexes = set(c.execute(text("SELECT indexname FROM pg_indexes WHERE tablename = 'puzzles'")).scalars())
    assert {"ix_puzzles_rnd", "ix_puzzles_themes"} <= indexes


def test_empty_file_is_refused(db, tmp_path):
    f = tmp_path / "empty.csv"
    f.write_text(HEADER + "\n")
    with pytest.raises(ValueError):
        puzzle_import.import_puzzles(str(f), engine=get_engine())


# ---- picking and attempts --------------------------------------------------------------------


def test_no_puzzles_yet(client):
    res = client.get("/api/puzzles/next")
    assert res.status_code == 409 and "download" in res.json()["detail"]


def test_next_puzzle_near_the_rating_skips_disliked_and_tried(client, imported):
    first = client.get("/api/puzzles/next").json()
    assert first["window"] == 200 and 1300 <= first["rating"] <= 1700  # within 200 of 1500
    seen = set()
    for _ in range(4):
        p = client.get("/api/puzzles/next").json()
        assert p["id"] != "000aY"  # popularity -50
        seen.add(p["id"])
        client.post(f"/api/puzzles/{p['id']}/attempts", json={"solved": False})  # keeps the rating low
    assert seen == {"00008", "0000D", "0009B", "000hf"}
    assert client.get("/api/puzzles/next").status_code == 404  # all tried


def test_next_puzzle_by_theme_and_exclude(client, imported):
    p = client.get("/api/puzzles/next", params={"theme": "mateIn2"}).json()
    assert p["id"] == "000hf" and "Mate in 2" in p["theme_names"]
    assert p["opening_tags"] == ["Horwitz Defense", "Horwitz Defense Other variations"]
    assert p["moves"] == ["e8f7", "e2e6", "f7f8", "e6f7"] and p["tried"] == 0
    assert client.get("/api/puzzles/next", params={"theme": "mateIn2", "exclude": "000hf"}).status_code == 404
    assert client.get("/api/puzzles/next", params={"theme": "nonsense"}).status_code == 422


def test_window_widens_when_nothing_is_near(client, imported, db):
    with db.begin() as c:
        c.execute(text("INSERT INTO puzzle_rating (id, rating, rd, volatility) VALUES (1, 2300, 60, 0.06)"))
    p = client.get("/api/puzzles/next").json()
    assert p["window"] == 800 and p["rating"] >= 1500


def test_only_the_first_attempt_is_rated(client, imported):
    first = client.post("/api/puzzles/0009B/attempts", json={"solved": False, "seconds": 40}).json()
    assert first["rated"] and first["change"] < 0 and first["rating_before"] == 1500 and first["provisional"]
    retry = client.post("/api/puzzles/0009B/attempts", json={"solved": True}).json()
    assert not retry["rated"] and retry["change"] == 0 and retry["rating_after"] == first["rating_after"]
    assert client.get("/api/puzzles/0009B").json()["tried"] == 2
    assert client.post("/api/puzzles/nope/attempts", json={"solved": True}).status_code == 404


def test_summary(client, imported):
    for pid, ok in (("00008", True), ("0000D", False), ("0009B", True), ("0009B", False)):
        client.post(f"/api/puzzles/{pid}/attempts", json={"solved": ok})
    s = client.get("/api/puzzles/summary").json()
    assert (s["attempts"], s["solved"], s["rated"], s["rated_solved"]) == (4, 2, 3, 2)
    assert s["today"] == {"attempts": 3, "solved": 2}
    assert len(s["history"]) == 1 and s["history"][0]["rating"] == s["rating"]
    assert [r["puzzle_id"] for r in s["recent"]] == ["0009B", "0009B", "0000D", "00008"]
    assert s["recent"][0]["rated"] is False and "Hanging piece" in s["recent"][3]["themes"]
    assert s["recent"][3]["fen"] and " w " in s["recent"][3]["fen"]  # 00008: Black's set-up move played, White to solve
    assert s["themes"] == []  # fewer than 5 attempts per theme


def test_themes_list(client):
    themes = client.get("/api/puzzles/themes").json()
    assert {"theme": "fork", "name": "Fork"} in themes


def test_import_endpoint_starts_a_background_import(client, monkeypatch):
    started = []
    monkeypatch.setattr(puzzle_import, "start_import", lambda: started.append(1) or True)
    assert client.post("/api/puzzles/import").status_code == 202
    assert started == [1]
