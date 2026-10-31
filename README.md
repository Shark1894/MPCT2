# MPCT — Multi Purpose Chess Tool (web)

Web rebuild of the PyQt MPCT desktop app: opening repertoire builder, spaced-repetition
opening trainer, engine analysis and games database, usable from any device.

- **Backend:** FastAPI (Python). Serves the JSON API under `/api` and the static frontend.
- **Frontend:** plain ES modules, no build step. [chessground](https://github.com/lichess-org/chessground)
  draws the board, [chess.js](https://github.com/jhlywa/chess.js) enforces the rules.
- **Engine (later):** Stockfish compiled to WebAssembly, running in the browser.
- **Database (from Phase 2):** PostgreSQL.
- **Hosting:** Docker Compose on the home server, behind a Cloudflare tunnel + Cloudflare Access.

The full plan, decisions and data model are in the project's
[Architecture & Migration Plan](https://claude.ai/artifact/ToeRp5xeTfkE3tBMef25sV).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | FastAPI skeleton, Docker, health check | Done |
| 1 | Board: legal moves, move list, navigation, promotion, flip, FEN | Done |
| 2 | Postgres + repertoire API | Done |
| 3 | Repertoire UI: pickers, explorer, add/delete line, comments | Done |
| 4 | Opening trainer: spaced repetition, hints, practice retries | Done |
| 5 | Review dashboard | Done |
| 6 | Legacy data import | Next |
| 7–8 | Engine, games | Planned |

## Using the board

- Move by dragging, or tap a piece then a square. Only legal moves are accepted; dots show where the selected piece can go.
- Promotions open a piece picker (Escape or tap outside to cancel).
- Navigate with the buttons, the move list, or keys: **←/→** step, **↑** end, **↓** start, **Home/End**, **F** flips.
  The mouse wheel over the board also steps through moves.
- Stepping back and playing a different move replaces the moves after it; replaying the same move keeps them.
- Paste a FEN and press **Load FEN** (or Enter) to set up a position; **Copy FEN** copies the current one.
- Right-click drag draws arrows; right-click a square draws a circle.
- The current game is kept in the browser, so reloading the page (or a phone dropping the tab) doesn't lose it.

## Building a repertoire

- Pick a repertoire and opening at the top of the repertoire panel (**+** creates one; **Manage** renames or
  deletes). Choosing an opening turns the board to your side.
- **Repertoire moves** lists the opening's moves from the current position with how many lines use each, and
  draws them as green arrows. Tap one to play it.
- **Add line** saves the moves up to the current position. It reports whether that created a new line, extended
  an existing one, or was already covered.
- **Delete line** deletes every line in the opening that passes through the current position, after confirming
  how many.
- **Comment** notes are saved automatically as you type, per repertoire. The previous position's comment is
  shown underneath.

## API

Interactive docs: `/api/docs` (Swagger UI). Positions are sent as FEN; move counters and an
en passant square that allows no capture are ignored, so transpositions match.

| Method + path | Purpose |
| --- | --- |
| `GET/POST /api/repertoires` | List / create repertoires |
| `PATCH/DELETE /api/repertoires/{id}` | Rename / delete (cascades to everything in it) |
| `GET/POST /api/repertoires/{id}/openings` | List (with line, due and next-review counts) / create openings |
| `GET/PATCH/DELETE /api/openings/{id}` | One opening: summary / rename or recolour / delete |
| `GET /api/openings/{id}/lines` | Lines with their moves (SAN + UCI) |
| `POST /api/openings/{id}/lines` | Save moves `{"moves": ["e2e4", ...]}`: `created`, `extended` or `exists` |
| `GET/DELETE /api/openings/{id}/lines/through?fen=` | Count / delete the lines passing through a position |
| `DELETE /api/lines/{id}` | Delete one line |
| `GET /api/openings/{id}/explorer?fen=` | Repertoire moves from a position, with line counts |
| `GET/PUT /api/repertoires/{id}/comment` | Read / save a position comment (empty comment deletes it) |

Lines always start from the initial position. Extending a line makes it due for review today,
since it now has moves you haven't trained.

## Training

- **Train due (n)** reviews the opening's lines that are due, most overdue first; **Train all** drills every line.
- The app plays the opponent's moves; you play yours. The explorer is hidden and navigation is locked so nothing
  gives the answer away. Comments show while a line is still being learned (streak under 2) or after a mistake.
- Wrong move: it snaps back. After 2 wrong tries on a move the piece to move is highlighted; after 3 the move is
  shown as an arrow.
- A line with no mistakes adds 1 to its streak; any mistake resets the streak to 0 and makes it due again today.
  Next review after a streak of 0–6+: 0, 1, 3, 7, 14, 30, 60 days (capped at 60).
- **Retry** after a line is practice: recorded, but doesn't change the schedule. Stopping half-way records nothing.
- Every move tried is stored (`move_attempts`), including the wrong move actually played.

## Dashboard

The **Dashboard** tab (top bar) shows the selected opening: lines, due now, next review, total reviews and accuracy
(share of reviews without mistakes; practice retries excluded). Each line shows its next review, streak and last 5
results, with **Train** (just that line), **Show** (plays it on the board), **Reset** (clears its history, due
today) and **Delete**. **More** has Reset all lines, Delete all lines and Delete opening. On phones lines are cards.

API: `GET /api/openings/{id}/dashboard`, `POST /api/lines/{id}/reset`, `POST /api/openings/{id}/reset`,
`DELETE /api/openings/{id}/lines`.

Training API: `GET /api/openings/{id}/training?mode=due|all` (or `line_id=`) returns the lines to train;
`POST /api/lines/{id}/reviews` with `{"practice": false, "attempts": [{"ply": 2, "uci": "c7c6"}, ...]}` records a
finished line (the server checks each move against the line and updates the schedule).

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate   # fish: source .venv/bin/activate.fish
pip install -r requirements-dev.txt
export DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/mpct   # fish: set -x DATABASE_URL ...
alembic upgrade head
uvicorn app.main:app --reload --port 8010
# open http://localhost:8010
```

Without `DATABASE_URL` the board still works; the repertoire API answers 503.

## Database changes

Models live in `app/db/models.py`. After changing them:

```bash
alembic revision --autogenerate -m "describe the change"   # review the generated file in app/db/migrations/versions/
alembic upgrade head
```

The container runs `alembic upgrade head` on every start, so deploying a new version applies its migrations.

## Tests

```bash
TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/mpct_test pytest   # backend
npm test         # frontend game-state logic (Node 20+, no npm install needed)
```

The database tests drop and rebuild the schema of `TEST_DATABASE_URL`, so they refuse to run unless its
database name contains `test`. Without it set, they're skipped.

Browser checks against a running copy (the repertoire suite needs an empty database):

```bash
npm i --no-save playwright && npx playwright install chromium
MPCT_URL=http://localhost:8010/ node tests/e2e/board.e2e.cjs
MPCT_URL=http://localhost:8010/ node tests/e2e/repertoire.e2e.cjs   # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/training.e2e.cjs     # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/dashboard.e2e.cjs    # empty database
```

## Deploy on the home server

The server runs Postgres, Caddy and cloudflared from the Compose project in `~/docker`; MPCT is a
separate Compose project in `~/docker/mpct` that joins the same Docker network.

1. **Clone** (read-only deploy key on the server)

   ```bash
   cd ~/docker && git clone git@github.com:Shark1894/MPCT2.git mpct && cd mpct
   cp .env.example .env
   ```

2. **Join the shared network.** Create `docker-compose.override.yml` (git-ignored) with the network
   cloudflared/Caddy/Postgres use (`docker inspect cloudflared` shows it):

   ```yaml
   services:
     mpct:
       networks: [default, homeserver]
   networks:
     homeserver:
       external: true
       name: docker_default
   ```

3. **Create the database** (once). Postgres runs in the `postgres` container:

   ```bash
   MPCT_DB_PASSWORD=$(openssl rand -hex 24)
   docker exec -i postgres psql -U jason -d postgres -v pw="$MPCT_DB_PASSWORD" < scripts/create_database.sql
   echo "DATABASE_URL=postgresql+psycopg://mpct:$MPCT_DB_PASSWORD@postgres:5432/mpct" >> .env
   ```

4. **Start**

   ```bash
   docker compose up -d --build
   curl -s localhost:8010/api/health   # {"status":"ok","version":...,"database":"ok"}
   ```

   Tables are created and migrated automatically on start. The published port is bound to
   `127.0.0.1` only.

5. **Route the subdomain.** Caddy (`~/docker/Caddyfile`):

   ```
   http://chess.sharkeyhome.co.uk {
   	reverse_proxy mpct:8000
   }
   ```

   Cloudflare tunnel: a published-application route `chess.sharkeyhome.co.uk` → `http://caddy:80`.
   Cloudflare Access: a self-hosted application for the hostname with an Allow policy for your email only
   (one-time PIN login). The app itself has no login.

6. **Update later:** `cd ~/docker/mpct && git pull && docker compose up -d --build`. Static files are served
   from a URL containing a hash of their contents (`/assets/<build>/...`), so no browser or Cloudflare cache
   can serve an old copy; the page itself is never cached. `/api/health` shows the current `build`.

## Layout

```
app/
  main.py         app factory: routes, error mapping, headers, static files
  config.py       settings from environment / .env
  core/           pure chess logic (position keys, add-line rules), no web or DB imports
  db/             SQLAlchemy models, session, Alembic migrations
  repositories/   database queries (replaces the legacy DBFunctions.py)
  api/            FastAPI routers + request/response schemas
web/              frontend served as-is
  js/game.js      game state + rules wrapper (pure logic, unit tested)
  js/board.js     chessground wrapper + promotion picker
  js/movelist.js  move list rendering
  js/repertoire.js repertoire panel: pickers, explorer, lines, comments
  js/trainer.js   training session rules (pure logic, unit tested)
  js/training.js  training mode: board, auto replies, hints, results
  js/dashboard.js dashboard view: stats, lines with history, resets
  js/api.js       JSON API client
  js/ui.js        dialogs, toast, local storage
  js/main.js      page wiring, keyboard, FEN tools
  vendor/         pinned third-party libraries (see below)
scripts/          one-off server scripts (database setup)
tests/            pytest (backend), tests/js (Node), tests/e2e (Playwright)
```

## Third-party code

| Library | Version | Licence | Location |
| --- | --- | --- | --- |
| chessground | 9.2.1 | GPL-3.0-or-later | `web/vendor/chessground/` |
| chess.js | 1.4.0 | BSD-2-Clause | `web/vendor/chess.js/` |
| python-chess | 1.11.2 | GPL-3.0-or-later | `requirements.txt` |

The cburnett piece set and brown board theme ship with chessground. Because chessground and python-chess are GPL-3.0, keep this
repository private or license it under the GPL if you ever publish it.

To update a vendored library: `npm install <pkg>@<version>` in a scratch folder and copy the files listed above.
