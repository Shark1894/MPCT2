from fastapi.testclient import TestClient

from app import __version__
from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert (body["status"], body["version"]) == ("ok", __version__)
    assert body["database"] in {"ok", "not configured", "unavailable"}


def test_index_served_with_isolation_headers():
    r = client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert r.headers["cross-origin-opener-policy"] == "same-origin"
    assert r.headers["cross-origin-embedder-policy"] == "require-corp"
    assert r.headers["cache-control"] == "no-cache"


def test_js_modules_served_as_javascript():
    # Browsers refuse ES modules served with a non-JavaScript MIME type.
    for path in ["/js/main.js", "/js/game.js", "/vendor/chess.js/chess.js", "/vendor/chessground/chessground.min.js"]:
        r = client.get(path)
        assert r.status_code == 200, path
        assert "javascript" in r.headers["content-type"], path


def test_unknown_api_route_is_404():
    assert client.get("/api/nope").status_code == 404
