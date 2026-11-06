"""Offline speech model for hands-free training: served at a versioned URL, and the build
script that repacks Vosk's zip into the tar.gz the browser library wants."""

import importlib.util
import io
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


def fake_zip(prefix="vosk-model-small-en-us-0.15/", files=fetch.REQUIRED) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(prefix, "") if prefix else None
        for f in files:
            z.writestr(prefix + f, f"data of {f}")
    return buf.getvalue()


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
        assert fetch.repack(zipped, out) == len(fetch.REQUIRED)
        with tarfile.open(out) as tar:
            names = tar.getnames()
            assert sorted(names) == sorted(f"{fetch.NAME}/{f}" for f in fetch.REQUIRED)  # one top folder, stripped by the worker
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
