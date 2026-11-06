// Browser checks for the Puzzles tab and solving puzzles. Needs a server with an EMPTY database and
// MPCT_DATABASE_URL pointing at the same database (a few real Lichess puzzles are loaded with
// app.tools.import_puzzles, since the test can't download the database).
// Usage: MPCT_URL=http://localhost:8010/ MPCT_DATABASE_URL=postgresql+psycopg://... node tests/e2e/puzzles.e2e.cjs
const { chromium, devices } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const DB = process.env.MPCT_DATABASE_URL;
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);

// Real puzzles from the Lichess database (CC0). Ratings set so they're picked in this order of likelihood.
const CSV = [
  'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate',
  '00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1500,76,94,6000,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#48,,',
  '0000D,5rk1/1p3ppp/pq3b2/8/8/1P1Q1N2/P4PPP/3R2K1 w - - 2 27,d3d6 f8d8 d6d8 f6d8,1500,74,96,25000,advantage endgame short,https://lichess.org/F8M8OS71#53,,',
  '000hf,r1bqk2r/pp1nbNp1/2p1p2p/8/2BP4/1PN3P1/P3QP1P/3R1RK1 b kq - 0 19,e8f7 e2e6 f7f8 e6f7,1500,75,99,800,mate mateIn2 middlegame short,https://lichess.org/71ygsFeE/black#38,Horwitz_Defense Horwitz_Defense_Other_variations,',
].join('\n');

function sq(box, s, flipped) {
  const f = s.charCodeAt(0) - 97, r = Number(s[1]) - 1, z = box.width / 8;
  const col = flipped ? 7 - f : f, row = flipped ? r : 7 - r;
  return { x: box.x + (col + 0.5) * z, y: box.y + (row + 0.5) * z };
}

async function move(page, uci) {
  const box = await page.locator('cg-board').boundingBox();
  const flipped = (await page.evaluate(() => mpct.board.orientation())) === 'black';
  const a = sq(box, uci.slice(0, 2), flipped), b = sq(box, uci.slice(2, 4), flipped);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(150);
}

const waitTurn = (p) => p.waitForFunction(() => mpct.puzzles.canMove(), null, { timeout: 5000 });
const current = (p) => p.evaluate(() => ({ id: mpct.puzzles.run.puzzle.id, expected: mpct.puzzles.run.expected(), color: mpct.puzzles.run.color }));

(async () => {
  if (!DB) throw new Error('Set MPCT_DATABASE_URL');
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 800);

  // ---- before the database is loaded ---------------------------------------------------------
  await page.click('#view-courses'); await page.click('.cv-item[data-puzzles=rated]');
  await settle(page, 700);
  check(/No puzzles yet/.test(await text(page, '#pz-db-text')), 'asks to download the database');
  check((await text(page, '#pz-import')) === 'Download puzzles' && (await page.isDisabled('#pz-start')), 'Download offered, Start disabled');
  check((await text(page, '#pz-rating')) === '1500?', 'starts at 1500, provisional');

  const file = path.join(os.tmpdir(), 'puzzles-e2e.csv');
  fs.writeFileSync(file, CSV);
  const out = execFileSync('python3', ['-m', 'app.tools.import_puzzles', file], { env: { ...process.env, DATABASE_URL: DB }, cwd: path.resolve(__dirname, '../..') }).toString();
  check(/Imported 3 puzzles/.test(out), 'import tool: ' + out.trim());

  await page.click('#view-board');
  await page.click('#view-courses'); await page.click('.cv-item[data-puzzles=rated]');
  await settle(page, 700);
  check(/3 puzzles from the Lichess puzzle database, downloaded today/.test(await text(page, '#pz-db-text')), 'database status');
  check((await text(page, '#pz-import')) === 'Update puzzles' && !(await page.isDisabled('#pz-start')), 'Update offered, Start enabled');
  const themes = await page.$$eval('#pz-theme option', (o) => o.length);
  check(themes > 30, `theme list (${themes})`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/puzzles-tab-empty.png` });

  // ---- solve one cleanly ----------------------------------------------------------------------
  await page.selectOption('#pz-theme', 'mateIn2');
  await page.click('#pz-start');
  await waitTurn(page);
  check(!(await page.isHidden('#puzzle')) && (await text(page, '#mode-badge')) === 'Puzzle', 'puzzle mode on the board');
  check(await page.isHidden('#rep-build') && (await page.isDisabled('#view-dashboard')), 'repertoire hidden, tabs locked');
  check(await page.isHidden('#engine-panel'), 'engine hidden while solving');
  let c = await current(page);
  check(c.id === '000hf' && c.color === 'white' && (await page.evaluate(() => mpct.board.orientation())) === 'white', 'theme puzzle shown from the solver’s side');
  check(/Your move: find the best move for White/.test(await text(page, '#puzzle-message')), 'prompt');
  check((await page.evaluate(() => mpct.game.ply)) === 1, 'opponent’s set-up move played');
  await move(page, 'e2e6');
  check(/Best move/.test(await text(page, '#puzzle-message')), 'right move accepted');
  await waitTurn(page);
  await move(page, 'e6f7');
  await page.waitForSelector('#puzzle-end:not([hidden])', { timeout: 5000 });
  await settle(page, 400);
  const solved = await text(page, '#puzzle-result');
  check(/✓ Solved! Rating 1\d{3} \(\+\d+\)/.test(solved), 'solved with a rating gain: ' + solved);
  check(/Puzzle rated 1500 · Checkmate, Mate in 2.* · Horwitz Defense Other variations · 800 plays/.test(await text(page, '#puzzle-info')), 'puzzle info: ' + (await text(page, '#puzzle-info')));
  check((await page.getAttribute('#puzzle-game', 'href')) === 'https://lichess.org/71ygsFeE/black#38', 'link to the game');
  check(!(await page.isHidden('#engine-panel')) && !(await page.isDisabled('#nav-back')), 'after solving: engine and navigation free');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/puzzle-solved.png` });

  // ---- fail one, then show the solution ----------------------------------------------------------
  await page.evaluate(() => { mpct.puzzles.theme = null; });
  await page.click('#puzzle-next');
  await waitTurn(page);
  c = await current(page);
  const wrong = c.id === '00008' ? 'h6g6' : 'g7g6'; // legal but not the solution
  await move(page, wrong);
  check(/puzzle failed/.test(await text(page, '#puzzle-message')), 'wrong move fails the puzzle');
  await settle(page, 600);
  check(/Your rating 1\d{3}/.test(await text(page, '#puzzle-progress')), 'rating loss shown straight away: ' + (await text(page, '#puzzle-progress')));
  await page.click('#puzzle-reveal');
  await page.waitForSelector('#puzzle-end:not([hidden])', { timeout: 8000 });
  await settle(page, 400);
  check(/✗ Solution shown\. Rating \d+ \(−\d+\)/.test(await text(page, '#puzzle-result')), 'failure result: ' + (await text(page, '#puzzle-result')));
  const shownAll = await page.evaluate(() => mpct.game.moves.length === mpct.puzzles.run.moves.length);
  check(shownAll, 'whole solution played on the board');

  // Retry is unrated
  await page.click('#puzzle-retry');
  await waitTurn(page);
  check(/retry \(not rated\)/.test(await text(page, '#puzzle-title')), 'retry marked not rated');
  c = await current(page);
  while (true) {
    const exp = await page.evaluate(() => mpct.puzzles.run.expected());
    if (!exp) break;
    await move(page, exp);
    const done = await page.evaluate(() => mpct.puzzles.run.done);
    if (done) break;
    await waitTurn(page);
  }
  await page.waitForSelector('#puzzle-end:not([hidden])', { timeout: 5000 });
  await settle(page, 400);
  check(/Not rated: you’ve tried it before/.test(await text(page, '#puzzle-result')), 'retry result not rated');

  await page.click('#puzzle-stop');
  await settle(page, 400);
  check(await page.isHidden('#puzzle') && !(await page.isHidden('#rep-build')) && (await page.isHidden('#mode-badge')), 'Stop returns to the normal board');

  // ---- the tab after a few puzzles ----------------------------------------------------------------
  await page.click('#view-courses'); await page.click('.cv-item[data-puzzles=rated]');
  await settle(page, 800);
  const meta = await text(page, '#pz-rating-meta');
  check(/2 puzzles rated, 50% solved · today 1\/2/.test(meta), 'rating summary: ' + meta);
  check((await page.$$('#pz-chart svg path.pz-line')).length === 1, 'rating history chart');
  const recent = await page.$$eval('#pz-recent .pz-recent-row', (r) => r.map((x) => x.textContent));
  check(recent.length === 3 && /retry/.test(recent[0]) && /^✓/.test(recent[2]), 'recent puzzles, newest first: ' + recent.join(' | '));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/puzzles-tab.png` });

  // Retry from the list opens that puzzle
  await page.click('#pz-recent .pz-recent-row:last-child button');
  await waitTurn(page);
  check((await current(page)).id === '000hf', 'Retry from the list opens the puzzle');
  await page.click('#puzzle-stop');

  if (SHOTS) {
    const phone = await browser.newPage({ ...devices['Pixel 7'] });
    await phone.goto(URL);
    await settle(phone, 800);
    await phone.click('#view-courses'); await phone.click('.cv-item[data-puzzles=rated]');
    await settle(phone, 800);
    await phone.screenshot({ path: `${SHOTS}/puzzles-phone.png` });
    await phone.click('#pz-start');
    await phone.waitForFunction(() => mpct.puzzles.canMove() || mpct.puzzles.active, null, { timeout: 5000 });
    await settle(phone, 1200);
    await phone.screenshot({ path: `${SHOTS}/puzzle-phone-solving.png` });
    await phone.close();
  }

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})();
