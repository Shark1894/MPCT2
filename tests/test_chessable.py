"""Chessable course import: reading a line (synthetic data in Chessable's shape), importing it,
re-running, and reading a fetch_chessable folder in course order."""

import json

import pytest
from sqlalchemy.orm import Session

from app.core.chessable import NotALine, clean_text, parse_line
from app.tools import import_chessable as tool
from tests.conftest import count


def notes(*nodes):
    return json.dumps({"before": "x", "after": "y", "data": list(nodes)})


C = lambda text: {"key": "C", "state": "", "val": text}  # noqa: E731
S = lambda san: {"key": "S", "state": "", "val": san}  # noqa: E731
V = lambda *nodes: {"key": "V", "state": "", "val": list(nodes)}  # noqa: E731


def line(oid, sans, after=None, lid=1, chapter="1) Test Chapter", color="white", **game):
    after = after or {}
    data = [{"id": i, "san": san, "before": "", "after": after.get(i + 1, "")} for i, san in enumerate(sans)]
    return {"game": {"data": data, "initial": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "bid": 9,
                     "oid": oid, "lid": lid, "name": "Test Course", "lineName": chapter, "title": f"Line {oid}",
                     "color": color, "isDel": False, "commentsByFEN": {"x": [{"comment": "forum"}]}, **game}}


LINE = line(
    101,
    ["d4", "d5", "c4", "e6", "Nc3"],
    after={
        3: notes(C("White puts <strong>pressure</strong> on @@SANStart@@d5@@SANEnd@@.")),
        4: notes(V(C("The QGD @@StartBracket@@QGD@@EndBracket@@, or"), S("2...c6"), C(", the Slav."))),
        5: notes(C("Main move."), V(S("3.Nf3"), S("Nf6"), C("is also fine.")), V(S("3.cxd5?!"), S("exd5"))),
    },
)


def test_clean_text():
    assert clean_text('Go <a href="/x">Chapter 2, </a> or @@SANStart@@Nf3@@SANEnd@@ &amp; more<br>next') == "Go Chapter 2, or Nf3 & more\nnext"


def test_parse_line():
    cl = parse_line(LINE)
    assert (cl.course, cl.course_id, cl.chapter, cl.chapter_id, cl.line_id, cl.color) == ("Test Course", 9, "1) Test Chapter", 1, 101, "white")
    assert cl.ucis == ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3"]
    assert cl.comments[3] == "White puts pressure on d5."
    assert cl.comments[4] == "The QGD (QGD), or 2...c6, the Slav."  # prose block: no brackets
    assert cl.comments[5] == "Main move.\n\n(3.Nf3 Nf6 is also fine.)\n\n(3.cxd5?! exd5)"
    assert set(cl.comments) == {3, 4, 5}


def test_not_a_line():
    with pytest.raises(NotALine):
        parse_line({"game": {"data": [], "color": "white"}})
    with pytest.raises(NotALine):
        parse_line(line(1, ["e4"], initial="8/8/8/8/8/8/8/K6k w - - 0 1"))
    with pytest.raises(NotALine):
        parse_line(line(1, ["e4", "e4"]))  # illegal


def run(db, lines, **kw):
    report = tool.Report()
    with Session(db) as s:
        tool.import_lines(s, lines, report, **kw)
        s.commit()
    return report


def test_import_and_rerun(db):
    first = run(db, [parse_line(LINE), parse_line(line(102, ["d4", "d5", "c4", "c6"]))])
    assert (first.lines_created, first.comments_added) == (2, 3)
    assert first.repertoires == {"Test Course"}
    assert count(db, "openings") == 1 and count(db, "lines") == 2 and count(db, "position_comments") == 3
    again = run(db, [parse_line(LINE)])
    assert (again.lines_created, again.lines_existing, again.comments_added, again.comments_existing) == (0, 1, 0, 3)
    assert count(db, "position_comments") == 3
    longer = run(db, [parse_line(line(103, ["d4", "d5", "c4", "e6", "Nc3", "Nf6"]))])
    assert longer.lines_extended == 1 and count(db, "lines") == 2


def test_note_added_to_an_existing_comment(db, client):
    rep = client.post("/api/repertoires", json={"name": "Test Course"}).json()
    after_c4 = "rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2"
    client.put(f"/api/repertoires/{rep['id']}/comment", json={"fen": after_c4, "comment": "My own note."})
    run(db, [parse_line(LINE)])
    text = client.get(f"/api/repertoires/{rep['id']}/comment", params={"fen": after_c4}).json()["comment"]
    assert text == "My own note.\n\nWhite puts pressure on d5."


def test_black_course_and_repertoire_option(db):
    r = run(db, [parse_line(line(201, ["e4", "c6"], color="black", chapter="Caro"))], repertoire_name="Mine")
    assert r.repertoires == {"Mine"} and r.openings == {"Caro": 1}


def test_course_folder_order(tmp_path):
    (tmp_path / "course.json").write_text(json.dumps({"course": {"data": [
        {"id": 2, "order": 3, "title": "Second"}, {"id": 1, "order": 2, "title": "First"}, {"id": 17, "order": 1, "title": "Skipped"}]}}))
    (tmp_path / "chapter-1.json").write_text(json.dumps({"openings": [12, 11]}))
    (tmp_path / "chapter-2.json").write_text(json.dumps({"openings": [21, 22]}))
    for oid, lid in ((11, 1), (12, 1), (21, 2)):
        (tmp_path / f"line-{oid}.json").write_text(json.dumps(line(oid, ["d4"], lid=lid)))
    report = tool.Report()
    lines = tool.read_files([tmp_path], report)
    assert [x.line_id for x in lines] == [12, 11, 21]
    assert any("22 not downloaded" in s for s in report.skipped)


def test_fetch_course_resumes_and_skips(tmp_path):
    from app.tools import fetch_chessable as fetch

    class Fake:
        requests = 0

        def __init__(self):
            self.calls = []

        def get(self, endpoint, params):
            self.calls.append((endpoint, params))
            if endpoint == "getCourse":
                return {"course": {"name": "Test", "data": [{"id": 17, "order": 1, "title": "Quick"}, {"id": 1, "order": 2, "title": "One"}]}}
            if endpoint == "getOpeningsForBookLevelInCorrectOrder":
                return {"openings": [11, 12]}
            return line(params["oid"], ["d4"])

    first = Fake()
    assert fetch.fetch_course(first, 9, 5, tmp_path, None, {17}, False) == 2
    assert [c[0] for c in first.calls] == ["getCourse", "getOpeningsForBookLevelInCorrectOrder", "getGame", "getGame"]
    assert first.calls[2][1] == {"lng": "en", "uid": 5, "oid": 11}
    assert "commentsByFEN" not in json.loads((tmp_path / "line-11.json").read_text())["game"]  # forum dropped
    (tmp_path / "line-12.json").unlink()  # as if stopped part-way
    again = Fake()
    assert fetch.fetch_course(again, 9, 5, tmp_path, None, {17}, False) == 1
    assert [c[0] for c in again.calls] == ["getGame"]  # everything else from the folder
    assert [x.line_id for x in tool.read_files([tmp_path], tool.Report())] == [11, 12]


def test_headers_file(tmp_path):
    from app.tools import fetch_chessable as fetch

    f = tmp_path / "h.txt"
    f.write_text(
        "GET /api/v1/getGame?lng=en&uid=4242&oid=1 HTTP/2\nHost: www.chessable.com\n"
        "User-Agent: Mozilla/5.0 Firefox\nAccept-Encoding: gzip, br\nCookie: a=b; c=d\nReferer: https://www.chessable.com/variation/1/\n"
    )
    headers, api, uid = fetch.read_headers(f)
    assert headers == {"User-Agent": "Mozilla/5.0 Firefox", "Cookie": "a=b; c=d", "Referer": "https://www.chessable.com/variation/1/"}
    assert (api, uid) == ("https://www.chessable.com/api/v1", 4242)
    f.write_text("Authorization: Bearer xyz\n")
    assert fetch.read_headers(f) == ({"Authorization": "Bearer xyz"}, None, None)
    f.write_text("User-Agent: x\n")
    with pytest.raises(fetch.Stop):
        fetch.read_headers(f)
