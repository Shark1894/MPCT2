"""One pooled engine for the whole app (the legacy code created a new engine per query)."""

from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session

from app.config import settings


class DatabaseNotConfigured(RuntimeError):
    pass


@lru_cache
def get_engine() -> Engine:
    if not settings.database_url:
        raise DatabaseNotConfigured("DATABASE_URL is not set")
    return create_engine(settings.database_url, pool_pre_ping=True, pool_size=5, max_overflow=5)


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one transaction per request, committed on success, rolled back on error."""
    with Session(get_engine()) as session, session.begin():
        yield session


def database_status() -> str:
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        return "ok"
    except DatabaseNotConfigured:
        return "not configured"
    except Exception:
        return "unavailable"
