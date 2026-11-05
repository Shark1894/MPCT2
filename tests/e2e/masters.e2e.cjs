// Browser checks for the board's Masters panel (masters moves + top games). Needs a server
// with an EMPTY database, started with LICHESS_TOKEN=lip_e2e and LICHESS_EXPLORER_URL pointing
// at the fake explorer (tests/e2e/fake_explorer.py):
//   python tests/e2e/fake_explorer.py 8099 &
//   LICHESS_TOKEN=lip_e2e LICHESS_EXPLORER_URL=http://127.0.0.1:8099 uvicorn app.main:app --port 8010
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/masters.e2e.cjs
const { chromium, devices } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const FAKE = process.env.FAKE_EXPLORER || 'http://127.0.0.1:8099';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);
const sans = (p) => p.evaluate(() => mpct.game.moves.slice(0, mpct.game.ply).map((m) => m.san).join(' '));
const moveRows = (p) => p.$$eval('#masters-moves .mx-move', (els) => els.map((e) => e.querySelector('.mx-san').textContent));
const log = () => fetch(`${FAKE}/log`).then((r) => r.json());

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d|status of 50\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const ids = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const caro = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro-Kann', color: 'black' });
    await post(`/api/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'] });
    return { caro: caro.id };
  });
  await page.reload();
  await settle(page, 800);
  const before = (await log()).length;

  // ---- closed by default: no lookups -------------------------------------------------------
  check(await page.isVisible('#masters-box summary'), 'Masters section on the board');
  check(!(await page.evaluate(() => document.getElementById('masters-box').open)), 'closed by default');
  check((await log()).length === before, 'no lookups while closed');

  // ---- open at the start position ----------------------------------------------------------
  await page.click('#masters-box summary');
  await settle(page, 900);
  check(JSON.stringify(await moveRows(page)) === '["e4","d4","Nf3"]', 'masters moves at the start: ' + (await moveRows(page)));
  check((await text(page, '#masters-total')) === '1,000 games', 'total games: ' + (await text(page, '#masters-total')));
  const e4 = await page.$eval('#masters-moves .mx-move', (b) => ({ count: b.querySelector('.mx-count').textContent, label: b.getAttribute('aria-label'), elo: b.querySelector('.mx-elo').textContent }));
  check(e4.count === '500 · 50%' && e4.elo === 'Ø 2400', 'move row: games, share, average rating: ' + JSON.stringify(e4));
  check(e4.label.includes('White wins 50%, draws 50%, Black wins 0%'), 'results bar described: ' + e4.label);
  const spill = await page.$$eval('#masters-moves .mx-bar i', (els) => els.filter((i) => i.textContent && i.scrollWidth > i.clientWidth).length);
  check(spill === 0, 'no bar label spills out of its segment');
  const rowSpill = await page.$$eval('#masters-moves .mx-move', (els) =>
    els.filter((b) => [...b.children].some((c) => c.offsetParent && c.getBoundingClientRect().right > b.getBoundingClientRect().right + 0.5)).length,
  );
  check(rowSpill === 0, 'nothing sticks out of a move row');
  check((await page.getAttribute('#masters-moves .mx-move .mx-bar', 'title')) === 'White wins 50% · draws 50% · Black wins 0%', 'bar tooltip gives the full split');
  const games = await page.$$eval('#masters-games .mx-game', (els) => els.map((e) => e.textContent));
  check(games.length === 2 && games[0].startsWith('Carlsen (2700) – Caruana (2650)') && games[0].includes('1-0 · 2019 · played e4'), 'top games: ' + games[0]);
  check(games[1].includes('½-½ · 2005'), 'drawn game shown as ½-½: ' + games[1]);

  // ---- play a move from the panel; the panel follows the board ----------------------------------
  await page.click('#masters-moves .mx-move:has-text("e4")');
  await settle(page, 900);
  check((await sans(page)) === 'e4', 'tapping a move plays it');
  check((await text(page, '#masters-status')) === 'No masters games reached this position.', 'empty position explained');
  await page.evaluate(() => {
    mpct.game.playSan('c6');
    mpct.render();
  });
  await settle(page, 900);
  check(JSON.stringify(await moveRows(page)) === '["d4","Nc3","Nf3","c4"]', 'panel follows the board: ' + (await moveRows(page)));
  // stepping back uses the session cache, not the server
  const n = (await log()).length;
  await page.click('#nav-start');
  await settle(page, 600);
  check(JSON.stringify(await moveRows(page)) === '["e4","d4","Nf3"]' && (await log()).length === n, 'going back shows the cached position without asking again');
  await page.click('#nav-end');
  await settle(page, 600);

  // ---- open a game at this position ---------------------------------------------------------------
  await page.click('#masters-games li:first-child .mx-game');
  await settle(page, 1000);
  check(await page.isVisible('#game-panel'), 'game opens in the game panel');
  check((await text(page, '#game-title')).startsWith('Carlsen, Magnus (2862) v Caruana, Fabiano (2832)'), 'title: ' + (await text(page, '#game-title')));
  check((await text(page, '#game-source')).includes('Masters game') && (await text(page, '#game-source')).includes('2019'), 'source line: ' + (await text(page, '#game-source')));
  check((await sans(page)) === 'e4 c6' && (await page.evaluate(() => mpct.game.moves.length)) === 8, 'opened at the position it was opened from (move 2 of 8)');
  check(await page.isVisible('#game-wild-save') && (await page.getAttribute('#game-white', 'readonly')) !== null, 'read-only, with Save to Games');
  check((await page.getAttribute('#game-pgn', 'href')) === '/api/masters/games/fake0001/pgn', 'PGN download link');
  check((await log()).includes('pgn:fake0001'), 'PGN fetched from Lichess');

  // survives a reload
  await page.reload();
  await settle(page, 1200);
  check(await page.isVisible('#game-panel') && (await text(page, '#game-source')).includes('Masters game') && (await sans(page)) === 'e4 c6', 'open masters game restored after reload');
  check(await page.evaluate(() => document.getElementById('masters-box').open), 'panel stays open after reload');
  check((await log()).filter((x) => x === 'pgn:fake0001').length === 1, 'game kept on the server: not fetched again');

  // save to games
  await page.click('#game-wild-save');
  await settle(page, 1000);
  check(await page.isVisible('#game-save') && (await page.isHidden('#game-wild-save')), 'saved: now one of your games (editable)');
  const saved = await page.evaluate(() => fetch('/api/games').then((r) => r.json()));
  check(saved.length === 1 && saved[0].white === 'Carlsen, Magnus' && saved[0].competition === 'Fake Masters' && saved[0].plies === 8, 'in Games: ' + JSON.stringify(saved[0]));
  await page.click('#game-close');
  await settle(page, 400);

  // ---- hidden while training ---------------------------------------------------------------------
  await page.selectOption('#opening-select', String(ids.caro));
  await settle(page, 400);
  await page.click('#train-all');
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  await settle(page, 400);
  check(await page.isHidden('#masters-box'), 'hidden while training (it would give the answers away)');
  await page.click('#train-stop');
  await settle(page, 600);
  check(await page.isVisible('#masters-box'), 'back after training');

  // ---- errors ------------------------------------------------------------------------------------
  await page.route('**/api/masters?*', (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'The masters explorer needs a Lichess API token: add LICHESS_TOKEN to the server\'s .env and restart the app.' }) }),
  );
  await page.evaluate(() => {
    mpct.game.load('rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1');
    mpct.render();
  });
  await settle(page, 800);
  check((await text(page, '#masters-status')).includes('LICHESS_TOKEN') && (await page.isVisible('#masters-retry')), 'no token: says how to add one, with Try again');
  await page.unroute('**/api/masters?*');
  await page.click('#masters-retry');
  await settle(page, 800);
  check(await page.isHidden('#masters-retry') && (await text(page, '#masters-status')) === 'No masters games reached this position.', 'Try again works once fixed');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/masters.png`, fullPage: true });

  // ---- phone -------------------------------------------------------------------------------------
  const phone = await browser.newPage({ ...devices['Pixel 7'] });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(URL);
  await settle(phone, 800);
  await phone.evaluate(() => localStorage.setItem('mpct.mastersOpen', 'true'));
  await phone.reload();
  await settle(phone, 1200);
  const fit = await phone.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    rows: document.querySelectorAll('#masters-moves .mx-move').length,
    games: document.querySelectorAll('#masters-games .mx-game').length,
  }));
  check(!fit.overflow && fit.rows === 3 && fit.games === 2, 'phone: fits, moves and games listed ' + JSON.stringify(fit));
  if (SHOTS) {
    await phone.$eval('#masters-box', (e) => e.scrollIntoView());
    await phone.screenshot({ path: `${SHOTS}/masters-phone.png` });
  }

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})();
