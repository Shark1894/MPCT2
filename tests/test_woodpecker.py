"""The Woodpecker Method: cycles over a course's puzzles, timed first attempts, stats."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from tests.test_courses import BACK_RANK, BLACK, CHAPTERS, INFO, post


def wp_course(client, **kw):
    r = post(client, [BACK_RANK, INFO, BLACK], kind="woodpecker", **kw)
    return r["course_id"]


def test_cycle_lifecycle(client, db):
    cid = wp_course(client)
    o = client.get(f"/api/courses/{cid}/woodpecker").json()
    assert (o["puzzles"], o["current"], o["cycles"], o["suggested_target_days"]) == (2, None, [], None)  # the info page isn't a puzzle
    assert [c["puzzles"] for c in o["chapters"]] == [1, 1]

    c1 = client.post(f"/api/courses/{cid}/woodpecker/cycles", json={"target_days": 28}).json()
    assert (c1["number"], c1["total"], c1["done"], c1["target_days"]) == (1, 2, 0, 28)
    assert client.post(f"/api/courses/{cid}/woodpecker/cycles", json={}).status_code == 409  # one at a time
    o = client.get(f"/api/courses/{cid}/woodpecker").json()
    first, second = o["todo"]

    r = client.post(f"/api/woodpecker/cycles/{c1['id']}/attempts", json={"exercise_id": first, "solved": False, "seconds": 41.26}).json()
    assert r["recorded"] and not r["finished"] and (r["cycle"]["done"], r["cycle"]["seconds"]) == (1, 41.3)
    again = client.post(f"/api/woodpecker/cycles/{c1['id']}/attempts", json={"exercise_id": first, "solved": True, "seconds": 5}).json()
    assert not again["recorded"] and again["cycle"]["solved"] == 0  # only the first go counts
    assert client.get(f"/api/courses/{cid}/woodpecker").json()["todo"] == [second]

    r = client.post(f"/api/woodpecker/cycles/{c1['id']}/attempts", json={"exercise_id": second, "solved": True, "seconds": 9}).json()
    assert r["finished"] and r["cycle"]["finished_at"] and (r["cycle"]["accuracy"], r["cycle"]["avg_seconds"]) == (50.0, 25.1)
    assert client.post(f"/api/woodpecker/cycles/{c1['id']}/attempts", json={"exercise_id": second, "solved": True, "seconds": 1}).status_code == 409

    # Pretend cycle 1 took 9 days: cycle 2 is suggested at 5 (half, rounded up).
    with db.begin() as conn:
        conn.execute(text("UPDATE woodpecker_cycles SET started_at = finished_at - interval '9 days'"))
    o = client.get(f"/api/courses/{cid}/woodpecker").json()
    assert o["suggested_target_days"] == 5 and o["current"] is None and o["cycles"][0]["days"] == 9.0
    summary = client.get("/api/courses").json()[0]
    assert summary["cycle"]["number"] == 1 and summary["cycle"]["finished_at"]

    # by chapter, for the last (finished) cycle: one missed in chapter 1, one solved in chapter 2
    assert [(c["in_cycle"], c["done"], c["solved"]) for c in o["chapters"]] == [(True, 1, 0), (True, 1, 1)]
    c2 = client.post(f"/api/courses/{cid}/woodpecker/cycles", json={"chapter_ids": [o["chapters"][1]["id"]], "target_days": 5}).json()
    o2 = client.get(f"/api/courses/{cid}/woodpecker").json()
    assert [(c["in_cycle"], c["done"]) for c in o2["chapters"]] == [(False, 0), (True, 0)]
    assert (c2["number"], c2["total"]) == (2, 1)
    client.post(f"/api/woodpecker/cycles/{c2['id']}/attempts", json={"exercise_id": second, "solved": True, "seconds": 4})
    times = client.get(f"/api/courses/{cid}/woodpecker/times").json()
    assert times["cycles"] == [1, 2]
    by_id = {p["id"]: p["times"] for p in times["puzzles"]}
    assert by_id[first] == {"1": {"seconds": 41.3, "solved": False}}
    assert by_id[second] == {"1": {"seconds": 9.0, "solved": True}, "2": {"seconds": 4.0, "solved": True}}


def test_errors_and_abandon(client, db):
    tactics = post(client, [BACK_RANK])["course_id"]
    assert client.post(f"/api/courses/{tactics}/woodpecker/cycles", json={}).status_code == 422  # not a Woodpecker course
    client.patch(f"/api/courses/{tactics}", json={"kind": "woodpecker"})
    c1 = client.post(f"/api/courses/{tactics}/woodpecker/cycles", json={}).json()
    other = client.get(f"/api/courses/{tactics}").json()["chapters"][0]["exercises"][0]["id"]
    assert client.post(f"/api/woodpecker/cycles/{c1['id']}/attempts", json={"exercise_id": 999, "solved": True, "seconds": 1}).status_code == 422
    client.post(f"/api/woodpecker/cycles/{c1['id']}/attempts", json={"exercise_id": other, "solved": True, "seconds": 1})  # finishes it
    assert client.post(f"/api/courses/{tactics}/woodpecker/cycles", json={"chapter_ids": [999]}).status_code == 422
    assert client.post(f"/api/courses/{tactics}/woodpecker/cycles", json={"target_days": 0}).status_code == 422
    c2 = client.post(f"/api/courses/{tactics}/woodpecker/cycles", json={}).json()
    assert client.delete(f"/api/woodpecker/cycles/{c1['id']}").status_code == 409  # not the latest
    assert client.delete(f"/api/woodpecker/cycles/{c2['id']}").status_code == 204
    assert client.get(f"/api/courses/{tactics}/woodpecker").json()["current"] is None
    assert client.post(f"/api/courses/{tactics}/woodpecker/cycles", json={}).json()["number"] == 2
    client.delete(f"/api/courses/{tactics}")


def test_accept_missed_attempt(client, db):
    """A miss can be counted as solved (an alternative solution), in a finished cycle too."""
    cid = wp_course(client)
    c1 = client.post(f"/api/courses/{cid}/woodpecker/cycles", json={}).json()
    first, second = client.get(f"/api/courses/{cid}/woodpecker").json()["todo"]
    base = f"/api/woodpecker/cycles/{c1['id']}/attempts"
    assert client.post(f"{base}/{first}/accept").status_code == 404  # not tried yet
    client.post(base, json={"exercise_id": first, "solved": False, "seconds": 20})
    client.post(base, json={"exercise_id": second, "solved": False, "seconds": 10})  # finishes the cycle

    r = client.post(f"{base}/{first}/accept")
    assert r.status_code == 200
    c = r.json()
    assert (c["done"], c["solved"], c["accuracy"], c["seconds"]) == (2, 1, 50.0, 30.0)  # time unchanged
    assert client.post(f"{base}/{first}/accept").json()["solved"] == 1  # idempotent

    times = {p["id"]: p["times"] for p in client.get(f"/api/courses/{cid}/woodpecker/times").json()["puzzles"]}
    assert times[first] == {"1": {"seconds": 20.0, "solved": True}}
    ex = client.get(f"/api/exercises/{first}").json()
    assert ex["status"] == "solved"
    client.delete(f"/api/courses/{cid}")


def test_sets_of_cycles(client, db):
    """A new set starts again at cycle 1 (ending an open cycle where it stands); older sets stay
    viewable; abandoning a set's only cycle removes the set."""
    cid = wp_course(client)
    o = client.get(f"/api/courses/{cid}/woodpecker").json()
    easy = o["chapters"][0]["id"]
    c1 = client.post(f"/api/courses/{cid}/woodpecker/cycles", json={"chapter_ids": [easy]}).json()
    assert (c1["set_number"], c1["number"], c1["total"]) == (1, 1, 1)
    first = client.get(f"/api/courses/{cid}/woodpecker").json()["todo"][0]
    # Nothing done yet in set 1's cycle 1 → still open; start a new set with every chapter.
    assert client.post(f"/api/courses/{cid}/woodpecker/cycles", json={}).status_code == 409
    s2 = client.post(f"/api/courses/{cid}/woodpecker/cycles", json={"new_set": True, "target_days": 20}).json()
    assert (s2["set_number"], s2["number"], s2["total"]) == (2, 1, 2)

    o = client.get(f"/api/courses/{cid}/woodpecker").json()
    assert (o["set_number"], o["latest_set"], [c["number"] for c in o["cycles"]]) == (2, 2, [1])
    assert [(st["number"], st["cycles"], st["chapter_ids"], st["open"]) for st in o["sets"]] == [(1, 1, [easy], False), (2, 1, None, True)]
    old = client.get(f"/api/courses/{cid}/woodpecker?set=1").json()
    assert old["current"] is None and old["cycles"][0]["finished_at"] and old["cycles"][0]["done"] == 0  # ended early, kept

    client.post(f"/api/woodpecker/cycles/{s2['id']}/attempts", json={"exercise_id": first, "solved": True, "seconds": 7})
    assert client.get(f"/api/courses/{cid}/woodpecker/times?set=1").json()["cycles"] == [1]
    t2 = client.get(f"/api/courses/{cid}/woodpecker/times").json()
    assert t2["set_number"] == 2 and {p["id"]: p["times"] for p in t2["puzzles"]}[first] == {"1": {"seconds": 7.0, "solved": True}}
    assert client.get("/api/courses").json()[0]["cycle"]["set_number"] == 2

    assert client.delete(f"/api/woodpecker/cycles/{c1['id']}").status_code == 409  # not the latest
    assert client.delete(f"/api/woodpecker/cycles/{s2['id']}").status_code == 204
    o = client.get(f"/api/courses/{cid}/woodpecker").json()
    assert (o["set_number"], len(o["sets"])) == (1, 1)
    client.delete(f"/api/courses/{cid}")
