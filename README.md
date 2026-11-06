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
| 6 | Legacy data import (openings, lines, comments) | Done |
| 7 | Engine analysis (Stockfish 19 Lite in the browser) | Done |
| 7b | Play against the engine | Done |
| 8 | Games database: save, edit, PGN import/export, compare with repertoire | Done |
| — | Bookmarked lines; engine review of the moves on the board | Done |
| — | Repertoire in the wild: watched positions in tournament games | Done |
| — | Puzzles: the Lichess puzzle database, your own puzzle rating | Done |
| — | Puzzles from your own games, with spaced repetition | Done |
| — | Play on against the engine from the end of a training line | Done |
| — | Position drill: random repertoire positions without the moves before them | Done |
| — | Repertoire gap finder: masters replies your repertoire doesn't cover | Done |
| — | Masters explorer on the board: masters moves and top games for any position | Done |
| — | Hands-free training: moves read aloud, say yours | Done |
| — | Lichess game import: your recent Lichess games into Games, onto the board | Done |

## Using the board

- Move by dragging, or tap a piece then a square. Only legal moves are accepted; dots show where the selected piece can go.
- Promotions open a piece picker (Escape or tap outside to cancel).
- Navigate with the buttons, the move list, or keys: **←/→** step, **↑** end, **↓** start, **Home/End**, **F** flips.
  The mouse wheel over the board also steps through moves.
- Stepping back and playing a different move replaces the moves after it; replaying the same move keeps them.
- Paste a FEN and press **Load FEN** (or Enter) to set up a position; **Copy FEN** copies the current one.
- Right-click drag draws arrows; right-click a square draws a circle.
- The current game is kept in the browser, so reloading the page (or a phone dropping the tab) doesn't lose it.
- **Move sounds**: a click for a move, a knock for a capture, a ping for check, two clicks for castling, a rising pair
  for promotion; a buzz for a wrong answer in training or puzzles and a chime for a clean line or a solved puzzle.
  Stepping forward plays the move's sound; going back and jumping are silent. **Sound on/off** (or **M**) under the
  board, remembered per device. Made in the browser with the Web Audio API (no sound files); phones start the sound
  on your first tap.

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
| `PUT/DELETE /api/lines/{id}/bookmark` | Bookmark a line (optional note) / remove the bookmark |
| `GET /api/openings/{id}/explorer?fen=` | Repertoire moves from a position, with line counts |
| `GET/PUT /api/repertoires/{id}/comment` | Read / save a position comment (empty comment deletes it) |

Lines always start from the initial position. Extending a line makes it due for review today,
since it now has moves you haven't trained.

## Engine analysis

Stockfish 19 Lite runs in the browser (a Web Worker), so the server does no work. The multi-threaded build is
used because the app is cross-origin isolated (falls back to single-threaded otherwise); phones use at most 2
threads and a smaller hash.

- **Engine on/off** in the engine panel (setting remembered). Shows the evaluation (from White's side, `#3` = mate
  in 3), depth, and the best 1–5 lines; **Lines** and **Depth** (12–30 or no limit) are adjustable.
- Click any move in a line to play the line up to that move.
- Blue arrow = engine's best move, pale blue = the other lines (repertoire arrows stay green). An evaluation bar
  sits beside the board and flips with it.
- Analysis pauses during training (and is hidden), on the dashboard, and while the tab is in the background.

## Engine review

**Review** (engine panel, next to Play vs engine) analyses every position from the start up to the position on the
board: an opened game, a repertoire line opened with Show, or moves you just played. Step back first to review only
part of a game.

- **Before it starts** a dialog says how many positions it will analyse and lets you pick the thinking time per
  position: Quick 0.3 s, Standard 1 s (default), Deep 3 s, each with an estimate. Positions analysed before are
  reused, so a second review (or one sharing an opening with an earlier one) is faster.
- **While it runs**: a progress bar with "Analysing position 23 of 81 · about 40 s left", the graph and marks filling
  in as each position finishes, and Cancel (what's done is kept; Review again continues). Stockfish runs in this
  browser on its own worker; the live engine pauses meanwhile. Keep the tab open; on phones the screen stays on.
- **Results**: an evaluation graph of White's winning chances (tap to jump to a move; a copper strip marks moves in
  the selected opening's repertoire), marks in the move list, and for the selected move: the verdict, notes (missed
  mate, allows mate, lets a winning position slip), the engine's best move and its evaluation (with a green arrow
  for flagged moves), White's winning chances in the position and the evaluation. A summary gives each side's
  accuracy and counts.
- **Review again** (in the review panel) re-analyses the same moves, wherever you are in them, suggesting the next
  longer thinking time. Positions already analysed at least that long are kept; the current results stay on screen
  until the better ones arrive, and the longer analysis replaces the shorter one on the server.
- **How moves are judged**, the same for both sides, by the drop in the mover's winning chances (Lichess's curve):
  4.5+ points `?!` inaccuracy (about half a pawn from a level position; Lichess uses 10), 20+ `?` mistake,
  30+ `??` blunder. `!` = only move: the engine's best move, at least
  20 points better than the second best. Accuracy per move uses Lichess's formula. Each side's game accuracy is
  Lichess's too: the mean of (a) the move accuracies weighted by how much the winning chances swung around each move
  and (b) their harmonic mean. A plain average (used before v0.21.0) let a long game of easy moves hide a game-losing
  blunder and gave 95%+ to players who lost badly.
- The review stays while you look through the moves and survives a reload; playing a different move closes it.
- **Reviewed games:** when a review of a saved game's whole game finishes (open it from Games, go to the end, then
  Review), the game is marked reviewed: its accuracy shows in the Games list and the game panel, and its mistakes
  become puzzles (see Puzzles › From your games). A review that stops at an earlier move doesn't count. Editing the
  moves makes the game unreviewed again ("Moves changed: save the game, then review it"). **Review N unreviewed
  games** in the Games tab reviews them all one after another (1 s per position, reusing saved analysis), with
  progress and Stop (finished games are kept).
- **Saved evaluation**: whenever the board shows a position any review has analysed before (in any game or line,
  however it was reached), the engine panel shows White's winning chances and the score, even with the review
  closed. Hidden while the review panel is open or the live engine is on (they show the evaluation themselves), in
  training and in play.

Every analysed position is saved on the server (`position_evals`, keyed like repertoire positions, so transpositions
share it); a longer analysis replaces a shorter one, never the reverse. API: `POST /api/evals/lookup`
`{"fens": [...], "min_movetime_ms": 1000}` → evals in the same order (or null), `POST /api/evals`
`{"evals": [{"fen", "movetime_ms", "depth", "engine", "lines": [{"uci", "score": {"cp"|"mate"}, "pv"}]}]}`.

## Play against the engine

**Play vs engine** (in the engine panel) starts a game against Stockfish on the main board. Choose your side
(White, Black or random), a strength, and whether to start from the initial position or the position on the board
(handy for playing out a repertoire line). Your name is only used when saving.

Strengths: **Beginner ~800**, **Novice ~1000**, **Casual ~1200** use Stockfish's Skill Level with a shallow search
(ratings are rough); **1400–2500** use its built-in Elo limiter (UCI_LimitStrength); **Full strength** is unlimited.
The engine thinks for 0.1–1.5 s a move and never replies in under half a second.

While playing the engine panel and eval bar are hidden, and New board / Load FEN are unavailable. You can step back
through the moves to look, but only move at the end. **Take back** removes your last move and the engine's reply;
**Resign** and **Stop** (abandon, keeping the moves) ask first, as does starting training or opening a saved game.
A game in progress survives a reload. When it ends: **Save to games** (stored as "Practice vs engine" and opened
in the game panel), **Play again**, or **Analyse** (back to the normal board with the engine available).

Play uses its own Stockfish worker, so analysis settings are untouched. Nothing runs on the server.

## Branch tags

A tag names a position within one opening, e.g. "Queen's Gambit Accepted" after 1.d4 d5 2.c4 dxc4. Every line in
that opening passing through the position carries the tag (including transpositions and lines added later), and
tags can nest (a line can be in "QGA" and "QGA 3.e4").

- **Board:** the **Branches** section shows the tags along the current moves; tap one to jump there. **Tag this
  position** names the current position (not the start, and only where a line in the opening goes);
  **Rename tag** / **Remove tag** appear at a tagged position. Removing a tag keeps the lines.
- **Training:** the **Lines** dropdown (shown once an opening has tags) limits Train due / Train all to one branch.
  Picking a branch there also moves the board to its position: a jump if the board's moves already pass through it
  (later moves are kept), otherwise the branch's moves are set up from the start (asking first if that would end a
  game against the engine or discard changes to an open game). "All lines" leaves the board alone.
- **Dashboard:** the same filter (stats then cover just that branch), and each line lists its tags.

API: `GET/POST /api/openings/{id}/tags` (`{"name", "fen"}`), `PATCH/DELETE /api/tags/{id}`; `tag_id=` on
`/api/openings/{id}/training` and `/api/openings/{id}/dashboard`.

## Training

- **Train due (n)** reviews the opening's lines that are due, most overdue first; **Train all** drills every line.
- The app plays the opponent's moves; you play yours. The explorer is hidden and navigation is locked so nothing
  gives the answer away.
- Comments show while a line is still being learned (streak under 2). Once you've played a line correctly 2 or
  more times in a row they're hidden, and the training panel says so ("Comments hidden: you've played this line
  correctly 3 times in a row") with a **Show comments** button to peek (not counted as a mistake). After a mistake
  they come back, and stay visible for that line for the rest of the session, including retries.
- Wrong move: it snaps back. After 2 wrong tries on a move the piece to move is highlighted; after 3 the move is
  shown as an arrow.
- A line with no mistakes adds 1 to its streak; any mistake resets the streak to 0 and makes it due again today.
  Next review after a streak of 0–6+: 0, 1, 3, 7, 14, 30, 60 days (capped at 60).
- **Retry** after a failed line is a real review: get it right and it counts as correct (streak 0 → 1, due tomorrow);
  a mistake keeps it at 0, due today. The session summary counts the line as correct. Retrying a line you got right
  is practice: recorded, but doesn't change the schedule. Stopping half-way records nothing.
- Every move tried is stored (`move_attempts`), including the wrong move actually played.
- **Play on vs engine** (on the end-of-line card) carries on from the line's final position against Stockfish, with
  you on the repertoire's side, to practise the middlegame plans. It asks only for a strength (the last one used is
  preselected). The line's result is already saved by then, so the game is practice and never changes the schedule.
  The training session waits: **Next line** (or **Finish training** after the last line) in the play panel goes back
  to it (asking first if the game is still on), and **Save to games** saves the game as
  "Practice vs engine (<opening>)" and goes back too. **Stop** / **Analyse** ends the game and the session (a
  message says how many lines were left); so does anything else that ends the game, such as starting other
  training. A reload keeps the game but not the waiting session.

### Hands-free training

While training, **🎧 Hands-free** (under the training title) reads the opponent's moves aloud and listens for
yours, so you can train away from the screen. It stays on for later sessions until you switch it off (per device),
and keeps the screen awake while on. Sessions count as real reviews, with the same rules as on the board.

- Say moves the way you'd read them: “knight F3”, “E4”, “E takes D5”, “bishop takes C6”, “castles kingside”,
  “E8 queen”. Piece names and letters the recogniser often mishears (“night”, “be”, “see”, “for”…) are understood.
  What was heard is matched against the legal moves only, and a square on its own means the pawn move.
- **A mishearing never fails a line**: the recogniser's guesses are all checked and any that is the expected move
  counts; a different legal move is read back (“I heard knight D3. Is that right?”) and only counts as a mistake
  after “yes”; nothing recognisable gets “say that again”. **That was a mishearing** (button or said) takes the
  last mistake on the current move back.
- Hints are spoken (“move your knight on G8”, then the move itself); the line's result is read out and the next
  line starts by itself.
- Commands: “repeat” (the last move again), “moves” (the line so far), “that was a mishearing”, “stop” (hands-free
  off; training carries on).
- **Type a move** in the box instead (SAN or the spoken form); typed wrong moves count without asking.
  **Hide pieces** trains blindfold (the board keeps its squares and last-move highlight).

Speech out uses the browser's voices. For listening there are two recognisers:

- **The browser's speech service** (Chrome, Edge, Samsung Internet, Safari): used by default where it exists, e.g.
  Chrome on Android. Gives several guesses per move; needs a connection (it's Google's/Apple's service).
- **Offline, in this browser**: [Vosk](https://alphacephei.com/vosk/) compiled to WebAssembly (Lichess's fork of
  vosk-browser, `web/vendor/vosk/`), listening only for chess words, so it's accurate for moves. Used automatically
  where there's no built-in recogniser (**Firefox**), and selectable under **Recognition** where both work. The
  model (`vosk-model-small-en-us-0.15`, about 30 MB) downloads the first time and is kept in the browser after that
  (IndexedDB); nothing you say leaves the device. It doesn't know “kingside” or “mishearing”: say “castles king
  side” and “undo”.

Reading moves aloud uses the system's voices. **Firefox on Linux** has none until speech-dispatcher and a voice
engine are installed (Arch: `sudo pacman -S speech-dispatcher espeak-ng`, then restart Firefox; test with
`spd-say hello`); the panel says so when there are no voices.

Either way the microphone has to be allowed for the site. The Docker build downloads the Vosk model from
alphacephei.com once (`scripts/fetch_voice_model.py`; Docker's cache keeps it) into `/srv/mpct/voice`, served at a
versioned `/voice/...` URL that browsers cache for good. If that download fails the build carries on and the offline
recogniser says the model isn't installed (typing still works); rebuild with internet access to fix it.
`VOICE_MODEL_DIR` overrides where the server looks.

## Position drill

**Position drill** (under Train due / Train all) tests whether you know a position on its own, without the
move order as a crutch. It asks where the positions come from (the whole repertoire, both colours; the selected
opening; or one of its branch tags, from the tagged position on) and how many (10, 20 or 50; fewer if the scope
has fewer). Each one is set up on the board with no moves before it and your side to move; the starting position
is left out. Hints as in training: the piece after 2 wrong tries, the move after 3; **Show answer** gives it away
(counts as missed). Comments stay hidden until you've answered. After each answer: **Next position**, or **Play the
rest of the line** to carry on through one of the lines from there (not recorded).

The summary lists the positions you missed, with **Show** (leave the drill and put the line up to that position on
the board) and **Drill missed again**.

Practice only: schedules and streaks never change. Each answer is stored (`drill_attempts`); the API still folds
them into the dashboard's `problems` list (see Dashboard), though that list is no longer shown.

API: `GET /api/drill?repertoire_id=|opening_id=|tag_id=&count=` (random positions with the repertoire move(s), a
line through each and the SAN path to it), `POST /api/drill/results` (`{"results": [{opening_id, position_id,
expected_uci, correct, wrong: [uci, ...]}]}`).

## Dashboard

The **Dashboard** tab (top bar). At the top, always visible: the selected opening (or one branch of it) with
**Train due**, **Train weakest** (lines with a mistake in their last 5 reviews, weakest first, up to 15),
**Train all**, and **More** (Reset all lines, Delete all lines, Delete opening), then its stats: lines, due now,
next review, total reviews and accuracy (share of reviews without mistakes).

Below that, four sub-tabs (opens on Overview; after that the last one used is remembered per device; ← → move
between them):

- **Overview**: **Openings**, every opening in the repertoire (White first) with lines, due, accuracy and a
  learning-progress bar; click one to select it. **Training activity**: a grid of the last 26 weeks (shade =
  reviews that day), your current and longest run of consecutive training days, and how many days you trained.
- **Lines**: sort (next review, weakest, lowest streak, move order), show (all, due, not reviewed yet, recent
  mistakes, bookmarked) and search by move (`Bf5`, `3.e5`). Choices are remembered. Each line shows its next review,
  streak and last 5 results, with **☆** (bookmark), **Train**, **Show**, **Reset** (clears its history, due today)
  and **Delete**. On phones lines are cards. When Show or the search narrows the list, **Train shown (n)** trains
  exactly those lines in that order (**Train bookmarked (n)** with the Bookmarked filter).
- **Progress**: **learning progress**, lines by stage. New (never reviewed), learning (streak 0–1), known (2–4,
  comments hidden in training), mastered (5+, next review a month or more away). **Due over the next 2 weeks**:
  lines due each day (overdue lines count as today), plus how many are due later.
- **Gaps**: the repertoire gap finder (see below).

### Bookmarks

Star a line to come back to it later or show someone: **☆** on its dashboard row, or **☆** next to Stop while
training it (one tap, no dialog, so the line carries on). A bookmarked line shows a ✎ note under its moves: tap it to
add or edit a short note (up to 500 characters). Bookmarks survive extending or resetting the line. Removing a
bookmark deletes its note, and asks first if there is one.
API: `PUT /api/lines/{id}/bookmark` with `{"note": "..."}` (bookmarks, or changes the note; empty = no note),
`DELETE /api/lines/{id}/bookmark`. Dashboard and training lines include `bookmarked` and `bookmark_note`.

Practice retries (of a line already played correctly) are left out of everything here. Hover or tap a bar, segment
or day for its numbers.

### Repertoire gaps

The **Repertoire gaps** card lists replies that strong players actually play but the selected opening doesn't
answer, from the Lichess opening explorer's masters database (over-the-board games between 2200+ players).

- **Check with Lichess masters** looks up every position in the opening where it's your opponent's move and your
  repertoire already has at least one reply. Line ends (where you chose to stop) and the starting position (an
  opening for Black answers one first move on purpose) aren't checked; the starting position is still looked up,
  for how often the first move is played. Answers are cached on the server for 180 days, so a position is looked up
  once; requests go one at a time, about a second apart, in the background (progress bar, **Stop**). A stopped or
  failed check keeps what it got, and **Check again** fetches only what's missing (e.g. after adding lines).
- A reply is covered if **any** opening of the same colour in the repertoire plays it from that position, so
  transpositions into your other openings aren't gaps.
- Shown: replies played in at least 5% of the position's masters games (2% / 10% in the menu; at least 5 games),
  most often met first: the chance of reaching the position (the masters share of each opponent move on the way,
  your moves always played) times the reply's share there. Each says what your repertoire plays there.
- **Show** puts the position and the reply on the board, so you can add a line from there with **Add line**.

Needs a Lichess personal API token on the server (the explorer has required one since 2026): create one, free with
no scopes, at https://lichess.org/account/oauth/token, add `LICHESS_TOKEN=lip_…` to `.env` and restart
(`docker compose up -d`). Without it the card says so and the button is off. `LICHESS_EXPLORER_URL` overrides the
explorer address (default `https://explorer.lichess.org`).

API: `GET /api/openings/{id}/gaps?min_share=5&min_games=5`, `POST /api/openings/{id}/gaps/check` (starts a
background check; 409 without a token or while one runs), `GET /api/explorer/status`, `POST /api/explorer/stop`.

## Masters explorer (board)

The **Masters** section on the board (under Branches; tap the heading to open or close it, remembered per device)
shows what strong players play from the board position, from the same Lichess masters database as the gap finder:

- **Moves**: each masters move with its number of games and share, a White-wins / draws / Black-wins bar and the
  players' average rating. Tap a move to play it. It works for any position, not just your repertoire.
- **Top games**: up to 15 of the strongest games that reached the position, with players, ratings, result, year and
  the move played there. Tap one to open it on the board at this position, in the game panel like a tournament
  game from the Wild tab: read-only, PGN download, and **Save to Games** to keep it as one of yours.
- Looked up only while the section is open, once the position has settled (stepping through moves quickly doesn't
  send a request per move), and kept for the session; the server caches each position for 180 days, shared with
  the gap finder (one lookup serves both). An opened game is fetched once and kept in `masters_games`.
- Hidden while training, drilling, solving puzzles or playing the engine, since it would give the answers away.

Needs the same `LICHESS_TOKEN` as the gap finder; without it the section says how to add one. If Lichess is busy
(HTTP 429) it says so with **Try again** rather than waiting a minute.

API: `GET /api/masters?fen=` (moves, totals and top games; 409 without a token, 502 if Lichess fails),
`GET /api/masters/games/{id}` (fetched from Lichess the first time), `GET /api/masters/games/{id}/pgn`,
`POST /api/masters/games/{id}/save` (copies it into Games; saving again opens the existing copy).

API: `GET /api/openings/{id}/dashboard` (stats, stages, forecast, problem positions (not shown since v0.25.3), lines),
`GET /api/repertoires/{id}/overview`, `GET /api/activity?tz=Europe/London&days=182`, `POST /api/lines/{id}/reset`, `POST /api/openings/{id}/reset`,
`DELETE /api/openings/{id}/lines`.

Training API: `GET /api/openings/{id}/training?mode=due|all` (or `line_id=`, or `line_ids=3,1,7` in that order) returns the lines to train;
`POST /api/lines/{id}/reviews` with `{"practice": false, "attempts": [{"ply": 2, "uci": "c7c6"}, ...]}` records a
finished line (the server checks each move against the line and updates the schedule).

## Repertoire in the wild

See when strong players reach your positions. Tournament games are fetched in the background from
[Lichess broadcasts](https://lichess.org/broadcast) and [The Week in Chess](https://theweekinchess.com) (TWIC), and
any game that reaches a branch you watch shows up in the **Wild** tab.

- **Watch a branch:** only branch tags can be watched. On the Board, go to a tagged position (or tag one under
  Branches) and tap **Watch in the wild** next to the tag's buttons. The button then shows how many games reach it;
  tap again to stop (the tag stays). Transpositions count: the position is matched, not the move order. Removing the
  tag removes the watch.
- **Wild tab:** the branches you watch, under their tag names (with game counts, **Games**, **Show**, **Rename** (renames
  the tag), **Unwatch**), and the games that reached them, newest first: players and ratings, event and round, result,
  and the branch and move where it came up. Each game is marked **New** until you open it, then **Viewed** with the
  date; **Not viewed** shows only the games you haven't opened. Filter by watched position, by rating (**A player 2000+** … **2700+**: at least one player rated that
  or higher; remembered, and the counts, the board's Watch button and the new-games count follow it), or search
  players and event. **Open** puts the game on the board at that
  position (the rest of the game follows, so you can step through it or review it with the engine), with the same
  details panel as your own games: players with ratings, event, date, result, plus round, site and source. The details
  are read-only, **PGN** downloads it, **Compare with repertoire** works as usual, and it stays open after a reload.
  **Save to Games** (on the row or in the panel) copies it into the Games tab; from the panel it then carries on as
  one of your games, editable, at the same move. The tab shows a count of new games since you last looked.
- **Fetching:** a minute after the app starts, then every 6 hours, or **Check now**. TWIC is fetched from 1 January
  2026 (`WILD_SINCE`): every issue since then, once each (a missed issue is picked up on the next run). Lichess offers
  only its recent broadcasts (5 pages of the list), so its history builds up from when fetching started. Finished
  broadcasts are fetched once, live ones again until they end. Unfinished games are skipped, and a game found in both
  sources is stored once.
- **Storage:** every game is kept, so the history grows over time: about 2 KB a game, roughly 0.5–0.6 GB for 2026 so
  far and maybe 1.5–2 GB a year after that. Each game keeps a hash of each of its first 20 moves' positions, so
  matching is one indexed lookup. The games are part of the database, so they're in backups and the test copy too.

Settings (environment): `WILD_FETCH=false` turns fetching off (the tab still works with games already stored),
`WILD_INTERVAL_HOURS` (default 6), `WILD_SINCE` (default 2026-01-01: how far back TWIC and Lichess are fetched).

If a site blocks the server's downloads, load a file by hand (a TWIC zip or any PGN):

```bash
docker cp twic1669g.zip mpct:/tmp/
docker compose exec mpct python -m app.tools.import_wild_pgn /tmp/twic1669g.zip
```

API: `GET /api/repertoires/{id}/watches`, `GET /api/openings/{id}/watches`, `PUT/DELETE /api/tags/{id}/watch`,
`DELETE /api/watches/{id}`, `POST /api/wild-games/{id}/viewed`, `GET /api/repertoires/{id}/wild-games?watch_id=&q=&min_elo=&unviewed=&limit=&offset=` (`min_elo` also on the watches and status calls),
`GET /api/wild-games/{id}` (with moves), `GET /api/wild-games/{id}/pgn`, `POST /api/wild-games/{id}/save`, `GET /api/wild/status?repertoire_id=&since=`,
`POST /api/wild/refresh`.

## Puzzles

The **Puzzles** tab: tactics from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0, about
6 million puzzles) with your own puzzle rating.

- **The database:** **Download puzzles** streams the compressed file (about 260 MB) from Lichess into Postgres in the
  background, with a progress bar: a few minutes, about 2 GB in the database. **Update puzzles** later replaces them
  with the latest file; your attempts and rating are kept. A failed download leaves the previous puzzles in place.
  By hand: `python -m app.tools.import_puzzles` (or give it a downloaded `.csv.zst` file).
- **Solving:** **Start puzzles** (any theme, or pick one) opens puzzle mode on the board, like training: the opponent's
  move is played, then it's yours, from your side of the board. The first wrong move fails the puzzle, as on Lichess
  (the rating change shows straight away); you can keep trying (after a second wrong try the piece to move is
  highlighted) or show the **Solution**. Any checkmate is accepted. **Skip** moves on (counts as failed if you'd
  started). After a puzzle: the result and rating change, its themes and opening, a link to the game on Lichess,
  **Next puzzle** and **Retry** (not rated). Once a puzzle is over the engine and move navigation are free, to look
  at it. While solving the engine, repertoire panel and other tabs are hidden.
- **Which puzzle:** a random one within 200 of your rating that you haven't tried (wider if none is left), skipping
  puzzles players voted down. Only the first go at a puzzle is rated.
- **Rating:** Glicko-2, starting at 1500 (shown with a ? while it settles, for your first few dozen puzzles); each
  attempt is a game against the puzzle's own rating, as on Lichess.
- **Tab:** your rating and record (today too), rating history (last rating of each day), themes to work on (rated
  results per theme once you've done 5, weakest first, with **Practise**), and recent puzzles with **Retry**.

### From your games

The **From your games** card on the Puzzles tab turns your own mistakes into puzzles.

- **Where they come from:** only games reviewed with the engine (see Engine review › Reviewed games). The card
  says how many of your games are reviewed, and **Review them** goes to the Games tab to review the rest. A move
  becomes a puzzle when it lost at least 20 points of winning chances (a mistake; 30 is a blunder), there was one
  clearly best move (20 points better than the next), the player wasn't already losing (under 15%), and it isn't a
  move from your repertoire. Both sides' mistakes are kept; the ones on your side are shown.
- **Which side was you:** the names you play under, set with **Change** (your Lichess username, your name in PGNs…);
  guessed from the name in most of your games until you set them. Changing them needs no new review. Reviewed games
  where neither player matches give no puzzles (the card counts them).
- **Practising:** spaced repetition, the same schedule as your repertoire lines. **Practise due** gives today's;
  **Practise all** the lot in random order; or **Practise** one from the list. The board starts just before your
  move, after the opponent's move: find the best one. Only your first go in a session counts; **Retry** is practice.
  Afterwards: when it's next due, what you played and what it cost, the engine's line, and **Open the game** at that
  move. **Remove** drops one that isn't useful, for good (reviewing the game again won't bring it back).

API: `GET /api/game-reviews/queue` (games without a current review), `POST /api/game-reviews/{game_id}`
(`{"moves", "movetime_ms", "accuracy": {"w", "b"}, "counts", "candidates"}`; `moves` must be the game's saved moves),
`GET /api/game-puzzles/status`, `PUT /api/game-puzzles/names` (`{"names"}`), `GET /api/game-puzzles?due=&game_id=`,
`POST /api/game-puzzles/{id}/reviews` (`{"correct"}`), `DELETE /api/game-puzzles/{id}`. Games include `review`
(accuracy, counts) when they have a current one.

The test-site refresh (`scripts/refresh_test_db.sh`) leaves the puzzle database out; download it there separately if
you want puzzles on the test site.

API: `GET /api/puzzles/status`, `POST /api/puzzles/import`, `GET /api/puzzles/themes`, `GET /api/puzzles/summary`,
`GET /api/puzzles/next?theme=&exclude=`, `GET /api/puzzles/{id}`, `POST /api/puzzles/{id}/attempts`
(`{"solved", "seconds"}`).

## Games

The **Games** tab lists your games newest first (date, players with teams, competition, opening moves, result),
with a search box that matches players, teams and competition.

Filters under the search box narrow the list further, and are remembered on the device:

- **Player**: every name in your games, most games first (names match whatever their capitals). With a player
  chosen, **As White / As Black** appears, and the result filter becomes theirs: **Won**, **Lost**, **Drawn**.
- **Result** without a player: **White won**, **Black won**, **Draw**, or **Unfinished**.
- **Reviewed** / **Not reviewed** (has a current engine review).
- **Clear filters** resets them. Export PGN downloads exactly the filtered list.

- **New game** asks for the details (date defaults to today) and can keep the moves already on the board.
- **Import PGN** takes pasted text or one or more `.pgn` files (choose several at once; they're loaded one after
  another, and very large imports are sent in parts, split between games). Only the main line is kept; `WhiteTeam`/`BlackTeam`, `Event`
  and `Date` tags are read. Games already in the app (same players, date and moves) are skipped, and games with
  illegal moves are listed rather than imported.
- **Export PGN** downloads every game matching the search; **PGN** on a row downloads one game.
- **Open** loads a game on the board. A panel above the move buttons holds its details. Play or take back moves,
  edit the details and **Save**; unsaved changes are marked, and closing the game, starting training or leaving
  the page asks first. The open game is reopened after a reload. A reviewed game opens with its review showing:
  the evaluation graph, move marks and per-side summary, rebuilt from the saved analysis (no engine run).
- **Compare with repertoire** checks the game against the selected opening and reports where it left the book,
  whose move it was and what the repertoire plays, with **Show that position**.

### From Lichess

**From Lichess** opens a box with your latest finished games on lichess.org, fetched when it opens (and again
each time you come back to the Games tab while it's open). No password or token is needed: games are public, so
your **Lichess username** is enough. It's asked for the first time (**Change** next to it later), stored as an app
setting, and added to your names in games so puzzles know which side was you. `LICHESS_TOKEN` is sent when it's
set, because Lichess lets authenticated requests download faster; a refused token falls back to no token.

- Each row: when it was played (your time zone), players with ratings, speed and clock, rated or casual, the
  opening, length, and the result from your side (**Won** / **Lost** / **Drawn**), plus a link to it on Lichess.
- **Open** imports the game into Games (once: it's remembered by its Lichess id) and opens it on the board, ready
  for Review, Compare with repertoire and puzzles. A game you already had from a PGN (same players, date and moves)
  is linked rather than copied. Imported games show "Imported from Lichess · View on lichess.org" in the game panel.
- **Open latest** does that for your most recent finished game in one tap: play on Lichess, then come here.
- **Import N new games** imports every listed game that isn't in Games yet (one request). **Show more** lists
  50, then 100.
- Standard games and games from a set-up position can be imported; Chess960 and other variants, and aborted
  games, are listed but can't. Imported games: players as on Lichess (AI games as "Stockfish level N"),
  competition "Lichess · Blitz 3+2 · rated", date = the day the game started (UTC), main line only.

API: `GET /api/lichess/settings`, `PUT /api/lichess/username` (`{"username": "..."}`, `""` clears it),
`GET /api/lichess/games?max=20` (fetched from Lichess now, nothing stored; 409 without a username, 404 for an
unknown user), `POST /api/lichess/games/{id}/import` (`{game_id, created}`), `POST /api/lichess/latest`,
`POST /api/lichess/import-new?max=20`. Games carry `lichess_id`. `LICHESS_API_URL` (default `https://lichess.org`)
points elsewhere for tests.

API: `GET/POST /api/games` (`?q=` search; filters `player`, `color` = white|black (needs a player),
`result` = white|black|draw|unfinished or won|lost|drawn (needs a player), `reviewed` = yes|no),
`GET /api/games/players` (names with game counts), `GET/PATCH/DELETE /api/games/{id}`, `GET /api/games/{id}/pgn`,
`GET /api/pgn/games` (all matching games, same search and filters), `POST /api/games/import-pgn` (`{"pgn": "..."}`),
`POST /api/openings/{id}/check` (`{"moves": ["e2e4", ...]}`).

## Importing from the desktop app

`app/tools/import_legacy.py` copies the openings, lines and position comments from a PyQt MPCT repertoire file
into a new repertoire. Review history isn't imported: every line starts fresh and is due today. Move names are
regenerated from the moves (fixing the legacy extension bug), positions are re-keyed (fixing the en passant
bug), duplicate or overlapping lines are merged and illegal ones reported.

On the server, copy the file into the container and run it (dry run first):

```bash
docker cp Main.db mpct:/tmp/Main.db
docker compose exec mpct python -m app.tools.import_legacy /tmp/Main.db --repertoire Main --dry-run
docker compose exec mpct python -m app.tools.import_legacy /tmp/Main.db --repertoire Main
```

`--replace` overwrites an existing repertoire of that name; `--no-comments` skips comments.

The same tool recognises the legacy games file and imports every game (players, teams, competition, date,
result, moves). `--repertoire` isn't needed, and reruns skip games already imported:

```bash
docker cp Games.db mpct:/tmp/Games.db
docker compose exec mpct python -m app.tools.import_legacy /tmp/Games.db --dry-run
docker compose exec mpct python -m app.tools.import_legacy /tmp/Games.db
```

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

For offline hands-free recognition locally (Firefox), fetch the speech model once and point the server at it:
`python scripts/fetch_voice_model.py ./voice` then `VOICE_MODEL_DIR=./voice` (fish: `set -x VOICE_MODEL_DIR ./voice`).

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
MPCT_URL=http://localhost:8010/ node tests/e2e/sounds.e2e.cjs      # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/repertoire.e2e.cjs   # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/training.e2e.cjs     # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/dashboard.e2e.cjs    # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/tags.e2e.cjs         # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/engine.e2e.cjs       # runs the real engine
MPCT_URL=http://localhost:8010/ node tests/e2e/games.e2e.cjs        # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/play.e2e.cjs         # empty database, real engine
MPCT_URL=http://localhost:8010/ node tests/e2e/gamefilters.e2e.cjs   # empty database (filters; reviewed game shows its graph)
MPCT_URL=http://localhost:8010/ node tests/e2e/drill.e2e.cjs        # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/continue.e2e.cjs     # empty database, real engine (play on after a line)
MPCT_URL=http://localhost:8010/ node tests/e2e/insights.e2e.cjs     # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/bookmarks.e2e.cjs    # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/review.e2e.cjs       # empty database, real engine
# empty database, server started with WILD_FETCH=false; loads games with the import tool:
MPCT_URL=http://localhost:8010/ MPCT_DATABASE_URL=postgresql+psycopg://... node tests/e2e/wild.e2e.cjs
MPCT_URL=http://localhost:8010/ MPCT_DATABASE_URL=postgresql+psycopg://... node tests/e2e/puzzles.e2e.cjs   # empty database
MPCT_URL=http://localhost:8010/ node tests/e2e/gamepuzzles.e2e.cjs  # empty database, real engine (reviews + puzzles)
# empty database; the server talks to the fake explorer (python tests/e2e/fake_explorer.py 8099 &) and is
# started with LICHESS_TOKEN=lip_e2e LICHESS_EXPLORER_URL=http://127.0.0.1:8099:
MPCT_URL=http://localhost:8010/ node tests/e2e/gaps.e2e.cjs
MPCT_URL=http://localhost:8010/ node tests/e2e/masters.e2e.cjs
# the fake also plays Lichess (user JasonS); server started with LICHESS_API_URL=http://127.0.0.1:8099
# (restart the fake between runs: some checks count its requests):
MPCT_URL=http://localhost:8010/ node tests/e2e/lichess.e2e.cjs
MPCT_URL=http://localhost:8010/ node tests/e2e/handsfree.e2e.cjs    # empty database (fake speech in and out)
# optional, real speech through the offline recogniser: server with VOICE_MODEL_DIR set, WAVs made with espeak-ng
MPCT_URL=http://localhost:8010/ node tests/e2e/voskvoice.e2e.cjs
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

## Test environment

A second copy of the app at `chess-test.sharkeyhome.co.uk` for trying new work before it reaches the live
site. It runs the `dev` branch against its own database (`mpct_staging`), filled on demand with a copy of
live data. Its pages have an orange top bar, a TEST badge and a "TEST ·" tab title.

Workflow: commit to `dev` → deploy and try it on test → merge `dev` into `main` → deploy live.

| | Live | Test |
| --- | --- | --- |
| Clone (on the server) | `~/docker/mpct` on `main` | `~/docker/mpct-test` on `dev` |
| Compose file | `docker-compose.yml` | `docker-compose.test.yml` (selected by `COMPOSE_FILE` in `.env`) |
| Service / container | `mpct` | `mpct-test` |
| Host port | 8010 | 8011 |
| Database / role | `mpct` | `mpct_staging` (cannot connect to `mpct`) |

The test service is deliberately not called `mpct`. Compose adds each service name as a DNS alias on the
shared network, so two services named `mpct` would let Caddy's `reverse_proxy mpct:8000` reach either one.
The database name avoids "test" because the pytest suite wipes any database whose name contains it.

### One-time setup

1. **Clone the dev branch** (the same read-only deploy key works):

   ```bash
   cd ~/docker && git clone -b dev git@github.com:Shark1894/MPCT2.git mpct-test && cd mpct-test
   printf 'COMPOSE_FILE=docker-compose.test.yml:docker-compose.override.yml\nMPCT_PORT=8011\n' > .env
   ```

2. **Join the shared network.** `docker-compose.override.yml` (git-ignored), naming the test service:

   ```yaml
   services:
     mpct-test:
       networks: [default, homeserver]
   networks:
     homeserver:
       external: true
       name: docker_default
   ```

3. **Create the test database** and copy live data into it:

   ```bash
   MPCT_DB_PASSWORD=$(openssl rand -hex 24)
   docker exec -i postgres psql -U jason -d postgres -v pw="$MPCT_DB_PASSWORD" < scripts/create_staging_database.sql
   echo "DATABASE_URL=postgresql+psycopg://mpct_staging:$MPCT_DB_PASSWORD@postgres:5432/mpct_staging" >> .env
   scripts/refresh_test_db.sh
   ```

4. **Start:**

   ```bash
   docker compose up -d --build
   curl -s localhost:8011/api/health   # ... "environment":"test", "database":"ok"
   ```

5. **Route the subdomain.** Add to `~/docker/Caddyfile`, then restart Caddy (a second or two of downtime
   for everything behind it):

   ```
   http://chess-test.sharkeyhome.co.uk {
   	reverse_proxy mpct-test:8000
   }
   ```

   ```bash
   docker restart caddy
   ```

   Cloudflare tunnel: add a published-application route `chess-test.sharkeyhome.co.uk` → `http://caddy:80`.
   Cloudflare Access: add `chess-test.sharkeyhome.co.uk` as a second hostname on the existing MPCT
   application (or a new application with the same Allow policy). **Do this before the tunnel route goes
   live**, or the test site is briefly public.

### Day to day

```bash
cd ~/docker/mpct-test && git pull && docker compose up -d --build   # deploy the latest dev to test
cd ~/docker/mpct-test && scripts/refresh_test_db.sh                 # reset test data to a copy of live
```

The refresh only reads live (`pg_dump`). It replaces everything in the test database, stops the test
container while it does, and starts it again so the `dev` branch's migrations run on the fresh copy. Test
and live keep separate browser storage (engine settings, a game in progress against the engine and so on) because they are different
hostnames.

## Layout

```
app/
  main.py         app factory: routes, error mapping, headers, static files
  config.py       settings from environment / .env
  core/           pure chess logic (position keys, add-line rules), no web or DB imports
  db/             SQLAlchemy models, session, Alembic migrations
  repositories/   database queries (replaces the legacy DBFunctions.py)
  api/            FastAPI routers + request/response schemas
  tools/          command-line tools (legacy repertoire + games import, wild PGN import)
  wild_fetch.py   background fetching of tournament games (Lichess broadcasts, TWIC)
  puzzle_import.py streaming import of the Lichess puzzle database
web/              frontend served as-is
  js/game.js      game state + rules wrapper (pure logic, unit tested)
  js/board.js     chessground wrapper + promotion picker
  js/movelist.js  move list rendering
  js/repertoire.js repertoire panel: pickers, explorer, lines, comments
  js/trainer.js   training session rules (pure logic, unit tested)
  js/training.js  training mode: board, auto replies, hints, results
  js/dashboard.js dashboard view: stats, lines with history, resets
  js/insights.js  dashboard insights: progress bars, forecast, activity, line sort/filter
  js/engine.js    Stockfish worker client + UCI parsing (helpers unit tested)
  js/analysis.js  engine panel, evaluation bar, engine arrows
  js/games.js     games list view + open-game panel (save, compare, PGN)
  js/wild.js      Wild tab: watched positions, spotted tournament games, fetch status
  js/masters.js   board Masters panel: masters moves and top games for the position
  js/speech-core.js hands-free: moves to speech, heard text to moves/commands (pure, unit tested)
  js/handsfree.js hands-free training: speech out/in, confirmations, typing, blindfold
  js/vosk-listener.js hands-free: offline recognition with Vosk (Firefox), chess words only
  js/puzzle.js    one puzzle's rules + rating chart path (pure logic, unit tested)
  js/puzzles.js   Puzzles tab + puzzle mode on the board
  js/sounds.js    move sounds (Web Audio; choosing the sound is unit tested)
  js/play.js      play vs engine: levels, engine replies, takeback, resign, save
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
| Stockfish.js (Lite builds) | 19.0.1 | GPL-3.0 | `web/vendor/stockfish/` |
| @lichess-org/vosk-browser (Vosk WebAssembly) | 0.0.3 | Apache-2.0 | `web/vendor/vosk/` |
| Vosk model vosk-model-small-en-us-0.15 | 0.15 | Apache-2.0 | downloaded at image build (`scripts/fetch_voice_model.py`) |
| python-chess | 1.11.2 | GPL-3.0-or-later | `requirements.txt` |

The cburnett piece set and brown board theme ship with chessground. Because chessground and python-chess are GPL-3.0, keep this
repository private or license it under the GPL if you ever publish it.

To update a vendored library: `npm install <pkg>@<version>` in a scratch folder and copy the files listed above.
