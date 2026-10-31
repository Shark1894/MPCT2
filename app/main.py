"""MPCT web app: FastAPI serves the JSON API under /api and the static frontend from web/."""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api import repertoires
from app.core.positions import InvalidLine, InvalidPosition
from app.db.session import DatabaseNotConfigured, database_status
from app.repositories.repertoire import Conflict, NotFound

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


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
    app.add_exception_handler(DatabaseNotConfigured, _error(503))

    @app.middleware("http")
    async def add_headers(request: Request, call_next):
        response = await call_next(request)
        # Cross-origin isolation: lets the browser run multi-threaded Stockfish (SharedArrayBuffer).
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        # Static files: always revalidate (cheap ETag check) so phones pick up new deploys.
        if not request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "version": __version__, "database": database_status()}

    app.include_router(repertoires.router)

    # Mounted last so /api routes take precedence.
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


app = create_app()
