// Browser checks for the Training tab: importing a Chessable tactics course (synthetic data in the
// export's shape) and working through it move by move. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/courses.e2e.cjs   [MPCT_SHOTS=/tmp/shots]
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);

const note = (...texts) => JSON.stringify({ before: 'x', after: 'y', data: texts.map((val) => ({ key: 'C', state: '', val })) });
const line = (oid, lid, chapter, initial, color, sans, extra = {}, notes = {}) => ({
  game: {
    owned: true, oid, lid, bid: 55, name: 'Test Tactics', lineName: chapter, title: `Puzzle ${oid}`, color, initial,
    isInfo: 0, isRef: 0, isAlt: 0, isDel: false,
    data: sans.map((san, i) => ({ id: i, san, before: i === 0 ? notes[0] ?? null : null, after: notes[i + 1] ?? null })),
    ...extra,
  },
});
const BACK_RANK = '6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1';
const QUEEN_MATE = '6k1/8/8/8/8/6q1/6P1/6K1 w - - 0 1';
const EXPORT = {
  bookData: {
    course: { name: 'Test Tactics', data: [{ id: 1, order: 0, title: '1) Back rank' }, { id: 2, order: 1, title: '2) Black to play' }] },
    // As Chessable stores them: an information page is a line of a move or two with the text after it.
    1: line(1, 1, '1) Back rank', '8/8/8/8/8/8/8/K6k w - - 0 1', 'white', ['Kb1', 'Kg1'], { isInfo: 1, title: 'How to use this course' }, { 1: note('Read me first.'), 2: note('And this.') }),
    2: line(2, 1, '1) Back rank', BACK_RANK, 'white', ['h6', 'Ra8+', 'Kh7'], {}, { 0: note('White to play and win.'), 2: note('Check, and the king has to run.') }),
    3: line(3, 2, '2) Black to play', QUEEN_MATE, 'black', ['Kh1', 'Qxg2#']),
  },
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
const waitTurn = (p) => p.waitForFunction(() => mpct.courseTrainer.canMove(), null, { timeout: 5000 });
const waitEnd = (p) => p.waitForSelector('#cx-end:not([hidden])', { timeout: 5000 });
const notes = (p) => p.$$eval('#cx-notes .cx-note', (els) => els.map((e) => e.textContent));

async function importFile(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#cv-import')]);
  await chooser.setFiles(file);
  await page.waitForSelector('dialog[open] input[name=name]');
}

(async () => {
  const dir = fs.mkdtempSync('/tmp/mpct-tactics-');
  fs.writeFileSync(`${dir}/tactics.json`, JSON.stringify(EXPORT));
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 800);

  // ---- the tab, empty ----------------------------------------------------------------------------
  await page.click('#view-courses');
  await settle(page);
  check(await page.isVisible('#courses-view'), 'Training tab opens');
  check((await text(page, '#cv-empty')).includes('No courses yet'), 'empty state explained');

  // ---- import ------------------------------------------------------------------------------------
  await importFile(page, `${dir}/tactics.json`);
  check((await text(page, 'dialog[open] h2')) === 'Import a course for Training', 'import dialog');
  check((await page.inputValue('dialog[open] select[name=kind]')) === 'tactics', 'kind guessed: tactics');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/courses-import.png` });
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] h2')?.textContent === 'Course imported', null, { timeout: 15000 });
  check((await text(page, 'dialog[open] .modal-message')).includes('Created “Test Tactics”: 3 new exercises'), 'import report');
  await page.click('dialog[open] button[type=submit]');
  await settle(page);
  check((await text(page, '.cv-course .cv-counts')).includes('3 exercises · 0 solved · 0 missed · 3 to do'), 'course card counts');
  check((await page.$$('.cv-chapter')).length === 2, 'chapters listed (opened after import)');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/courses-tab.png` });

  // ---- work through it -----------------------------------------------------------------------------
  await page.click('.cv-course .cv-actions button.primary'); // Start
  await page.waitForSelector('#cx:not([hidden])');
  check(await page.isVisible('main.layout'), 'board view');
  check((await text(page, '#cx-title')) === 'How to use this course', 'info page first (course order)');
  check((await notes(page)).join('|') === '1.Kb1Read me first.|1...Kg1And this.', 'info page: all of it shown at once');
  await waitEnd(page);
  await page.click('#cx-next');

  await waitTurn(page);
  check((await text(page, '#cx-title')) === 'Puzzle 2', 'first exercise');
  check((await page.evaluate(() => mpct.game.moves.map((m) => m.san))).join(' ') === 'h6', "opponent's first move played for you");
  check((await page.evaluate(() => mpct.board.orientation())) === 'white', 'board from your side');
  check((await notes(page)).join('|') === 'White to play and win.', 'start note shown, later notes hidden');
  check(await page.isDisabled('#view-courses'), 'tabs locked while solving');
  await move(page, 'a1a7');
  check((await text(page, '#cx-message')).includes('Not the move. Try again'), 'first miss: try again');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/courses-wrong.png` });
  await move(page, 'a1b1');
  check((await text(page, '#cx-message')).includes('The move was 2.Ra8+'), 'second miss: the move shown');
  await waitEnd(page);
  check((await text(page, '#cx-result')).includes('Missed'), 'counted as missed');
  check((await notes(page)).some((n) => n.startsWith('2.Ra8+') && n.includes('Check, and the king has to run.')), 'note shown after the move');
  await page.click('#cx-next');

  await waitTurn(page);
  check((await page.evaluate(() => mpct.board.orientation())) === 'black', 'black exercise: board flipped');
  await move(page, 'g3g2');
  await waitEnd(page);
  check((await text(page, '#cx-result')).includes('Solved'), 'solved');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/courses-solved.png` });
  check((await text(page, '#cx-next')) === 'Finish', 'last one: Finish');
  await page.click('#cx-next');
  await page.waitForSelector('#courses-view:not([hidden])');
  await settle(page);
  check((await text(page, '.cv-course .cv-counts')).includes('2 solved · 1 missed'), 'progress saved and shown');
  check((await text(page, '.cv-course .cv-actions button.primary')) === 'Retry missed', 'next step: retry missed');

  // ---- retry missed -------------------------------------------------------------------------------
  await page.click('.cv-course .cv-actions button.primary');
  await waitTurn(page);
  check((await text(page, '#cx-title')) === 'Puzzle 2', 'the missed one comes back');
  await move(page, 'a1a8');
  await waitEnd(page);
  check((await text(page, '#cx-result')).includes('Solved'), 'solved on retry');
  check(await page.isEnabled('#nav-start, .nav button >> nth=0').catch(() => true), 'board free to step through afterwards');
  await page.click('#cx-next');
  await page.waitForSelector('#courses-view:not([hidden])');
  await settle(page);
  check((await text(page, '.cv-course .cv-counts')).includes('3 solved · 0 missed · all done'), 'all done');

  // ---- re-import keeps progress -------------------------------------------------------------------
  await importFile(page, `${dir}/tactics.json`);
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] h2')?.textContent === 'Course imported', null, { timeout: 15000 });
  check((await text(page, 'dialog[open] .modal-message')).includes('Updated “Test Tactics”: 0 new exercises'), 're-import updates');
  await page.click('dialog[open] button[type=submit]');
  await settle(page);
  check((await text(page, '.cv-course .cv-counts')).includes('3 solved'), 'progress kept');

  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await browser.close();
})();
