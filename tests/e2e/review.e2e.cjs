// Browser checks for the engine review. Needs a server with an EMPTY database; runs the real engine.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/review.e2e.cjs
const { chromium, devices } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);
const SCHOLAR = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];

async function playSans(page, sans, fromStart = true) {
  await page.evaluate(
    ({ sans, fromStart }) => {
      if (fromStart) mpct.game.load();
      for (const s of sans) mpct.game.playSan(s);
      mpct.render();
    },
    { sans, fromStart },
  );
  await settle(page, 200);
}

async function startReview(page, speed) {
  await page.click('#review-start');
  await page.waitForSelector('dialog.modal[open]');
  const msg = await text(page, 'dialog.modal .modal-message');
  const options = await page.$$eval('dialog.modal select[name="speed"] option', (os) => os.map((o) => o.textContent));
  await page.selectOption('dialog.modal select[name="speed"]', speed);
  await page.click('dialog.modal button[type="submit"]');
  return { msg, options };
}

const waitDone = (page, timeout = 90000) =>
  page.waitForFunction(() => !mpct.review.running && document.getElementById('review-progress').hidden, null, { timeout });
const marks = (page) =>
  page.$$eval('#moves .move[data-ply]', (els) =>
    els.map((e) => ({ ply: Number(e.dataset.ply), mark: e.querySelector('.move-mark')?.textContent ?? '', book: e.classList.contains('book') })),
  );

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const o = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Scholar', color: 'white' });
    await post(`/api/openings/${o.id}/lines`, { moves: ['e2e4', 'e7e5', 'd1h5'] });
  });
  await page.reload();
  await settle(page, 800);

  // ---- nothing to review at the start position ------------------------------------
  await page.click('#review-start');
  await settle(page, 300);
  check(await page.isHidden('dialog.modal[open]'), 'no dialog without moves');
  check((await text(page, '.toast')).includes('Play or open some moves'), 'explains what to do');

  // ---- the dialog explains time and scope ----------------------------------------------
  await playSans(page, SCHOLAR);
  const { msg, options } = await startReview(page, 'quick');
  check(msg.includes('8 positions') && msg.includes('7 moves'), 'dialog counts positions and moves: ' + msg.split('\n')[0]);
  check(msg.includes('keep this tab open'), 'dialog warns to keep the tab open');
  check(options.length === 3 && options[0].startsWith('Quick: 0.3 s') && options[1].startsWith('Standard: 1 s'), 'speed options: ' + options.join(' | '));
  check(options.every((o) => /\((about|a few)/.test(o)), 'each speed shows an estimate');

  // ---- progress while it runs ---------------------------------------------------------
  await page.waitForSelector('#review-progress:not([hidden])', { timeout: 5000 });
  check(await page.isVisible('#review'), 'review panel open');
  check((await text(page, '#review-progress-text')).startsWith('Analysing position'), 'progress text: ' + (await text(page, '#review-progress-text')));
  check(await page.isDisabled('#review-start'), 'Review button disabled while running');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/rv-running.png` });
  await waitDone(page);
  check(!(await page.isDisabled('#review-start')), 'Review button enabled again');
  check((await text(page, '#review-title')) === 'Review · 7 moves · Quick', 'title when done: ' + (await text(page, '#review-title')));

  // ---- results ------------------------------------------------------------------------
  const m = await marks(page);
  check(m.find((x) => x.ply === 6).mark === '??', '...Nf6 marked ?? in the move list');
  check(m.filter((x) => x.book).map((x) => x.ply).join() === '1,2,3', 'repertoire moves marked: ' + m.filter((x) => x.book).map((x) => x.ply));
  check((await text(page, '#review-book')) === 'In your Scholar repertoire up to 2.Qh5.', 'book note: ' + (await text(page, '#review-book')));
  check((await page.$$('#review-graph svg .rv-g-dot.rv-blunder')).length >= 1, 'blunder dot on the graph');
  check((await page.$$('#review-graph svg polyline')).length === 1, 'one continuous evaluation line');
  const blackRow = await page.$$eval('#review-summary .rv-row', (rows) => rows[2].textContent);
  check(blackRow.startsWith('Black') && (await page.$$eval('#review-summary .rv-row:nth-child(3) span', (s) => Number(s[4].textContent))) >= 1, 'summary counts Black’s blunder: ' + blackRow);

  // Current position = after Qxf7#: describes the mate.
  check((await text(page, '#review-move .rv-move-head')).startsWith('4.Qxf7#'), 'detail for the last move: ' + (await text(page, '#review-move .rv-move-head')));
  check((await text(page, '#review-move')).includes('checkmate'), 'final position is checkmate');

  await page.click('#moves .move[data-ply="6"]');
  await settle(page, 300);
  const detail = await text(page, '#review-move');
  check(detail.startsWith('3...Nf6??') && detail.includes('Blunder'), 'Nf6 detail: ' + detail.slice(0, 40));
  check(detail.includes('Allows mate in 1'), 'explains the blunder');
  check(detail.includes("White's winning chances: 100%") && !detail.includes('→'), 'one winning-chances figure for the position: ' + detail.match(/White's winning chances: \d+%/)?.[0]);
  check(/Best was 3\.\.\.\w+ \([-+]\d\.\d\d\)$/m.test(await text(page, '#review-move .rv-best')), 'best move and its evaluation, no line: ' + (await text(page, '#review-move .rv-best')));
  const shapes = await page.evaluate(() => mpct.board.layers.review);
  check(shapes.length === 1 && shapes[0].brush === 'green', 'best move arrow on the board');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/rv-done.png` });

  await page.click('#moves .move[data-ply="1"]');
  await settle(page, 200);
  check((await text(page, '#review-move')).includes('Repertoire'), 'repertoire tag on a book move');

  // Graph click jumps to a move.
  const g = await page.locator('#review-graph').boundingBox();
  await page.mouse.click(g.x + 2, g.y + g.height / 2);
  await settle(page, 300);
  check((await page.evaluate(() => mpct.game.ply)) === 0, 'tap on the graph’s left edge goes to the start');
  check((await text(page, '#review-move .rv-move-head')) === 'Start position', 'start position detail');
  check(/White's winning chances: 5\d%/.test(await text(page, '#review-move')), 'start position shows White’s chances');

  // ---- review again, for longer (works from anywhere in the reviewed moves) ----------------
  check(await page.isVisible('#review-again'), 'Review again offered when done');
  await page.click('#review-again');
  await page.waitForSelector('dialog.modal[open]');
  check((await text(page, 'dialog.modal h2')) === 'Review again', 'dialog titled Review again');
  check((await page.$eval('dialog.modal select[name="speed"]', (s) => s.value)) === 'standard', 'suggests the next longer time');
  const againMsg = await text(page, 'dialog.modal .modal-message');
  check(againMsg.includes('same 8 positions (7 moves)'), 'same moves even though the board is at the start: ' + againMsg.split('.')[0]);
  await page.click('dialog.modal button[type="submit"]');
  await page.waitForSelector('#review-progress:not([hidden])', { timeout: 5000 });
  check(await page.isHidden('#review-again'), 'Review again hidden while running');
  check((await page.$$('#review-graph svg polyline')).length === 1, 'Quick results stay on screen meanwhile');
  await waitDone(page);
  check((await text(page, '#review-title')) === 'Review · 7 moves · Standard', 'now at Standard: ' + (await text(page, '#review-title')));
  check((await page.evaluate(() => mpct.game.ply)) === 0, 'board position unchanged');

  // ---- saved: reviewing again is instant ------------------------------------------------
  const saved = await page.evaluate(async () => {
    const fens = [mpct.game.startFen, ...mpct.game.moves.map((m) => m.fen)];
    const r = await fetch('/api/evals/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fens }) }).then((x) => x.json());
    return r.evals.map((e) => (e ? e.movetime_ms : null));
  });
  check(saved.slice(0, 7).every((v) => v === 1000) && saved[7] === null, 'longer analysis replaced the quick one on the server (mate needs no engine): ' + saved);
  await page.click('#nav-end');
  const again = await startReview(page, 'quick');
  check(again.options[0].includes('already analysed') && again.options[1].includes('already analysed') && again.msg.includes('8 positions analysed before'), 'a new review reuses everything: ' + again.options.slice(0, 2).join(' | '));
  await waitDone(page, 5000);
  check(true, 'second review finished at once');

  // ---- saved evaluation without the review open ------------------------------------------
  check(await page.isHidden('#saved-eval'), 'saved-eval line hidden while the review panel is open');
  await page.click('#review-close');
  await settle(page, 400);
  check(await page.isHidden('#review'), 'review closed');
  check((await marks(page)).every((x) => !x.mark), 'close removes the move marks');
  await page.click('#moves .move[data-ply="6"]');
  await settle(page, 400);
  check(/^White's winning chances: 100% · #1$/.test(await text(page, '#saved-eval')), 'saved evaluation shown with the review closed: ' + (await text(page, '#saved-eval')));
  await page.click('#nav-start');
  await settle(page, 400);
  check(/^White's winning chances: 5\d% · \+0\.\d\d$/.test(await text(page, '#saved-eval')), 'start position: ' + (await text(page, '#saved-eval')));
  await page.click('#engine-toggle');
  await settle(page, 300);
  check(await page.isHidden('#saved-eval'), 'hidden while the live engine is on (it shows its own score)');
  await page.click('#engine-toggle');
  await settle(page, 300);
  check(await page.isVisible('#saved-eval'), 'back when the engine is switched off');
  await page.reload();
  await settle(page, 1000);
  await page.evaluate(() => { mpct.game.goTo(3); mpct.render(); });
  await settle(page, 500);
  check(await page.isVisible('#saved-eval'), 'after a reload, a reviewed position shows its saved evaluation');
  await playSans(page, ['d4', 'd5']); // never analysed
  await settle(page, 500);
  check(await page.isHidden('#saved-eval'), 'nothing shown for a position never analysed');
  await playSans(page, ['e4', 'e5', 'Qh5']);
  await settle(page, 500);
  check(await page.isVisible('#saved-eval'), 'same position reached again (new board): shown');

  // Back to the reviewed game, review it again (instant) for the rest of the checks.
  await playSans(page, SCHOLAR);
  await startReview(page, 'quick');
  await waitDone(page, 5000);

  // ---- survives a reload (no engine needed) ---------------------------------------------
  await page.reload();
  await settle(page, 1200);
  check(await page.isVisible('#review'), 'review restored after reload');
  check((await marks(page)).find((x) => x.ply === 6).mark === '??', 'marks restored');

  // ---- changing the moves closes it ---------------------------------------------------------
  await page.click('#moves .move[data-ply="5"]');
  await playSans(page, ['h6'], false);
  check(await page.isHidden('#review'), 'a different move closes the review');
  check((await marks(page)).every((x) => !x.mark), 'marks gone');

  // ---- cancel ---------------------------------------------------------------------------------
  await startReview(page, 'deep');
  await page.waitForSelector('#review-progress:not([hidden])');
  await settle(page, 1200);
  await page.click('#review-cancel');
  await waitDone(page, 5000);
  check((await text(page, '.toast')).includes('Review stopped'), 'cancel says how to continue: ' + (await text(page, '.toast')));
  check((await text(page, '#review-title')).includes('of 7 positions analysed at Deep'), 'title shows partial: ' + (await text(page, '#review-title')));
  check((await page.$$('#review-graph svg polyline')).length >= 1, 'earlier Quick analysis still drawn while Deep is incomplete');

  // ---- phone ------------------------------------------------------------------------------------
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(String(e)));
  await pp.goto(URL);
  await settle(pp, 600);
  await playSans(pp, SCHOLAR);
  await startReview(pp, 'quick');
  await pp.waitForFunction(() => !mpct.review.running, null, { timeout: 30000 });
  await pp.click('#moves .move[data-ply="6"]');
  await settle(pp, 300);
  check(await pp.isVisible('#review-graph svg'), 'phone: graph visible');
  check(!(await pp.textContent('#review-move')).includes('null'), 'phone: saved scores display properly');
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, 'phone: no horizontal overflow (' + overflow + ')');
  if (SHOTS) {
    await pp.locator('#engine-panel').screenshot({ path: `${SHOTS}/rv-phone.png` });
  }

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
