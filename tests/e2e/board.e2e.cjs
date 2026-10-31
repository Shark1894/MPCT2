const { chromium, devices } = require('playwright');
// Browser checks for the board. Needs Playwright: npm i -D playwright && npx playwright install chromium
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/board.e2e.cjs
const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS; // optional folder for screenshots
const errors = [];
function sq(box, s, flipped=false) {
  const f = s.charCodeAt(0) - 97, r = Number(s[1]) - 1, z = box.width / 8;
  const col = flipped ? 7 - f : f, row = flipped ? r : 7 - r;
  return { x: box.x + (col + 0.5) * z, y: box.y + (row + 0.5) * z };
}
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
(async () => {
  const browser = await chromium.launch();
  // ---------- desktop ----------
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector('cg-board piece');
  check(await page.evaluate(() => crossOriginIsolated), 'page is cross-origin isolated (needed for threaded Stockfish later)');
  await page.screenshot({ path: SHOTS ? `${SHOTS}/desktop-start.png` : undefined });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'desktop: no horizontal overflow');
  const box = await page.locator('cg-board').boundingBox();
  const drag = async (a, b) => { const p = sq(box, a), q = sq(box, b); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(250); };
  const click2 = async (a, b) => { const p = sq(box, a), q = sq(box, b); await page.mouse.click(p.x, p.y); await page.waitForTimeout(80); await page.mouse.click(q.x, q.y); await page.waitForTimeout(250); };
  await drag('e2', 'e4');
  await click2('e7', 'e5');
  await drag('e1', 'e3'); // illegal
  let sans = await page.evaluate(() => mpct.game.moves.map(m => m.san));
  check(JSON.stringify(sans) === '["e4","e5"]', 'drag + click moves played, illegal king move rejected: ' + sans);
  // dests shown when selecting
  const p = sq(box, 'g1'); await page.mouse.click(p.x, p.y); await page.waitForTimeout(100);
  check(await page.locator('square.move-dest').count() === 3, 'legal destination dots shown for Ng1 (e2, f3, h3)');
  await page.mouse.click(p.x, p.y);
  // Fool's-mate-ish sequence to reach promotion via FEN
  await page.fill('#fen', '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1');
  await page.click('#btn-fen-load');
  check((await page.textContent('#fen-msg')).includes('loaded'), 'FEN loaded');
  await drag('e7', 'e8');
  check(await page.isVisible('#promo'), 'promotion picker opens');
  await page.screenshot({ path: SHOTS ? `${SHOTS}/desktop-promo.png` : undefined });
  await page.click('button[aria-label="Promote to knight"]');
  await page.waitForTimeout(200);
  sans = await page.evaluate(() => mpct.game.moves.map(m => m.san));
  check(sans[0] === 'e8=N+', 'under-promotion to knight: ' + sans);
  // cancel promotion
  await page.click('#btn-new');
  await page.fill('#fen', '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1'); await page.press('#fen', 'Enter');
  await drag('e7', 'e8'); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check(await page.evaluate(() => mpct.game.moves.length) === 0 && await page.locator('cg-board piece.pawn.white:not(.ghost)').count() === 1, 'cancelled promotion puts pawn back');
  // bad FEN
  await page.fill('#fen', 'rubbish'); await page.click('#btn-fen-load');
  check(await page.$eval('#fen-msg', e => e.classList.contains('error')), 'invalid FEN shows error');
  // keyboard navigation
  await page.click('#btn-new');
  for (const [a, b] of [['e2','e4'],['c7','c5'],['g1','f3'],['d7','d6']]) await drag(a, b);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  check(await page.evaluate(() => mpct.game.ply) === 2, 'Left arrow steps back');
  check((await page.textContent('.move.current')) === 'c5', 'current move highlighted in list');
  await page.keyboard.press('ArrowUp');
  check(await page.evaluate(() => mpct.game.ply) === 4, 'Up arrow goes to end');
  await page.keyboard.press('ArrowDown');
  check(await page.evaluate(() => mpct.game.ply) === 0 && await page.isDisabled('#nav-back'), 'Down arrow goes to start, back disabled');
  await page.click('.move >> text=Nf3');
  check(await page.evaluate(() => mpct.game.ply) === 3, 'clicking a move in the list jumps to it');
  // branch: go to ply 1 and play different move
  await page.click('.move >> text=e4');
  await drag('e7', 'e5');
  sans = await page.evaluate(() => mpct.game.moves.map(m => m.san));
  check(JSON.stringify(sans) === '["e4","e5"]', 'new move after stepping back replaces continuation');
  await page.click('#btn-flip');
  await page.waitForTimeout(200);
  check(await page.evaluate(() => mpct.board.orientation()) === 'black', 'flip board');
  await page.screenshot({ path: SHOTS ? `${SHOTS}/desktop-flipped.png` : undefined });
  // castle by dragging king on flipped board
  const box2 = await page.locator('cg-board').boundingBox();
  for (const [a,b] of [['g1','f3'],['b8','c6'],['f1','c4'],['g8','f6'],['e1','g1']]) {
    const s = sq(box2, a, true), t = sq(box2, b, true);
    await page.mouse.move(s.x, s.y); await page.mouse.down(); await page.mouse.move(t.x, t.y, {steps:5}); await page.mouse.up(); await page.waitForTimeout(200);
  }
  sans = await page.evaluate(() => mpct.game.moves.map(m => m.san));
  check(sans.at(-1) === 'O-O', 'castling on flipped board: ' + sans.join(' '));
  // ---------- phone ----------
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await ctx.newPage();
  mp.on('pageerror', e => errors.push('mobile: ' + e));
  await mp.goto(URL);
  await mp.waitForSelector('cg-board piece');
  const mb = await mp.locator('cg-board').boundingBox();
  check(mb.width > 350, 'phone: board fills width (' + Math.round(mb.width) + 'px)');
  const tap = async (s) => { const pt = sq(mb, s); await mp.touchscreen.tap(pt.x, pt.y); await mp.waitForTimeout(150); };
  await tap('d2'); await tap('d4'); await tap('g8'); await tap('f6'); await tap('c2'); await tap('c4');
  sans = await mp.evaluate(() => mpct.game.moves.map(m => m.san));
  check(JSON.stringify(sans) === '["d4","Nf6","c4"]', 'phone: tap-tap moves: ' + sans);
  await mp.tap('#nav-back');
  check(await mp.evaluate(() => mpct.game.ply) === 2, 'phone: back button');
  await mp.screenshot({ path: SHOTS ? `${SHOTS}/phone.png` : undefined, fullPage: true });
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow');
  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
