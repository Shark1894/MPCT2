-- Creates the test instance's own Postgres user and database (run once, as the Postgres superuser).
--
-- On the home server, from ~/docker/mpct-test:
--
--   MPCT_DB_PASSWORD=$(openssl rand -hex 24)
--   docker exec -i postgres psql -U jason -d postgres -v pw="$MPCT_DB_PASSWORD" < scripts/create_staging_database.sql
--   echo "DATABASE_URL=postgresql+psycopg://mpct_staging:$MPCT_DB_PASSWORD@postgres:5432/mpct_staging" >> .env
--
-- A separate role means the test app cannot even connect to the live "mpct" database.
-- The name deliberately doesn't contain "test": pytest wipes any database whose name does.
-- Fill it with live data using scripts/refresh_test_db.sh.

\set ON_ERROR_STOP on

CREATE ROLE mpct_staging LOGIN PASSWORD :'pw';
CREATE DATABASE mpct_staging OWNER mpct_staging;
REVOKE ALL ON DATABASE mpct_staging FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE mpct_staging TO mpct_staging;
