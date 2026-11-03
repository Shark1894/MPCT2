"""Confusable positions: the pure pair finder and the API around it."""

import chess
import pytest

from app.core.confusable import Decision, differences, find_pairs
from app.core.positions import position_key


def key(*sans: str) -> str:
    board = chess.Board()
    for san in sans:
        board.push_san(san)
    return position_key(board)


# Slav: the bishop on f5 or g4 decides between cxd5 and Ne5.
SLAV = ("d4", "d5", "c4", "c6", "Nf3")
BF5 = key(*SLAV, "Bf5")
BG4 = key(*SLAV, "Bg4")


def test_bishop_on_a_neighbouring_square_is_a_pair():
    pairs = find_pairs([Decision(BF5, "c4d5", frozenset({1})), Decision(BG4, "f3e5", frozenset({2}))])
    assert len(pairs) == 1
    assert pairs[0].distance == 2  # f5 and g4


def test_differences_name_what_stands_where():
    a, b = Decision(BF5, "c4d5"), Decision(BG4, "f3e5")
    assert differences(a, b) == [
        {"square": "g4", "a": None, "b": "black bishop"},
        {"square": "f5", "a": "black bishop", "b": None},
    ]


def test_same_move_is_not_a_pair():
    assert find_pairs([Decision(BF5, "e2e3", frozenset({1})), Decision(BG4, "e2e3", frozenset({2}))]) == []


def test_positions_on_a_common_line_are_not_paired():
    assert find_pairs([Decision(BF5, "c4d5", frozenset({1, 2})), Decision(BG4, "f3e5", frozenset({2}))]) == []


def test_each_answer_must_be_legal_in_the_other_position():
    a = key("d4", "d5", "Bf4", "Nf6")  # expect e3
    b = key("d4", "d5", "Bf4", "c5")  # expect dxc5
    assert find_pairs([Decision(a, "e2e3"), Decision(b, "d4c5")]) == []  # dxc5 is illegal with no pawn on c5


def test_too_far_apart_is_not_a_pair():
    far = key("d4", "Nf6", "c4", "e6")
    assert find_pairs([Decision(BF5, "c4d5"), Decision(far, "b1c3")]) == []


def test_same_position_with_two_moves_is_left_out():
    assert find_pairs([Decision(BF5, "c4d5", frozenset({1})), Decision(BF5, "e2e3", frozenset({2}))]) == []


def test_only_the_same_side_to_move():
    white_to_move = key("e4", "e5")
    black_to_move = key("e4", "e5", "Nf3")
    assert find_pairs([Decision(white_to_move, "g1f3"), Decision(black_to_move, "b8c6")]) == []


# ---- API ----------------------------------------------------------------------

SLAV_BF5 = ["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "c8f5", "c4d5"]
SLAV_BG4 = ["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "c8g4", "f3e5"]


@pytest.fixture
def slav(client):
    rep = client.post("/api/repertoires", json={"name": "Main"}).json()
    o = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Slav", "color": "white"}).json()
    ids = [client.post(f"/api/openings/{o['id']}/lines", json={"moves": m}).json()["line_id"] for m in (SLAV_BF5, SLAV_BG4)]
    return rep, o, ids


def test_api_lists_the_pair(client, slav):
    _, o, ids = slav
    r = client.get(f"/api/openings/{o['id']}/confusable")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] == 1 and data["hidden"] == 0
    pair = data["pairs"][0]
    assert pair["distance"] == 2
    sides = {pair["a"]["expected_san"]: pair["a"], pair["b"]["expected_san"]: pair["b"]}
    assert set(sides) == {"cxd5", "Ne5"}
    assert sides["cxd5"]["moves"] == ["d4", "d5", "c4", "c6", "Nf3", "Bf5"]
    assert sides["cxd5"]["fen"].startswith(BF5) and sides["cxd5"]["fen"].endswith(" 0 4")
    assert sides["cxd5"]["line_ids"] == [ids[0]]
    assert sides["Ne5"]["opening_name"] == "Slav"
    assert {d["square"] for d in pair["differences"]} == {"f5", "g4"}
    assert pair["mixups"] == {"a_as_b": 0, "b_as_a": 0}


def test_api_counts_mixups_from_training(client, slav):
    _, o, ids = slav
    attempts = [{"ply": 1, "uci": "d2d4"}, {"ply": 3, "uci": "c2c4"}, {"ply": 5, "uci": "g1f3"},
                {"ply": 7, "uci": "f3e5"}, {"ply": 7, "uci": "c4d5"}]  # Ne5 by mistake in the Bf5 line
    assert client.post(f"/api/lines/{ids[0]}/reviews", json={"attempts": attempts}).status_code == 201
    pair = client.get(f"/api/openings/{o['id']}/confusable").json()["pairs"][0]
    a_is_bf5 = pair["a"]["expected_san"] == "cxd5"
    assert pair["mixups"] == ({"a_as_b": 1, "b_as_a": 0} if a_is_bf5 else {"a_as_b": 0, "b_as_a": 1})


def test_api_mixups_rank_first(client, slav):
    _, o, _ = slav
    # A second pair, 4 squares apart: ...Nf6 (Nc3) against ...Nd7 (Bf4). Closer pairs come first...
    nf6 = client.post(f"/api/openings/{o['id']}/lines", json={"moves": ["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "g8f6", "b1c3"]}).json()["line_id"]
    client.post(f"/api/openings/{o['id']}/lines", json={"moves": ["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "b8d7", "c1f4"]})
    first = client.get(f"/api/openings/{o['id']}/confusable").json()["pairs"][0]
    assert first["distance"] == 2
    # ...until you mix one up: Bf4 played in the Nf6 line puts that pair on top.
    attempts = [{"ply": 1, "uci": "d2d4"}, {"ply": 3, "uci": "c2c4"}, {"ply": 5, "uci": "g1f3"},
                {"ply": 7, "uci": "c1f4"}, {"ply": 7, "uci": "b1c3"}]
    assert client.post(f"/api/lines/{nf6}/reviews", json={"attempts": attempts}).status_code == 201
    first = client.get(f"/api/openings/{o['id']}/confusable").json()["pairs"][0]
    assert {first["a"]["expected_san"], first["b"]["expected_san"]} == {"Nc3", "Bf4"}
    assert first["distance"] == 4 and sum(first["mixups"].values()) == 1


def test_api_crosses_openings_of_the_same_colour(client, slav):
    rep, o, _ = slav
    other = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "QG", "color": "white"}).json()
    client.post(f"/api/openings/{other['id']}/lines", json={"moves": ["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "c8f5", "e2e3"]})
    black = client.post(f"/api/repertoires/{rep['id']}/openings", json={"name": "Caro", "color": "black"}).json()
    client.post(f"/api/openings/{black['id']}/lines", json={"moves": ["e2e4", "c7c6"]})
    data = client.get(f"/api/openings/{other['id']}/confusable").json()
    # QG's e3 after ...Bf5 against the Slav's Ne5 after ...Bg4 (QG's side first). The same position with cxd5 is left out.
    assert data["total"] == 1
    pair = data["pairs"][0]
    assert (pair["a"]["opening_name"], pair["a"]["expected_san"]) == ("QG", "e3")
    assert (pair["b"]["opening_name"], pair["b"]["expected_san"]) == ("Slav", "Ne5")
    assert client.get(f"/api/openings/{black['id']}/confusable").json()["total"] == 0


def test_api_hide_and_unhide(client, slav):
    rep, o, _ = slav
    pair = client.get(f"/api/openings/{o['id']}/confusable").json()["pairs"][0]
    ids = [pair["b"]["position_id"], pair["a"]["position_id"]]
    assert client.post(f"/api/repertoires/{rep['id']}/confusable/hidden", json={"position_ids": ids}).status_code == 204
    assert client.post(f"/api/repertoires/{rep['id']}/confusable/hidden", json={"position_ids": ids}).status_code == 204  # idempotent
    data = client.get(f"/api/openings/{o['id']}/confusable").json()
    assert data["pairs"] == [] and data["hidden"] == 1
    assert client.delete(f"/api/repertoires/{rep['id']}/confusable/hidden").json() == {"pairs": 1}
    assert client.get(f"/api/openings/{o['id']}/confusable").json()["total"] == 1


def test_api_hide_validation(client, slav):
    rep, o, _ = slav
    assert client.post(f"/api/repertoires/{rep['id']}/confusable/hidden", json={"position_ids": [1, 1]}).status_code == 422
    assert client.post(f"/api/repertoires/{rep['id']}/confusable/hidden", json={"position_ids": [1, 99999]}).status_code == 404
    assert client.post("/api/repertoires/999/confusable/hidden", json={"position_ids": [1, 2]}).status_code == 404
    assert client.get("/api/openings/999/confusable").status_code == 404


def test_api_branch_filter(client, slav):
    _, o, _ = slav
    tag = client.post(f"/api/openings/{o['id']}/tags", json={"name": "Bf5", "fen": BF5 + " 0 4"}).json()
    data = client.get(f"/api/openings/{o['id']}/confusable", params={"tag_id": tag["id"]}).json()
    assert data["total"] == 1 and data["tag_id"] == tag["id"]
