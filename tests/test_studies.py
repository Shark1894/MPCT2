"""Endgame studies in the Training tab: PGN import, browsing and filters, solving, favourites."""

from tests.test_pgn_course import FILE, RETI, SAAVEDRA

SAAVEDRA_FEN = "8/8/1KP5/3r4/8/8/8/k7 w - - 0 1"


def imp(client, pgn=FILE, collection="Classics", **kw):
    r = client.post("/api/studies/import", json={"pgn": pgn, "collection": collection, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def test_preview(client, db):
    r = client.post("/api/studies/preview", json={"pgn": FILE})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["studies"] == 3 and len(p["skipped"]) == 1
    assert [(g["group"], g["title"], g["count"]) for g in p["groups"]] == [
        ("pawn", "Pawn endings", 1), ("rook", "Rook endings", 1), ("many", "Many pieces", 1)]
    assert client.post("/api/studies/preview", json={"pgn": "nonsense"}).status_code == 422


def test_import_summary_and_list(client, db):
    assert client.post("/api/studies/import", json={"pgn": FILE, "collection": " "}).status_code == 422
    assert client.post("/api/studies/import", json={"pgn": FILE, "collection": "x", "groups": []}).status_code == 422
    r = imp(client, groups=["pawn", "rook"])
    assert (r["added"], r["updated"], r["unchanged"]) == (2, 0, 0)
    s = client.get("/api/studies/summary").json()
    assert (s["total"], s["new"], s["favourites"], s["wins"], s["draws"]) == (2, 2, 0, 1, 1)
    assert [g["group"] for g in s["groups"]] == ["pawn", "rook"]
    assert s["collections"] == [{"name": "Classics", "count": 2}]

    items = client.get("/api/studies").json()
    assert items["total"] == 2 and [i["title"] for i in items["items"]] == ["Reti, Richard, 1921 · P v P", "Saavedra, Fernando, 1895 · P v R"]
    sv = items["items"][1]
    assert (sv["composer"], sv["year"], sv["source"], sv["stipulation"], sv["material"], sv["group"], sv["moves"]) == (
        "Saavedra, Fernando", 1895, "Glasgow Weekly Citizen", "win", "P v R", "rook", 13)
    assert client.get("/api/studies", params={"group": "rook"}).json()["total"] == 1
    assert client.get("/api/studies", params={"stipulation": "draw"}).json()["items"][0]["composer"] == "Reti, Richard"
    assert client.get("/api/studies", params={"q": "saav"}).json()["total"] == 1
    assert client.get("/api/studies", params={"q": "P v R"}).json()["total"] == 1
    assert client.get("/api/studies", params={"group": "nonsense"}).status_code == 422

    # The same file again, every group: two unchanged, the game added; progress untouched.
    again = imp(client)
    assert (again["added"], again["updated"], again["unchanged"]) == (1, 0, 2)
    assert client.get("/api/studies/summary").json()["total"] == 3


def test_solve_queue_and_favourites(client, db):
    imp(client, SAAVEDRA + "\n" + RETI)
    ids = {i["composer"]: i["id"] for i in client.get("/api/studies").json()["items"]}
    sv, reti = ids["Saavedra, Fernando"], ids["Reti, Richard"]

    e = client.get(f"/api/studies/{sv}").json()
    assert (e["start_fen"], e["color"], e["kind"], e["course"], e["chapter"]) == (SAAVEDRA_FEN, "white", "line", "Endgame studies", "Rook endings · Win")
    assert e["ucis"][:2] == ["c6c7", "d5d6"] and e["comments"]["0"].startswith("White to play and win.")
    assert client.get("/api/studies/999999").status_code == 404

    assert client.get("/api/studies/queue").json() == [reti, sv]  # pawn endings first
    assert client.post(f"/api/studies/{reti}/attempt", json={"solved": True}).json()["status"] == "solved"
    assert client.post(f"/api/studies/{sv}/attempt", json={"solved": False}).json()["status"] == "missed"
    assert client.get("/api/studies/queue").json() == [sv, reti]  # missed before solved
    assert client.get("/api/studies/queue", params={"status": "unsolved"}).json() == [sv]
    assert sorted(client.get("/api/studies/queue", params={"random": True}).json()) == sorted([sv, reti])
    s = client.get("/api/studies/summary").json()
    assert (s["new"], s["solved"], s["missed"]) == (0, 1, 1)

    f = client.put(f"/api/studies/{sv}/favourite", json={}).json()
    assert f == {"id": sv, "favourite": True, "favourite_note": ""}
    client.put(f"/api/studies/{reti}/favourite", json={"note": "  the king walks two ways at once  "})
    favs = client.get("/api/studies", params={"favourites": True}).json()["items"]
    assert [i["id"] for i in favs] == [reti, sv]  # most recent first
    assert favs[0]["favourite_note"] == "the king walks two ways at once"
    assert client.get("/api/studies/summary").json()["favourites"] == 2
    assert client.get("/api/studies/queue", params={"favourites": True, "status": "unsolved"}).json() == [sv]

    # Importing again keeps progress and favourites.
    imp(client, SAAVEDRA + "\n" + RETI)
    assert client.get(f"/api/studies/{reti}").json()["favourite"] is True
    assert client.get(f"/api/studies/{sv}").json()["status"] == "missed"

    assert client.delete(f"/api/studies/{reti}/favourite").json() == {"id": reti, "favourite": False, "favourite_note": ""}
    assert client.get("/api/studies", params={"favourites": True}).json()["total"] == 1


def test_delete_collection(client, db):
    imp(client, SAAVEDRA, "One")
    imp(client, RETI, "Two")
    assert [c["name"] for c in client.get("/api/studies/summary").json()["collections"]] == ["One", "Two"]
    assert client.delete("/api/studies/collections/One").json() == {"deleted": 1}
    assert client.delete("/api/studies/collections/One").status_code == 404
    assert client.get("/api/studies/summary").json()["total"] == 1
