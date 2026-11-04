// Browser checks for the position drill. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/drill.e2e.cjs
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
  await page.waitForTimeout(200);
}
const expected = (p) => p.evaluate(() => mpct.drill.run.current.expected[0].uci);
/** Legal moves here that aren't the answer. */
const wrongMoves = (p) =>
  p.evaluate(() => {
    const ok = mpct.drill.run.expectedUcis();
    const out = [];
    for (const [from, tos] of mpct.game.dests()) for (const to of tos) if (!ok.includes(from + to)) out.push(from + to);
    return out.filter((u) => !mpct.game.isPromotion(u.slice(0, 2), u.slice(2, 4)));
  });
async function startDrill(p, scope, count = '10') {
  await p.click('#train-drill');
  await p.waitForSelector('dialog[open]');
  await p.selectOption('dialog select[name=scope]', scope);
  await p.selectOption('dialog select[name=count]', count);
  await p.click('dialog button[type=submit]');
  await settle(p, 500);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const ids = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const caro = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro-Kann', color: 'black' });
    const ital = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Italian', color: 'white' });
    await post(`/api/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'] });
    await post(`/api/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4', 'c8f5'] });
    await post(`/api/openings/${ital.id}/lines`, { moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'] });
    // a comment on the position after 1.e4 (Black to move): hidden until answered
    await fetch(`/api/repertoires/${rep.id}/comment`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', comment: 'Caro-Kann: c6 then d5' }),
    });
    const tag = await post(`/api/openings/${caro.id}/tags`, { name: 'Classical', fen: 'rnbqkbnr/pp2pppp/2p5/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR b KQkq - 1 3' });
    return { rep: rep.id, caro: caro.id, ital: ital.id, tag: tag.id };
  });
  await page.reload();
  await settle(page, 700);
  await page.selectOption('#opening-select', String(ids.caro));
  await settle(page, 400);

  // ---- the dialog ----------------------------------------------------------------------
  check(await page.isEnabled('#train-drill'), 'Position drill button enabled');
  await page.click('#train-drill');
  await page.waitForSelector('dialog[open]');
  const scopes = await page.$$eval('dialog select[name=scope] option', (o) => o.map((x) => x.textContent));
  check(scopes.join('|') === 'Whole repertoire: Main|Caro-Kann (Black)|Caro-Kann › Classical', 'scopes: ' + scopes.join('|'));
  check((await page.inputValue('dialog select[name=scope]')) === 'opening', 'this opening preselected');
  await page.click('dialog button:text("Cancel")');
  await settle(page);
  check(!(await page.evaluate(() => mpct.drill.active)), 'cancel: no drill');

  // ---- drill the Caro-Kann (5 positions) ---------------------------------------------------
  await startDrill(page, 'opening', '10');
  check(await page.evaluate(() => mpct.drill.active), 'drill started');
  check((await text(page, '#toast')).includes('has 5 positions'), 'fewer positions than asked: says so: ' + (await text(page, '#toast')));
  check(await page.isVisible('#drill') && (await page.isHidden('#rep-build')) && (await text(page, '#mode-badge')) === 'Drill', 'drill panel, repertoire tools hidden, Drill badge');
  check((await text(page, '#drill-progress')).startsWith('Position 1 of 5 · Caro-Kann · move'), 'progress: ' + (await text(page, '#drill-progress')));
  check((await page.evaluate(() => mpct.game.moves.length)) === 0, 'no moves leading to the position');
  check((await page.evaluate(() => mpct.board.orientation())) === 'black' && (await page.evaluate(() => mpct.game.turn())) === 'black', 'Black to move, board from Black');
  check(await page.isHidden('#engine-panel') || (await page.evaluate(() => !mpct.analysis.settings.on)), 'engine not available');
  await page.keyboard.press('ArrowLeft');
  check(await page.isDisabled('#nav-back'), 'navigation locked');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/drill-position.png` });

  // position 1: right first time
  await move(page, await expected(page));
  await page.waitForSelector('#drill-end:not([hidden])');
  check((await text(page, '#drill-result')).includes('Right first time'), 'right first time: ' + (await text(page, '#drill-result')));
  check(await page.isVisible('#drill-next'), 'Next position offered');

  // position 2: three wrong tries, hints, then right
  await page.click('#drill-next');
  await settle(page);
  check((await text(page, '#drill-progress')).startsWith('Position 2 of 5'), 'position 2');
  const wrong = await wrongMoves(page);
  await move(page, wrong[0]);
  check((await text(page, '#drill-message')).includes('Try again') && (await page.evaluate(() => mpct.game.moves.length)) === 0, '1st wrong move snapped back');
  await move(page, wrong[1]);
  check((await page.evaluate(() => mpct.board.cg.state.drawable.autoShapes.length)) === 1, '2nd wrong: piece highlighted');
  await move(page, wrong[2]);
  const arrow = await page.evaluate(() => mpct.board.cg.state.drawable.autoShapes[0]);
  check(arrow && arrow.dest, '3rd wrong: arrow shown');
  await move(page, await expected(page));
  await page.waitForSelector('#drill-end:not([hidden])');
  check((await text(page, '#drill-result')).includes('after 3 wrong tries'), 'found after 3 wrong tries');

  // position 3: show answer
  await page.click('#drill-next');
  await settle(page);
  await page.click('#drill-reveal');
  await settle(page, 300);
  check((await text(page, '#drill-result')).startsWith('The repertoire move is'), 'Show answer: ' + (await text(page, '#drill-result')));
  check((await page.evaluate(() => mpct.game.moves.length)) === 1, 'answer played on the board');

  // positions 4–5: right, and play the line on where there's a line left
  for (let i = 4; i <= 5; i++) {
    await page.click('#drill-next');
    await settle(page);
    await move(page, await expected(page));
    await page.waitForSelector('#drill-end:not([hidden])');
    if (await page.isVisible('#drill-line')) {
      const restLen = await page.evaluate(() => mpct.drill.run.current.rest.length);
      await page.click('#drill-line');
      // play the user's moves of the line as they come
      for (let k = 0; k < 10 && !(await page.isVisible('#drill-end')); k++) {
        await page.waitForTimeout(600);
        if (await page.evaluate(() => mpct.drill.canMove())) await move(page, await page.evaluate(() => mpct.drill.run.lineMove().uci));
      }
      check((await text(page, '#drill-result')).startsWith('End of the line'), `position ${i}: played the line on to its end (${restLen} moves)`);
      check(await page.isHidden('#drill-line'), 'line offered once');
    }
  }
  check((await text(page, '#drill-next')) === 'Finish', 'last position: Finish');
  await page.click('#drill-next');
  await settle(page);
  check(await page.isVisible('#drill-summary'), 'summary shown');
  check((await text(page, '#drill-summary-text')) === '3 of 5 right first time. Missed:', 'summary: ' + (await text(page, '#drill-summary-text')));
  const missed = await page.$$eval('#drill-missed li span', (s) => s.map((x) => x.textContent));
  check(missed.length === 2 && missed.some((m) => m.includes('(shown)')), 'missed list: ' + JSON.stringify(missed));
  check((await text(page, '#drill-again')) === 'Drill missed again (2)', 'Drill missed again (2)');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/drill-summary.png` });

  // stored answers: 5, and the misses show as problem positions without touching the schedule
  const dash = await page.evaluate((id) => fetch(`/api/openings/${id}/dashboard`).then((r) => r.json()), ids.caro);
  check(dash.problems.length === 2, 'two problem positions from the drill: ' + dash.problems.map((p) => p.expected).join(','));
  check(dash.lines.every((l) => l.streak === 0 && !l.last_results?.length), 'line schedules untouched');

  // drill missed again: 2 positions
  await page.click('#drill-again');
  await settle(page);
  check((await text(page, '#drill-progress')).startsWith('Position 1 of 2'), 'missed again: 2 positions');
  check((await text(page, '#drill-title')).endsWith('(missed)'), 'title says missed: ' + (await text(page, '#drill-title')));
  await page.click('#drill-stop');
  await settle(page);
  check(!(await page.evaluate(() => mpct.drill.active)) && (await page.isVisible('#rep-build')) && (await page.isHidden('#mode-badge')), 'Stop: back to the board');

  // ---- comments hidden until answered (the 1.e4 position, from the branch-free scope) -------
  await page.evaluate(() => mpct.drill.start([{ opening: { id: 1, name: 'Caro-Kann', color: 'black' }, position_id: 0, fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', ply: 2, expected: [{ uci: 'c7c6', san: 'c6' }], line_id: 1, path: ['e4'], rest: [{ ply: 2, uci: 'c7c6', san: 'c6' }] }]));
  await settle(page, 600);
  check(await page.isHidden('#comments'), 'comment hidden while answering');
  await page.evaluate(() => mpct.drill.reveal());
  await settle(page, 600);
  check(await page.isVisible('#comments') && (await page.inputValue('#comment-previous')).includes('c6 then d5'), 'comment shown after answering (as the previous position)');
  await page.evaluate(() => mpct.drill.stop());

  // ---- branch scope and whole repertoire ---------------------------------------------------
  await startDrill(page, `tag:${ids.tag}`, '10');
  check((await text(page, '#drill-progress')).startsWith('Position 1 of 2'), 'branch: its 2 positions');
  check((await text(page, '#drill-title')) === 'Position drill: Caro-Kann › Classical', 'branch title');
  await page.click('#drill-stop');
  await startDrill(page, 'rep', '10');
  check((await text(page, '#drill-progress')).startsWith('Position 1 of 7'), 'whole repertoire: 7 positions (both colours)');
  // a White position turns the board round
  for (let i = 0; i < 7; i++) {
    if ((await page.evaluate(() => mpct.drill.run.color)) === 'white') break;
    await page.click('#drill-reveal');
    await page.click('#drill-next');
    await settle(page, 200);
  }
  check((await page.evaluate(() => mpct.board.orientation())) === 'white', 'White position: board from White');

  // Show from the summary leaves the drill with the line on the board
  await page.evaluate(() => {
    const r = mpct.drill.run;
    while (!r.done) {
      if (r.phase === 'answer') r.reveal();
      r.next();
    }
    mpct.drill._summary();
  });
  await settle(page);
  await page.click('#drill-missed li button');
  await settle(page);
  check(!(await page.evaluate(() => mpct.drill.active)) && (await page.evaluate(() => mpct.game.moves.length)) >= 1, 'Show: drill left, line on the board');

  // ---- phone ---------------------------------------------------------------------------
  const phone = await browser.newPage({ ...devices['Pixel 7'] });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(URL);
  await settle(phone, 700);
  await phone.selectOption('#opening-select', String(ids.caro));
  await settle(phone, 300);
  await startDrill(phone, 'opening', '10');
  await move(phone, await expected(phone));
  await phone.waitForSelector('#drill-end:not([hidden])');
  const fit = await phone.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    buttons: [...document.querySelectorAll('#drill-end button')].filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().right)),
    vw: window.innerWidth,
  }));
  check(!fit.overflow && fit.buttons.every((r) => r <= fit.vw), 'phone: drill panel fits ' + JSON.stringify(fit));
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/drill-phone.png`, fullPage: true });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
