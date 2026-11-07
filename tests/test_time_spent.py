"""Time spent (Stats tab): stretches reported by the browser, older attempt times, local days."""

from sqlalchemy import text

from tests.test_endgames import KBN
from tests.test_woodpecker import wp_course

T0 = "2026-11-05T23:30:00+00:00"


def stretch(client, key="k-aaaaaaaa", seconds=30.0, **kw):
    body = {"key": key, "category": "openings", "activity": "opening-training", "detail": "Italian",
            "started_at": T0, "seconds": seconds} | kw
    return client.post("/api/time", json=body)


def test_stretches_upsert_and_never_go_down(client, db):
    assert stretch(client).json() == {"key": "k-aaaaaaaa", "seconds": 30.0}
    assert stretch(client, seconds=95.04).json()["seconds"] == 95.0
    assert stretch(client, seconds=10).json()["seconds"] == 95.0  # a late, older report
    assert stretch(client, seconds=999999).json()["seconds"] == 86400.0
    with db.connect() as conn:
        assert conn.execute(text("select count(*) from activity_sessions")).scalar_one() == 1
    assert stretch(client, key="k-bbbbbbbb", category="cooking").status_code == 422
    assert stretch(client, key="bad key!").status_code == 422
    assert stretch(client, key="k-cccccccc", activity="Opening Training").status_code == 422
    assert stretch(client, key="k-dddddddd", seconds=-1).status_code == 422


def test_summary_local_days_and_rows(client, db):
    stretch(client, seconds=120)
    stretch(client, key="k-bbbbbbbb", category="tactics", activity="puzzles-rated", detail=None, seconds=60,
            started_at="2026-11-06T10:00:00Z")
    stretch(client, key="k-zzzzzzzz", seconds=0)  # nothing counted: left out
    utc = client.get("/api/time").json()
    assert utc["tz"] == "UTC" and utc["tracking_since"].startswith("2026-11-05T23:30")
    assert [(r["date"], r["category"], r["activity"], r["detail"], r["seconds"], r["sessions"]) for r in utc["rows"]] == [
        ("2026-11-05", "openings", "opening-training", "Italian", 120.0, 1),
        ("2026-11-06", "tactics", "puzzles-rated", None, 60.0, 1),
    ]
    # 23:30 UTC is already the next day in Berlin
    berlin = client.get("/api/time", params={"tz": "Europe/Berlin"}).json()
    assert berlin["tz"] == "Europe/Berlin" and [r["date"] for r in berlin["rows"]] == ["2026-11-06", "2026-11-06"]
    assert client.get("/api/time", params={"tz": "Mars/Olympus"}).json()["tz"] == "UTC"


def test_older_attempt_times_count_until_tracking_starts(client, db):
    cid = wp_course(client)
    cyc = client.post(f"/api/courses/{cid}/woodpecker/cycles", json={}).json()
    todo = client.get(f"/api/courses/{cid}/woodpecker").json()["todo"]
    client.post(f"/api/woodpecker/cycles/{cyc['id']}/attempts", json={"exercise_id": todo[0], "solved": True, "seconds": 40})
    client.post("/api/endgames/attempts", json={"drill": "kbn", "start_fen": KBN, "color": "white", "result": "mate",
                                                "moves": 30, "seconds": 5000})
    with db.begin() as conn:
        conn.execute(text("""insert into puzzle_attempts (puzzle_id, attempted_at, solved, rated, puzzle_rating,
                             rating_before, rating_after, rd_after, seconds, themes)
                             values ('abc', '2026-11-01T12:00:00Z', true, true, 1500, 1500, 1510, 80, 25, '{}'),
                                    ('abd', '2026-11-01T12:05:00Z', true, false, 1500, 1510, 1510, 80, null, '{}')"""))
        conn.execute(text("update woodpecker_attempts set attempted_at = '2026-11-02T12:00:00Z'"))
        conn.execute(text("update endgame_attempts set finished_at = '2026-11-03T12:00:00Z'"))
    rows = client.get("/api/time").json()["rows"]
    assert [(r["date"], r["category"], r["activity"], r["seconds"]) for r in rows] == [
        ("2026-11-01", "tactics", "puzzles-rated", 25.0),
        ("2026-11-02", "tactics", "woodpecker", 40.0),
        ("2026-11-03", "endgames", "endgame-drill", 600.0),  # capped: probably left open
    ]
    assert rows[1]["detail"] and rows[2]["detail"] == "kbn"
    assert client.get("/api/time").json()["tracking_since"] is None

    # Tracking starts on the 2nd: older times before then still count, later ones come from tracking only.
    stretch(client, started_at="2026-11-02T00:00:00Z", category="tactics", activity="woodpecker", detail=None, seconds=50)
    rows = client.get("/api/time").json()["rows"]
    assert [(r["date"], r["activity"], r["seconds"]) for r in rows] == [
        ("2026-11-01", "puzzles-rated", 25.0), ("2026-11-02", "woodpecker", 50.0)]
