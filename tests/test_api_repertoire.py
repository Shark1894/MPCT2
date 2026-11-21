from datetime import date, timedelta

import pytest
from sqlalchemy import text

from tests.conftest import count

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"

RUY = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]
ITALIAN = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]


@pytest.fixture
def rep(client):
    return client.post("/api/repertoires", json={"name": "Main"}).json()


@pytest.fixture
def opening(client, rep):
    return client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Open Games", "color": "white"}).json()


def add(client, opening, moves):
    return client.post(f"/api/openings/{opening['id']}/lines", json={"moves": moves})


# ---- repertoires ----------------------------------------------------------


def test_repertoire_crud(client):
    r = client.post("/api/repertoires", json={"name": "  Main  "})
    assert r.status_code == 201
    rep = r.json()
    assert rep == {"id": rep["id"], "name": "Main", "openings": 0}

    assert client.post("/api/repertoires", json={"name": "Main"}).status_code == 409
    assert client.post("/api/repertoires", json={"name": "   "}).status_code == 422

    assert client.patch(f"/api/repertoires/{rep['id']}", json={"name": "2026"}).json()["name"] == "2026"
    assert [x["name"] for x in client.get("/api/repertoires").json()] == ["2026"]

    assert client.delete(f"/api/repertoires/{rep['id']}").status_code == 204
    assert client.get("/api/repertoires").json() == []
    assert client.delete(f"/api/repertoires/{rep['id']}").status_code == 404


def test_rename_to_existing_name_conflicts(client):
    a = client.post("/api/repertoires", json={"name": "A"}).json()
    client.post("/api/repertoires", json={"name": "B"})
    assert client.patch(f"/api/repertoires/{a['id']}", json={"name": "B"}).status_code == 409


# ---- openings ---------------------------------------------------------------


def test_opening_crud_and_summary(client, rep):
    url = f"/api/repertoires/{rep['id']}/openings"
    r = client.post(url, json={"name": "Benoni", "color": "white"})
    assert r.status_code == 201
    o = r.json()
    assert (o["name"], o["color"], o["lines"], o["due"], o["next_review_on"]) == ("Benoni", "white", 0, 0, None)

    assert client.post(url, json={"name": "Benoni", "color": "black"}).status_code == 409
    assert client.post(url, json={"name": "Dutch", "color": "green"}).status_code == 422

    other = client.post("/api/repertoires", json={"name": "Other"}).json()
    assert client.post(f"/api/repertoires/{other['id']}/openings", json={"name": "Benoni", "color": "black"}).status_code == 201

    patched = client.patch(f"/api/openings/{o['id']}", json={"color": "black"}).json()
    assert patched["color"] == "black" and patched["name"] == "Benoni"

    assert client.get("/api/repertoires").json()[0]["openings"] == 1
    assert client.delete(f"/api/openings/{o['id']}").status_code == 204
    assert client.get(f"/api/openings/{o['id']}").status_code == 404
    assert client.get("/api/repertoires/999/openings").status_code == 404


# ---- adding lines -------------------------------------------------------


def test_add_new_line_generates_san(client, opening):
    r = add(client, opening, RUY)
    assert r.status_code == 201
    assert r.json() == {"status": "created", "line_id": r.json()["line_id"], "moves_added": 5}
    lines = client.get(f"/api/openings/{opening['id']}/lines").json()
    assert [m["san"] for m in lines[0]["moves"]] == ["e4", "e5", "Nf3", "Nc6", "Bb5"]
    assert lines[0]["next_review_on"] == date.today().isoformat()


def test_add_same_or_prefix_is_a_no_op(client, opening, db):
    line_id = add(client, opening, RUY).json()["line_id"]
    for moves in (RUY, RUY[:2]):
        r = add(client, opening, moves)
        assert r.status_code == 200
        assert r.json() == {"status": "exists", "line_id": line_id, "moves_added": 0}
    assert count(db, "lines") == 1


def test_extension_stores_correct_san_and_makes_line_due(client, opening, db):
    """Regression: the legacy app stored SAN from the start of the move list when extending."""
    line_id = add(client, opening, RUY).json()["line_id"]
    with db.begin() as conn:
        conn.execute(text("UPDATE lines SET next_review_on = :d"), {"d": date.today() + timedelta(days=30)})

    r = add(client, opening, RUY + ["a7a6", "b5a4"])
    assert r.json() == {"status": "extended", "line_id": line_id, "moves_added": 2}
    line = client.get(f"/api/openings/{opening['id']}/lines").json()[0]
    assert [m["san"] for m in line["moves"]] == ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4"]
    assert [m["ply"] for m in line["moves"]] == [1, 2, 3, 4, 5, 6, 7]
    assert line["next_review_on"] == date.today().isoformat()
    assert count(db, "lines") == 1


def test_branch_creates_new_line(client, opening, db):
    add(client, opening, RUY)
    assert add(client, opening, ITALIAN).json()["status"] == "created"
    assert count(db, "lines") == 2
    summary = client.get(f"/api/openings/{opening['id']}").json()
    assert (summary["lines"], summary["due"]) == (2, 2)


def test_positions_are_shared_not_duplicated(client, opening, db):
    add(client, opening, RUY)
    add(client, opening, ITALIAN)
    # start + 5 positions of the Ruy + 1 new position after Bc4
    assert count(db, "positions") == 7


@pytest.mark.parametrize(
    "moves,status",
    [
        (["e2e5"], 422),  # illegal
        (["e2e4", "e2e4"], 422),  # illegal second move
        (["castle"], 422),  # not UCI
        ([], 422),  # empty
    ],
)
def test_invalid_lines_rejected(client, opening, moves, status, db):
    assert add(client, opening, moves).status_code == status
    assert count(db, "lines") == 0


def test_add_line_to_missing_opening(client):
    assert client.post("/api/openings/42/lines", json={"moves": RUY}).status_code == 404


# ---- explorer -----------------------------------------------------------


def test_explorer_counts_moves_from_position(client, opening):
    add(client, opening, RUY)
    add(client, opening, ITALIAN)
    add(client, opening, ["d2d4", "d7d5"])
    oid = opening["id"]

    start = client.get(f"/api/openings/{oid}/explorer", params={"fen": START}).json()
    assert start == [{"uci": "e2e4", "san": "e4", "lines": 2, "transposes": False, "opening": None}, {"uci": "d2d4", "san": "d4", "lines": 1, "transposes": False, "opening": None}]

    pos = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
    moves = client.get(f"/api/openings/{oid}/explorer", params={"fen": pos}).json()
    assert {m["san"] for m in moves} == {"Bb5", "Bc4"}

    unknown = "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1"
    assert client.get(f"/api/openings/{oid}/explorer", params={"fen": unknown}).json() == []


def test_explorer_ignores_en_passant_field_and_counters(client, opening):
    """Regression: the legacy key kept the full FEN after a double pawn push."""
    add(client, opening, RUY)
    for fen in (AFTER_E4, AFTER_E4.replace(" e3 0 1", " - 5 40")):
        assert client.get(f"/api/openings/{opening['id']}/explorer", params={"fen": fen}).json() == [
            {"uci": "e7e5", "san": "e5", "lines": 1, "transposes": False, "opening": None}
        ]


def test_explorer_finds_transpositions(client, opening):
    add(client, opening, ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3"])
    add(client, opening, ["c2c4", "e7e6", "d2d4", "g8f6", "g1f3"])
    fen = "rnbqkb1r/pppp1ppp/4pn2/8/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3"
    moves = client.get(f"/api/openings/{opening['id']}/explorer", params={"fen": fen}).json()
    assert {m["san"] for m in moves} == {"Nc3", "Nf3"}


def test_explorer_moves_that_transpose_into_the_lines(client, opening):
    """d4 d5 c4 e6 Nf3 in the lines: after d4 d5 Nf3 e6 (not in them), c4 reaches the same position."""
    add(client, opening, ["d2d4", "d7d5", "c2c4", "e7e6", "g1f3", "g8f6"])
    add(client, opening, ["d2d4", "d7d5", "c2c4", "e7e6", "g1f3", "c7c5"])
    oid = opening["id"]
    fen = "rnbqkbnr/ppp2ppp/4p3/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 0 3"  # d4 d5 Nf3 e6
    assert client.get(f"/api/openings/{oid}/explorer", params={"fen": fen}).json() == [
        {"uci": "c2c4", "san": "c4", "lines": 2, "transposes": True, "opening": None}
    ]
    # in the lines: their own moves first, then any move into another part of them
    after_c4 = "rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2"
    moves = client.get(f"/api/openings/{oid}/explorer", params={"fen": after_c4}).json()
    assert moves[0] == {"uci": "e7e6", "san": "e6", "lines": 2, "transposes": False, "opening": None}
    assert all(m["transposes"] for m in moves[1:])


def test_explorer_moves_that_transpose_into_another_opening(client, rep, opening):
    """QGD (white) has d4 d5 c4 e6 Nf3; a London opening reaching d4 d5 Nf3 e6 sees c4 → QGD (purple)."""
    qgd = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "QGD", "color": "white"}).json()
    add(client, qgd, ["d2d4", "d7d5", "c2c4", "e7e6", "g1f3", "g8f6"])
    add(client, qgd, ["d2d4", "d7d5", "c2c4", "e7e6", "g1f3", "c7c5"])
    london = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "London", "color": "white"}).json()
    add(client, london, ["d2d4", "d7d5", "g1f3", "e7e6", "c1f4"])
    fen = "rnbqkbnr/ppp2ppp/4p3/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 0 3"  # d4 d5 Nf3 e6
    moves = client.get(f"/api/openings/{london['id']}/explorer", params={"fen": fen}).json()
    assert moves == [
        {"uci": "c1f4", "san": "Bf4", "lines": 1, "transposes": False, "opening": None},
        {"uci": "c2c4", "san": "c4", "lines": 2, "transposes": False, "opening": {"id": qgd["id"], "name": "QGD"}},
    ]
    # openings sharing the moves so far and splitting here: 2.c4 after 1.d4 d5 leads into the QGD
    after_d4_d5 = "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2"
    moves = client.get(f"/api/openings/{london['id']}/explorer", params={"fen": after_d4_d5}).json()
    assert [(m["san"], (m["opening"] or {}).get("name")) for m in moves] == [("Nf3", None), ("c4", "QGD")]
    # a move transposing within the opening itself stays blue, not purple
    add(client, london, ["d2d4", "d7d5", "c2c4", "e7e6", "g1f3"])
    moves = client.get(f"/api/openings/{london['id']}/explorer", params={"fen": fen}).json()
    assert {m["san"]: (m["transposes"], m["opening"]) for m in moves}["c4"] == (True, None)
    # other colour or another repertoire: ignored
    other = client.post("/api/repertoires", json={"name": "Other"}).json()
    o2 = client.post(f"/api/repertoires/{other['id']}/openings", json={"name": "London", "color": "white"}).json()
    add(client, o2, ["d2d4", "d7d5", "g1f3", "e7e6", "c1f4"])
    assert [m["san"] for m in client.get(f"/api/openings/{o2['id']}/explorer", params={"fen": fen}).json()] == ["Bf4"]
    client.patch(f"/api/openings/{qgd['id']}", json={"color": "black"})
    client.delete(f"/api/openings/{london['id']}")
    london = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "London", "color": "white"}).json()
    add(client, london, ["d2d4", "d7d5", "g1f3", "e7e6", "c1f4"])
    assert [m["san"] for m in client.get(f"/api/openings/{london['id']}/explorer", params={"fen": fen}).json()] == ["Bf4"]


def test_explorer_opponent_reply_covered_by_another_opening(client, rep, opening):
    """Jason's case: 1.d4 Nf6 2.Nc3 c5 in one White opening, 2...d5 in another."""
    a = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Jobava c5", "color": "white"}).json()
    add(client, a, ["d2d4", "g8f6", "b1c3", "c7c5", "d4d5"])
    b = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Jobava d5", "color": "white"}).json()
    add(client, b, ["d2d4", "g8f6", "b1c3", "d7d5", "c1f4"])
    fen = "rnbqkb1r/pppppppp/5n2/8/3P4/2N5/PPP1PPPP/R1BQKBNR b KQkq - 2 2"
    moves = client.get(f"/api/openings/{a['id']}/explorer", params={"fen": fen}).json()
    assert moves == [
        {"uci": "c7c5", "san": "c5", "lines": 1, "transposes": False, "opening": None},
        {"uci": "d7d5", "san": "d5", "lines": 1, "transposes": False, "opening": {"id": b["id"], "name": "Jobava d5"}},
    ]


def test_explorer_bad_fen(client, opening):
    assert client.get(f"/api/openings/{opening['id']}/explorer", params={"fen": "nope"}).status_code == 422


# ---- deleting lines -----------------------------------------------------


def test_delete_lines_through_position(client, opening, db):
    add(client, opening, RUY)
    add(client, opening, ITALIAN)
    add(client, opening, ["d2d4", "d7d5"])
    oid = opening["id"]
    url = f"/api/openings/{oid}/lines/through"

    assert client.get(url, params={"fen": AFTER_E4_E5}).json() == {"lines": 2}
    assert client.delete(url, params={"fen": AFTER_E4_E5}).json() == {"lines": 2}
    assert [line["moves"][0]["san"] for line in client.get(f"/api/openings/{oid}/lines").json()] == ["d4"]
    assert count(db, "moves") == 2  # moves of deleted lines cascaded away

    assert client.delete(url, params={"fen": START}).json() == {"lines": 1}
    assert count(db, "lines") == 0


def test_delete_through_only_touches_this_opening(client, rep, opening, db):
    other = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Other", "color": "black"}).json()
    add(client, opening, RUY)
    add(client, other, RUY)
    client.delete(f"/api/openings/{opening['id']}/lines/through", params={"fen": START})
    assert len(client.get(f"/api/openings/{other['id']}/lines").json()) == 1


def test_delete_single_line(client, opening):
    line_id = add(client, opening, RUY).json()["line_id"]
    assert client.delete(f"/api/lines/{line_id}").status_code == 204
    assert client.delete(f"/api/lines/{line_id}").status_code == 404


def test_deleting_opening_and_repertoire_cascades(client, rep, opening, db):
    add(client, opening, RUY)
    client.put(f"/api/repertoires/{rep['id']}/comment", json={"fen": START, "comment": "Hello"})
    client.delete(f"/api/openings/{opening['id']}")
    assert (count(db, "lines"), count(db, "moves")) == (0, 0)
    client.delete(f"/api/repertoires/{rep['id']}")
    assert count(db, "position_comments") == 0


# ---- comments -----------------------------------------------------------


def test_comments(client, rep):
    url = f"/api/repertoires/{rep['id']}/comment"
    assert client.get(url, params={"fen": AFTER_E4}).json()["comment"] == ""

    r = client.put(url, json={"fen": AFTER_E4, "comment": "  Best by test  "})
    assert r.json() == {"fen": AFTER_E4, "comment": "Best by test"}
    # Same position, different en passant field / counters
    assert client.get(url, params={"fen": AFTER_E4.replace(" e3 0 1", " - 0 1")}).json()["comment"] == "Best by test"

    client.put(url, json={"fen": AFTER_E4, "comment": "Updated"})
    assert client.get(url, params={"fen": AFTER_E4}).json()["comment"] == "Updated"

    other = client.post("/api/repertoires", json={"name": "Other"}).json()
    assert client.get(f"/api/repertoires/{other['id']}/comment", params={"fen": AFTER_E4}).json()["comment"] == ""

    client.put(url, json={"fen": AFTER_E4, "comment": "   "})
    assert client.get(url, params={"fen": AFTER_E4}).json()["comment"] == ""

    assert client.put(url, json={"fen": "bad", "comment": "x"}).status_code == 422
    assert client.get("/api/repertoires/999/comment", params={"fen": START}).status_code == 404


# ---- copying an opening to another repertoire ---------------------------------


def test_copy_opening_to_another_repertoire(client, rep, opening, db):
    ruy = add(client, opening, RUY).json()["line_id"]
    add(client, opening, ITALIAN)
    # history: a correct review of the Ruy (white plays plies 1, 3, 5)
    r = client.post(
        f"/api/lines/{ruy}/reviews",
        json={"attempts": [{"ply": 1, "uci": "e2e4"}, {"ply": 3, "uci": "g1f3"}, {"ply": 5, "uci": "f1b5"}]},
    ).json()
    client.put(f"/api/lines/{ruy}/bookmark", json={"note": "main line"})
    client.post(f"/api/openings/{opening['id']}/tags", json={"name": "1.e4 e5", "fen": AFTER_E4_E5})
    client.put(f"/api/repertoires/{rep['id']}/comment", json={"fen": AFTER_E4, "comment": "best by test"})
    client.put(f"/api/repertoires/{rep['id']}/comment", json={"fen": AFTER_E4_E5, "comment": "theirs"})
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO drill_attempts (opening_id, position_id, expected_uci, correct) "
                "SELECT :o, position_before_id, uci, false FROM moves WHERE line_id = :l AND ply = 1"
            ),
            {"o": opening["id"], "l": ruy},
        )

    other = client.post("/api/repertoires", json={"name": "2027"}).json()
    # the target already has its own comment on one of the positions: it's kept
    client.put(f"/api/repertoires/{other['id']}/comment", json={"fen": AFTER_E4_E5, "comment": "mine"})

    res = client.post(f"/api/openings/{opening['id']}/copy", json={"repertoire_id": other["id"]})
    assert res.status_code == 201
    copy = res.json()
    assert copy["id"] != opening["id"]
    assert copy["repertoire_id"] == other["id"]
    assert (copy["name"], copy["color"], copy["lines"]) == ("Open Games", "white", 2)
    assert (copy["tags"], copy["comments"]) == (1, 1)

    # original untouched
    assert [o["lines"] for o in client.get(f"/api/repertoires/{rep['id']}/openings").json()] == [2]
    assert count(db, "lines") == 4
    assert count(db, "moves") == 20
    assert count(db, "line_reviews") == 2
    assert count(db, "move_attempts") == 6
    assert count(db, "opening_tags") == 2
    assert count(db, "drill_attempts") == 2

    lines = client.get(f"/api/openings/{copy['id']}/lines").json()
    assert sorted(ln["moves"][-1]["uci"] for ln in lines) == ["f1b5", "f1c4"]
    training = client.get(f"/api/openings/{copy['id']}/training", params={"mode": "all"}).json()["lines"]
    ruy_copy = next(ln for ln in training if ln["moves"][-1]["uci"] == "f1b5")
    assert ruy_copy["streak"] == r["streak"] == 1
    assert ruy_copy["next_review_on"] == r["next_review_on"]
    assert (ruy_copy["bookmarked"], ruy_copy["bookmark_note"]) == (True, "main line")
    assert [t["name"] for t in client.get(f"/api/openings/{copy['id']}/tags").json()] == ["1.e4 e5"]

    comment = lambda rid, fen: client.get(f"/api/repertoires/{rid}/comment", params={"fen": fen}).json()["comment"]
    assert comment(other["id"], AFTER_E4) == "best by test"
    assert comment(other["id"], AFTER_E4_E5) == "mine"

    # deleting the original leaves the copy whole
    client.delete(f"/api/openings/{opening['id']}")
    assert client.get(f"/api/openings/{copy['id']}").json()["lines"] == 2
    assert count(db, "line_reviews") == 1


def test_copy_opening_name_conflict_and_rename(client, rep, opening):
    other = client.post("/api/repertoires", json={"name": "2027"}).json()
    client.post(f"/api/repertoires/{other['id']}/openings", json={"name": "Open Games", "color": "black"})
    url = f"/api/openings/{opening['id']}/copy"
    assert client.post(url, json={"repertoire_id": other["id"]}).status_code == 409
    res = client.post(url, json={"repertoire_id": other["id"], "name": "  Open Games (old)  "})
    assert res.status_code == 201 and res.json()["name"] == "Open Games (old)"
    # blank name keeps the original; copying within the same repertoire needs a new name
    assert client.post(url, json={"repertoire_id": rep["id"], "name": " "}).status_code == 409
    assert client.post(url, json={"repertoire_id": rep["id"], "name": "Open Games 2"}).status_code == 201


def test_copy_opening_missing(client, rep, opening):
    assert client.post("/api/openings/9999/copy", json={"repertoire_id": rep["id"]}).status_code == 404
    assert client.post(f"/api/openings/{opening['id']}/copy", json={"repertoire_id": 9999}).status_code == 404
