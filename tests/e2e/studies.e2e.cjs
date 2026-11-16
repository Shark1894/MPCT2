// Browser checks for Endgame studies in the Training tab: importing a PGN file, the page with its
// filters, favourites (in the list and while solving) and solving one. Needs a server with an
// EMPTY database.
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
const rows = (p) => p.$$eval('#st-list .st-row .st-title', (els) => els.map((e) => e.textContent));

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

  // ---- the hub, empty -----------------------------------------------------------------------------
  await page.click('#view-courses');
  await settle(page);
  check(await page.isVisible('#tr-studies'), 'Endgame studies section on the hub');
  check((await text(page, '#tr-studies')).includes('Import studies'), 'empty: invites an import');
  check((await page.$$eval('.tr-section-link', (bs) => bs.map((b) => b.textContent))).includes('Endgame studies'), 'section link in the hub nav');
  await page.click('#st-hub-open');
  await settle(page);
  check((await text(page, '.tr-crumbs')).includes('Training›Endgame studies'), 'studies page with its breadcrumb');
  check(await page.isVisible('#st-empty'), 'empty page explains and links a sample');

  // ---- import -------------------------------------------------------------------------------------
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#st-import')]);
  await chooser.setFiles(`${dir}/Classic studies.pgn`);
  await page.waitForSelector('dialog[open] input[name=collection]');
  check((await text(page, 'dialog[open] h2')) === 'Import endgame studies', 'import dialog');
  check((await page.inputValue('dialog[open] input[name=collection]')) === 'Classic studies', 'collection named after the file');
  const labels = await page.$$eval('dialog[open] label', (ls) => ls.map((l) => l.textContent.trim()));
  check(labels.some((l) => l.startsWith('Pawn endings (1 study)')) && labels.some((l) => l.startsWith('Rook endings (1 study)')), 'kinds of ending to tick');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/studies-import.png` });
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog[open] h2')?.textContent === 'Studies imported', null, { timeout: 15000 });
  check((await text(page, 'dialog[open] .modal-message')).includes('“Classic studies”: 2 new studies'), 'import report');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForSelector('#st-list .st-row');
  await settle(page);
  check((await text(page, '#st-facts')).includes('2 studies · 0 solved'), 'page facts');
  check((await rows(page)).join(' | ') === 'Reti, Richard, 1921 · P v P | Saavedra, Fernando, 1895 · P v R', 'listed by material: pawn endings first');
  check((await text(page, '#st-list .st-row >> nth=0')).includes('White to play and draw'), 'each row says the task');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/studies-page.png`, fullPage: true });

  // ---- filters ------------------------------------------------------------------------------------
  await page.click('.st-groups button[data-group=rook]');
  await settle(page);
  check((await rows(page)).join() === 'Saavedra, Fernando, 1895 · P v R', 'material filter');
  await page.click('.st-groups button[data-group=""]');
  await page.selectOption('select[name=stipulation]', 'draw');
  await settle(page);
  check((await rows(page)).join() === 'Reti, Richard, 1921 · P v P', 'win/draw filter');
  await page.selectOption('select[name=stipulation]', '');
  await page.fill('input[name=q]', 'saavedra');
  await settle(page, 700);
  check((await rows(page)).join() === 'Saavedra, Fernando, 1895 · P v R', 'search by composer');
  await page.fill('input[name=q]', '');
  await settle(page, 700);

  // ---- favourites in the list -----------------------------------------------------------------------
  await page.click('#st-list .st-row:has-text("Saavedra") button.star');
  await settle(page);
  check((await page.getAttribute('#st-list .st-row:has-text("Saavedra") button.star', 'aria-pressed')) === 'true', 'star: favourite');
  check((await text(page, '#st-fav-filter')).includes('★ Favourites 1'), 'favourites count');
  await page.click('#st-list .st-row:has-text("Saavedra") .st-note');
  await page.fill('dialog[open] input[name=note]', 'Underpromote to a rook!');
  await page.click('dialog[open] button[type=submit]');
  await settle(page);
  check((await text(page, '#st-list .st-row:has-text("Saavedra") .st-note')) === 'Underpromote to a rook!', 'favourite note');
  await page.click('#st-fav-filter');
  await settle(page);
  check((await rows(page)).join() === 'Saavedra, Fernando, 1895 · P v R', 'favourites filter');
  await page.click('#st-fav-filter');
  await settle(page);

  // ---- solve: Start goes through new ones, pawn endings first ------------------------------------------
  await page.click('#st-start');
  await waitTurn(page);
  check((await text(page, '#cx-title')).startsWith('Reti, Richard, 1921'), 'first study: Réti');
  check((await text(page, '#cx-sub')).includes('Pawn endings · Draw'), 'where it is from');
  check((await notes(page)).join('|').includes('White to play and draw.'), 'start note');
  check(await page.isVisible('#cx-star'), 'favourite star while solving');
  check((await text(page, '#cx-star')) === '☆', 'not a favourite yet');
  await page.click('#cx-star');
  await settle(page);
  check((await text(page, '#cx-star')) === '★', 'favourited while solving');
  await move(page, 'h8g7');
  await waitTurn(page);
  check((await page.evaluate(() => mpct.game.moves.map((m) => m.san))).join(' ') === 'Kg7 h4', 'right move: the reply is played');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/studies-solving.png` });
  // give up the rest: Show move until the end
  for (let i = 0; i < 8 && !(await page.isVisible('#cx-end')); i++) {
    if (await page.evaluate(() => mpct.courseTrainer.canMove())) await page.click('#cx-show');
    await settle(page, 1500);
  }
  await page.waitForSelector('#cx-end:not([hidden])', { timeout: 15000 });
  check((await text(page, '#cx-result')).includes('Missed'), 'shown moves: missed');
  await page.click('#cx-stop');
  await page.waitForSelector('#st-list .st-row');
  await settle(page, 800);
  check((await text(page, '#st-facts')).includes('2 studies · 0 solved · 1 missed · ★ 2'), 'back on the page: progress and favourites');
  check((await text(page, '#st-list .st-row:has-text("Reti") .st-status')).includes('Missed'), 'status in the list');

  // ---- the hub shows the database ---------------------------------------------------------------------
  await page.click('.tr-crumb >> nth=0');
  await settle(page);
  const tiles = await page.$$eval('#tr-studies .st-tile', (ts) => ts.map((t) => t.dataset.studyGroup));
  check(tiles.join() === 'pawn,rook,favourites', `hub tiles (${tiles.join()})`);
  if (SHOTS) {
    await page.locator('#tr-studies').scrollIntoViewIfNeeded();
    await page.locator('#tr-studies').screenshot({ path: `${SHOTS}/studies-hub.png` });
  }
  await page.click('#tr-studies .st-tile[data-study-group=favourites]');
  await settle(page);
  check((await page.getAttribute('#st-fav-filter', 'aria-pressed')) === 'true' && (await rows(page)).length === 2, 'favourites tile opens them');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/studies-favourites.png`, fullPage: true });

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
})();
