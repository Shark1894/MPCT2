#!/bin/sh
# Container entrypoint: bring the database schema up to date, then serve.
# A database problem must not take the board down, so migrations are retried a few
# times and the web server starts regardless (/api/health then reports the database
# as "unavailable" and the repertoire panel says so).

if [ -n "$DATABASE_URL" ]; then
  attempt=1
  until alembic upgrade head; do
    if [ "$attempt" -ge 5 ]; then
      echo "WARNING: database migrations failed after $attempt attempts; starting without them." >&2
      break
    fi
    echo "Database migration attempt $attempt failed; retrying in 3s..." >&2
    attempt=$((attempt + 1))
    sleep 3
  done
else
  echo "DATABASE_URL not set: repertoire features disabled." >&2
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
