"""Repertoire in the wild: PGN reading, watches, matching, fetching (with a fake network)."""

import io
import json
import zipfile
from datetime import date, datetime, timedelta, timezone

import chess
import pytest
from sqlalchemy.orm import Session

from app import wild_fetch
from app.core.positions import position_key
from app.core.wild import MAX_PLY, key_hash, read_games
from app.repositories import wild as repo

TODAY = date.today()


def pgn(white, black, moves, result="1-0", day=None, event="Test Open", elo=("2700", "2650"), extra=""):
    day = day or TODAY
    return (
        f'[Event "{event}"]\n[Site "Oslo NOR"]\n[Date "{day:%Y.%m.%d}"]\n[Round "1.1"]\n'
        f'[White "{white}"]\n[Black "{black}"]\n[Result "{result}"]\n'
        f'[WhiteElo "{elo[0]}"]\n[BlackElo "{elo[1]}"]\n{extra}\n{moves} {result}\n\n'
    )


SLAV = "1. d4 d5 2. c4 c6 3. Nf3 Bf5 4. cxd5 cxd5 5. Qb3"
SLAV_TRANSPOSED = "1. Nf3 d5 2. d4 c6 3. c4 Bf5 4. e3 e6"  # same position after 3...Bf5
QGD = "1. d4 d5 2. c4 e6 3. Nc3 Nf6"


def key(*sans):
    b = chess.Board()
    for san in sans:
        b.push_san(san)
    return position_key(b)


BF5 = key("d4", "d5", "c4", "c6", "Nf3", "Bf5")


# ---- reading PGN ------------------------------------------------------------------------


def test_read_games_keeps_finished_standard_games():
    text = (
        pgn("Carlsen, Magnus", "Caruana, Fabiano", SLAV)
        + pgn("A", "B", "1. e4 e5", result="*")  # unfinished
        + pgn("C", "D", "1. e4 e5", extra='[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]\n')
        + pgn("E", "F", "1. e4 e5 2. Ke3", result="0-1")  # illegal
        + pgn("G", "H", "1. e4 {a comment} c5 (1... e5 2. Nf3) 2. Nf3", result="1/2-1/2", elo=("?", "x"))
    )
    games, skipped = read_games(text)
    assert skipped == 3
    assert [g.white for g in games] == ["Carlsen, Magnus", "G"]
    g = games[0]
    assert (g.white_elo, g.black_elo, g.event, g.round, g.played_on, g.result) == (2700, 2650, "Test Open", "1.1", TODAY, "1-0")
    assert g.moves[:2] == ["d2d4", "d7d5"] and len(g.hashes) == 9
    assert games[1].moves == ["e2e4", "c7c5", "g1f3"] and games[1].white_elo is None


def test_hashes_find_transpositions_and_the_ply():
    (direct,), _ = read_games(pgn("A", "B", SLAV))
    (transposed,), _ = read_games(pgn("C", "D", SLAV_TRANSPOSED))
    h = key_hash(BF5)
    assert direct.hashes.index(h) + 1 == 6
    assert transposed.hashes.index(h) + 1 == 6


def test_only_the_opening_is_hashed():
    moves = " ".join(f"{i}. Nf3 Nf6 {i}. Ng1 Ng8" for i in range(1, 40))  # a long silly game
    (g,), _ = read_games(pgn("A", "B", moves, result="1/2-1/2"))
    assert len(g.hashes) == MAX_PLY and len(g.moves) > MAX_PLY


def test_game_key_ignores_name_formatting():
    (a,), _ = read_games(pgn("Carlsen, Magnus", "Caruana, F.", SLAV))
    (b,), _ = read_games(pgn("Carlsen,Magnus", "Caruana, F", SLAV, event="Other"))
    assert a.key == b.key


# ---- API: watches and matching -------------------------------------------------------------

SLAV_LINE = ["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "c8f5", "c4d5"]


@pytest.fixture
def rep(client):
    r = client.post("/api/repertoires", json={"name": "Main"}).json()
    o = client.post(f"/api/repertoires/{r['id']}/openings", json={"name": "Slav", "color": "white"}).json()
    client.post(f"/api/openings/{o['id']}/lines", json={"moves": SLAV_LINE})
    return r, o


def store(db, text, source="twic", ref="twic1669"):
    games, _ = read_games(text)
    with Session(db) as s, s.begin():
        return repo.store_games(s, games, source, ref)


def test_watch_finds_stored_games(client, db, rep):
    r, o = rep
    store(db, pgn("Carlsen, Magnus", "Caruana, Fabiano", SLAV, day=TODAY - timedelta(days=3))
          + pgn("Giri, Anish", "So, Wesley", SLAV_TRANSPOSED, day=TODAY - timedelta(days=1))
          + pgn("X", "Y", QGD))
    res = client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5 + " 0 4", "label": "Slav Bf5"})
    assert res.status_code == 201, res.text
    w = res.json()
    assert (w["games"], w["label"], w["path"]) == (2, "Slav Bf5", ["d4", "d5", "c4", "c6", "Nf3", "Bf5"])
    assert w["latest_played_on"] == str(TODAY - timedelta(days=1))

    data = client.get(f"/api/repertoires/{r['id']}/wild-games").json()
    assert data["total"] == 2
    first = data["games"][0]  # newest first
    assert first["white"] == "Giri, Anish" and first["matches"] == [{"watch_id": w["id"], "ply": 6}]
    full = client.get(f"/api/wild-games/{first['id']}").json()
    assert full["moves"][:2] == ["g1f3", "d7d5"]
    assert client.get(f"/api/repertoires/{r['id']}/wild-games", params={"q": "carlsen"}).json()["total"] == 1
    assert client.get(f"/api/repertoires/{r['id']}/watches").json()[0]["games"] == 2


def test_new_games_match_existing_watches(client, db, rep):
    r, o = rep
    w = client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5 + " 0 4"}).json()
    assert w["games"] == 0
    store(db, pgn("A", "B", SLAV))
    assert store(db, pgn("A", "B", SLAV), "lichess", "lichess:x") == 0  # same game from another source
    assert client.get(f"/api/repertoires/{r['id']}/wild-games", params={"watch_id": w["id"]}).json()["total"] == 1


def test_watch_validation(client, rep):
    _, o = rep
    start = chess.STARTING_FEN
    assert client.post(f"/api/openings/{o['id']}/watches", json={"fen": start}).status_code == 422
    elsewhere = key("e4", "e5") + " 0 2"
    assert client.post(f"/api/openings/{o['id']}/watches", json={"fen": elsewhere}).status_code == 422
    assert client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5}).status_code == 201
    assert client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5}).status_code == 409
    assert client.post("/api/openings/999/watches", json={"fen": BF5}).status_code == 404


def test_rename_and_unwatch(client, rep):
    r, o = rep
    w = client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5}).json()
    assert client.patch(f"/api/watches/{w['id']}", json={"label": " Bf5 Slav "}).json()["label"] == "Bf5 Slav"
    assert len(client.get(f"/api/openings/{o['id']}/watches").json()) == 1
    assert client.delete(f"/api/watches/{w['id']}").status_code == 204
    assert client.get(f"/api/repertoires/{r['id']}/watches").json() == []
    assert client.delete(f"/api/watches/{w['id']}").status_code == 404


def test_save_to_games(client, db, rep):
    r, o = rep
    store(db, pgn("Carlsen, Magnus", "Caruana, Fabiano", SLAV))
    client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5})
    g = client.get(f"/api/repertoires/{r['id']}/wild-games").json()["games"][0]
    saved = client.post(f"/api/wild-games/{g['id']}/save").json()
    assert saved["created"] is True
    game = client.get(f"/api/games/{saved['game_id']}").json()
    assert (game["white"], game["competition"], game["result"]) == ("Carlsen, Magnus", "Test Open", "1-0")
    assert client.post(f"/api/wild-games/{g['id']}/save").json() == {"game_id": saved["game_id"], "created": False}


def test_status_counts_new_games(client, db, rep):
    r, o = rep
    client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5})
    before = datetime.now(timezone.utc) - timedelta(seconds=5)
    store(db, pgn("A", "B", SLAV) + pgn("C", "D", QGD))
    st = client.get("/api/wild/status", params={"repertoire_id": r["id"], "since": before.isoformat()}).json()
    assert st["games"] == 2 and st["new_games"] == 1 and st["running"] is False and st["enabled"] is False


def test_prune_keeps_matched_and_recent_games(client, db, rep):
    _, o = rep
    old = TODAY - timedelta(days=200)
    store(db, pgn("Old", "Matched", SLAV, day=old) + pgn("Old", "Other", QGD, day=old) + pgn("New", "Other", QGD))
    client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5})
    with Session(db) as s, s.begin():
        assert repo.prune(s, 92) == 1
    with Session(db) as s:
        assert repo.stats(s)["games"] == 2


# ---- fetching (fake network) ----------------------------------------------------------------


def twic_zip(text):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("twic1669.pgn", text.encode("latin-1"))
    return buf.getvalue()


class FakeNet:
    def __init__(self, today):
        ms = lambda d: int(datetime.combine(d, datetime.min.time(), timezone.utc).timestamp() * 1000)  # noqa: E731
        self.pages = {
            1: {
                "active": [{"tour": {"id": "live0001", "name": "Live Open"}}],
                "past": {"currentPageResults": [{"tour": {"id": "past0001", "name": "Recent Cup", "dates": [ms(today - timedelta(days=12)), ms(today - timedelta(days=5))]}}], "nextPage": 2},
            },
            2: {
                "past": {"currentPageResults": [
                    {"tour": {"id": "past0002", "name": "Older Cup", "dates": [ms(today - timedelta(days=60))]}},
                    {"tour": {"id": "ancient1", "name": "Ancient", "dates": [ms(today - timedelta(days=400))]}},
                ], "nextPage": 3},
            },
        }
        self.pgn = {
            "live0001": pgn("Live, A", "Live, B", SLAV) + pgn("Live, C", "Live, D", QGD, result="*"),
            "past0001": pgn("Recent, A", "Recent, B", SLAV_TRANSPOSED),
            "past0002": pgn("Older, A", "Older, B", QGD),
        }
        self.twic_latest = 1669
        self.calls = []

    def __call__(self, url, accept="*/*"):
        self.calls.append(url)
        if "/api/broadcast/top?page=" in url:
            page = int(url.rsplit("=", 1)[1])
            assert page in self.pages, f"fetched page {page}: should stop at older tours"
            return json.dumps(self.pages[page]).encode()
        if "/api/broadcast/" in url and url.endswith(".pgn"):
            return self.pgn[url.rsplit("/", 1)[1][:-4]].encode()
        if url.endswith("/twic"):
            return f'<a href="https://theweekinchess.com/zips/twic{self.twic_latest}g.zip">'.encode()
        if "/zips/twic" in url:
            n = int(url.split("twic")[-1].split("g.zip")[0])
            if n > self.twic_latest:
                raise wild_fetch.HttpError(404, url)
            return twic_zip(pgn(f"Twic{n}, A", "Player, Ü", SLAV if n == self.twic_latest else QGD, day=TODAY - timedelta(days=(self.twic_latest - n) * 7)))
        raise AssertionError(f"unexpected url {url}")


@pytest.fixture
def quick(monkeypatch):
    monkeypatch.setattr(wild_fetch, "PAUSE_S", 0)
    monkeypatch.setattr(wild_fetch.settings, "wild_days", 92)


def test_run_fetches_lichess_and_twic(client, db, rep, quick):
    r, o = rep
    client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5})
    net = FakeNet(TODAY)
    assert wild_fetch.run_once(get=net, today=TODAY) is True
    assert wild_fetch.state["errors"] == [], wild_fetch.state["errors"]
    twic = [u for u in net.calls if "/zips/" in u]
    assert twic[0].endswith("twic1656g.zip") and twic[-1].endswith("twic1670g.zip")  # 92 days = 14 issues, then probe the next
    assert not any("ancient1" in u for u in net.calls)
    with Session(db) as s:
        st = repo.stats(s)
    # Lichess: live 1 (the unfinished game skipped) + recent 1 + older 1; TWIC: 14 issues of 1 game
    assert st["games"] == 17 and st["twic_issue"] == 1669
    names = {g["white"] for g in client.get(f"/api/repertoires/{r['id']}/wild-games").json()["games"]}
    assert names == {"Live, A", "Recent, A", "Twic1669, A"}

    # Second run: finished tours and old issues aren't fetched again; the live tour is.
    net2 = FakeNet(TODAY)
    net2.twic_latest = 1670
    wild_fetch.run_once(get=net2, today=TODAY)
    fetched = [u for u in net2.calls if u.endswith(".pgn") or "/zips/" in u]
    assert any("live0001.pgn" in u for u in fetched)
    assert not any("past0001" in u or "past0002" in u for u in fetched)
    assert [u for u in fetched if "/zips/" in u] == [f"{wild_fetch.TWIC}/zips/twic1670g.zip", f"{wild_fetch.TWIC}/zips/twic1671g.zip"]


def test_run_survives_network_errors(client, db, rep, quick):
    def broken(url, accept="*/*"):
        raise wild_fetch.HttpError(503, url)

    assert wild_fetch.run_once(get=broken, today=TODAY) is True
    errors = " ".join(wild_fetch.state["errors"])
    assert "Lichess broadcast list" in errors and "TWIC index" in errors and "giving up" in errors
    assert wild_fetch.state["running"] is False


def test_twic_estimate():
    assert wild_fetch.twic_estimate(date(2026, 8, 31)) == 1660
    assert wild_fetch.twic_estimate(date(2026, 11, 2)) == 1669


def test_refresh_endpoint_starts_a_run(client, monkeypatch):
    started = []
    monkeypatch.setattr(wild_fetch, "start_now", lambda: started.append(1) or True)
    assert client.post("/api/wild/refresh").status_code == 202
    assert started == [1]
