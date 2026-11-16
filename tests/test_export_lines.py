"""app.tools.export_lines: an opening's lines for scripts/practical_choices.py."""

import pytest
from sqlalchemy.orm import Session

from app.db.models import Opening, Repertoire
from app.repositories.repertoire import add_line
from app.tools.export_lines import export


def test_export(db):
    with Session(db) as s:
        r1, r2 = Repertoire(name="Main"), Repertoire(name="2026 New")
        s.add_all([r1, r2])
        s.flush()
        modern = [Opening(repertoire_id=r.id, name="Scandinavian (Modern)", color="black") for r in (r1, r2)]
        s.add_all([*modern, Opening(repertoire_id=r1.id, name="Scandinavian", color="black")])
        s.flush()
        add_line(s, modern[0].id, ["e2e4", "d7d5", "e4d5", "g8f6", "d2d4", "c8g4", "f1e2", "g4e2"])
        add_line(s, modern[1].id, ["e2e4", "d7d5", "e4d5", "g8f6", "c2c4"])

        ops, lines = export(s, "Scandinavian (Modern)")  # the same opening in two repertoires: both
        assert len(ops) == 2 and sorted(len(x) for x in lines) == [5, 8]
        ops, lines = export(s, "scandinavian (modern)", "Main")
        assert [o.repertoire.name for o in ops] == ["Main"] and lines[0][-1] == "g4e2"
        with pytest.raises(SystemExit, match="More than one opening matches"):
            export(s, "Scandi")
        with pytest.raises(SystemExit, match="Openings: 'Scandinavian' .black, repertoire 'Main'."):
            export(s, "Wuss")
