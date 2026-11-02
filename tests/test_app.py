import re

from fastapi.testclient import TestClient

from app import __version__
from app.main import BUILD_ID, WEB_DIR, app, build_id, render_index

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert (body["status"], body["version"], body["build"]) == ("ok", __version__, BUILD_ID)
    assert body["environment"] == "live"
    assert body["database"] in {"ok", "not configured", "unavailable"}
    assert r.headers["cache-control"] == "no-store"


def test_index_is_uncached_and_points_at_versioned_assets():
    r = client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["cross-origin-opener-policy"] == "same-origin"
    assert r.headers["cross-origin-embedder-policy"] == "require-corp"
    assert "__ASSETS__" not in r.text
    assets = re.findall(r'(?:href|src)="(/assets/[^"]+)"', r.text)
    assert assets and all(a.startswith(f"/assets/{BUILD_ID}/") for a in assets)
    for a in assets:
        assert client.get(a).status_code == 200, a


def test_assets_are_cached_forever_and_modules_are_javascript():
    # Browsers refuse ES modules served with a non-JavaScript MIME type.
    for path in ["js/main.js", "js/game.js", "js/repertoire.js", "vendor/chess.js/chess.js", "vendor/chessground/chessground.min.js"]:
        r = client.get(f"/assets/{BUILD_ID}/{path}")
        assert r.status_code == 200, path
        assert "javascript" in r.headers["content-type"], path
        assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_old_or_unknown_asset_urls_are_not_cached():
    r = client.get("/assets/000000000000/js/main.js")
    assert r.status_code == 404
    assert r.headers["cache-control"] == "no-store"
    assert client.get("/js/main.js").status_code == 404


def test_build_id_changes_when_web_files_change(tmp_path):
    (tmp_path / "a.js").write_text("one")
    first = build_id(tmp_path)
    (tmp_path / "a.js").write_text("two")
    assert build_id(tmp_path) != first


def test_unknown_api_route_is_404():
    assert client.get("/api/nope").status_code == 404


def test_stockfish_files_served_with_correct_types():
    # Browsers refuse to compile WebAssembly served with any other MIME type.
    for name in ["stockfish-19-lite", "stockfish-19-lite-single"]:
        js = client.get(f"/assets/{BUILD_ID}/vendor/stockfish/{name}.js")
        wasm = client.get(f"/assets/{BUILD_ID}/vendor/stockfish/{name}.wasm")
        assert js.status_code == 200 and "javascript" in js.headers["content-type"]
        assert wasm.status_code == 200 and wasm.headers["content-type"] == "application/wasm"
        assert wasm.content[:4] == b"\0asm"


TEMPLATE = (WEB_DIR / "index.html").read_text(encoding="utf-8")


def test_live_index_has_no_environment_marker():
    html = render_index(TEMPLATE, "/assets/abc")
    assert "env-badge" not in html and "env-nonlive" not in html
    assert "<title>MPCT</title>" in html
    assert html == TEMPLATE.replace("__ASSETS__", "/assets/abc")


def test_test_index_is_clearly_marked():
    html = render_index(TEMPLATE, "/assets/abc", "test")
    assert "<title>TEST · MPCT</title>" in html
    assert '<body class="env-nonlive" data-env="test">' in html
    assert '<span class="env-badge">TEST</span>' in html
    assert '<meta name="theme-color" content="#b5651d"' in html
    assert "__ASSETS__" not in html


def test_environment_label_is_escaped():
    html = render_index(TEMPLATE, "/assets/abc", "<x>")
    assert "<X>" not in html and "&lt;X&gt;" in html
