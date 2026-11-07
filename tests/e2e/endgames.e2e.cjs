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
  const drills = await page.$$eval('.tr-drill[data-drill]', (bs) => bs.map((b) => b.querySelector('.tr-drill-name').textContent));
  check(drills.slice(0, 5).join(' | ') === 'Queen mate | Rook mate | Two bishops | Bishop and knight | King and pawn' && drills.length === 13, `drills listed (${drills.join(' | ')})`);
  check((await text(page, '.tr-drill[data-drill=kbn] .tr-drill-stat')) === 'Not tried yet', 'not tried yet');
  check((await text(page, '.tr-drill[data-drill=kbn] .tr-level')) === 'New', 'level: New');
  await page.click('.tr-drill[data-drill=kbn]');
  await settle(page);
  check((await text(page, '.cv-head-card .dash-h')) === 'Bishop and knight', 'drill page');
  check((await text(page, '.eg-method')).includes('corner of the bishop’s colour'), 'the method');
  check(await page.isVisible('.eg-corners'), 'mating corners diagram (B+N)');
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
  await page.click('.tr-crumb >> nth=0');
  await settle(page, 800);
  check((await text(page, '.tr-drill[data-drill=kq] .tr-drill-stat')).startsWith('1/1'), 'K+Q: 1 of 1 on the hub');
  check((await text(page, '.tr-drill[data-drill=kq] .tr-level')) === 'Learning', 'K+Q level: Learning');
  check((await text(page, '.tr-drill[data-drill=kr] .tr-drill-stat')).startsWith('0/1'), 'K+R: the slip counted, the practice not');
  check((await page.$$eval('.tr-drill[data-drill=kr] .tr-tick.fail', (t) => t.length)) === 1, 'result strip');
  await page.click('.tr-drill[data-drill=kq]');
  await settle(page);
  const values = await page.$$eval('.wp-stat-value', (e) => e.map((x) => x.textContent));
  check(values[0] === '1' && values[1] === '100%' && values[2] === '1 move', `stats (${values.join(', ')})`);
  check((await page.$$('.eg-start')).length === 1, 'recent start listed with its board');
  check((await page.$$('.eg-ladder li.on')).length === 2, 'mastery ladder at Learning');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/eg-stats.png` });
  await page.click('.eg-start .eg-again');
  await waitTurn(page);
  check((await page.evaluate(() => mpct.game.fen())) === '7k/8/6K1/8/8/8/8/1Q6 w - - 0 1', 'Again: the same start position');
  await page.click('#eg-giveup');
  await waitEnd(page);

  // ---- the named endgames: groups, guides, key positions ---------------------------------------------
  await page.click('#eg-stop');
  await page.waitForSelector('#courses-view:not([hidden])');
  await settle(page, 800);
  if (await page.isVisible('.tr-crumb')) await page.click('.tr-crumb >> nth=0');
  await settle(page, 600);
  const groups = await page.$$eval('.tr-drill-group', (h) => h.map((x) => x.textContent));
  check(groups.join(' | ') === 'Basic mates | Pawn endings | Rook endings | Queen and minor pieces', `drill groups (${groups.join(' | ')})`);
  check((await page.$$('.tr-drill[data-drill]')).length === 13, '13 drills');
  check((await text(page, '.tr-drill[data-drill=philidor] .tr-drill-goal')) === 'Defend: hold for 15 moves', 'defend drill goal');
  await page.click('.tr-drill[data-drill=philidor]');
  await settle(page);
  check((await text(page, '.eg-guide')).includes('third rank'), 'the guide');
  check(await page.isVisible('.eg-figure .mb'), 'the key position');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/eg-philidor.png`, fullPage: true });

  // a defend drill from the key position: a losing move, take back, then hold
  await page.click('.eg-key-play');
  await waitTurn(page);
  check((await page.evaluate(() => mpct.board.orientation())) === 'black', 'you defend with Black');
  check((await text(page, '#eg-status')).startsWith('Held: 0/15 moves'), `hold count (${await text(page, '#eg-status')})`);
  await move(page, 'h6d6'); // Rd6+?? Kxd6
  await waitEnd(page);
  check((await text(page, '#eg-message')).includes('That loses'), `losing move spotted (${await text(page, '#eg-message')})`);
  check((await text(page, '#eg-result')).includes('That lost the draw'), 'counted as not passed');
  await page.click('#eg-takeback');
  await waitTurn(page);
  await page.waitForFunction(() => document.querySelector('#eg-message').textContent.includes('A drawing move'), null, { timeout: 5000 });
  check(true, `hint for a drawing move (${await text(page, '#eg-message')})`);
  const legal = () => page.evaluate(() => {
    const d = mpct.game.dests();
    for (const [from, tos] of d) for (const to of tos) if (from !== 'h6' || to[1] === '6') return from + to; // keep it simple: any move but the rook leaving its rank
    return null;
  });
  await move(page, await legal());
  await page.waitForFunction(() => mpct.endgameTrainer.canMove() || !document.querySelector('#eg-end').hidden, null, { timeout: 20000 });
  check((await page.evaluate(() => mpct.game.moves.length)) >= 2, 'Stockfish attacked');
  check((await text(page, '#eg-status')).startsWith('Held: 1/15'), `held one (${await text(page, '#eg-status')})`);
  await page.click('#eg-giveup');
  await waitEnd(page);

  // win the material: queen takes rook
  await start(page, 'qvr', '7k/1r6/6K1/8/8/8/8/1Q6 w - - 0 1'); // Qxb7 wins the rook (not mate: Kg8)
  await waitTurn(page);
  await move(page, 'b1b7');
  await waitEnd(page);
  check((await text(page, '#eg-result')).includes('Material won'), `captured (${await text(page, '#eg-result')})`);

  // a server-made variation (Q v R)
  await start(page, 'qvr');
  await waitTurn(page);
  const qvr = (await page.evaluate(() => mpct.game.fen())).split(' ')[0].replace(/[0-9/]/g, '');
  check([...qvr].sort().join('') === 'KQkr' || [...qvr].sort().join('') === 'KRkq', `Q v R from the server (${qvr})`);
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
