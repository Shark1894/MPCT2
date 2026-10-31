from datetime import date, timedelta

import pytest
from sqlalchemy import text

from tests.conftest import count

TODAY = date.today()
CARO = ["e2e4", "c7c6", "d2d4", "d7d5", "e4e5"]  # Black's moves: plies 2 and 4
RUY = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]  # White's moves: plies 1, 3, 5


@pytest.fixture
def rep(client):
    return client.post("/api/repertoires", json={"name": "Main"}).json()


def make_opening(client, rep, name, color, *lines):
    o = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": name, "color": color}).json()
    ids = [client.post(f"/api/openings/{o['id']}/lines", json={"moves": m}).json()["line_id"] for m in lines]
    return o, ids


def review(client, line_id, attempts, practice=False):
    return client.post(
        f"/api/lines/{line_id}/reviews",
        json={"practice": practice, "attempts": [{"ply": p, "uci": u} for p, u in attempts]},
    )


def perfect(moves, color):
    first = 1 if color == "white" else 2
    return [(p, moves[p - 1]) for p in range(first, len(moves) + 1, 2)]


def set_review_date(db, line_id, d):
    with db.begin() as conn:
        conn.execute(text("UPDATE lines SET next_review_on = :d WHERE id = :id"), {"d": d, "id": line_id})


# ---- which lines to train -------------------------------------------------


def test_due_lines_most_overdue_first(client, rep, db):
    o, (a, b, c) = make_opening(client, rep, "Ruy", "white", RUY, RUY[:4] + ["f1c4"], RUY[:2] + ["d2d4"])
    set_review_date(db, a, TODAY - timedelta(days=1))
    set_review_date(db, b, TODAY + timedelta(days=5))
    set_review_date(db, c, TODAY - timedelta(days=9))

    due = client.get(f"/api/openings/{o['id']}/training").json()
    assert due["opening"] == {"id": o["id"], "name": "Ruy", "color": "white"}
    assert [line["id"] for line in due["lines"]] == [c, a]
    assert [m["san"] for m in due["lines"][1]["moves"]] == ["e4", "e5", "Nf3", "Nc6", "Bb5"]
    assert due["lines"][0]["streak"] == 0

    every = client.get(f"/api/openings/{o['id']}/training", params={"mode": "all"}).json()
    assert [line["id"] for line in every["lines"]] == [c, a, b]

    one = client.get(f"/api/openings/{o['id']}/training", params={"line_id": b}).json()
    assert [line["id"] for line in one["lines"]] == [b]


def test_training_errors(client, rep):
    o, _ = make_opening(client, rep, "Ruy", "white", RUY)
    assert client.get(f"/api/openings/{o['id']}/training", params={"mode": "soon"}).status_code == 422
    assert client.get(f"/api/openings/{o['id']}/training", params={"line_id": 999}).status_code == 404
    assert client.get("/api/openings/999/training").status_code == 404


# ---- recording reviews ----------------------------------------------------


def test_correct_reviews_build_streak_and_push_review_date(client, rep, db):
    o, (line,) = make_opening(client, rep, "Caro", "black", CARO)
    expected_days = [1, 3, 7, 14, 30, 60, 60]
    for n, days in enumerate(expected_days, start=1):
        r = review(client, line, perfect(CARO, "black"))
        assert r.status_code == 201
        body = r.json()
        assert (body["correct"], body["mistakes"], body["streak"]) == (True, 0, n)
        assert body["next_review_on"] == (TODAY + timedelta(days=days)).isoformat()
    assert count(db, "line_reviews") == 7
    assert count(db, "move_attempts") == 14
    assert client.get(f"/api/openings/{o['id']}/training").json()["lines"] == []  # nothing due


def test_mistake_resets_streak_and_makes_line_due_today(client, rep, db):
    o, (line,) = make_opening(client, rep, "Caro", "black", CARO)
    for _ in range(3):
        review(client, line, perfect(CARO, "black"))
    r = review(client, line, [(2, "c7c6"), (4, "e7e6"), (4, "d7d6"), (4, "d7d5")]).json()
    assert (r["correct"], r["mistakes"], r["streak"]) == (False, 2, 0)
    assert r["next_review_on"] == TODAY.isoformat()
    due = client.get(f"/api/openings/{o['id']}/training").json()["lines"]
    assert [(line_["id"], line_["streak"]) for line_ in due] == [(line, 0)]

    with db.connect() as conn:
        wrong = conn.execute(text("SELECT played_uci FROM move_attempts WHERE NOT correct ORDER BY id")).scalars().all()
    assert wrong == ["e7e6", "d7d6"]  # the wrong moves actually played are kept


def test_practice_retry_does_not_change_schedule(client, rep):
    o, (line,) = make_opening(client, rep, "Caro", "black", CARO)
    review(client, line, perfect(CARO, "black"))  # streak 1, due tomorrow
    review(client, line, [(2, "c7c5"), (2, "c7c6"), (4, "d7d5")])  # mistake: streak 0, due today
    r = review(client, line, perfect(CARO, "black"), practice=True).json()
    assert (r["correct"], r["practice"], r["streak"]) == (True, True, 0)
    assert r["next_review_on"] == TODAY.isoformat()
    # The next real review continues from the reset streak, ignoring the practice run
    r = review(client, line, perfect(CARO, "black")).json()
    assert (r["streak"], r["next_review_on"]) == (1, (TODAY + timedelta(days=1)).isoformat())


def test_white_line_review(client, rep):
    _, (line,) = make_opening(client, rep, "Ruy", "white", RUY)
    r = review(client, line, perfect(RUY, "white")).json()
    assert (r["correct"], r["streak"]) == (True, 1)


@pytest.mark.parametrize(
    "attempts",
    [
        [(2, "c7c6")],  # ply 4 never played
        [(1, "e2e4"), (2, "c7c6"), (4, "d7d5")],  # ply 1 is the opponent's move
        [(2, "c7c6"), (4, "d7d5"), (6, "a7a6")],  # ply 6 doesn't exist
        [(2, "c7c6"), (4, "d7d6")],  # last move never played correctly
    ],
)
def test_invalid_reviews_rejected(client, rep, db, attempts):
    _, (line,) = make_opening(client, rep, "Caro", "black", CARO)
    assert review(client, line, attempts).status_code == 422
    assert count(db, "line_reviews") == 0


def test_review_missing_line(client):
    assert review(client, 999, [(1, "e2e4")]).status_code == 404


def test_deleting_line_deletes_its_history(client, rep, db):
    _, (line,) = make_opening(client, rep, "Caro", "black", CARO)
    review(client, line, perfect(CARO, "black"))
    client.delete(f"/api/lines/{line}")
    assert (count(db, "line_reviews"), count(db, "move_attempts")) == (0, 0)


def test_extending_a_line_keeps_history_and_makes_it_due(client, rep, db):
    o, (line,) = make_opening(client, rep, "Caro", "black", CARO)
    review(client, line, perfect(CARO, "black"))
    client.post(f"/api/openings/{o['id']}/lines", json={"moves": CARO + ["c8f5"]})
    due = client.get(f"/api/openings/{o['id']}/training").json()["lines"]
    assert [(d["id"], d["streak"], len(d["moves"])) for d in due] == [(line, 1, 6)]
