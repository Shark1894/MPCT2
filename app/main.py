"""MPCT web app: FastAPI serves the JSON API under /api and the frontend from web/.

Caching: the frontend's files are served under /assets/<build id>/, where the build id
is a hash of everything in web/. Every change gets new URLs, so browsers and
Cloudflare can cache assets forever but never serve a stale copy. index.html is
rendered with those URLs and is never cached.
"""

import hashlib
import re
from html import escape
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api import bookmarks, confusable, dashboard, evals, games, repertoires, tags, training
from app.config import settings
from app.core.positions import InvalidLine, InvalidPosition
from app.db.session import DatabaseNotConfigured, database_status
from app.repositories.repertoire import Conflict, NotFound
from app.repositories.confusable import InvalidPair
from app.repositories.tags import InvalidTag
from app.repositories.training import InvalidReview

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def build_id(web_dir: Path = WEB_DIR) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in web_dir.rglob("*") if p.is_file()):
        digest.update(path.relative_to(web_dir).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


BUILD_ID = build_id()
ASSETS_PREFIX = f"/assets/{BUILD_ID}"
ENV_THEME_COLOR = "#b5651d"


def render_index(template: str, assets_prefix: str, environment: str = "live") -> str:
    """index.html with asset URLs filled in; non-live environments get a visible marker."""
    html = template.replace("__ASSETS__", assets_prefix)
    if environment == "live":
        return html
    label = escape(environment.upper())
    html = html.replace("<title>MPCT</title>", f"<title>{label} · MPCT</title>", 1)
    html = re.sub(r'(<meta name="theme-color" content=")[^"]*"', rf'\g<1>{ENV_THEME_COLOR}"', html, count=1)
    html = html.replace("<body>", f'<body class="env-nonlive" data-env="{label.lower()}">', 1)
    html = html.replace("<span>MPCT</span>", f'<span>MPCT</span>\n        <span class="env-badge">{label}</span>', 1)
    return html


INDEX_HTML = render_index((WEB_DIR / "index.html").read_text(encoding="utf-8"), ASSETS_PREFIX, settings.mpct_env)


def _error(status: int):
    async def handler(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=status, content={"detail": str(exc)})

    return handler


def create_app() -> FastAPI:
    app = FastAPI(
        title="MPCT",
        version=__version__,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )

    app.add_exception_handler(NotFound, _error(404))
    app.add_exception_handler(Conflict, _error(409))
    app.add_exception_handler(InvalidLine, _error(422))
    app.add_exception_handler(InvalidPosition, _error(422))
    app.add_exception_handler(InvalidReview, _error(422))
    app.add_exception_handler(InvalidTag, _error(422))
    app.add_exception_handler(InvalidPair, _error(422))
    app.add_exception_handler(DatabaseNotConfigured, _error(503))

    @app.middleware("http")
    async def add_headers(request: Request, call_next):
        response = await call_next(request)
        # Cross-origin isolation: lets the browser run multi-threaded Stockfish (SharedArrayBuffer).
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        path = request.url.path
        if path.startswith("/assets/") and response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    def health() -> dict:
        return {
            "status": "ok",
            "version": __version__,
            "build": BUILD_ID,
            "environment": settings.mpct_env,
            "database": database_status(),
        }

    app.include_router(repertoires.router)
    app.include_router(training.router)
    app.include_router(dashboard.router)
    app.include_router(tags.router)
    app.include_router(games.router)
    app.include_router(bookmarks.router)
    app.include_router(evals.router)
    app.include_router(confusable.router)

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    @app.get("/index.html", response_class=HTMLResponse, include_in_schema=False)
    def index() -> HTMLResponse:
        return HTMLResponse(INDEX_HTML)

    app.mount(ASSETS_PREFIX, StaticFiles(directory=WEB_DIR), name="assets")
    return app


app = create_app()
