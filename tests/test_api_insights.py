"""Dashboard insights: learning stages, forecast, problem positions, overview, activity."""

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.repositories.insights import forecast, stage

TODAY = date.today()
CARO_ADV = ["e2e4", "c7c6", "d2d4", "d7d5", "e4e5", "c8f5"]
CARO_CLASSIC = ["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4"]
CARO_EXCH = ["e2e4", "c7c6", "d2d4", "d7d5", "e4d5", "c6d5"]


@pytest.fixture
def setup(client):
    rep = client.post("/api/repertoires", json={"name": "Main"}).json()
    o = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Caro", "color": "black"}).json()
    ids = [
        client.post(f"/api/openings/{o['id']}/lines", json={"moves": m}).json()["line_id"]
        for m in (CARO_ADV, CARO_CLASSIC, CARO_EXCH)
    ]
    return rep, o, ids


def review(client, line_id, moves, wrong=None, practice=False):
    """Review a Black line; wrong = {ply: uci} adds a wrong try before the right move."""
    attempts = []
    for p in range(2, len(moves) + 1, 2):
        if wrong and p in wrong:
            attempts.append({"ply": p, "uci": wrong[p]})
        attempts.append({"ply": p, "uci": moves[p - 1]})
    r = client.post(f"/api/lines/{line_id}/reviews", json={"practice": practice, "attempts": attempts})
    assert r.status_code == 201, r.text
    return r.json()


def test_stage_boundaries():
    assert stage(0, False) == "new"
    assert [stage(n, True) for n in (0, 1, 2, 4, 5, 9)] == ["learning", "learning", "known", "known", "mastered", "mastered"]


def test_forecast_counts_overdue_as_today():
    f = forecast([TODAY - timedelta(days=3), TODAY, TODAY + timedelta(days=1), TODAY + timedelta(days=40)], TODAY, 3)
    assert [d["due"] for d in f["days"]] == [2, 1, 0]
    assert f["days"][0]["date"] == TODAY
    assert f["later"] == 1


def test_dashboard_mastery_and_forecast(client, setup):
    _, o, (a, b, c) = setup
    for _ in range(5):
        review(client, a, CARO_ADV)  # streak 5: mastered, due in 30 days
    review(client, b, CARO_CLASSIC)
    review(client, b, CARO_CLASSIC)  # streak 2: known, due in 3 days
    d = client.get(f"/api/openings/{o['id']}/dashboard").json()
    assert d["stats"]["mastery"] == {"new": 1, "learning": 0, "known": 1, "mastered": 1}
    days = d["forecast"]["days"]
    assert len(days) == 14 and days[0]["date"] == TODAY.isoformat()
    assert (days[0]["due"], days[3]["due"], d["forecast"]["later"]) == (1, 1, 1)


def test_problem_positions_grouped_across_lines(client, setup):
    _, o, (a, b, c) = setup
    # 2...c6 is in every line: wrong in two lines, with two different wrong moves
    review(client, a, CARO_ADV, wrong={2: "e7e5"})
    review(client, b, CARO_CLASSIC, wrong={2: "e7e5"})
    review(client, c, CARO_EXCH, wrong={2: "c7c5", 6: "d8d5"})
    d = client.get(f"/api/openings/{o['id']}/dashboard").json()
    probs = d["problems"]
    assert [p["expected"] for p in probs] == ["c6", "cxd5"]
    top = probs[0]
    assert top["moves"] == ["e4"] and top["ply"] == 2
    assert (top["times_wrong"], top["times_seen"], top["right_since"]) == (3, 3, 0)
    assert top["wrong"] == [{"san": "e5", "count": 2}, {"san": "c5", "count": 1}]
    assert sorted(top["line_ids"]) == sorted([a, b, c])
    exch = probs[1]
    assert exch["moves"] == ["e4", "c6", "d4", "d5", "exd5"]
    assert exch["wrong"] == [{"san": "Qxd5", "count": 1}] and exch["line_ids"] == [c]


def test_problem_dropped_after_three_right_in_a_row(client, setup):
    _, o, (a, b, c) = setup
    review(client, c, CARO_EXCH, wrong={6: "d8d5"})
    for n in range(1, 4):
        review(client, c, CARO_EXCH)
        probs = client.get(f"/api/openings/{o['id']}/dashboard").json()["problems"]
        if n < 3:
            assert probs[0]["right_since"] == n
        else:
            assert probs == []


def test_practice_and_old_mistakes_ignored(client, setup, db):
    _, o, (a, b, c) = setup
    review(client, a, CARO_ADV)
    review(client, a, CARO_ADV, wrong={2: "e7e5"}, practice=True)
    review(client, b, CARO_CLASSIC, wrong={2: "e7e5"})
    with db.begin() as conn:
        conn.execute(text("update line_reviews set reviewed_at = :t where line_id = :b"),
                     {"t": datetime.now(timezone.utc) - timedelta(days=100), "b": b})
    assert client.get(f"/api/openings/{o['id']}/dashboard").json()["problems"] == []


def test_train_specific_lines_in_order(client, setup):
    _, o, (a, b, c) = setup
    r = client.get(f"/api/openings/{o['id']}/training", params={"line_ids": f"{c},{a}"}).json()
    assert [line["id"] for line in r["lines"]] == [c, a]
    assert client.get(f"/api/openings/{o['id']}/training", params={"line_ids": "1,x"}).status_code == 422


def test_overview(client, setup):
    rep, o, (a, b, c) = setup
    w = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "London", "color": "white"}).json()
    review(client, a, CARO_ADV)
    review(client, b, CARO_CLASSIC, wrong={2: "e7e5"})
    ov = client.get(f"/api/repertoires/{rep['id']}/overview").json()["openings"]
    assert [x["name"] for x in ov] == ["London", "Caro"]  # White first
    caro = ov[1]
    assert (caro["lines"], caro["due"], caro["reviews"], caro["accuracy"]) == (3, 2, 2, 0.5)
    assert caro["mastery"] == {"new": 1, "learning": 2, "known": 0, "mastered": 0}
    assert ov[0]["id"] == w["id"] and ov[0]["lines"] == 0 and ov[0]["accuracy"] is None
    assert client.get("/api/repertoires/999/overview").status_code == 404


def test_activity_days_and_runs(client, setup, db):
    _, o, (a, b, c) = setup
    for _ in range(3):
        review(client, a, CARO_ADV)
    review(client, b, CARO_CLASSIC, practice=True)  # practice not counted
    now = datetime.now(timezone.utc)
    with db.begin() as conn:
        ids = conn.execute(text("select id from line_reviews where not practice order by id")).scalars().all()
        # Move the reviews to: today, 1 day ago, 3 days ago -> current run 2
        for review_id, days_ago in zip(ids, (0, 1, 3)):
            conn.execute(text("update line_reviews set reviewed_at = :t where id = :i"),
                         {"t": now - timedelta(days=days_ago), "i": review_id})
    act = client.get("/api/activity", params={"tz": "UTC", "days": 7}).json()
    assert len(act["days"]) == 7 and act["days"][-1]["date"] == act["today"]
    assert [d["reviews"] for d in act["days"]] == [0, 0, 0, 1, 0, 1, 1]
    assert (act["current_run"], act["trained_today"], act["longest_run"], act["active_days"]) == (2, True, 2, 3)
    # An unknown time zone falls back to UTC instead of failing
    assert client.get("/api/activity", params={"tz": "Mars/Olympus"}).status_code == 200
    assert client.get("/api/activity", params={"days": 3}).status_code == 422
