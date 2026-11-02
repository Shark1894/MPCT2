from tests.conftest import count

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
# Same position as AFTER_E4 reached at a later move number: must share the eval.
AFTER_E4_LATER = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 7"
MATED = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"


def ev(fen, movetime=1000, cp=30, depth=18):
    return {
        "fen": fen,
        "movetime_ms": movetime,
        "depth": depth,
        "engine": "Stockfish 19 Lite",
        "lines": [
            {"uci": "e2e4", "score": {"cp": cp}, "pv": ["e2e4", "e7e5", "g1f3"]},
            {"uci": "d2d4", "score": {"cp": cp - 5}, "pv": ["d2d4", "d7d5"]},
        ],
    }


def lookup(client, fens, min_ms=0):
    r = client.post("/api/evals/lookup", json={"fens": fens, "min_movetime_ms": min_ms})
    assert r.status_code == 200
    return r.json()["evals"]


def test_save_and_lookup_in_order(client, db):
    assert lookup(client, [START, AFTER_E4]) == [None, None]
    r = client.post("/api/evals", json={"evals": [ev(START)]})
    assert r.json() == {"saved": 1}
    got = lookup(client, [AFTER_E4, START])
    assert got[0] is None
    assert got[1]["depth"] == 18 and got[1]["movetime_ms"] == 1000
    assert got[1]["lines"][0] == {"uci": "e2e4", "score": {"cp": 30, "mate": None}, "pv": ["e2e4", "e7e5", "g1f3"]}
    assert count(db, "position_evals") == 1


def test_transpositions_and_move_counters_share_an_eval(client):
    client.post("/api/evals", json={"evals": [ev(AFTER_E4, cp=-20)]})
    a, b = lookup(client, [AFTER_E4, AFTER_E4_LATER])
    assert a and b and a["lines"] == b["lines"]


def test_min_movetime_filters_quick_evals(client):
    client.post("/api/evals", json={"evals": [ev(START, movetime=300)]})
    assert lookup(client, [START], min_ms=1000) == [None]
    assert lookup(client, [START], min_ms=300)[0]["movetime_ms"] == 300


def test_longer_analysis_replaces_shorter_but_not_the_reverse(client):
    client.post("/api/evals", json={"evals": [ev(START, movetime=1000, cp=30)]})
    assert client.post("/api/evals", json={"evals": [ev(START, movetime=300, cp=99)]}).json() == {"saved": 0}
    assert lookup(client, [START])[0]["lines"][0]["score"]["cp"] == 30
    assert client.post("/api/evals", json={"evals": [ev(START, movetime=3000, cp=25, depth=24)]}).json() == {"saved": 1}
    got = lookup(client, [START])[0]
    assert (got["movetime_ms"], got["depth"], got["lines"][0]["score"]["cp"]) == (3000, 24, 25)


def test_mate_scores_and_positions_without_moves(client):
    mate = ev(START)
    mate["lines"] = [{"uci": "e2e4", "score": {"mate": -3}, "pv": ["e2e4"]}]
    over = {**ev(MATED), "lines": [], "depth": 0}
    assert client.post("/api/evals", json={"evals": [mate, over]}).json() == {"saved": 2}
    a, b = lookup(client, [START, MATED])
    assert a["lines"][0]["score"] == {"cp": None, "mate": -3}
    assert b["lines"] == []


def test_validation(client):
    bad_fen = client.post("/api/evals/lookup", json={"fens": ["not a fen at all"]})
    assert bad_fen.status_code == 422
    both = ev(START)
    both["lines"][0]["score"] = {"cp": 1, "mate": 2}
    assert client.post("/api/evals", json={"evals": [both]}).status_code == 422
    bad_move = ev(START)
    bad_move["lines"][0]["uci"] = "e2e9"
    assert client.post("/api/evals", json={"evals": [bad_move]}).status_code == 422
