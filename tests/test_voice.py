"""Offline speech model for hands-free training: served at a versioned URL, and the build
script that repacks Vosk's zip into the tar.gz the browser library wants."""

import importlib.util
import io
import struct
import tarfile
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fetch_voice_model", ROOT / "scripts" / "fetch_voice_model.py")
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)


def fake_zip(prefix="vosk-model-small-en-us-0.15/", files=fetch.REQUIRED + ("graph/words.txt",), gr=None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(prefix, "") if prefix else None
        for f in files:
            z.writestr(prefix + f, gr if f == "graph/Gr.fst" and gr is not None else f"data of {f}")
    return buf.getvalue()


def _s(x: str) -> bytes:
    b = x.encode()
    return struct.pack("<i", len(b)) + b


def fake_fst(words=None, isymbols=False) -> bytes:
    """An OpenFst header (+ symbol tables) like the official model's Gr.fst, then arbitrary data."""
    flags = (2 if words else 0) | (1 if isymbols else 0)
    out = struct.pack("<i", fetch.FST_MAGIC) + _s("vector") + _s("standard") + struct.pack("<ii", 2, flags) + struct.pack("<Qqqq", 3, 0, 1, 1)

    def table(rows):
        return struct.pack("<i", fetch.SYMBOLS_MAGIC) + _s("syms") + struct.pack("<qq", len(rows), len(rows)) + b"".join(_s(w) + struct.pack("<q", k) for w, k in rows)

    if isymbols:
        out += table([("<eps>", 0), ("x", 1)])
    if words:
        out += table(words)
    return out + b"arcs..."


def test_no_model_installed(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "voice_model_dir", str(tmp_path))
    c = TestClient(app)
    assert c.get("/api/voice").json() == {"model_url": None}
    assert c.get("/voice/vosk-model-small-en-us-0.15.tar.gz").status_code == 404


def test_model_served_and_cached_for_good(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "voice_model_dir", str(tmp_path))
    (tmp_path / "vosk-model-small-en-us-0.15.tar.gz").write_bytes(b"model bytes")
    c = TestClient(app)
    url = c.get("/api/voice").json()["model_url"]
    assert url == "/voice/vosk-model-small-en-us-0.15.tar.gz"
    r = c.get(url)
    assert r.status_code == 200 and r.content == b"model bytes"
    assert "immutable" in r.headers["cache-control"] and r.headers["cross-origin-embedder-policy"] == "require-corp"
    assert c.get("/voice/../config.py").status_code == 404
    assert c.get("/voice/other.tar.gz").status_code == 404


def test_repack_zip_to_tar_gz(tmp_path):
    out = tmp_path / "m.tar.gz"
    for zipped in (fake_zip(), fake_zip(prefix="")):  # one top folder, or files at the top
        out.unlink(missing_ok=True)
        assert fetch.repack(zipped, out) == len(fetch.REQUIRED) + 1
        with tarfile.open(out) as tar:
            names = tar.getnames()
            assert sorted(names) == sorted(f"{fetch.NAME}/{f}" for f in fetch.REQUIRED + ("graph/words.txt",))  # one top folder, stripped by the worker
            assert tar.extractfile(f"{fetch.NAME}/am/final.mdl").read() == b"data of am/final.mdl"


def test_repack_refuses_a_model_without_grammar_support(tmp_path):
    out = tmp_path / "m.tar.gz"
    try:
        fetch.repack(fake_zip(files=("am/final.mdl", "conf/model.conf")), out)
        raise AssertionError("should refuse")
    except ValueError as exc:
        assert "graph/HCLr.fst" in str(exc)
    assert not out.exists()


def test_build_never_fails(tmp_path, capsys):
    assert fetch.main(["x", str(tmp_path / "out"), str(tmp_path / "missing.zip")]) == 0
    assert "WARNING" in capsys.readouterr().out
    src = tmp_path / "model.zip"
    src.write_bytes(fake_zip())
    assert fetch.main(["x", str(tmp_path / "out"), str(src)]) == 0
    assert (tmp_path / "out" / f"{fetch.NAME}.tar.gz").exists()
    assert fetch.main(["x", str(tmp_path / "out"), str(src)]) == 0
    assert "already there" in capsys.readouterr().out


def test_words_taken_from_gr_fst_when_the_zip_has_no_words_txt(tmp_path):
    """The official model ships its vocabulary only inside graph/Gr.fst; the browser's Vosk wants words.txt."""
    out = tmp_path / "m.tar.gz"
    rows = [("<eps>", 0), ("knight", 1), ("f", 2), ("three", 3)]
    for isymbols in (False, True):
        out.unlink(missing_ok=True)
        fetch.repack(fake_zip(files=fetch.REQUIRED, gr=fake_fst(rows, isymbols=isymbols)), out)
        with tarfile.open(out) as tar:
            words = tar.extractfile(f"{fetch.NAME}/graph/words.txt").read().decode()
        assert words == "<eps> 0\nknight 1\nf 2\nthree 3\n"


def test_no_words_anywhere_is_refused(tmp_path):
    out = tmp_path / "m.tar.gz"
    try:
        fetch.repack(fake_zip(files=fetch.REQUIRED, gr=fake_fst(None)), out)
        raise AssertionError("should refuse")
    except ValueError as exc:
        assert "no graph/words.txt" in str(exc)
    assert fetch.fst_words(b"not an fst") is None
