"""The Training tab: importing a Chessable tactics/strategy course, reading it, progress, re-import."""

import pytest

from app.core.chessable import NotALine, parse_exercise, parse_line
from tests.conftest import count
from tests.test_course_import import C, notes

# A mate in two from a set-up position, Black to move first (so your first move is White's 2nd ply).
MATE_FEN = "6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1"


def ex(oid, sans, initial=MATE_FEN, lid=1, chapter="1) Mates", color="white", before=None, after=None, **game):
    after = after or {}
    data = [{"san": san, "before": (before if i == 0 else None), "after": after.get(i + 1)} for i, san in enumerate(sans)]
    return {"game": {"data": data, "initial": initial, "bid": 77, "oid": oid, "lid": lid, "name": "Tactics 101",
                     "lineName": chapter, "title": f"Ex {oid}", "color": color, "isDel": False, "isInfo": 0,
                     "isRef": 0, "isAlt": 0, **game}}


BACK_RANK = ex(1, ["h6", "Ra8+", "Kh7"], before=notes(C("Black has just one move.")), after={2: notes(C("Check!"))})
INFO = ex(2, [], initial="8/8/8/8/8/8/8/K6k w - - 0 1", isInfo=1, before=None, title="About this course")
BLACK = ex(3, ["Kh1", "Qxg2#"], initial="6k1/8/8/8/8/6q1/6P1/6K1 w - - 0 1", lid=2, chapter="2) Black to play", color="black")
CHAPTERS = [{"id": 1, "title": "1) Mates"}, {"id": 2, "title": "2) Black to play"}]


def post(client, lines, **kw):
    r = client.post("/api/courses/import", json={"name": "", "kind": "tactics", "lines": lines, "chapters": CHAPTERS, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def test_parse_exercise():
    e = parse_exercise(BACK_RANK)
    assert (e.start_fen, e.color, e.ucis, e.kind) == (MATE_FEN, "white", ["h7h6", "a1a8", "g8h7"], "line")
    assert e.comments == {0: "Black has just one move.", 2: "Check!"}
    with pytest.raises(NotALine):
        parse_line(BACK_RANK)  # an opening import still wants the initial position
    info = parse_exercise(INFO)
    assert info.kind == "info" and info.ucis == []
    with pytest.raises(NotALine):
        parse_exercise(ex(9, ["e4"]))  # illegal from the set-up position


def test_import_read_and_progress(client, db):
    r = post(client, [BACK_RANK, INFO, BLACK, ex(9, ["Kh8"], isDel=True)])
    assert r["created_course"] and r["course"] == "Tactics 101" and r["added"] == 3 and len(r["skipped"]) == 1
    [summary] = client.get("/api/courses").json()
    assert (summary["total"], summary["new"], summary["kind"]) == (3, 3, "tactics")
    course = client.get(f"/api/courses/{r['course_id']}").json()
    assert [c["title"] for c in course["chapters"]] == ["1) Mates", "2) Black to play"]
    first = course["chapters"][0]["exercises"]
    assert [(e["title"], e["kind"], e["moves"]) for e in first] == [("Ex 1", "line", 3), ("About this course", "info", 0)]

    e = client.get(f"/api/exercises/{first[0]['id']}").json()
    assert e["start_fen"] == MATE_FEN and e["sans"] == ["h6", "Ra8+", "Kh7"] and e["comments"] == {"0": "Black has just one move.", "2": "Check!"}

    assert client.post(f"/api/exercises/{first[0]['id']}/attempt", json={"solved": False}).json()["status"] == "missed"
    done = client.post(f"/api/exercises/{first[0]['id']}/attempt", json={"solved": True}).json()
    assert (done["status"], done["attempts"], done["solved_count"]) == ("solved", 2, 1)
    client.post(f"/api/exercises/{first[1]['id']}/attempt", json={"solved": False})
    course = client.get(f"/api/courses/{r['course_id']}").json()
    assert (course["solved"], course["missed"], course["new"]) == (1, 1, 1)
    assert course["chapters"][0]["solved"] == 1 and course["chapters"][1]["new"] == 1

    assert client.post(f"/api/courses/{r['course_id']}/reset", json={"chapter_id": course["chapters"][0]["id"]}).json() == {"reset": 2}
    assert client.get("/api/courses").json()[0]["new"] == 3


def test_reimport_keeps_progress(client, db):
    r = post(client, [BACK_RANK, BLACK])
    ids = {e["title"]: e["id"] for ch in client.get(f"/api/courses/{r['course_id']}").json()["chapters"] for e in ch["exercises"]}
    client.post(f"/api/exercises/{ids['Ex 1']}/attempt", json={"solved": True})
    client.post(f"/api/exercises/{ids['Ex 3']}/attempt", json={"solved": True})
    changed = ex(3, ["Kf1", "Qxg2+"], initial="6k1/8/8/8/8/6q1/6P1/6K1 w - - 0 1", lid=2, chapter="2) Black to play", color="black")
    again = post(client, [BACK_RANK, changed, INFO], kind="strategy")
    assert not again["created_course"] and (again["added"], again["updated"], again["unchanged"], again["reset"]) == (1, 1, 1, 1)
    assert count(db, "courses") == 1 and count(db, "course_exercises") == 3
    course = client.get(f"/api/courses/{r['course_id']}").json()
    status = {e["title"]: e["status"] for ch in course["chapters"] for e in ch["exercises"]}
    assert status == {"Ex 1": "solved", "About this course": "new", "Ex 3": "new"} and course["kind"] == "strategy"


def test_edit_delete_and_errors(client, db):
    r = post(client, [BACK_RANK])
    assert client.patch(f"/api/courses/{r['course_id']}", json={"name": "Mates", "kind": "endgames"}).json()["kind"] == "endgames"
    other = ex(5, ["h6"], bid=78)
    other["game"]["bid"] = 78
    assert client.post("/api/courses/import", json={"name": "Mates", "lines": [other], "chapters": []}).status_code == 409
    assert client.post("/api/courses/import", json={"name": "X", "lines": [], "chapters": []}).status_code == 422
    assert client.post("/api/courses/import", json={"name": "X", "kind": "openings", "lines": [BACK_RANK]}).status_code == 422
    assert client.get("/api/exercises/999").status_code == 404
    assert client.delete(f"/api/courses/{r['course_id']}").status_code == 204
    assert count(db, "course_exercises") == 0
