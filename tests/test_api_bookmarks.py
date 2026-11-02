import pytest

RUY = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]
ITALIAN = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]


@pytest.fixture
def opening(client):
    rep = client.post("/api/repertoires", json={"name": "Main"}).json()
    o = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "1.e4", "color": "white"}).json()
    ids = [client.post(f"/api/openings/{o['id']}/lines", json={"moves": m}).json()["line_id"] for m in (RUY, ITALIAN)]
    return o, ids


def dash_lines(client, opening_id):
    return {l["id"]: l for l in client.get(f"/api/openings/{opening_id}/dashboard").json()["lines"]}


def test_lines_start_unbookmarked(client, opening):
    o, (ruy, _) = opening
    line = dash_lines(client, o["id"])[ruy]
    assert (line["bookmarked"], line["bookmark_note"]) == (False, None)
    training = client.get(f"/api/openings/{o['id']}/training", params={"mode": "all"}).json()
    assert all(l["bookmarked"] is False for l in training["lines"])


def test_bookmark_without_and_with_note(client, opening):
    o, (ruy, italian) = opening
    r = client.put(f"/api/lines/{ruy}/bookmark", json={})
    assert r.status_code == 200
    body = r.json()
    assert (body["line_id"], body["bookmarked"], body["note"]) == (ruy, True, None)
    assert body["bookmarked_at"]

    r = client.put(f"/api/lines/{italian}/bookmark", json={"note": "  Show Sam the Bc4 idea  "})
    assert r.json()["note"] == "Show Sam the Bc4 idea"

    lines = dash_lines(client, o["id"])
    assert (lines[ruy]["bookmarked"], lines[ruy]["bookmark_note"]) == (True, None)
    assert (lines[italian]["bookmarked"], lines[italian]["bookmark_note"]) == (True, "Show Sam the Bc4 idea")
    training = client.get(f"/api/openings/{o['id']}/training", params={"line_id": italian}).json()
    assert (training["lines"][0]["bookmarked"], training["lines"][0]["bookmark_note"]) == (True, "Show Sam the Bc4 idea")


def test_editing_note_keeps_bookmark_date_and_empty_clears_note(client, opening):
    _, (ruy, _) = opening
    first = client.put(f"/api/lines/{ruy}/bookmark", json={"note": "sharp"}).json()
    second = client.put(f"/api/lines/{ruy}/bookmark", json={"note": "   "}).json()
    assert second["bookmarked_at"] == first["bookmarked_at"]
    assert (second["bookmarked"], second["note"]) == (True, None)


def test_remove_bookmark_drops_note(client, opening):
    o, (ruy, _) = opening
    client.put(f"/api/lines/{ruy}/bookmark", json={"note": "sharp"})
    assert client.delete(f"/api/lines/{ruy}/bookmark").status_code == 204
    line = dash_lines(client, o["id"])[ruy]
    assert (line["bookmarked"], line["bookmark_note"]) == (False, None)
    assert client.delete(f"/api/lines/{ruy}/bookmark").status_code == 204  # already gone: fine


def test_bookmark_survives_reset_and_extension(client, opening):
    o, (ruy, _) = opening
    client.put(f"/api/lines/{ruy}/bookmark", json={"note": "keep"})
    client.post(f"/api/lines/{ruy}/reset")
    r = client.post(f"/api/openings/{o['id']}/lines", json={"moves": RUY + ["a7a6", "b5a4"]}).json()
    assert (r["status"], r["line_id"]) == ("extended", ruy)
    line = dash_lines(client, o["id"])[ruy]
    assert (line["bookmarked"], line["bookmark_note"]) == (True, "keep")


def test_unknown_line_and_long_note(client, opening):
    _, (ruy, _) = opening
    assert client.put("/api/lines/999999/bookmark", json={}).status_code == 404
    assert client.delete("/api/lines/999999/bookmark").status_code == 404
    assert client.put(f"/api/lines/{ruy}/bookmark", json={"note": "x" * 501}).status_code == 422
    assert client.put(f"/api/lines/{ruy}/bookmark", json={"note": "x" * 500}).status_code == 200
