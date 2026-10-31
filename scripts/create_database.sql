-- Creates MPCT's own Postgres user and database (run once, as the Postgres superuser).
--
-- On the home server (Postgres runs in the "postgres" container):
--
--   MPCT_DB_PASSWORD=$(openssl rand -hex 24)
--   docker exec -i postgres psql -U jason -d postgres -v pw="$MPCT_DB_PASSWORD" < scripts/create_database.sql
--   echo "DATABASE_URL=postgresql+psycopg://mpct:$MPCT_DB_PASSWORD@postgres:5432/mpct" >> .env
--
-- The app creates and upgrades its own tables on start (Alembic), so nothing else is needed.

\set ON_ERROR_STOP on

CREATE ROLE mpct LOGIN PASSWORD :'pw';
CREATE DATABASE mpct OWNER mpct;
REVOKE ALL ON DATABASE mpct FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE mpct TO mpct;
