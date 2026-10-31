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
| 2 | Postgres + repertoire API | Next |
| 3–8 | Repertoire UI, trainer, dashboard, data import, engine, games | Planned |

## Using the board

- Move by dragging, or tap a piece then a square. Only legal moves are accepted; dots show where the selected piece can go.
- Promotions open a piece picker (Escape or tap outside to cancel).
- Navigate with the buttons, the move list, or keys: **←/→** step, **↑** end, **↓** start, **Home/End**, **F** flips.
  The mouse wheel over the board also steps through moves.
- Stepping back and playing a different move replaces the moves after it; replaying the same move keeps them.
- Paste a FEN and press **Load FEN** (or Enter) to set up a position; **Copy FEN** copies the current one.
- Right-click drag draws arrows; right-click a square draws a circle.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate   # fish: source .venv/bin/activate.fish
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8010
# open http://localhost:8010
```

## Tests

```bash
pytest           # backend
npm test         # frontend game-state logic (Node 20+, no npm install needed)
```

Browser checks (drag/tap moves, promotion, navigation, phone layout) against a running copy:

```bash
npm i --no-save playwright && npx playwright install chromium
MPCT_URL=http://localhost:8010/ node tests/e2e/board.e2e.cjs
```

## Deploy on the home server

1. **Clone and start**

   ```bash
   git clone https://github.com/Shark1894/MPCT2.git mpct && cd mpct
   cp .env.example .env            # set MPCT_PORT if 8010 is taken
   docker compose up -d --build
   curl -s localhost:8010/api/health   # {"status":"ok",...}
   ```

   The port is bound to `127.0.0.1` only, so nothing outside the server can reach it except through the tunnel.

2. **Add the subdomain to the Cloudflare tunnel.** Add a public hostname (e.g. `chess.sharkeyhome.co.uk`)
   pointing at `http://localhost:8010`. If cloudflared runs in a container on a Docker network instead, attach
   the `mpct` service to that network and use `http://mpct:8000`.

3. **Protect it with Cloudflare Access.** In the Zero Trust dashboard, add a *self-hosted* Access application
   for the same hostname with an **Allow** policy that includes only your email address. Access then asks for a
   one-time code sent to that email before any page loads. The app itself has no login.

4. **Update later:** `git pull && docker compose up -d --build`. Static files are served with
   `Cache-Control: no-cache`, so phones pick up new versions on the next load.

## Layout

```
app/            FastAPI app (main.py: routes, static files, headers)
web/            frontend served as-is
  js/game.js      game state + rules wrapper (pure logic, unit tested)
  js/board.js     chessground wrapper + promotion picker
  js/movelist.js  move list rendering
  js/main.js      page wiring, keyboard, FEN tools
  vendor/         pinned third-party libraries (see below)
tests/          pytest (backend) and tests/js (Node test runner)
```

## Third-party code

| Library | Version | Licence | Location |
| --- | --- | --- | --- |
| chessground | 9.2.1 | GPL-3.0-or-later | `web/vendor/chessground/` |
| chess.js | 1.4.0 | BSD-2-Clause | `web/vendor/chess.js/` |

The cburnett piece set and brown board theme ship with chessground. Because chessground is GPL-3.0, keep this
repository private or license it under the GPL if you ever publish it.

To update a vendored library: `npm install <pkg>@<version>` in a scratch folder and copy the files listed above.
