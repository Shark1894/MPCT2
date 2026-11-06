// Browser checks for the endgame drills (Training tab) against a FAKE tablebase:
//   python tests/e2e/fake_tablebase.py 8098
//   LICHESS_TABLEBASE_URL=http://localhost:8098 uvicorn app.main:app --port 8010   (EMPTY database)
//   MPCT_URL=http://localhost:8010/ node tests/e2e/endgames.e2e.cjs
// The last part stops the fake (FAKE_TB_PID) to check the Stockfish fallback.
const { chromium } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);

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
const waitTurn = (p) => p.waitForFunction(() => mpct.endgameTrainer.canMove(), null, { timeout: 15000 });
const waitEnd = (p) => p.waitForSelector('#eg-end:not([hidden])', { timeout: 15000 });
const start = (p, drill, fen) => p.evaluate(([d, f]) => mpct.endgameTrainer.start(d, f), [drill, fen]);

(async () => {
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of (4|503)/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 800);

  // ---- the drills in the Training tab ---------------------------------------------------------------
  await page.click('#view-courses');
  await settle(page, 800);
  const drills = await page.$$eval('.cv-item[data-drill]', (bs) => bs.map((b) => b.querySelector('.cv-item-name').textContent));
  check(drills.join(' | ') === 'Queen mate (K+Q v K) | Rook mate (K+R v K) | Two bishops (K+B+B v K) | Bishop and knight (K+B+N v K) | King and pawn (K+P v K)', `drills listed (${drills.join(' | ')})`);
  check((await text(page, '.cv-item[data-drill=kbn] .cv-item-progress')) === 'not tried', 'not tried yet');
  await page.click('.cv-item[data-drill=kbn]');
  await settle(page);
  check((await text(page, '.cv-head-card .dash-h')) === 'Bishop and knight', 'drill page');
  check((await text(page, '.cv-head-card')).includes('corner of the bishop’s colour'), 'technique tip');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/eg-page.png` });

  // ---- a random B+N position from the page ----------------------------------------------------------------
  await page.click('.cv-head-card button.primary');
  await page.waitForSelector('#eg:not([hidden])');
  await waitTurn(page);
  const startFen = await page.evaluate(() => mpct.game.fen());
  const you = startFen.split(' ')[1] === 'w' ? 'white' : 'black';
  check((await page.evaluate(() => mpct.board.orientation())) === you, `board from your side (${you})`);
  await page.waitForFunction(() => document.querySelector('#eg-status').textContent.includes('perfect play mates in'), null, { timeout: 5000 }).catch(() => {});
  check((await text(page, '#eg-status')).includes('perfect play mates in'), `perfect play from the tablebase (${await text(page, '#eg-status')})`);
  check((await text(page, '#eg-status')).includes('50-move count: 0/50'), '50-move count shown');
  check(await page.isDisabled('#view-courses'), 'tabs locked while playing');
  await page.click('#eg-hint');
  await page.waitForFunction(() => document.querySelector('#eg-message').textContent.startsWith('Best:'), null, { timeout: 5000 });
  check(true, `hint: ${await text(page, '#eg-message')}`);
  const best = await page.evaluate(async () => (await (await fetch(`/api/tablebase?fen=${encodeURIComponent(mpct.game.fen())}`)).json()).moves[0].uci);
  await move(page, best);
  await waitTurn(page);
  check((await page.evaluate(() => mpct.game.moves.length)) === 2, 'the defence replied');
  check((await text(page, '#eg-status')).startsWith('Moves: 1'), 'move counted');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/eg-playing.png` });
  await page.click('#eg-giveup');
  await waitEnd(page);
  check((await text(page, '#eg-result')).includes('Given up') && (await text(page, '#eg-result')).includes('1 hint'), `gave up (${await text(page, '#eg-result')})`);

  // ---- mate in one: a pass ---------------------------------------------------------------------------------
  await start(page, 'kq', '7k/8/6K1/8/8/8/8/1Q6 w - - 0 1');
  await waitTurn(page);
  await move(page, 'b1b8');
  await waitEnd(page);
  check(/✓ Checkmate in 1 move/.test(await text(page, '#eg-result')), `mate recorded (${await text(page, '#eg-result')})`);

  // ---- a slip: the rook left hanging, then take back as practice ---------------------------------------
  await start(page, 'kr', '8/8/8/3k4/R7/8/8/4K3 w - - 0 1');
  await waitTurn(page);
  await move(page, 'a4c4');
  await waitEnd(page);
  check((await text(page, '#eg-message')).includes('lets the win go'), `slip spotted (${await text(page, '#eg-message')})`);
  check((await text(page, '#eg-result')).includes('The win slipped'), 'counted as not passed');
  check(await page.isVisible('#eg-takeback'), 'take back offered');
  await page.click('#eg-takeback');
  await waitTurn(page);
  check((await page.evaluate(() => mpct.game.moves.length)) === 0, 'move taken back');
  await page.waitForFunction(() => document.querySelector('#eg-message').textContent.includes('Practice'), null, { timeout: 5000 });
  check((await text(page, '#eg-message')).includes('Best:'), 'a winning move shown');
  await page.click('#eg-giveup');
  await waitEnd(page);
  check((await text(page, '#eg-result')).includes('practice, not recorded'), 'practice not recorded');

  // ---- K+P v K from the server ----------------------------------------------------------------------------
  await start(page, 'kp');
  await waitTurn(page);
  const kp = await page.evaluate(() => mpct.game.fen());
  const pieces = kp.split(' ')[0].replace(/[0-9/]/g, '');
  check(pieces.length === 3 && /p/i.test(pieces), `K+P position (${kp})`);
  const pawnSide = kp.split(' ')[1] === 'w' ? /P/.test(pieces) : /p/.test(pieces);
  check(pawnSide, 'you have the pawn');
  check((await text(page, '#eg-message')).includes('queen the pawn'), 'goal explained');
  await page.click('#eg-giveup');
  await waitEnd(page);

  // ---- stats back in the tab ---------------------------------------------------------------------------
  await page.click('#eg-stop');
  await page.waitForSelector('#courses-view:not([hidden])');
  await settle(page, 800);
  check((await text(page, '.cv-item[data-drill=kq] .cv-item-progress')) === '1/1', 'K+Q: 1 of 1 in the list');
  check((await text(page, '.cv-item[data-drill=kr] .cv-item-progress')) === '0/1', 'K+R: the slip counted, the practice not');
  await page.click('.cv-item[data-drill=kq]');
  await settle(page);
  const values = await page.$$eval('.wp-stat-value', (e) => e.map((x) => x.textContent));
  check(values[0] === '1' && values[1] === '100%' && values[2] === '1 move', `stats (${values.join(', ')})`);
  check((await page.$$('.wp-table tbody tr')).length === 1, 'recent attempt listed');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/eg-stats.png` });
  await page.click('.wp-table tbody button'); // Again
  await waitTurn(page);
  check((await page.evaluate(() => mpct.game.fen())) === '7k/8/6K1/8/8/8/8/1Q6 w - - 0 1', 'Again: the same start position');
  await page.click('#eg-giveup');
  await waitEnd(page);

  // ---- the tablebase goes away: Stockfish defends ----------------------------------------------------------
  if (process.env.FAKE_TB_PID) {
    process.kill(Number(process.env.FAKE_TB_PID));
    await settle(page, 500);
    await start(page, 'kr'); // a new random position: not in the server's cache
    await page.waitForFunction(() => document.querySelector('#eg-status').textContent.includes('Stockfish defending'), null, { timeout: 15000 });
    check(true, 'fallback: Stockfish defending');
    await waitTurn(page);
    const any = await page.evaluate(() => {  // any legal move of yours
      const d = mpct.game.dests();
      for (const [from, tos] of d) if (tos.length) return from + tos[0];
      return null;
    });
    await move(page, any);
    await page.waitForFunction(() => mpct.game.moves.length === 2 || !document.querySelector('#eg-end').hidden, null, { timeout: 20000 });
    check(true, 'Stockfish replied (or the game ended)');
    await page.click('#eg-hint').catch(() => {});
    check((await text(page, '#eg-message')).includes('Hints need the tablebase') || !(await page.isVisible('#eg-hint')), 'no hints without the tablebase');
  }

  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await browser.close();
})();
