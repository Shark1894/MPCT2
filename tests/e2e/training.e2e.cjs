// Browser checks for the opening trainer. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/training.e2e.cjs
const { chromium, devices } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};

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

const waitUserTurn = (page) => page.waitForFunction(() => mpct.trainer.canMove(), null, { timeout: 5000 });
const waitLineEnd = (page) => page.waitForSelector('#train-end:not([hidden])', { timeout: 5000 });
const sans = (page) => page.evaluate(() => mpct.game.moves.slice(0, mpct.game.ply).map((m) => m.san).join(' '));
const text = (page, sel) => page.textContent(sel);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());

  // Set up a Black opening with two lines via the API
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const o = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro-Kann', color: 'black' });
    await post(`/api/openings/${o.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'] });
    await post(`/api/openings/${o.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'] });
  });
  await page.reload();
  await page.waitForTimeout(600);
  check((await text(page, '#train-due')) === 'Train due (2)', 'train-due button shows count');

  // ---- start training -------------------------------------------------
  await page.click('#train-due');
  await waitUserTurn(page);
  check(await page.isVisible('#training'), 'training panel shown');
  check(await page.isHidden('#rep-build'), 'explorer and editing tools hidden during training');
  check(await page.isHidden('.tools'), 'board tools hidden during training');
  check(await page.isVisible('#mode-badge'), 'header shows Training badge');
  check((await page.evaluate(() => mpct.board.orientation())) === 'black', 'board oriented to Black');
  check((await sans(page)) === 'e4', 'opponent move 1.e4 auto-played');
  check((await text(page, '#train-progress')) === 'Line 1 of 2', 'progress shown');
  check((await page.evaluate(() => mpct.board.cg.state.drawable.autoShapes.length)) === 0, 'no explorer arrows giving answers away');
  check(await page.isVisible('#comments'), 'comments visible while learning a new line');

  // Navigation locked
  await page.keyboard.press('ArrowLeft');
  check((await page.evaluate(() => mpct.game.ply)) === 1 && (await page.isDisabled('#nav-back')), 'navigation locked while training');

  // ---- line 1: perfect ------------------------------------------------
  await move(page, 'c7c6');
  await waitUserTurn(page);
  check((await sans(page)) === 'e4 c6 d4', 'correct move accepted, opponent replied');
  await move(page, 'd7d5');
  await waitUserTurn(page);
  await move(page, 'c8f5');
  await waitLineEnd(page);
  const r1 = await text(page, '#train-result');
  check(r1.includes('no mistakes') && r1.includes('Streak 1') && r1.includes('tomorrow'), 'line 1 result: ' + r1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/p4-line-done.png` });

  // ---- line 2: mistakes and hints ------------------------------------------
  await page.click('#train-next');
  await waitUserTurn(page);
  check((await text(page, '#train-progress')) === 'Line 2 of 2', 'moved to line 2');
  await move(page, 'c7c6');
  await waitUserTurn(page);
  await move(page, 'd7d5');
  await waitUserTurn(page); // after 3.Nc3, expected dxe4
  await move(page, 'g8f6');
  check((await text(page, '#train-message')).includes('Try again'), '1st wrong move: try again');
  check((await sans(page)).endsWith('Nc3'), 'wrong move snapped back');
  await move(page, 'e7e6');
  const shapes2 = await page.evaluate(() => mpct.board.cg.state.drawable.autoShapes);
  check(shapes2.length === 1 && shapes2[0].orig === 'd5' && !shapes2[0].dest, '2nd wrong move: piece on d5 highlighted');
  check((await text(page, '#train-message')).includes('highlighted piece'), 'piece hint message');
  await move(page, 'g7g6');
  const shapes3 = await page.evaluate(() => mpct.board.cg.state.drawable.autoShapes);
  check(shapes3.length === 1 && shapes3[0].orig === 'd5' && shapes3[0].dest === 'e4', '3rd wrong move: full move arrow d5-e4');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/p4-hint.png` });
  await move(page, 'd5e4');
  await waitLineEnd(page);
  const r2 = await text(page, '#train-result');
  check(r2.includes('3 mistakes') && r2.includes('due again today'), 'line 2 result: ' + r2);
  check((await text(page, '#train-next')) === 'Finish', 'last line offers Finish');

  // ---- retry is practice ---------------------------------------------------
  await page.click('#train-retry');
  await waitUserTurn(page);
  check((await text(page, '#train-progress')) === 'Line 2 of 2 · practice', 'retry marked as practice');
  await move(page, 'c7c6');
  await waitUserTurn(page);
  await move(page, 'd7d5');
  await waitUserTurn(page);
  await move(page, 'd5e4');
  await waitLineEnd(page);
  check((await text(page, '#train-result')).includes('schedule is unchanged'), 'practice run does not change schedule');

  // ---- summary + back to repertoire mode ------------------------------------
  await page.click('#train-next');
  await page.waitForSelector('#train-summary:not([hidden])');
  const summary = await text(page, '#train-summary-text');
  check(summary.includes('2 lines reviewed') && summary.includes('1 correct') && summary.includes('1 to repeat'), 'summary: ' + summary);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/p4-summary.png` });
  await page.click('#train-done');
  await page.waitForTimeout(500);
  check(await page.isHidden('#training') && (await page.isVisible('#rep-build')), 'back to repertoire mode');
  check((await text(page, '#train-due')) === 'Train due (1)', 'due count updated: failed line still due');
  check(!(await page.isDisabled('#nav-back')), 'navigation unlocked');

  // ---- train again: only the failed line ------------------------------------
  await page.click('#train-due');
  await waitUserTurn(page);
  check((await text(page, '#train-progress')) === 'Line 1 of 1', 'only the failed line is due');
  check(await page.isVisible('#comments'), 'comments shown for a line still being learned');
  await page.click('#train-stop');
  await page.waitForTimeout(300);
  check(await page.isHidden('#training'), 'stop ends training');
  const stillDue = await page.evaluate(async () => {
    const openings = await fetch('/api/repertoires/1/openings').then((r) => r.json());
    return openings[0].due;
  });
  check(stillDue === 1, 'abandoned line not recorded (still due)');

  // ---- well-known line: comments hidden, and it says so ---------------------
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const o = await post('/api/repertoires/1/openings', { name: 'Known', color: 'white' });
    const line = (await post(`/api/openings/${o.id}/lines`, { moves: ['g1f3', 'd7d5', 'g2g3'] })).line_id;
    const perfect = [{ ply: 1, uci: 'g1f3' }, { ply: 3, uci: 'g2g3' }];
    await post(`/api/lines/${line}/reviews`, { attempts: perfect });
    await post(`/api/lines/${line}/reviews`, { attempts: perfect });
    await fetch('/api/repertoires/1/comment', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', comment: 'Start with Nf3' }),
    });
  });
  await page.reload();
  await page.waitForTimeout(700);
  await page.selectOption('#opening-select', { label: 'Known' });
  await page.waitForTimeout(500);
  await page.click('#train-all');
  await waitUserTurn(page);
  check(await page.isHidden('#comments'), 'well-known line: comments hidden');
  check(
    (await page.isVisible('#train-comments-note')) && (await text(page, '#train-comments-note-text')).includes('correctly 2 times in a row'),
    'well-known line: note says comments are hidden and why',
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/p4-comments-hidden.png` });
  await page.click('#train-comments-show');
  check(await page.isVisible('#comments') && (await page.inputValue('#comment-current')) === 'Start with Nf3', 'Show comments reveals them');
  check(await page.isHidden('#train-comments-note'), 'note goes away once revealed');
  await move(page, 'e2e4'); // wrong
  check(await page.isVisible('#comments'), 'comments visible after a mistake');
  check((await text(page, '#train-comments-note-text')).includes('after a mistake'), 'note explains comments are back after a mistake');
  await page.click('#train-stop');
  await page.waitForTimeout(300);

  // ---- phone: training box sits right under the controls --------------------
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await ctx.newPage();
  mp.on('pageerror', (e) => errors.push('phone: ' + e));
  await mp.goto(URL);
  await mp.waitForTimeout(600);
  await mp.selectOption('#opening-select', { label: 'Caro-Kann' });
  await mp.waitForTimeout(500);
  await mp.click('#train-all');
  await waitUserTurn(mp);
  await mp.waitForTimeout(800); // let the smooth scroll to the board finish
  const tops = await mp.evaluate(() => ['.controls', '#training'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  check(tops[1] > tops[0], 'phone: training panel below controls');
  check(await mp.evaluate(() => document.querySelector('cg-board').getBoundingClientRect().top >= 0), 'phone: board scrolled into view when training starts');
  const box = await mp.locator('cg-board').boundingBox();
  const a = sq(box, 'c7', true), b = sq(box, 'c6', true);
  await mp.touchscreen.tap(a.x, a.y);
  await mp.waitForTimeout(150);
  await mp.touchscreen.tap(b.x, b.y);
  await mp.waitForTimeout(200); // let the tap register before waiting for the reply
  await waitUserTurn(mp);
  const phoneSans = await sans(mp);
  check(phoneSans === 'e4 c6 d4', 'phone: tap move accepted in training: ' + phoneSans + ' | ' + (await text(mp, '#train-message')));
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow');
  if (SHOTS) await mp.screenshot({ path: `${SHOTS}/p4-phone.png`, fullPage: true });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
