"""Training courses from a PGN file (endgame studies): reading, chapters by material, import, re-import."""

import pytest

from app.core.pgn_course import NotACourse, material_text, parse_course
import chess

SAAVEDRA = """[Event "Glasgow Weekly Citizen"]
[Site "?"]
[Date "1895.??.??"]
[White "Saavedra, Fernando"]
[Black "Win"]
[Result "1-0"]
[SetUp "1"]
[FEN "8/8/1KP5/3r4/8/8/8/k7 w - - 0 1"]

{The most famous study of all.} 1. c7 Rd6+ 2. Kb5 Rd5+ 3. Kb4 Rd4+ 4. Kb3 Rd3+ 5. Kc2 Rd4
6. c8=R $1 (6. c8=Q $2 Rc4+ 7. Qxc4 {stalemate}) 6... Ra4 {forced} 7. Kb3 1-0
"""

RETI = """[Event "Kagans Neueste Schachnachrichten"]
[Date "1921.??.??"]
[White "Reti, Richard"]
[Black "Draw"]
[Result "1/2-1/2"]
[SetUp "1"]
[FEN "7K/8/k1P5/7p/8/8/8/8 w - - 0 1"]

1. Kg7 h4 2. Kf6 Kb6 (2... h3 3. Ke7 h2 4. c7 Kb7 5. Kd7) 3. Ke5 h3 (3... Kxc6 4. Kf4) 4. Kd6 h2 5. c7 h1=Q 6. c8=Q 1/2-1/2
"""

GAME = """[Event "Club match"]
[White "Smith"]
[Black "Jones"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0
"""

BROKEN = """[Event "Bad"]
[White "Nobody"]
[Black "Draw"]
[Result "1/2-1/2"]
[SetUp "1"]
[FEN "8/8/8/8/8/8/8/8 w - - 0 1"]

1. Kg7 1/2-1/2
"""

FILE = "\n".join((SAAVEDRA, RETI, GAME, BROKEN))


def test_material_text():
    assert material_text(chess.Board("8/8/1KP5/3r4/8/8/8/k7 w - - 0 1")) == "P v R"
    assert material_text(chess.Board("4k3/8/8/8/8/8/8/4K3 w - - 0 1")) == "K v K"


def test_parse_studies():
    c = parse_course(SAAVEDRA + "\n" + RETI, "Classics")
    assert c.group == "material"
    assert [(ch["title"], ch["count"]) for ch in c.chapters] == [("Pawn endings", 1), ("Rook endings", 1)]
    by_title = {line.title: line for line in c.lines}
    s = by_title["Saavedra, Fernando, 1895 · P v R"]
    assert (s.color, s.chapter, s.kind) == ("white", "Rook endings", "line")
    assert s.sans == ["c7", "Rd6+", "Kb5", "Rd5+", "Kb4", "Rd4+", "Kb3", "Rd3+", "Kc2", "Rd4", "c8=R", "Ra4", "Kb3"]
    assert s.comments[0] == ("White to play and win.\n\nSaavedra, Fernando, Glasgow Weekly Citizen, 1895\n\n"
                             "The most famous study of all.")
    # The sideline to 6.c8=R is shown after 6.c8=R has been played, not before.
    assert 10 not in s.comments
    assert s.comments[11] == "(6.c8=Q Rc4+ 7.Qxc4 stalemate)"
    assert s.comments[12] == "forced"
    r = by_title["Reti, Richard, 1921 · P v P"]
    assert r.comments[0].startswith("White to play and draw.")
    assert r.comments[4] == "(2...h3 3.Ke7 h2 4.c7 Kb7 5.Kd7)"
    assert r.comments[6] == "(3...Kxc6 4.Kf4)"


def test_parse_mixed_file():
    c = parse_course(FILE, "Mixed", group="auto")
    assert c.group == "material"  # 3 of the 4 games have a set-up position
    assert len(c.lines) == 3 and any("Game 4" in x for x in c.skipped)
    game = next(line for line in c.lines if line.title.startswith("Smith"))
    assert game.title == "Smith – Jones · Q+2R+2B+2N+8P v Q+2R+2B+2N+8P"
    assert game.chapter == "Many pieces" and game.comments[0] == "White to play and win.\n\nClub match"
    events = parse_course(FILE, "Mixed", group="event")
    assert [ch["title"] for ch in events.chapters] == ["Glasgow Weekly Citizen", "Kagans Neueste Schachnachrichten", "Club match"]
    one = parse_course(FILE, "Mixed", group="none")
    assert [(ch["title"], ch["count"]) for ch in one.chapters] == [("Mixed", 3)]


def test_parse_errors():
    with pytest.raises(NotACourse):
        parse_course("", "x")
    with pytest.raises(NotACourse):
        parse_course(BROKEN, "x")
    dup = parse_course(SAAVEDRA + "\n" + SAAVEDRA, "x")
    assert len(dup.lines) == 1 and "same as an earlier" in dup.skipped[0]


def test_preview_import_and_reimport(client, db):
    r = client.post("/api/courses/pgn/preview", json={"pgn": FILE, "name": "Studies"})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["group"] == "material" and p["exercises"] == 3 and len(p["skipped"]) == 1
    rook = next(ch["id"] for ch in p["chapters"] if ch["title"] == "Rook endings")
    pawn = next(ch["id"] for ch in p["chapters"] if ch["title"] == "Pawn endings")

    assert client.post("/api/courses/pgn/import", json={"pgn": FILE, "name": ""}).status_code == 422
    assert client.post("/api/courses/pgn/import", json={"pgn": FILE, "name": "Studies", "chapter_ids": []}).status_code == 422
    r = client.post("/api/courses/pgn/import", json={"pgn": FILE, "name": "Studies", "chapter_ids": [rook, pawn]})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["created_course"] and out["added"] == 2 and len(out["skipped"]) == 1
    course = client.get(f"/api/courses/{out['course_id']}").json()
    assert course["kind"] == "endgames"
    assert [c["title"] for c in course["chapters"]] == ["Pawn endings", "Rook endings"]
    saavedra = course["chapters"][1]["exercises"][0]
    e = client.get(f"/api/exercises/{saavedra['id']}").json()
    assert e["color"] == "white" and e["start_fen"] == "8/8/1KP5/3r4/8/8/8/k7 w - - 0 1" and len(e["ucis"]) == 13
    client.post(f"/api/exercises/{saavedra['id']}/attempt", json={"solved": True})

    # The same file again, every chapter: the two studies are kept (with progress), the game is added.
    again = client.post("/api/courses/pgn/import", json={"pgn": FILE, "name": "Studies"}).json()
    assert (again["created_course"], again["added"], again["unchanged"]) == (False, 1, 2)
    assert client.get(f"/api/exercises/{saavedra['id']}").json()["status"] == "solved"
    assert len(client.get("/api/courses").json()) == 1
