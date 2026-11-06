"""Creating an opening from a Chessable course export (synthetic data in Chessable's shape):
reading lines and notes, importing (lines, comments, chapter tags), re-importing."""

import json

import pytest

from app.core.chessable import NotALine, clean_text, parse_line
from app.repositories.course_import import walk_many
from app.core.positions import walk_line
from tests.conftest import count


def notes(*nodes):
    return json.dumps({"before": "x", "after": "y", "data": list(nodes)})


C = lambda text: {"key": "C", "state": "", "val": text}  # noqa: E731
S = lambda san: {"key": "S", "state": "", "val": san}  # noqa: E731
V = lambda *nodes: {"key": "V", "state": "", "val": list(nodes)}  # noqa: E731


def line(oid, sans, after=None, lid=1, chapter="1) Test Chapter", color="white", **game):
    after = after or {}
    data = [{"san": san, "before": None, "after": after.get(i + 1)} for i, san in enumerate(sans)]
    return {"game": {"data": data, "initial": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "bid": 9,
                     "oid": oid, "lid": lid, "name": "Test Course", "lineName": chapter, "title": f"Line {oid}",
                     "color": color, "isDel": False, "isInfo": 0, "isRef": 0, "isAlt": 0, **game}}


QGD = line(
    101,
    ["d4", "d5", "c4", "e6", "Nc3"],
    after={
        3: notes(C("White puts <strong>pressure</strong> on @@SANStart@@d5@@SANEnd@@.")),
        4: notes(V(C("The QGD @@StartBracket@@QGD@@EndBracket@@, or"), S("2...c6"), C(", the Slav."))),
        5: notes(C("Main move."), V(S("3.Nf3"), S("Nf6"), C("is also fine.")), V(S("3.cxd5?!"), S("exd5"))),
    },
)
SLAV = line(102, ["d4", "d5", "c4", "c6", "Nf3"], lid=2, chapter="2) Slav", after={4: notes(C("The Slav."))})
SLAV2 = line(103, ["d4", "d5", "c4", "c6", "Nf3", "Nf6", "Nc3"], lid=2, chapter="2) Slav")
CHAPTERS = [{"id": 1, "title": "1) Test Chapter"}, {"id": 2, "title": "2) Slav"}]


def test_clean_text():
    assert clean_text('Go <a href="/x">Chapter 2, </a> or @@SANStart@@Nf3@@SANEnd@@ &amp; more<br>next') == "Go Chapter 2, or Nf3 & more\nnext"
    assert clean_text("In style with @@StartFEN@@rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1@@EndFEN@@ 1.d4") == "In style with 1.d4"


def test_parse_line():
    cl = parse_line(QGD)
    assert (cl.course, cl.chapter, cl.chapter_id, cl.line_id, cl.color, cl.kind) == ("Test Course", "1) Test Chapter", 1, 101, "white", "line")
    assert cl.ucis == ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3"]
    assert cl.comments == {
        3: "White puts pressure on d5.",
        4: "The QGD (QGD), or 2...c6, the Slav.",  # prose with a move in it: no brackets
        5: "Main move.\n\n(3.Nf3 Nf6 is also fine.)\n\n(3.cxd5?! exd5)",
    }
    assert parse_line(line(1, ["e4"], isRef=1)).kind == "reference"
    with pytest.raises(NotALine):
        parse_line({"game": {"data": [], "color": "white"}})
    with pytest.raises(NotALine):
        parse_line(line(1, ["e4", "e4"]))  # illegal
    with pytest.raises(NotALine):
        parse_line(line(1, ["e4"], initial="8/8/8/8/8/8/8/K6k w - - 0 1"))


def test_walk_many_matches_walk_line():
    lines = [["d2d4", "d7d5", "c2c4"], ["d2d4", "g8f6"], ["e2e4"], ["d2d4", "d7d5", "c2c4", "e7e6"]]
    many = walk_many(lines)
    for m in lines:
        assert many[tuple(m)] == walk_line(m)


def post(client, rep_id, lines, **kw):
    r = client.post(f"/api/repertoires/{rep_id}/import-course", json={"name": kw.pop("name", "Course"), "lines": lines, "chapters": CHAPTERS, **kw})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def rep(client):
    return client.post("/api/repertoires", json={"name": "Main"}).json()


def test_import(client, rep, db):
    r = post(client, rep["id"], [QGD, SLAV, SLAV2, line(104, ["d4"]), line(105, ["e4"], isInfo=1)])
    assert r["created_opening"] and r["color"] == "white" and r["opening"] == "Course"
    assert (r["lines_read"], r["lines_created"], r["lines_covered"]) == (4, 2, 2)  # Slav inside Slav2, 1.d4 inside both
    assert r["comments_added"] == 4
    assert r["tags"] == ["1) Test Chapter", "2) Slav"]
    assert count(db, "lines") == 2 and count(db, "opening_tags") == 2
    opening = client.get(f"/api/repertoires/{rep['id']}/openings").json()[0]
    assert (opening["lines"], opening["due"], opening["color"]) == (2, 2, "white")
    after_c4 = "rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2"
    assert client.get(f"/api/repertoires/{rep['id']}/comment", params={"fen": after_c4}).json()["comment"] == "White puts pressure on d5."
    tags = client.get(f"/api/openings/{opening['id']}/tags").json()
    assert {t["name"]: t["lines"] for t in tags} == {"1) Test Chapter": 1, "2) Slav": 1}


def test_reimport_and_adding_to_an_opening(client, rep, db):
    after_c4 = "rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2"
    client.put(f"/api/repertoires/{rep['id']}/comment", json={"fen": after_c4, "comment": "My own note."})
    first = post(client, rep["id"], [QGD], tags=False)
    again = post(client, rep["id"], [QGD, SLAV])
    assert not again["created_opening"]
    assert (again["lines_created"], again["lines_covered"], again["comments_added"], again["comments_existing"]) == (1, 1, 1, 3)
    assert count(db, "openings") == 1 and count(db, "lines") == 2
    text = client.get(f"/api/repertoires/{rep['id']}/comment", params={"fen": after_c4}).json()["comment"]
    assert text == "My own note.\n\nWhite puts pressure on d5."  # your comment kept, the note added once
    longer = post(client, rep["id"], [line(106, ["d4", "d5", "c4", "e6", "Nc3", "Nf6"])], comments=False, tags=False)
    assert longer["lines_extended"] == 1 and count(db, "lines") == 2
    assert first["comments_added"] == 3


def test_errors(client, rep):
    r = client.post(f"/api/repertoires/{rep['id']}/import-course", json={"name": "X", "lines": [], "chapters": []})
    assert r.status_code == 422
    post(client, rep["id"], [QGD], name="Clash", tags=False)
    r = client.post(f"/api/repertoires/{rep['id']}/import-course", json={"name": "Clash", "lines": [line(1, ["e4", "c6"], color="black")], "chapters": []})
    assert r.status_code == 409  # same name, other colour
    r = post(client, rep["id"], [line(7, ["e4", "e4"]), SLAV], name="Mixed", tags=False)
    assert r["lines_created"] == 1 and len(r["skipped"]) == 1  # the illegal line is reported, the rest imported


def test_comment_modes(client, rep):
    after_c4 = "rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2"
    comment = lambda: client.get(f"/api/repertoires/{rep['id']}/comment", params={"fen": after_c4}).json()["comment"]
    client.put(f"/api/repertoires/{rep['id']}/comment", json={"fen": after_c4, "comment": "My own note."})

    keep = post(client, rep["id"], [QGD], name="Keep", tags=False, comment_mode="keep")
    assert comment() == "My own note."  # left alone
    assert keep["comments_kept"] == 1 and keep["comments_added"] == 2 and keep["comments_replaced"] == 0  # other positions still get notes

    replace = post(client, rep["id"], [QGD], name="Keep", tags=False, comment_mode="replace")
    assert comment() == "White puts pressure on d5."  # your text gone, the course's note instead
    assert replace["comments_replaced"] == 1 and replace["comments_added"] == 0  # the other two already hold exactly the course's notes
    again = post(client, rep["id"], [QGD], name="Keep", tags=False, comment_mode="replace")
    assert again["comments_replaced"] == 0  # already the course's notes: nothing rewritten

    client.put(f"/api/repertoires/{rep['id']}/comment", json={"fen": after_c4, "comment": "Mine again."})
    post(client, rep["id"], [QGD], name="Keep", tags=False)  # default: add under
    assert comment() == "Mine again.\n\nWhite puts pressure on d5."

    r = client.post(f"/api/repertoires/{rep['id']}/import-course", json={"name": "X", "lines": [QGD], "chapters": [], "comment_mode": "merge"})
    assert r.status_code == 422
