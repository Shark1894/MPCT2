// Browser checks for creating an opening from a Chessable course export (synthetic data in the
// export's shape). Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/courseimport.e2e.cjs  [COURSE_FILE=real.json]
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

const note = (...nodes) => JSON.stringify({ before: 'x', after: 'y', data: nodes });
const C = (val) => ({ key: 'C', state: '', val });
const line = (oid, lid, chapter, sans, extra = {}, after = {}) => ({
  game: {
    owned: true, oid, lid, bid: 9, name: 'Test Catalan', lineName: chapter, title: `Line ${oid}`, color: 'white',
    initial: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', isInfo: 0, isRef: 0, isAlt: 0, isDel: false, commentsByFEN: null,
    data: sans.map((san, i) => ({ id: i, san, before: null, after: after[i + 1] ?? null, alts: null, class: 'x' })),
    ...extra,
  },
  lastStudied: null,
  studyCol: 'white',
});
const EXPORT = {
  bookData: {
    course: {
      name: 'Test Catalan',
      data: [
        { id: 30, order: 0, title: 'Introduction ' },
        { id: 61, order: 1, title: 'Quickstarter Guide' },
        { id: 35, order: 2, title: '1. Main Line' },
        { id: 45, order: 3, title: '2. 4...Bb4+' },
        { id: 60, order: 4, title: 'Model Games' },
      ],
    },
    book_bought: { name: 'Test Catalan' },
    chapterStats: {},
    1: line(1, 30, 'Introduction', ['d4'], { isInfo: 1 }),
    2: line(2, 61, 'Quickstarter Guide', ['d4', 'Nf6', 'c4', 'e6', 'g3']),
    3: line(3, 35, '1. Main Line', ['d4', 'Nf6', 'c4', 'e6', 'g3', 'd5', 'Bg2', 'Be7'], {}, { 5: note(C('The Catalan: the bishop goes to @@SANStart@@g2@@SANEnd@@.')) }),
    4: line(4, 35, '1. Main Line', ['d4', 'Nf6', 'c4', 'e6', 'g3', 'd5', 'Bg2', 'dxc4']),
    5: line(5, 45, '2. 4...Bb4+', ['d4', 'Nf6', 'c4', 'e6', 'g3', 'Bb4+', 'Bd2', 'Be7']),
    6: line(6, 45, '2. 4...Bb4+', ['d4', 'Nf6', 'c4', 'e6', 'g3', 'Bb4+', 'Bd2', 'a5'], { isRef: 1 }),
    7: line(7, 60, 'Model Games', ['d4', 'Nf6', 'c4', 'e6', 'g3', 'd5', 'Bg2', 'Be7', 'Nf3', 'O-O']),
  },
  hash: '1',
};

async function chooseFile(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#opening-import-course')]);
  await chooser.setFiles(file);
}

(async () => {
  const dir = fs.mkdtempSync('/tmp/mpct-course-');
  fs.writeFileSync(`${dir}/course.json`, JSON.stringify(EXPORT));
  fs.writeFileSync(`${dir}/bad.json`, '{"not": "a course"}');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => fetch('/api/repertoires', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Main' }) }));
  await page.reload();
  await settle(page, 800);
  await page.click('details.manage summary');
  check(await page.isVisible('#opening-import-course'), 'Import Chessable course button under Manage');

  // ---- a file that isn't a course ------------------------------------------------------------
  await chooseFile(page, `${dir}/bad.json`);
  await settle(page, 500);
  check((await text(page, '#toast')).includes('Not a Chessable course export'), 'bad file explained');

  // ---- the dialog ---------------------------------------------------------------------------------
  await chooseFile(page, `${dir}/course.json`);
  await page.waitForSelector('dialog[open] h2');
  check((await text(page, 'dialog[open] h2')) === 'Import a Chessable course', 'dialog opens');
  check((await text(page, 'dialog[open] .modal-message')).includes('Test Catalan: 5 chapters, played as White'), 'course summary');
  check((await page.inputValue('dialog[open] input[name=name]')) === 'Test Catalan', 'opening named after the course');
  const ticks = await page.$$eval('dialog[open] .modal-check', (els) => els.map((l) => `${l.querySelector('input').checked ? 'x' : ' '} ${l.textContent}`));
  check(
    JSON.stringify(ticks.slice(0, 5)) ===
      JSON.stringify(['  Introduction (0 lines)', '  Quickstarter Guide (1 line)', 'x 1. Main Line (2 lines)', 'x 2. 4...Bb4+ (1 line)', '  Model Games (1 line)']),
    'chapters, with intro/quickstarter/model games unticked: ' + JSON.stringify(ticks.slice(0, 5)),
  );
  check(ticks.some((t) => t.startsWith('  Include 1 reference line')), 'reference lines offered, off');
  await page.fill('dialog[open] input[name=name]', 'Catalan (Alonso)');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/courseimport-dialog.png` });
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] h2')?.textContent === 'Course imported', null, { timeout: 30000 });
  const report = await text(page, 'dialog[open] .modal-message');
  check(report.includes('Created “Catalan (Alonso)”: 3 new lines'), 'report: ' + report.split('\n')[0]);
  check(report.includes('1 note added to comments') && report.includes('2 chapter tags'), 'notes and tags reported');
  await page.click('dialog[open] button[type=submit]');
  await settle(page, 800);

  // ---- the new opening is selected, with its lines, tags and comments -----------------------------
  const sel = await page.$eval('#opening-select', (s) => s.options[s.selectedIndex].textContent);
  check(sel.includes('Catalan (Alonso)'), 'new opening selected: ' + sel);
  check((await text(page, '#opening-info')).includes('White · 3 lines · 3 due'), 'lines due today: ' + (await text(page, '#opening-info')));
  const opening = await page.evaluate(() => fetch('/api/repertoires').then((r) => r.json()).then((reps) => fetch(`/api/repertoires/${reps[0].id}/openings`)).then((r) => r.json()));
  const tags = await page.evaluate((id) => fetch(`/api/openings/${id}/tags`).then((r) => r.json()), opening[0].id);
  check(JSON.stringify(tags.map((t) => [t.name, t.lines])) === JSON.stringify([['1. Main Line', 2], ['2. 4...Bb4+', 1]]), 'chapter tags: ' + JSON.stringify(tags.map((t) => [t.name, t.lines])));
  await page.evaluate(() => {
    for (const s of ['d4', 'Nf6', 'c4', 'e6', 'g3']) mpct.game.playSan(s);
    mpct.render();
  });
  await settle(page, 900);
  check((await page.inputValue('#comment-current')) === 'The Catalan: the bishop goes to g2.', 'author note in the comment');

  // ---- importing again adds nothing --------------------------------------------------------------
  await chooseFile(page, `${dir}/course.json`);
  await page.waitForSelector('dialog[open] input[name=name]');
  await page.fill('dialog[open] input[name=name]', 'Catalan (Alonso)');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] h2')?.textContent === 'Course imported', null, { timeout: 30000 });
  const again = await text(page, 'dialog[open] .modal-message');
  check(again.includes('Added to “Catalan (Alonso)”: 0 new lines') && again.includes('3 already covered'), 'second import adds nothing: ' + again.split('\n')[0]);
  await page.click('dialog[open] button[type=submit]');

  // ---- optionally, a real export (not part of the normal run) ------------------------------------
  if (process.env.COURSE_FILE) {
    await settle(page, 500);
    const t0 = Date.now();
    await chooseFile(page, process.env.COURSE_FILE);
    await page.waitForSelector('dialog[open] input[name=name]');
    await page.fill('dialog[open] input[name=name]', 'Real course');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForFunction(() => document.querySelector('dialog[open] h2')?.textContent === 'Course imported', null, { timeout: 180000 });
    console.log(`real course in ${((Date.now() - t0) / 1000).toFixed(1)} s:\n${await text(page, 'dialog[open] .modal-message')}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/courseimport-real.png` });
  }

  check(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await browser.close();
  fs.rmSync(dir, { recursive: true });
})();
