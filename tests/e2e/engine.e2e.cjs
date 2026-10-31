// Browser checks for engine analysis, running the real Stockfish 19 Lite in the page.
// Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/engine.e2e.cjs
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
const depthAtLeast = (p, d) =>
  p.waitForFunction((min) => Number((document.getElementById('engine-depth').textContent.match(/Depth (\d+)/) || [])[1]) >= min, d, {
    timeout: 30000,
  });
const loadFen = async (p, fen) => {
  await p.fill('#fen', fen);
  await p.click('#btn-fen-load');
  await settle(p);
};
const engineShapes = (p) => p.evaluate(() => mpct.board.layers.engine ?? []);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 600);

  // ---- off by default ---------------------------------------------------------
  check((await text(page, '#engine-toggle')) === 'Engine off', 'engine off by default');
  check(await page.isHidden('#engine-body') && (await page.isHidden('#eval-bar')), 'panel collapsed, no eval bar');

  // ---- switch on: real analysis ------------------------------------------------
  await page.click('#engine-toggle');
  await depthAtLeast(page, 12);
  check(await page.evaluate(() => mpct.analysis.engine.threaded), 'multi-threaded build in use (page is cross-origin isolated)');
  check((await page.$$('#engine-lines .engine-line')).length === 3, '3 lines by default');
  const evalText = await text(page, '#engine-eval');
  const evalNum = Number(evalText);
  check(/^[+-]?\d+\.\d\d$/.test(evalText) && Math.abs(evalNum) < 1, 'start position evaluated near equal: ' + evalText);
  const firstMoves = await page.$$eval('#engine-lines .engine-line .engine-move:first-child', (els) => els.map((e) => e.textContent));
  check(firstMoves.every((m) => /^1\./.test(m)), 'lines numbered from move 1: ' + firstMoves);
  const shapes = await engineShapes(page);
  check(shapes.length === 3 && shapes.at(-1).brush === 'blue' && shapes.slice(0, -1).every((s) => s.brush === 'paleBlue'), 'best move blue arrow, others pale');
  check(await page.isVisible('#eval-bar') && (await page.evaluate(() => document.body.classList.contains('engine-on'))), 'eval bar shown');

  // ---- settings ---------------------------------------------------------------
  await page.selectOption('#engine-multipv', '1');
  await page.selectOption('#engine-depth-limit', '12');
  await page.waitForFunction(() => document.getElementById('engine-depth').textContent.includes('✓'), null, { timeout: 30000 });
  check((await page.$$('#engine-lines .engine-line')).length === 1, 'Lines setting: 1 line');
  check((await text(page, '#engine-depth')) === 'Depth 12/12 ✓', 'depth limit reached and marked done');

  // ---- clicking a move in a line plays it ----------------------------------------
  await page.click('#engine-lines .engine-line .engine-move >> nth=1');
  await settle(page);
  check((await page.evaluate(() => mpct.game.ply)) === 2, 'clicking the 2nd move of a line plays two moves');
  await depthAtLeast(page, 8);
  const afterMoves = await page.$$eval('#engine-lines .engine-move', (els) => els.map((e) => e.textContent));
  check(/^2\./.test(afterMoves[0]), 'analysis restarted for the new position: ' + afterMoves[0]);

  // ---- mate scores, finished games -----------------------------------------------
  await loadFen(page, '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
  await page.waitForFunction(() => document.getElementById('engine-eval').textContent === '#1', null, { timeout: 30000 });
  check((await text(page, '#engine-lines .engine-move')) === '1.Rd8#', 'mate in one found and shown as #1');
  check((await page.evaluate(() => document.getElementById('eval-fill').style.height)) === '100%', 'eval bar full for White when mating');
  await loadFen(page, '3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1');
  await settle(page, 600);
  check((await text(page, '#engine-status')).includes('Checkmate'), 'checkmated position: nothing to analyse');
  check((await engineShapes(page)).length === 0, 'no arrows on a finished game');

  // ---- flipping the board flips the bar --------------------------------------------
  await page.click('#btn-new');
  await page.click('#btn-flip');
  await settle(page);
  check(await page.evaluate(() => document.getElementById('eval-bar').classList.contains('flipped')), 'eval bar flips with the board');
  await page.click('#btn-flip');
  if (SHOTS) {
    await depthAtLeast(page, 10);
    await page.screenshot({ path: `${SHOTS}/engine-desktop.png` });
  }

  // ---- paused during training and on the dashboard -----------------------------------
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const o = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Italian', color: 'white' });
    await post(`/api/openings/${o.id}/lines`, { moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'] });
  });
  await page.reload();
  await settle(page, 800);
  check((await text(page, '#engine-toggle')) === 'Engine on', 'engine setting remembered after reload');
  await depthAtLeast(page, 6);
  await page.click('#train-due');
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  await settle(page);
  check(await page.isHidden('#engine-panel') && (await page.isHidden('#eval-bar')), 'engine hidden during training');
  check(await page.evaluate(() => mpct.analysis.engine.current === null), 'engine stopped during training');
  check((await engineShapes(page)).length === 0, 'no engine arrows during training');
  await page.click('#train-stop');
  await depthAtLeast(page, 6);
  check(await page.isVisible('#engine-panel'), 'engine back after training');

  await page.click('#view-dashboard');
  await settle(page);
  check(await page.evaluate(() => mpct.analysis.engine.current === null), 'engine paused on the dashboard');
  await page.click('#view-board');
  await depthAtLeast(page, 6);
  check(true, 'engine resumes on the board');

  // ---- off again --------------------------------------------------------------------
  await page.click('#engine-toggle');
  await settle(page);
  check(
    (await text(page, '#engine-toggle')) === 'Engine off' && (await page.isHidden('#eval-bar')) && (await engineShapes(page)).length === 0,
    'switching off clears arrows and the bar',
  );

  // ---- phone ------------------------------------------------------------------------
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await ctx.newPage();
  mp.on('pageerror', (e) => errors.push('phone: ' + e));
  await mp.goto(URL);
  await settle(mp, 600);
  await mp.click('#engine-toggle');
  await depthAtLeast(mp, 10);
  check(await mp.evaluate(() => mpct.analysis.engine.threads) <= 2, 'phone: at most 2 threads');
  const order = await mp.evaluate(() =>
    ['.board-area', '.controls', '.repertoire', '.engine', '.history'].map((s) => document.querySelector(s).getBoundingClientRect().top),
  );
  check(order.every((v, i) => i === 0 || v > order[i - 1]), 'phone order: board, controls, repertoire, engine, moves');
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow');
  if (SHOTS) await mp.screenshot({ path: `${SHOTS}/engine-phone.png`, fullPage: true });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
