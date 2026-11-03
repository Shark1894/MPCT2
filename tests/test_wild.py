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


def watch(client, o, name="Slav Bf5", fen=BF5 + " 0 4"):
    """Tag a position and watch the tag; returns the watch."""
    tag = client.post(f"/api/openings/{o['id']}/tags", json={"name": name, "fen": fen})
    assert tag.status_code == 201, tag.text
    res = client.put(f"/api/tags/{tag.json()['id']}/watch")
    assert res.status_code == 201, res.text
    return res.json()


def store(db, text, source="twic", ref="twic1669"):
    games, _ = read_games(text)
    with Session(db) as s, s.begin():
        return repo.store_games(s, games, source, ref)


def test_watch_finds_stored_games(client, db, rep):
    r, o = rep
    store(db, pgn("Carlsen, Magnus", "Caruana, Fabiano", SLAV, day=TODAY - timedelta(days=3))
          + pgn("Giri, Anish", "So, Wesley", SLAV_TRANSPOSED, day=TODAY - timedelta(days=1))
          + pgn("X", "Y", QGD))
    w = watch(client, o)
    assert (w["games"], w["name"], w["path"]) == (2, "Slav Bf5", ["d4", "d5", "c4", "c6", "Nf3", "Bf5"])
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
    w = watch(client, o)
    assert w["games"] == 0
    store(db, pgn("A", "B", SLAV))
    assert store(db, pgn("A", "B", SLAV), "lichess", "lichess:x") == 0  # same game from another source
    assert client.get(f"/api/repertoires/{r['id']}/wild-games", params={"watch_id": w["id"]}).json()["total"] == 1


def test_only_tags_can_be_watched(client, rep):
    _, o = rep
    tag = client.post(f"/api/openings/{o['id']}/tags", json={"name": "Slav Bf5", "fen": BF5}).json()
    assert client.put(f"/api/tags/{tag['id']}/watch").status_code == 201
    assert client.put(f"/api/tags/{tag['id']}/watch").status_code == 409
    assert client.put("/api/tags/999/watch").status_code == 404
    assert client.post(f"/api/openings/{o['id']}/watches", json={"fen": BF5}).status_code == 405  # no untagged watches


def test_watch_takes_the_tag_name_and_goes_with_the_tag(client, rep):
    r, o = rep
    w = watch(client, o)
    client.patch(f"/api/tags/{w['tag_id']}", json={"name": "Slav with Bf5"})
    assert client.get(f"/api/repertoires/{r['id']}/watches").json()[0]["name"] == "Slav with Bf5"
    assert client.get(f"/api/openings/{o['id']}/watches").json()[0]["tag_id"] == w["tag_id"]
    assert client.delete(f"/api/tags/{w['tag_id']}").status_code == 204  # removing the tag removes the watch
    assert client.get(f"/api/repertoires/{r['id']}/watches").json() == []


def test_unwatch(client, rep):
    r, o = rep
    w = watch(client, o)
    assert client.delete(f"/api/tags/{w['tag_id']}/watch").status_code == 204
    assert client.get(f"/api/repertoires/{r['id']}/watches").json() == []
    assert client.delete(f"/api/tags/{w['tag_id']}/watch").status_code == 404
    w = client.put(f"/api/tags/{w['tag_id']}/watch").json()
    assert client.delete(f"/api/watches/{w['id']}").status_code == 204  # from the Wild tab
    assert client.get(f"/api/openings/{o['id']}/tags").json()[0]["name"] == "Slav Bf5"  # the tag stays


def test_viewed_games(client, db, rep):
    r, o = rep
    store(db, pgn("A", "B", SLAV) + pgn("C", "D", SLAV_TRANSPOSED))
    watch(client, o)
    games = client.get(f"/api/repertoires/{r['id']}/wild-games").json()["games"]
    assert [g["viewed_at"] for g in games] == [None, None]
    first = client.post(f"/api/wild-games/{games[0]['id']}/viewed").json()
    assert first["viewed_at"]
    again = client.post(f"/api/wild-games/{games[0]['id']}/viewed").json()
    assert again["viewed_at"] == first["viewed_at"]  # the first time counts
    games = client.get(f"/api/repertoires/{r['id']}/wild-games").json()["games"]
    assert [bool(g["viewed_at"]) for g in games] == [True, False]
    unseen = client.get(f"/api/repertoires/{r['id']}/wild-games", params={"unviewed": True}).json()
    assert unseen["total"] == 1 and unseen["games"][0]["id"] == games[1]["id"]
    assert client.post("/api/wild-games/999/viewed").status_code == 404


def test_save_to_games(client, db, rep):
    r, o = rep
    store(db, pgn("Carlsen, Magnus", "Caruana, Fabiano", SLAV))
    watch(client, o)
    g = client.get(f"/api/repertoires/{r['id']}/wild-games").json()["games"][0]
    saved = client.post(f"/api/wild-games/{g['id']}/save").json()
    assert saved["created"] is True
    game = client.get(f"/api/games/{saved['game_id']}").json()
    assert (game["white"], game["competition"], game["result"]) == ("Carlsen, Magnus", "Test Open", "1-0")
    assert client.post(f"/api/wild-games/{g['id']}/save").json() == {"game_id": saved["game_id"], "created": False}


def test_pgn_of_a_tournament_game(client, db, rep):
    r, o = rep
    store(db, pgn("Carlsen, Magnus", "Caruana, Fabiano", SLAV))
    watch(client, o)
    g = client.get(f"/api/repertoires/{r['id']}/wild-games").json()["games"][0]
    res = client.get(f"/api/wild-games/{g['id']}/pgn")
    assert res.status_code == 200 and 'filename="Carlsen-Caruana-' in res.headers["content-disposition"]
    text = res.text
    for line in ('[Event "Test Open"]', '[Site "Oslo NOR"]', '[Round "1.1"]', '[White "Carlsen, Magnus"]', '[WhiteElo "2700"]', '[BlackElo "2650"]'):
        assert line in text, line
    games, _ = read_games(text)
    assert games[0].moves[:3] == ["d2d4", "d7d5", "c2c4"] and games[0].white_elo == 2700


def test_status_counts_new_games(client, db, rep):
    r, o = rep
    watch(client, o)
    before = datetime.now(timezone.utc) - timedelta(seconds=5)
    store(db, pgn("A", "B", SLAV) + pgn("C", "D", QGD))
    st = client.get("/api/wild/status", params={"repertoire_id": r["id"], "since": before.isoformat()}).json()
    assert st["games"] == 2 and st["new_games"] == 1 and st["running"] is False and st["enabled"] is False


def test_rating_filter(client, db, rep):
    r, o = rep
    store(db, pgn("Strong, A", "Weak, B", SLAV, elo=("2610", "2100"))
          + pgn("Club, C", "Club, D", SLAV_TRANSPOSED, elo=("1950", "1900"))
          + pgn("Unrated, E", "Unrated, F", SLAV, elo=("?", "?"), event="Unrated"))
    w = watch(client, o)
    assert w["games"] == 3
    games = lambda **p: client.get(f"/api/repertoires/{r['id']}/wild-games", params=p).json()  # noqa: E731
    assert games()["total"] == 3
    assert [g["white"] for g in games(min_elo=2000)["games"]] == ["Strong, A"]  # one player is enough
    assert games(min_elo=2700)["total"] == 0
    assert client.get(f"/api/repertoires/{r['id']}/watches", params={"min_elo": 2000}).json()[0]["games"] == 1
    assert client.get(f"/api/openings/{o['id']}/watches", params={"min_elo": 1900}).json()[0]["games"] == 2
    since = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    st = client.get("/api/wild/status", params={"repertoire_id": r["id"], "since": since, "min_elo": 2000}).json()
    assert st["new_games"] == 1 and st["games"] == 3


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
    # history from about 14 weeks ago, like the 1 Jan 2026 default relative to TWIC 1669
    monkeypatch.setattr(wild_fetch.settings, "wild_since", TODAY - timedelta(days=92))


def test_run_fetches_lichess_and_twic(client, db, rep, quick):
    r, o = rep
    watch(client, o)
    net = FakeNet(TODAY)
    assert wild_fetch.run_once(get=net, today=TODAY) is True
    assert wild_fetch.state["errors"] == [], wild_fetch.state["errors"]
    twic = [u for u in net.calls if "/zips/" in u]
    first = wild_fetch.twic_estimate(TODAY - timedelta(days=92)) - 1
    assert twic[0].endswith(f"twic{first}g.zip") and twic[-1].endswith("twic1670g.zip")  # then probe the next
    assert not any("ancient1" in u for u in net.calls)
    with Session(db) as s:
        st = repo.stats(s)
    # Lichess: live 1 (the unfinished game skipped) + recent 1 + older 1; TWIC: one game per issue
    assert st["games"] == 3 + (1669 - first + 1) and st["twic_issue"] == 1669 and st["twic_first"] == first
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


def test_missed_twic_issues_are_backfilled(client, db, rep, quick):
    net = FakeNet(TODAY)
    wild_fetch.run_once(get=net, today=TODAY)
    first = wild_fetch.twic_estimate(TODAY - timedelta(days=92)) - 1
    with Session(db) as s, s.begin():  # pretend two issues failed earlier
        s.execute(__import__("sqlalchemy").text("DELETE FROM wild_sources WHERE key IN ('twic:1660', 'twic:1661')"))
    net2 = FakeNet(TODAY)
    wild_fetch.run_once(get=net2, today=TODAY)
    zips = [u.rsplit("/", 1)[1] for u in net2.calls if "/zips/" in u]
    assert zips == ["twic1660g.zip", "twic1661g.zip", "twic1670g.zip"]
    assert first < 1660


def test_run_survives_network_errors(client, db, rep, quick):
    def broken(url, accept="*/*"):
        raise wild_fetch.HttpError(503, url)

    assert wild_fetch.run_once(get=broken, today=TODAY) is True
    errors = " ".join(wild_fetch.state["errors"])
    assert "Lichess broadcast list" in errors and "TWIC index" in errors and "giving up" in errors
    assert wild_fetch.state["running"] is False


def test_lichess_list_keeps_earlier_pages_when_a_later_page_fails(quick):
    since = datetime.now(timezone.utc) - timedelta(days=92)
    recent = int((datetime.now(timezone.utc) - timedelta(days=3)).timestamp() * 1000)
    calls = []

    def get(url, accept="*/*"):
        calls.append(url)
        page = int(url.rsplit("=", 1)[1])
        if page == 3:
            raise wild_fetch.HttpError(400, url)
        return json.dumps({
            "active": [{"tour": {"id": "live0001", "name": "Live"}}] if page == 1 else [],
            "past": {"currentPageResults": [{"tour": {"id": f"past000{page}", "name": f"P{page}", "dates": [recent]}}], "nextPage": page + 1},
        }).encode()

    tours = wild_fetch.lichess_tours(since, get)
    assert {t[0] for t in tours} == {"live0001", "past0001", "past0002"}
    assert len(calls) == 3


def test_lichess_list_stops_at_the_page_limit(quick):
    recent = int((datetime.now(timezone.utc) - timedelta(days=3)).timestamp() * 1000)
    calls = []

    def get(url, accept="*/*"):
        calls.append(url)
        page = int(url.rsplit("=", 1)[1])
        return json.dumps({"past": {"currentPageResults": [{"tour": {"id": f"p{page}", "name": "x", "dates": [recent]}}], "nextPage": page + 1}}).encode()

    tours = wild_fetch.lichess_tours(datetime.now(timezone.utc) - timedelta(days=92), get)
    assert len(calls) == wild_fetch.LICHESS_MAX_PAGES == 5 and len(tours) == 5


def test_twic_estimate():
    assert wild_fetch.twic_estimate(date(2026, 8, 31)) == 1660
    assert wild_fetch.twic_estimate(date(2026, 11, 2)) == 1669
    assert wild_fetch.twic_estimate(date(2026, 1, 1)) == 1625  # the default history start (TWIC 1626 = 5 Jan 2026)


def test_refresh_endpoint_starts_a_run(client, monkeypatch):
    started = []
    monkeypatch.setattr(wild_fetch, "start_now", lambda: started.append(1) or True)
    assert client.post("/api/wild/refresh").status_code == 202
    assert started == [1]
