import sqlite3
from datetime import date

import pytest
from sqlalchemy.orm import Session

from app.repositories.repertoire import Conflict
from app.tools.import_legacy import import_legacy, legacy_fen, main
from tests.conftest import count

LEGACY_SCHEMA = """
CREATE TABLE openings (opening_id INTEGER PRIMARY KEY, name VARCHAR NOT NULL UNIQUE, color VARCHAR NOT NULL, date_added DATE NOT NULL);
CREATE TABLE positions (position_id INTEGER PRIMARY KEY, position_fen VARCHAR NOT NULL, comment VARCHAR);
CREATE TABLE lines (line_id INTEGER PRIMARY KEY, opening_id INTEGER NOT NULL, date_added DATE, date_next_review DATE NOT NULL);
CREATE TABLE moves (move_id INTEGER PRIMARY KEY, line_id INTEGER, move_uci VARCHAR, move_san VARCHAR, move_number INTEGER,
                    position_before_id INTEGER, position_after_id INTEGER);
CREATE TABLE log_lines (log_line_id INTEGER PRIMARY KEY, line_id INTEGER, opening_id INTEGER, datetime_reviewed DATETIME,
                        review_correct BOOLEAN, consecutive_review_correct INTEGER);
"""


@pytest.fixture
def legacy_db(tmp_path):
    path = tmp_path / "Main.db"
    c = sqlite3.connect(path)
    c.executescript(LEGACY_SCHEMA)
    c.execute("INSERT INTO openings VALUES (2, 'Caro-Kann', 'Black', '2025-11-01')")
    c.execute("INSERT INTO openings VALUES (5, 'Jobava', 'White', '2025-11-01')")
    c.execute("INSERT INTO openings VALUES (9, 'Empty', 'White', '2025-11-01')")

    def line(line_id, opening_id, moves, sans=None):
        c.execute("INSERT INTO lines VALUES (?, ?, '2025-11-01', '2030-01-01')", (line_id, opening_id))
        for i, uci in enumerate(moves):
            san = (sans or [None] * len(moves))[i] or "?"
            c.execute("INSERT INTO moves (line_id, move_uci, move_san, move_number) VALUES (?, ?, ?, ?)", (line_id, uci, san, i + 1))

    # Caro: a short line, then its extension (legacy stored WRONG SAN for the extension), a branch, a duplicate
    line(1, 2, ["e2e4", "c7c6", "d2d4", "d7d5"], ["e4", "c6", "d4", "d5"])
    line(2, 2, ["e2e4", "c7c6", "d2d4", "d7d5", "e4e5", "c8f5"], ["e4", "c6", "d4", "d5", "e4", "c6"])
    line(3, 2, ["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4"], ["e4", "c6", "d4", "d5", "Nc3", "dxe4"])
    line(4, 2, ["e2e4", "c7c6", "d2d4"], ["e4", "c6", "d4"])
    # Jobava: one good line and one illegal line
    line(10, 5, ["d2d4", "g8f6", "b1c3", "d7d5", "c1f4"], ["d4", "Nf6", "Nc3", "d5", "Bf4"])
    line(11, 5, ["d2d4", "d7d5", "d4d5"], ["d4", "d5", "d5"])
    # Review history that must NOT be imported
    c.execute("INSERT INTO log_lines VALUES (1, 1, 2, '2025-11-10 10:00:00', 1, 1)")

    # Comments in all three legacy key shapes, plus an empty one and a duplicate after re-keying
    after_d4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq"  # 3 fields
    no_castling = "8/8/8/8/8/5k2/8/4K3 w"  # 2 fields (castling was '-')
    after_e4_full = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"  # full FEN
    after_e4_short = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq"  # same position
    for fen, comment in [
        (after_d4, "Keep it simple: d4 and Nf3."),
        (no_castling, "Endgame note"),
        (after_e4_full, "Main move"),
        (after_e4_short, "Caro-Kann territory"),
        ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq", "   "),
        ("rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq", None),
    ]:
        c.execute("INSERT INTO positions (position_fen, comment) VALUES (?, ?)", (fen, comment))
    c.commit()
    c.close()
    return path


def test_legacy_fen_shapes():
    assert legacy_fen("8/8/8/8/8/5k2/8/4K3 w") == "8/8/8/8/8/5k2/8/4K3 w - - 0 1"
    assert legacy_fen("rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq").endswith(" b KQkq - 0 1")
    full = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
    assert legacy_fen(full) == full


def test_import(db, client, legacy_db):
    with Session(db) as s:
        report = import_legacy(s, legacy_db, "Main")
        s.commit()

    assert report.openings == 3
    assert report.lines_read == 6
    assert (report.lines_created, report.lines_extended, report.lines_duplicate) == (3, 1, 1)
    assert len(report.skipped) == 1 and "Jobava line 11" in report.skipped[0]
    assert report.san_fixed == 2  # the extension's "e4", "c6"
    assert (report.comments, report.comments_merged) == (3, 1)

    reps = client.get("/api/repertoires").json()
    assert [(r["name"], r["openings"]) for r in reps] == [("Main", 3)]
    openings = {o["name"]: o for o in client.get(f"/api/repertoires/{reps[0]['id']}/openings").json()}
    assert {n: (o["color"], o["lines"], o["due"]) for n, o in openings.items()} == {
        "Caro-Kann": ("black", 2, 2),
        "Jobava": ("white", 1, 1),
        "Empty": ("white", 0, 0),
    }

    caro = client.get(f"/api/openings/{openings['Caro-Kann']['id']}/lines").json()
    sans = sorted(" ".join(m["san"] for m in line["moves"]) for line in caro)
    assert sans == ["e4 c6 d4 d5 Nc3 dxe4", "e4 c6 d4 d5 e5 Bf5"]  # SAN regenerated
    assert all(line["next_review_on"] == date.today().isoformat() for line in caro)  # fresh: due today
    assert count(db, "line_reviews") == 0  # no history imported

    url = f"/api/repertoires/{reps[0]['id']}/comment"
    after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    assert client.get(url, params={"fen": after_e4}).json()["comment"] == "Main move\n\nCaro-Kann territory"
    after_d4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1"
    assert client.get(url, params={"fen": after_d4}).json()["comment"] == "Keep it simple: d4 and Nf3."
    assert client.get(url, params={"fen": "8/8/8/8/8/5k2/8/4K3 w - - 0 1"}).json()["comment"] == "Endgame note"

    # Explorer works on imported data, including the transposed/shared positions
    start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    assert client.get(f"/api/openings/{openings['Caro-Kann']['id']}/explorer", params={"fen": start}).json() == [
        {"uci": "e2e4", "san": "e4", "lines": 2}
    ]


def test_existing_repertoire_needs_replace(db, client, legacy_db):
    client.post("/api/repertoires", json={"name": "Main"})
    with Session(db) as s:
        with pytest.raises(Conflict):
            import_legacy(s, legacy_db, "Main")
    with Session(db) as s:
        import_legacy(s, legacy_db, "Main", replace=True)
        s.commit()
    assert count(db, "openings") == 3


def test_no_comments_option(db, legacy_db):
    with Session(db) as s:
        report = import_legacy(s, legacy_db, "Main", comments=False)
        s.commit()
    assert report.comments == 0
    assert count(db, "position_comments") == 0


def test_cli_dry_run_changes_nothing(db, legacy_db, capsys):
    assert main([str(legacy_db), "--repertoire", "Main", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "DRY RUN" in out and "new lines:              3" in out
    assert (count(db, "repertoires"), count(db, "lines"), count(db, "positions")) == (0, 0, 0)


def test_cli_import_and_conflict(db, legacy_db, capsys):
    assert main([str(legacy_db)]) == 0  # repertoire named after the file
    assert "repertoire 'Main'" in capsys.readouterr().out
    assert count(db, "lines") == 3
    assert main([str(legacy_db)]) == 1  # exists; no --replace
    assert "already exists" in capsys.readouterr().err


def test_not_a_legacy_file(db, tmp_path):
    bogus = tmp_path / "x.db"
    sqlite3.connect(bogus).execute("CREATE TABLE t (x)").connection.close()
    with pytest.raises(SystemExit, match="doesn't look like"):
        main([str(bogus)])
    with pytest.raises(SystemExit, match="Not found"):
        main([str(tmp_path / "missing.db")])
