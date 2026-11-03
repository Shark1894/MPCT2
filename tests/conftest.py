"""Test fixtures. Database tests need a throwaway Postgres database:

    TEST_DATABASE_URL=postgresql+psycopg://postgres@localhost:5432/mpct_test pytest

The schema is dropped and rebuilt with Alembic at the start of the run (which also
tests the migrations), and every table is emptied before each test.
"""

import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from app.config import settings
from app.db.session import get_engine
from app.main import app

ROOT = Path(__file__).resolve().parent.parent
TABLES = "position_evals, game_moves, games, opening_tags, move_attempts, line_reviews, position_comments, moves, lines, openings, repertoires, positions"


@pytest.fixture(scope="session")
def database():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set")
    if "test" not in url.rsplit("/", 1)[-1]:
        pytest.exit("Refusing to run: TEST_DATABASE_URL's database name must contain 'test' (it gets wiped)")

    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public"))
    engine.dispose()

    settings.database_url = url
    get_engine.cache_clear()
    command.upgrade(Config(str(ROOT / "alembic.ini")), "head")
    yield get_engine()
    get_engine().dispose()


@pytest.fixture
def db(database):
    with database.begin() as conn:
        conn.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    return database


@pytest.fixture
def client(db):
    return TestClient(app)


def count(db, table: str) -> int:
    with db.connect() as conn:
        return conn.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()
