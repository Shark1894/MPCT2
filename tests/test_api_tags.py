from datetime import date, timedelta

import pytest
from sqlalchemy import text

from tests.conftest import count

QGA_FEN = "rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3"  # 1.d4 d5 2.c4 dxc4
QGA_E4_FEN = "rnbqkbnr/ppp1pppp/8/8/2pPP3/8/PP3PPP/RNBQKBNR b KQkq - 0 3"  # ...3.e4
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

QGA_E4 = ["d2d4", "d7d5", "c2c4", "d5c4", "e2e4", "e7e5"]
QGA_E3 = ["d2d4", "d7d5", "c2c4", "d5c4", "e2e3", "g8f6"]
QGA_NF3 = ["d2d4", "d7d5", "c2c4", "d5c4", "g1f3", "g8f6"]
QGD = ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6"]
# Same QGA position reached by a different move order (transposition)
QGA_TRANSPOSED = ["c2c4", "d7d5", "d2d4", "d5c4", "g1f3", "a7a6"]


@pytest.fixture
def opening(client):
    rep = client.post("/api/repertoires", json={"name": "Main"}).json()
    o = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "QG", "color": "black"}).json()
    ids = {}
    for name, moves in [("e4", QGA_E4), ("e3", QGA_E3), ("nf3", QGA_NF3), ("qgd", QGD)]:
        ids[name] = client.post(f"/api/openings/{o['id']}/lines", json={"moves": moves}).json()["line_id"]
    o["line_ids"] = ids
    return o


def tag(client, opening, name, fen):
    return client.post(f"/api/openings/{opening['id']}/tags", json={"name": name, "fen": fen})


def test_create_and_list_tags(client, opening):
    r = tag(client, opening, "Queen's Gambit Accepted", QGA_FEN)
    assert r.status_code == 201
    t = r.json()
    assert (t["name"], t["path"], t["lines"], t["due"]) == ("Queen's Gambit Accepted", ["d4", "d5", "c4", "dxc4"], 3, 3)
    assert t["key"] == "rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq -"

    tag(client, opening, "QGA 3.e4", QGA_E4_FEN)
    tags = client.get(f"/api/openings/{opening['id']}/tags").json()
    assert [(t["name"], t["lines"]) for t in tags] == [("Queen's Gambit Accepted", 3), ("QGA 3.e4", 1)]  # shallow first


def test_tag_follows_new_lines_and_transpositions(client, opening):
    tag(client, opening, "QGA", QGA_FEN)
    client.post(f"/api/openings/{opening['id']}/lines", json={"moves": QGA_TRANSPOSED})
    assert client.get(f"/api/openings/{opening['id']}/tags").json()[0]["lines"] == 4


def test_tag_validation(client, opening):
    assert tag(client, opening, "Everything", START).status_code == 422  # start position
    unreached = "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1"
    r = tag(client, opening, "Reti", unreached)
    assert r.status_code == 422 and "No line" in r.json()["detail"]
    assert tag(client, opening, "Bad", "nonsense").status_code == 422
    assert tag(client, opening, "  ", QGA_FEN).status_code == 422

    assert tag(client, opening, "QGA", QGA_FEN).status_code == 201
    r = tag(client, opening, "Other name", QGA_FEN)
    assert r.status_code == 409 and "already tagged as 'QGA'" in r.json()["detail"]
    assert tag(client, opening, "QGA", QGA_E4_FEN).status_code == 409  # duplicate name


def test_tags_belong_to_one_opening(client, opening):
    other = client.post(f"/api/repertoires/{opening['repertoire_id']}/openings", json={"name": "Other", "color": "black"}).json()
    client.post(f"/api/openings/{other['id']}/lines", json={"moves": QGA_E4})
    t = tag(client, opening, "QGA", QGA_FEN).json()
    assert client.get(f"/api/openings/{other['id']}/tags").json() == []
    assert tag(client, other, "QGA", QGA_FEN).status_code == 201  # same name/position fine elsewhere
    # A tag can't be used to filter another opening
    assert client.get(f"/api/openings/{other['id']}/training", params={"tag_id": t["id"]}).status_code == 404
    assert client.get(f"/api/openings/{other['id']}/dashboard", params={"tag_id": t["id"]}).status_code == 404


def test_rename_and_delete(client, opening, db):
    t = tag(client, opening, "QGA", QGA_FEN).json()
    tag(client, opening, "QGA 3.e4", QGA_E4_FEN)
    assert client.patch(f"/api/tags/{t['id']}", json={"name": "Accepted"}).json()["name"] == "Accepted"
    assert client.patch(f"/api/tags/{t['id']}", json={"name": "QGA 3.e4"}).status_code == 409
    assert client.delete(f"/api/tags/{t['id']}").status_code == 204
    assert count(db, "lines") == 4  # lines untouched
    assert client.delete(f"/api/tags/{t['id']}").status_code == 404
    assert client.patch("/api/tags/999", json={"name": "x"}).status_code == 404


def test_training_filtered_by_tag(client, opening, db):
    t = tag(client, opening, "QGA", QGA_FEN).json()
    e4 = tag(client, opening, "QGA 3.e4", QGA_E4_FEN).json()
    ids = opening["line_ids"]
    with db.begin() as conn:  # make only the e3 line not due
        conn.execute(text("UPDATE lines SET next_review_on = :d WHERE id = :id"), {"d": date.today() + timedelta(days=3), "id": ids["e3"]})

    url = f"/api/openings/{opening['id']}/training"
    due = client.get(url, params={"tag_id": t["id"]}).json()["lines"]
    assert sorted(line["id"] for line in due) == sorted([ids["e4"], ids["nf3"]])
    every = client.get(url, params={"tag_id": t["id"], "mode": "all"}).json()["lines"]
    assert sorted(line["id"] for line in every) == sorted([ids["e4"], ids["e3"], ids["nf3"]])
    assert [line["id"] for line in client.get(url, params={"tag_id": e4["id"]}).json()["lines"]] == [ids["e4"]]
    assert client.get(f"/api/openings/{opening['id']}/tags").json()[0]["due"] == 2


def test_dashboard_filtered_by_tag(client, opening):
    t = tag(client, opening, "QGA", QGA_FEN).json()
    e4 = tag(client, opening, "QGA 3.e4", QGA_E4_FEN).json()
    ids = opening["line_ids"]
    full = client.get(f"/api/openings/{opening['id']}/dashboard").json()
    assert full["tag_id"] is None and full["stats"]["lines"] == 4
    by_id = {line["id"]: line["tags"] for line in full["lines"]}
    assert by_id[ids["e4"]] == sorted([t["id"], e4["id"]])
    assert by_id[ids["qgd"]] == []

    branch = client.get(f"/api/openings/{opening['id']}/dashboard", params={"tag_id": t["id"]}).json()
    assert branch["tag_id"] == t["id"]
    assert (branch["stats"]["lines"], branch["stats"]["due"]) == (3, 3)
    assert {line["id"] for line in branch["lines"]} == {ids["e4"], ids["e3"], ids["nf3"]}


def test_tag_with_no_lines_left(client, opening):
    t = tag(client, opening, "QGA 3.e4", QGA_E4_FEN).json()
    client.delete(f"/api/lines/{opening['line_ids']['e4']}")
    listed = client.get(f"/api/openings/{opening['id']}/tags").json()
    assert [(x["name"], x["lines"], x["path"]) for x in listed] == [("QGA 3.e4", 0, [])]
    assert client.get(f"/api/openings/{opening['id']}/training", params={"tag_id": t["id"], "mode": "all"}).json()["lines"] == []


def test_deleting_opening_deletes_its_tags(client, opening, db):
    tag(client, opening, "QGA", QGA_FEN)
    client.delete(f"/api/openings/{opening['id']}")
    assert count(db, "opening_tags") == 0
