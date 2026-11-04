"""Position drill: picking positions where it's your move, recording answers, and drill
mistakes showing as problem positions (without touching the schedule)."""

import pytest

CARO_ADV = ["e2e4", "c7c6", "d2d4", "d7d5", "e4e5", "c8f5"]
CARO_CLASSIC = ["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4", "c3e4", "c8f5"]
ITALIAN = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"]


@pytest.fixture
def setup(client):
    rep = client.post("/api/repertoires", json={"name": "Main"}).json()
    caro = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Caro", "color": "black"}).json()
    ital = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Italian", "color": "white"}).json()
    for m in (CARO_ADV, CARO_CLASSIC):
        client.post(f"/api/openings/{caro['id']}/lines", json={"moves": m})
    client.post(f"/api/openings/{ital['id']}/lines", json={"moves": ITALIAN})
    return rep, caro, ital


def get(client, **params):
    r = client.get("/api/drill", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_opening_positions_are_yours_to_move(client, setup):
    _, caro, _ = setup
    d = get(client, opening_id=caro["id"], count=50)
    # Black to move after 1.e4, 2.d4, 3.e5, 3.Nc3, 4.Nxe4: 5 different positions (1.e4 and 2.d4 shared)
    assert d["total"] == 5 and len(d["positions"]) == 5
    by_ply = sorted((p["ply"], p["expected"][0]["san"]) for p in d["positions"])
    assert by_ply == [(2, "c6"), (4, "d5"), (6, "Bf5"), (6, "dxe4"), (8, "Bf5")]
    for p in d["positions"]:
        assert p["fen"].split()[1] == "b"  # Black to move
        assert p["opening"] == {"id": caro["id"], "name": "Caro", "color": "black"}
        assert len(p["path"]) == p["ply"] - 1
        assert p["rest"][0]["ply"] == p["ply"] and p["rest"][0]["uci"] == p["expected"][0]["uci"]
    p4 = next(p for p in d["positions"] if p["ply"] == 4)
    assert p4["fen"].endswith(" 0 2")  # move number 2 for Black's second move


def test_white_skips_the_starting_position_and_repertoire_scope(client, setup):
    rep, caro, ital = setup
    d = get(client, opening_id=ital["id"], count=50)
    assert sorted(p["expected"][0]["san"] for p in d["positions"]) == ["Bc4", "Nf3"]  # no 1.e4
    assert all(p["fen"].split()[1] == "w" for p in d["positions"])
    whole = get(client, repertoire_id=rep["id"], count=50)
    assert whole["total"] == 7 and {p["opening"]["name"] for p in whole["positions"]} == {"Caro", "Italian"}


def test_count_and_randomness(client, setup):
    _, caro, _ = setup
    d = get(client, opening_id=caro["id"], count=2)
    assert d["total"] == 5 and len(d["positions"]) == 2
    assert len({p["position_id"] for p in d["positions"]}) == 2
    assert client.get("/api/drill", params={"opening_id": caro["id"], "count": 0}).status_code == 422
    assert client.get("/api/drill").status_code == 422  # no scope
    assert client.get("/api/drill", params={"opening_id": 9999}).status_code == 404


def test_tag_scope_starts_at_the_branch(client, setup):
    _, caro, _ = setup
    # tag the position after 3.Nc3 (Classical)
    tag = client.post(
        f"/api/openings/{caro['id']}/tags",
        json={"name": "Classical", "fen": "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR b KQkq - 1 3"},
    )
    assert tag.status_code == 201, tag.text
    d = get(client, tag_id=tag.json()["id"], count=50)
    assert sorted(p["expected"][0]["san"] for p in d["positions"]) == ["Bf5", "dxe4"]  # 3...dxe4 and 4...Bf5 only


def test_record_results_and_validation(client, setup):
    _, caro, _ = setup
    d = get(client, opening_id=caro["id"], count=50)
    p = next(p for p in d["positions"] if p["ply"] == 4)
    ok = {"opening_id": caro["id"], "position_id": p["position_id"], "expected_uci": "d7d5", "correct": False, "wrong": ["e7e6"]}
    assert client.post("/api/drill/results", json={"results": [ok]}).json() == {"saved": 1}
    bad = dict(ok, expected_uci="e7e6")  # not the repertoire move there
    assert client.post("/api/drill/results", json={"results": [bad]}).status_code == 422
    white_move = dict(ok, expected_uci="d2d4", position_id=next(q for q in d["positions"] if q["ply"] == 2)["position_id"])
    assert client.post("/api/drill/results", json={"results": [white_move]}).status_code == 422
    assert client.post("/api/drill/results", json={"results": []}).status_code == 422


def test_drill_mistakes_are_problem_positions_but_schedule_untouched(client, setup):
    _, caro, _ = setup
    before = client.get(f"/api/openings/{caro['id']}/dashboard").json()
    d = get(client, opening_id=caro["id"], count=50)
    p = next(p for p in d["positions"] if p["ply"] == 4)
    res = {"opening_id": caro["id"], "position_id": p["position_id"], "expected_uci": "d7d5", "correct": False, "wrong": ["e7e6", "g7g6"]}
    client.post("/api/drill/results", json={"results": [res]})
    after = client.get(f"/api/openings/{caro['id']}/dashboard").json()
    (prob,) = after["problems"]
    assert (prob["expected"], prob["times_wrong"], prob["moves"]) == ("d5", 1, ["e4", "c6", "d4"])
    assert sorted(w["san"] for w in prob["wrong"]) == ["e6", "g6"]
    assert len(prob["line_ids"]) == 2  # both lines go through it
    # no line reviewed, nothing rescheduled
    strip = lambda d: [(line["id"], line["streak"], line["next_review_on"]) for line in d["lines"]]  # noqa: E731
    assert strip(after) == strip(before)
    # three right answers in a row clear it
    right = dict(res, correct=True, wrong=[])
    client.post("/api/drill/results", json={"results": [right, right, right]})
    assert client.get(f"/api/openings/{caro['id']}/dashboard").json()["problems"] == []


def test_drill_answers_in_another_opening_dont_count(client, setup):
    rep, caro, _ = setup
    other = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Caro 2", "color": "black"}).json()
    client.post(f"/api/openings/{other['id']}/lines", json={"moves": CARO_ADV})
    p = next(p for p in get(client, opening_id=other["id"], count=50)["positions"] if p["ply"] == 4)
    client.post("/api/drill/results", json={"results": [{"opening_id": other["id"], "position_id": p["position_id"], "expected_uci": "d7d5", "correct": False, "wrong": ["e7e6"]}]})
    assert client.get(f"/api/openings/{caro['id']}/dashboard").json()["problems"] == []
    assert len(client.get(f"/api/openings/{other['id']}/dashboard").json()["problems"]) == 1

