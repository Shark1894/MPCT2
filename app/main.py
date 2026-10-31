"""MPCT web app: FastAPI serves the JSON API under /api and the static frontend from web/."""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from app import __version__

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def create_app() -> FastAPI:
    app = FastAPI(
        title="MPCT",
        version=__version__,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )

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
        return {"status": "ok", "version": __version__}

    # Mounted last so /api routes take precedence.
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


app = create_app()
