"""MPCT web app: FastAPI serves the JSON API under /api and the frontend from web/.

Caching: the frontend's files are served under /assets/<build id>/, where the build id
is a hash of everything in web/. Every change gets new URLs, so browsers and
Cloudflare can cache assets forever but never serve a stale copy. index.html is
rendered with those URLs and is never cached.
"""

import hashlib
from contextlib import asynccontextmanager
import re
from html import escape
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app import wild_fetch
from app.api import bookmarks, course_import, courses, dashboard, drill, evals, gaps, game_puzzles, games, lichess, masters, puzzles, repertoires, tags, training, wild
from app.config import settings
from app.core.positions import InvalidLine, InvalidPosition
from app.db.session import DatabaseNotConfigured, database_status
from app.repositories.repertoire import Conflict, NotFound
from app.repositories.tags import InvalidTag
from app.repositories.game_puzzles import InvalidGameReview
from app.repositories.puzzles import InvalidPuzzle, PuzzlesUnavailable
from app.repositories.training import InvalidReview
from app.repositories.drill import InvalidDrill
from app.repositories.courses import InvalidCourse

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def build_id(web_dir: Path = WEB_DIR) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in web_dir.rglob("*") if p.is_file()):
        digest.update(path.relative_to(web_dir).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


BUILD_ID = build_id()
ASSETS_PREFIX = f"/assets/{BUILD_ID}"


def voice_model_name() -> str | None:
    """File name of the installed Vosk model (vosk-model-*.tar.gz), or None."""
    found = sorted(Path(settings.voice_model_dir).glob("vosk-model-*.tar.gz"))
    return found[-1].name if found else None
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Repertoire in the wild: fetch tournament games in the background (WILD_FETCH=false to turn off).
    wild_fetch.start_schedule()
    yield
    wild_fetch.stop_schedule()


def create_app() -> FastAPI:
    app = FastAPI(
        lifespan=lifespan,
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
    app.add_exception_handler(InvalidGameReview, _error(422))
    app.add_exception_handler(InvalidTag, _error(422))
    app.add_exception_handler(InvalidPuzzle, _error(422))
    app.add_exception_handler(InvalidReview, _error(422))
    app.add_exception_handler(InvalidDrill, _error(422))
    app.add_exception_handler(InvalidCourse, _error(422))
    app.add_exception_handler(PuzzlesUnavailable, _error(409))
    app.add_exception_handler(DatabaseNotConfigured, _error(503))

    @app.middleware("http")
    async def add_headers(request: Request, call_next):
        response = await call_next(request)
        # Cross-origin isolation: lets the browser run multi-threaded Stockfish (SharedArrayBuffer).
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        path = request.url.path
        if (path.startswith("/assets/") or path.startswith("/voice/")) and response.status_code == 200:
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
    app.include_router(course_import.router)
    app.include_router(courses.router)
    app.include_router(training.router)
    app.include_router(drill.router)
    app.include_router(gaps.router)
    app.include_router(masters.router)
    app.include_router(dashboard.router)
    app.include_router(tags.router)
    app.include_router(games.router)
    app.include_router(lichess.router)
    app.include_router(bookmarks.router)
    app.include_router(evals.router)
    app.include_router(wild.router)
    app.include_router(puzzles.router)
    app.include_router(game_puzzles.router)
    app.include_router(game_puzzles.reviews_router)

    @app.get("/api/voice", include_in_schema=False)
    def voice_status() -> dict:
        """The offline speech model, if installed: its URL (versioned, so it's cached for good)."""
        name = voice_model_name()
        return {"model_url": f"/voice/{name}" if name else None}

    @app.get("/voice/{name}", include_in_schema=False)
    def voice_model(name: str) -> FileResponse:
        if name != voice_model_name():
            raise HTTPException(404, "No such speech model")
        return FileResponse(Path(settings.voice_model_dir) / name, media_type="application/gzip")

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    @app.get("/index.html", response_class=HTMLResponse, include_in_schema=False)
    def index() -> HTMLResponse:
        return HTMLResponse(INDEX_HTML)

    app.mount(ASSETS_PREFIX, StaticFiles(directory=WEB_DIR), name="assets")
    return app


app = create_app()
