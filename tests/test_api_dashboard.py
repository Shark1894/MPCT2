from datetime import date, timedelta

import pytest
from sqlalchemy import text

from tests.conftest import count

TODAY = date.today()
CARO_ADV = ["e2e4", "c7c6", "d2d4", "d7d5", "e4e5", "c8f5"]
CARO_CLASSIC = ["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4"]


@pytest.fixture
def setup(client):
    rep = client.post("/api/repertoires", json={"name": "Main"}).json()
    o = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Caro", "color": "black"}).json()
    a = client.post(f"/api/openings/{o['id']}/lines", json={"moves": CARO_ADV}).json()["line_id"]
    b = client.post(f"/api/openings/{o['id']}/lines", json={"moves": CARO_CLASSIC}).json()["line_id"]
    return o, a, b


def black_moves(moves):
    return [{"ply": p, "uci": moves[p - 1]} for p in range(2, len(moves) + 1, 2)]


def review(client, line_id, moves, ok=True, practice=False):
    attempts = black_moves(moves)
    if not ok:
        attempts.insert(0, {"ply": 2, "uci": "e7e5"})
    return client.post(f"/api/lines/{line_id}/reviews", json={"practice": practice, "attempts": attempts}).json()


def test_dashboard_empty_history(client, setup):
    o, a, b = setup
    d = client.get(f"/api/openings/{o['id']}/dashboard").json()
    assert d["opening"]["name"] == "Caro"
    assert d["stats"] == {"lines": 2, "due": 2, "next_review_on": TODAY.isoformat(), "reviews": 0, "accuracy": None}
    line = d["lines"][0]
    assert line["moves"] == ["e4", "c6", "d4", "d5", "e5", "Bf5"]
    assert (line["streak"], line["recent"], line["reviews"], line["last_reviewed_at"]) == (0, [], 0, None)


def test_dashboard_history_stats_and_order(client, setup):
    o, a, b = setup
    for ok in (True, False, True, True, True, True):  # 6 reviews: last 5 shown
        review(client, a, CARO_ADV, ok)
    review(client, b, CARO_CLASSIC, ok=False)
    review(client, b, CARO_CLASSIC, practice=True)  # practice: excluded

    d = client.get(f"/api/openings/{o['id']}/dashboard").json()
    by_id = {line["id"]: line for line in d["lines"]}
    assert by_id[a]["recent"] == [False, True, True, True, True]
    assert (by_id[a]["streak"], by_id[a]["reviews"], by_id[a]["correct"]) == (4, 6, 5)
    assert by_id[a]["next_review_on"] == (TODAY + timedelta(days=14)).isoformat()
    assert by_id[b]["recent"] == [False]
    assert (by_id[b]["reviews"], by_id[b]["streak"]) == (1, 0)
    assert by_id[b]["last_reviewed_at"] is not None

    assert [line["id"] for line in d["lines"]] == [b, a]  # soonest review first
    assert d["stats"]["reviews"] == 7
    assert d["stats"]["accuracy"] == round(5 / 7, 3)
    assert d["stats"]["due"] == 1


def test_reset_line(client, setup, db):
    o, a, b = setup
    review(client, a, CARO_ADV)
    review(client, a, CARO_ADV)
    review(client, b, CARO_CLASSIC)
    assert client.post(f"/api/lines/{a}/reset").status_code == 204
    d = client.get(f"/api/openings/{o['id']}/dashboard").json()
    line_a = next(line for line in d["lines"] if line["id"] == a)
    assert (line_a["streak"], line_a["recent"], line_a["next_review_on"]) == (0, [], TODAY.isoformat())
    assert count(db, "line_reviews") == 1  # b's history untouched
    assert client.post("/api/lines/999/reset").status_code == 404


def test_reset_opening(client, setup, db):
    o, a, b = setup
    review(client, a, CARO_ADV)
    review(client, b, CARO_CLASSIC)
    assert client.post(f"/api/openings/{o['id']}/reset").json() == {"lines": 2}
    assert (count(db, "line_reviews"), count(db, "move_attempts")) == (0, 0)
    assert client.get(f"/api/openings/{o['id']}/dashboard").json()["stats"]["due"] == 2
    assert client.post("/api/openings/999/reset").status_code == 404


def test_delete_all_lines(client, setup, db):
    o, a, b = setup
    review(client, a, CARO_ADV)
    assert client.delete(f"/api/openings/{o['id']}/lines").json() == {"lines": 2}
    assert (count(db, "lines"), count(db, "moves"), count(db, "line_reviews")) == (0, 0, 0)
    assert client.get(f"/api/openings/{o['id']}").status_code == 200  # opening kept
    assert client.delete("/api/openings/999/lines").status_code == 404


def test_dashboard_missing_opening(client):
    assert client.get("/api/openings/999/dashboard").status_code == 404
