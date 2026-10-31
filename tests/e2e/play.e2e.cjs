// Browser checks for playing against the engine (real Stockfish in the page).
// Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/play.e2e.cjs
const { chromium, devices } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 400) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);
const plies = (p) => p.evaluate(() => mpct.game.moves.length);
const waitPlies = (p, n) => p.waitForFunction((k) => mpct.game.moves.length === k, n, { timeout: 20000 });
const yourMove = (p) => p.waitForFunction(() => document.getElementById('play-status').textContent === 'Your move', null, { timeout: 20000 });

/** Click a square on the board (as a user would), allowing for orientation. */
async function clickSquare(p, sq) {
  const box = await p.locator('#board cg-board').boundingBox();
  const black = (await p.evaluate(() => mpct.board.orientation())) === 'black';
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]) - 1;
  const size = box.width / 8;
  const x = box.x + size * ((black ? 7 - file : file) + 0.5);
  const y = box.y + size * ((black ? rank : 7 - rank) + 0.5);
  await p.mouse.click(x, y);
}
async function move(p, from, to) {
  await clickSquare(p, from);
  await clickSquare(p, to);
  await settle(p, 250);
}
async function setup(p, { side = 'white', level = '1', from = null, name = null } = {}) {
  await p.click('#play-start');
  await p.waitForSelector('dialog[open]');
  await p.selectOption('dialog select[name=side]', side);
  await p.selectOption('dialog select[name=level]', level);
  if (from) await p.selectOption('dialog select[name=from]', from);
  if (name !== null) await p.fill('dialog input[name=name]', name);
  await p.click('dialog button[type=submit]');
  await settle(p);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 600);

  // ---- engine analysis on beforehand: hidden while playing -----------------------------
  await page.click('#engine-toggle');
  await settle(page, 300);
  check(await page.isVisible('#play-start'), 'Play vs engine button in the engine panel');
  await page.click('#play-start');
  await page.waitForSelector('dialog[open]');
  check((await page.$$('dialog select[name=from]')).length === 0, 'no "start from" choice on an empty board');
  check((await page.$$eval('dialog select[name=level] option', (o) => o.length)) === 10, '10 strength levels');
  await page.click('dialog button:text("Cancel")');
  await setup(page, { side: 'white', level: '1', name: 'Jason Sharkey' });
  check(await page.isVisible('#play-panel') && (await page.isHidden('#engine-panel')) && (await page.isHidden('#eval-bar')), 'play panel shown; engine panel and eval bar hidden');
  check((await text(page, '#play-title')) === 'You (White) v Stockfish (Beginner ~800)', 'title: ' + (await text(page, '#play-title')));
  check((await text(page, '#play-status')) === 'Your move' && (await page.isDisabled('#play-takeback')), 'your move; nothing to take back');
  check(await page.isHidden('#btn-new') && (await page.isHidden('#btn-fen-load')), 'New board and Load FEN hidden mid-game');

  // ---- moves: yours on the board, the engine replies ---------------------------------
  await move(page, 'e2', 'e4');
  check((await plies(page)) >= 1 && (await page.evaluate(() => !mpct.play.canMove())), 'your move played; board locked for the reply');
  await waitPlies(page, 2);
  await yourMove(page);
  check((await page.evaluate(() => mpct.game.turn())) === 'white', 'engine replied with Black');
  await move(page, 'a2', 'a5'); // illegal: ignored
  check((await plies(page)) === 2, 'illegal move ignored');

  // can't move for the engine
  await move(page, 'd2', 'd4');
  await waitPlies(page, 4);
  await yourMove(page);
  await page.click('#nav-back');
  await settle(page, 200);
  check((await text(page, '#play-status')).startsWith('Viewing an earlier move'), 'stepping back to look says so');
  check(await page.evaluate(() => !mpct.play.canMove()), 'no moves from an earlier position');
  await page.click('#nav-end');
  await settle(page, 200);

  // ---- take back ---------------------------------------------------------------------
  await page.click('#play-takeback');
  await settle(page, 300);
  check((await plies(page)) === 2 && (await text(page, '#play-status')) === 'Your move', 'take back removes your move and the reply');

  // ---- survives a reload -----------------------------------------------------------
  await page.reload();
  await settle(page, 1000);
  check(await page.isVisible('#play-panel') && (await plies(page)) === 2 && (await text(page, '#play-status')) === 'Your move', 'game resumed after a reload');

  // ---- resign, save to games ------------------------------------------------------------
  await page.click('#play-resign');
  await page.click('dialog button[type=submit]');
  await settle(page);
  check((await text(page, '#play-status')) === 'You resigned · 0-1', 'resigned: ' + (await text(page, '#play-status')));
  check(await page.isVisible('#play-save') && (await page.isHidden('#play-resign')) && (await text(page, '#play-stop')) === 'Analyse', 'Save / Play again / Analyse offered');
  check(await page.evaluate(() => !mpct.play.canMove()), 'no more moves after resigning');
  await page.click('#play-save');
  await settle(page, 800);
  check(await page.isHidden('#play-panel') && (await page.isVisible('#game-panel')), 'saved game opens in the game panel');
  check((await text(page, '#game-title')) === 'Jason Sharkey v Stockfish (Beginner ~800) · 0-1', 'saved: ' + (await text(page, '#game-title')));
  check((await page.inputValue('#game-competition')) === 'Practice vs engine', 'marked as practice');
  check(await page.isVisible('#engine-panel') && (await page.isVisible('#eval-bar')), 'engine analysis back after the game');
  await page.click('#game-close');
  await settle(page);

  // ---- play Black: the engine opens; board flips ----------------------------------------
  await page.click('#btn-new');
  await setup(page, { side: 'black', level: '4' });
  check((await page.evaluate(() => mpct.board.orientation())) === 'black', 'board turned to Black');
  await waitPlies(page, 1);
  await yourMove(page);
  check((await text(page, '#play-title')).includes('You (Black) v Stockfish (1400)') && (await page.isDisabled('#play-takeback')), 'engine moved first; nothing of yours to take back');
  // Abandoning asks first
  await page.click('#play-stop');
  await page.waitForSelector('dialog[open]');
  check((await text(page, 'dialog h2')) === 'Abandon the game?', 'stopping mid-game asks');
  await page.click('dialog button[type=submit]');
  await settle(page);
  check(await page.isHidden('#play-panel') && (await plies(page)) === 1, 'abandoned; moves stay on the board');

  // ---- from the position on the board: mate in one ---------------------------------------
  await page.fill('#fen', '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
  await page.click('#btn-fen-load');
  await settle(page);
  await setup(page, { side: 'white', level: '10', from: 'board' });
  check((await page.evaluate(() => mpct.game.startFen)).startsWith('6k1/5ppp'), 'started from the board position');
  await move(page, 'd1', 'd8');
  await settle(page, 700);
  check((await text(page, '#play-status')) === 'You won by checkmate · 1-0', 'checkmate scored: ' + (await text(page, '#play-status')));
  check((await plies(page)) === 1, 'engine makes no move after mate');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/play-over.png` });
  await page.click('#play-stop'); // Analyse: no question when the game is over
  await settle(page);
  check(await page.isHidden('#play-panel') && !(await page.isVisible('dialog[open]')), 'Analyse leaves play mode without asking');

  // ---- training mid-game asks to abandon ------------------------------------------------
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const o = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Italian', color: 'white' });
    await post(`/api/openings/${o.id}/lines`, { moves: ['e2e4', 'e7e5', 'g1f3'] });
  });
  await page.click('#btn-new');
  await page.reload();
  await settle(page, 1000);
  await setup(page, { side: 'white', level: '1' });
  await move(page, 'e2', 'e4');
  await waitPlies(page, 2);
  await yourMove(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/play-desktop.png` });
  await page.click('#train-due');
  await page.waitForSelector('dialog[open]');
  check((await text(page, 'dialog h2')) === 'Abandon the game?', 'training mid-game asks to abandon');
  await page.click('dialog button:text("Cancel")');
  await settle(page);
  check(await page.evaluate(() => mpct.play.active && !mpct.trainer.active), 'cancel keeps playing');

  // ---- phone ----------------------------------------------------------------------------
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await ctx.newPage();
  mp.on('pageerror', (e) => errors.push('phone: ' + e));
  await mp.goto(URL);
  await mp.evaluate(() => localStorage.clear());
  await mp.reload();
  await settle(mp, 700);
  await setup(mp, { side: 'white', level: '1' });
  await move(mp, 'e2', 'e4');
  await waitPlies(mp, 2);
  await yourMove(mp);
  const tops = await mp.evaluate(() => ['.board-area', '.controls', '#play-panel', '.repertoire'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  check(tops.every((v, i) => i === 0 || v > tops[i - 1]), 'phone: play panel right under the move buttons');
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow');
  if (SHOTS) await mp.screenshot({ path: `${SHOTS}/play-phone.png` });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
