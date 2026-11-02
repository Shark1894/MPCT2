#!/bin/sh
# Replace the test database with a fresh copy of the live one.
#
#   cd ~/docker/mpct-test && scripts/refresh_test_db.sh
#
# Live is only read (pg_dump). The test app is stopped while its database is swapped, then
# started again, which runs the dev branch's migrations on top of the copied live data.
# Everything in the test database is replaced, including anything you did on the test site.
#
# Defaults match the home server; override with environment variables if needed.
# Set PG_CONTAINER= (empty) to run psql/pg_dump directly instead of inside a container,
# and TEST_CONTAINER= (empty) to skip stopping/starting the test app.

set -eu

PG_CONTAINER=${PG_CONTAINER-postgres}
PG_SUPERUSER=${PG_SUPERUSER:-jason}
LIVE_DB=${LIVE_DB:-mpct}
TEST_DB=${TEST_DB:-mpct_staging}
TEST_ROLE=${TEST_ROLE:-$TEST_DB}
TEST_CONTAINER=${TEST_CONTAINER-mpct-test}

if [ "$TEST_DB" = "$LIVE_DB" ] || [ "$TEST_DB" = "mpct" ]; then
  echo "Refusing: TEST_DB ($TEST_DB) must not be the live database." >&2
  exit 1
fi

pg() {
  if [ -n "$PG_CONTAINER" ]; then
    docker exec -i "$PG_CONTAINER" "$@"
  else
    "$@"
  fi
}

sql() {
  pg psql -X -q -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d postgres -c "$1"
}

dump=$(mktemp)
trap 'rm -f "$dump"' EXIT

# 1. Dump live first, so a failed dump leaves the test database untouched.
echo "Dumping $LIVE_DB..."
pg pg_dump -U "$PG_SUPERUSER" -d "$LIVE_DB" --format=custom --no-owner --no-privileges > "$dump"
if [ ! -s "$dump" ]; then
  echo "Dump of $LIVE_DB is empty; aborting." >&2
  exit 1
fi

# 2. Stop the test app so nothing holds the database open.
restart=""
if [ -n "$TEST_CONTAINER" ] && [ -n "$(docker ps -q --filter "name=^${TEST_CONTAINER}\$")" ]; then
  echo "Stopping $TEST_CONTAINER..."
  docker stop "$TEST_CONTAINER" > /dev/null
  restart=1
fi

# 3. Recreate the test database, then restore with every object owned by the test role.
echo "Recreating $TEST_DB..."
sql "DROP DATABASE IF EXISTS \"$TEST_DB\" WITH (FORCE)"
sql "CREATE DATABASE \"$TEST_DB\" OWNER \"$TEST_ROLE\""
sql "REVOKE ALL ON DATABASE \"$TEST_DB\" FROM PUBLIC"
sql "GRANT CONNECT, TEMPORARY ON DATABASE \"$TEST_DB\" TO \"$TEST_ROLE\""

echo "Restoring into $TEST_DB..."
pg pg_restore -U "$PG_SUPERUSER" -d "$TEST_DB" --no-owner --no-privileges --role="$TEST_ROLE" --exit-on-error < "$dump"

pg psql -X -q -U "$PG_SUPERUSER" -d "$TEST_DB" -t -A -F ' ' -c \
  "SELECT 'Copied: ' || (SELECT count(*) FROM openings) || ' openings, '
       || (SELECT count(*) FROM lines) || ' lines, '
       || (SELECT count(*) FROM games) || ' games, '
       || (SELECT count(*) FROM line_reviews) || ' reviews'"

# 4. Start the test app again (it migrates the copy to the dev branch's schema on start).
if [ -n "$restart" ]; then
  echo "Starting $TEST_CONTAINER..."
  docker start "$TEST_CONTAINER" > /dev/null
fi
echo "Done."
