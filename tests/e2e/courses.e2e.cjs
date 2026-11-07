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
  if (!(await page.isVisible('#cv-import'))) {
    await page.click('.tr-crumb >> nth=0'); // the import button is on the hub
    await page.waitForSelector('#cv-import');
  }
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
  check((await text(page, '#cv-empty')).includes('Import adds your Chessable courses'), 'empty state explained');

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
  check((await text(page, '.cv-head-card .cv-counts')).includes('3 exercises · 0 solved · 0 missed · 3 to do'), 'course card counts');
  check((await page.$$('.cv-chapter')).length === 2, 'chapters listed (the course opens after import)');
  check((await text(page, '.tr-crumbs')).includes('Training›Courses›Test Tactics'), 'breadcrumb');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/courses-tab.png` });

  // ---- work through it -----------------------------------------------------------------------------
  await page.click('.cv-head-card .cv-actions button.primary'); // Start
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
  check((await text(page, '.cv-head-card .cv-counts')).includes('2 solved · 1 missed'), 'progress saved and shown');
  check((await text(page, '.cv-head-card .cv-actions button.primary')) === 'Retry missed', 'next step: retry missed');

  // ---- retry missed -------------------------------------------------------------------------------
  await page.click('.cv-head-card .cv-actions button.primary');
  await waitTurn(page);
  check((await text(page, '#cx-title')) === 'Puzzle 2', 'the missed one comes back');
  await move(page, 'a1a8');
  await waitEnd(page);
  check((await text(page, '#cx-result')).includes('Solved'), 'solved on retry');
  check(await page.isEnabled('#nav-start, .nav button >> nth=0').catch(() => true), 'board free to step through afterwards');
  await page.click('#cx-next');
  await page.waitForSelector('#courses-view:not([hidden])');
  await settle(page);
  check((await text(page, '.cv-head-card .cv-counts')).includes('3 solved · 0 missed · all done'), 'all done');

  // ---- re-import keeps progress -------------------------------------------------------------------
  await importFile(page, `${dir}/tactics.json`);
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] h2')?.textContent === 'Course imported', null, { timeout: 15000 });
  check((await text(page, 'dialog[open] .modal-message')).includes('Updated “Test Tactics”: 0 new exercises'), 're-import updates');
  await page.click('dialog[open] button[type=submit]');
  await settle(page);
  check((await text(page, '.cv-head-card .cv-counts')).includes('3 solved'), 'progress kept');

  // ---- grouping: a second course, a Woodpecker one -----------------------------------------------
  const WP = JSON.parse(JSON.stringify(EXPORT).replaceAll('"bid":55', '"bid":56').replaceAll('Test Tactics', 'The Woodpecker Method'));
  WP.bookData.course.data = [{ id: 1, order: 0, title: 'Easy' }, { id: 2, order: 1, title: 'Intermediate' }];
  fs.writeFileSync(`${dir}/wp.json`, JSON.stringify(WP));
  await importFile(page, `${dir}/wp.json`);
  check((await page.inputValue('dialog[open] select[name=kind]')) === 'woodpecker', 'kind guessed: woodpecker');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] h2')?.textContent === 'Course imported', null, { timeout: 15000 });
  await page.click('dialog[open] button[type=submit]');
  await settle(page, 800);
  check((await text(page, '.cv-head-card .dash-h')) === 'The Woodpecker Method', 'the imported Woodpecker course opens');
  check((await text(page, '.wp-current .wp-h')) === 'The Woodpecker Method', 'woodpecker intro');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wp-empty.png` });

  // the hub: up next, a shelf of covers (each kind its own look), drills apart from courses
  await page.click('.tr-crumb >> nth=0');
  await settle(page, 800);
  const covers = await page.$$eval('.tr-shelf .tr-cover[data-course]', (cs) => cs.map((c) => `${c.className.match(/kind-(\w+)/)[1]}: ${c.querySelector('.tr-cover-name').textContent}`));
  check(covers.join(' | ') === 'woodpecker: The Woodpecker Method | tactics: Test Tactics', `course covers (${covers.join(' | ')})`);
  check((await text(page, '.tr-cover.kind-woodpecker .tr-cover-big')) === 'No cycle yet', 'woodpecker cover: no cycle yet');
  check((await page.$$('.tr-drill[data-drill]')).length === 13, 'endgame drills in their own section');
  check((await page.$$('#tr-courses .tr-drill')).length === 0, 'drills are not mixed in with courses');
  const next = await page.$$eval('.tr-next-card', (cs) => cs.map((c) => c.dataset.kind));
  check(next[0] === 'woodpecker' && next.includes('drill'), `up next (${next.join(', ')})`);
  await page.click('.tr-chip-btn[data-filter=tactics]');
  await settle(page);
  check((await page.$$('.tr-shelf .tr-cover[data-course]')).length === 1, 'filter: tactics only');
  await page.click('.tr-chip-btn[data-filter=""]');
  await settle(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/hub-e2e.png`, fullPage: true });

  // a course page and back
  await page.click('.tr-cover.kind-tactics');
  await settle(page);
  check((await text(page, '.cv-head-card .dash-h')) === 'Test Tactics', 'selecting a course shows it');
  await page.click('.tr-crumb >> nth=0');
  await settle(page);
  await page.click('.tr-cover.kind-woodpecker');
  await settle(page);

  // ---- a cycle ---------------------------------------------------------------------------------------
  await page.click('.wp-current button.primary'); // Start cycle 1
  await page.waitForSelector('dialog[open] input[name=target]');
  check((await page.inputValue('dialog[open] input[name=target]')) === '28', 'first cycle: 28 days offered');
  check((await page.$$('dialog[open] input[type=checkbox]')).length === 2, 'chapters to choose');
  await page.fill('dialog[open] input[name=target]', '10');
  await page.click('dialog[open] button[type=submit]');
  await settle(page, 800);
  check((await text(page, '.wp-current .wp-h')) === 'Cycle 1', 'cycle 1 running');
  check((await page.$$eval('.wp-stat-value', (e) => e.map((x) => x.textContent)))[0] === '0 / 2', 'cycle covers the 2 puzzles (info page left out)');
  await page.click('.wp-current button.primary'); // Start solving
  await waitTurn(page);
  check(await page.isVisible('#cx-clock'), 'clock shown');
  check((await text(page, '#cx-progress')).includes('Cycle 1 · puzzle 1 of 2'), 'cycle progress in the panel');
  await page.waitForTimeout(1300);
  check((await text(page, '#cx-timer')) === '0:01', 'clock running');
  await page.click('#cx-pause');
  check(await page.evaluate(() => document.body.classList.contains('cx-paused')), 'paused: board hidden');
  const frozen = await text(page, '#cx-timer');
  await page.waitForTimeout(1200);
  check((await text(page, '#cx-timer')) === frozen, 'clock stopped while paused');
  await page.keyboard.press('p');
  check(!(await page.evaluate(() => document.body.classList.contains('cx-paused'))), 'P resumes');
  await move(page, 'a1a8');
  await waitEnd(page);
  check(/✓ Solved in 0:0\d!/.test(await text(page, '#cx-result')), `solved with its time (${await text(page, '#cx-result')})`);
  // auto-next: on to the next puzzle by itself
  await page.waitForFunction(() => mpct.courseTrainer.run?.ex.title === 'Puzzle 3', null, { timeout: 5000 });
  check(true, 'next puzzle automatically after a solve');
  await waitTurn(page);
  await move(page, 'g3h2');
  await page.waitForTimeout(300);
  await move(page, 'g3h3');
  await waitEnd(page);
  await page.waitForFunction(() => document.querySelector('#cx-result').textContent.includes('complete'), null, { timeout: 5000 }).catch(() => {});
  check((await text(page, '#cx-result')).includes('Missed') && (await text(page, '#cx-result')).includes('Cycle 1 complete!'), 'missed, and the cycle is complete');
  await page.click('#cx-next');
  await page.waitForSelector('#courses-view:not([hidden])');
  await settle(page, 800);
  check((await text(page, '.wp-current .wp-h')).includes('Ready for cycle 2'), 'ready for cycle 2');
  const row = await page.$$eval('.wp-history tbody tr td', (t) => t.map((x) => x.textContent));
  check(row[0] === '1' && row[4] === '2/2' && row[5] === '50%', `cycle table (${row.join(', ')})`);
  check((await page.$$('.wp-grid .wp-cell')).length === 2 && (await page.$$('.wp-grid .wp-cell.miss')).length === 1, 'puzzle map: 2 puzzles, 1 missed');
  check((await page.$$eval('.wp-ch', (r) => r.length)) === 2, 'cycle by chapter');
  await page.click('.wp-times summary');
  await page.waitForSelector('.wp-times-table');
  const times = await page.$$eval('.wp-times-table tbody tr', (rs) => rs.map((r) => [...r.children].slice(0, 3).map((c) => c.textContent).join(' ')));
  check(times.length === 2 && times.some((t) => t.startsWith('Puzzle 3 Intermediate ✗ 0:0')), `puzzle times (${times.join(' | ')})`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wp-done.png`, fullPage: true });
  await page.click('.tr-crumb >> nth=0');
  await settle(page);
  check((await text(page, '.tr-cover.kind-woodpecker .tr-cover-big')) === 'Cycle 1', 'the cover shows the cycle');
  check((await text(page, '.tr-next-card[data-kind=woodpecker] .tr-cta')) === 'Start cycle 2', 'up next: start cycle 2');

  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await browser.close();
})();
