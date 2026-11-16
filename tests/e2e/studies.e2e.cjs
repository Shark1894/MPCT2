// Browser checks for importing a PGN file of endgame studies into the Training tab (chapters by
// material) and starting one. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/studies.e2e.cjs   [MPCT_SHOTS=/tmp/shots]
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

const PGN = `[Event "Glasgow Weekly Citizen"]
[Date "1895.??.??"]
[White "Saavedra, Fernando"]
[Black "Win"]
[Result "1-0"]
[SetUp "1"]
[FEN "8/8/1KP5/3r4/8/8/8/k7 w - - 0 1"]

1. c7 Rd6+ 2. Kb5 Rd5+ 3. Kb4 Rd4+ 4. Kb3 Rd3+ 5. Kc2 Rd4 6. c8=R (6. c8=Q Rc4+ 7. Qxc4) 6... Ra4 7. Kb3 1-0

[Event "Kagans Neueste Schachnachrichten"]
[Date "1921.??.??"]
[White "Reti, Richard"]
[Black "Draw"]
[Result "1/2-1/2"]
[SetUp "1"]
[FEN "7K/8/k1P5/7p/8/8/8/8 w - - 0 1"]

1. Kg7 h4 2. Kf6 Kb6 3. Ke5 h3 (3... Kxc6 4. Kf4) 4. Kd6 h2 5. c7 h1=Q 6. c8=Q 1/2-1/2
`;

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
const notes = (p) => p.$$eval('#cx-notes .cx-note', (els) => els.map((e) => e.textContent));

async function importFile(page, file) {
  if (!(await page.isVisible('#cv-import'))) {
    await page.click('.tr-crumb >> nth=0');
    await page.waitForSelector('#cv-import');
  }
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#cv-import')]);
  await chooser.setFiles(file);
  await page.waitForSelector('dialog[open] input[name=name]');
}

(async () => {
  const dir = fs.mkdtempSync('/tmp/mpct-studies-');
  fs.writeFileSync(`${dir}/Classic studies.pgn`, PGN);
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 800);
  await page.click('#view-courses');
  await settle(page);
  check((await text(page, '#cv-empty')).includes('PGN file of endgame studies'), 'empty state mentions PGN files');

  await importFile(page, `${dir}/Classic studies.pgn`);
  check((await text(page, 'dialog[open] h2')) === 'Import a PGN file for Training', 'PGN import dialog');
  check((await page.inputValue('dialog[open] input[name=name]')) === 'Classic studies', 'name from the file name');
  check((await page.inputValue('dialog[open] select[name=kind]')) === 'endgames', 'kind: endgames');
  const msg = await text(page, 'dialog[open] .modal-message');
  check(msg.includes('2 exercises in 2 chapters (by material)'), `preview (${msg.slice(0, 80)})`);
  const labels = await page.$$eval('dialog[open] label', (ls) => ls.map((l) => l.textContent.trim()));
  check(labels.some((l) => l.startsWith('Pawn endings (1 exercise)')) && labels.some((l) => l.startsWith('Rook endings (1 exercise)')), 'chapters by material');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/studies-import.png` });
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] h2')?.textContent === 'Course imported', null, { timeout: 15000 });
  check((await text(page, 'dialog[open] .modal-message')).includes('Created “Classic studies”: 2 new exercises'), 'import report');
  await page.click('dialog[open] button[type=submit]');
  await settle(page);
  check((await page.$$('.cv-chapter')).length === 2, 'the course opens with its chapters');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/studies-course.png` });

  // Start: course order is pawn endings first, so Réti's study.
  await page.click('.cv-head-card .cv-actions button.primary');
  await waitTurn(page);
  check((await text(page, '#cx-title')).startsWith('Reti, Richard, 1921'), 'first study: Réti');
  const start = (await notes(page)).join('|');
  check(start.includes('White to play and draw.') && start.includes('Kagans Neueste Schachnachrichten'), 'start note: the task and the source');
  check((await page.evaluate(() => mpct.board.orientation())) === 'white', 'board from the side to move');
  await move(page, 'h8g7');
  await waitTurn(page);
  check((await page.evaluate(() => mpct.game.moves.map((m) => m.san))).join(' ') === 'Kg7 h4', 'right move: the reply is played');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/studies-solving.png` });

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
})();
