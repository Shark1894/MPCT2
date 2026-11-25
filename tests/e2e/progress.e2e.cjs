// Browser checks for the dashboard's Progress tab: lines by branch, streak rows that list
// their lines, the overview's whole-repertoire row and branches, and early reviews.
// Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ MPCT_DB=postgresql://postgres@localhost:5432/mpct_e2e node tests/e2e/progress.e2e.cjs
// (MPCT_DB: the server's database, to make lines due between seeded reviews; see db.cjs)
const { makeDue } = require('./db.cjs');
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

const CARO = [
  ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'], // Advance
  ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'], // Classical
  ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4d5', 'c6d5'], // Exchange
  ['e2e4', 'c7c6', 'c2c4', 'd7d5'], // no branch
];
const MAIN_FEN = 'rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3';
const ADV_FEN = 'rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3';

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

async function seed(page) {
  const s = await page.evaluate(
    async ({ CARO, MAIN_FEN, ADV_FEN }) => {
      const post = (url, body) =>
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      const rep = await post('/api/repertoires', { name: 'Main' });
      const caro = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro-Kann', color: 'black' });
      const london = await post(`/api/repertoires/${rep.id}/openings`, { name: 'London', color: 'white' });
      await post(`/api/openings/${london.id}/lines`, { moves: ['d2d4', 'd7d5', 'c1f4'] });
      const ids = [];
      for (const m of CARO) ids.push((await post(`/api/openings/${caro.id}/lines`, { moves: m })).line_id);
      const main = await post(`/api/openings/${caro.id}/tags`, { name: 'Main line', fen: MAIN_FEN });
      const adv = await post(`/api/openings/${caro.id}/tags`, { name: 'Advance', fen: ADV_FEN });
      return { rep: rep.id, caro: caro.id, ids, main: main.id, adv: adv.id };
    },
    { CARO, MAIN_FEN, ADV_FEN },
  );
  const clean = (id, moves) =>
    page.evaluate(
      async ({ id, moves }) => {
        const attempts = [];
        for (let p = 2; p <= moves.length; p += 2) attempts.push({ ply: p, uci: moves[p - 1] });
        await fetch(`/api/lines/${id}/reviews`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attempts }) });
      },
      { id, moves },
    );
  // Advance: 3 clean (streak 3, due in 7 days). Classical: 1 clean (due tomorrow). Others new.
  for (let i = 0; i < 3; i++) {
    makeDue([s.ids[0]]);
    await clean(s.ids[0], CARO[0]);
  }
  await clean(s.ids[1], CARO[1]);
  return s;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const s = await seed(page);
  await page.reload();
  await settle(page, 800);
  await page.selectOption('#opening-select', { label: 'Caro-Kann' });
  await settle(page);
  await page.click('#view-dashboard');
  await settle(page, 900);
  await page.click('#dash-tab-progress');
  await settle(page, 300);

  // ---- by branch -------------------------------------------------------------------
  const branches = await page.$$eval('#dash-branches .br-row', (rs) =>
    rs.map((r) => `${r.querySelector('.br-name').textContent}|${r.querySelector('.br-count').textContent}|${r.querySelector('.br-due').textContent}`),
  );
  check(branches.join(' ; ') === 'Main line|3|1 due ; Advance|1| ; No branch|1|1 due', 'branch rows, nested, untagged last: ' + branches.join(' ; '));
  check((await page.$eval('#dash-branches .br-row:nth-child(2) .br-name', (e) => e.classList.contains('sub'))), 'Advance indented under Main line');
  check((await page.$$('#dash-branches .br-row:first-child .seg')).length === 3, 'Main line bar: new, learning and known segments');
  const widths = await page.$$eval('#dash-branches .mastery', (els) => els.map((e) => e.getBoundingClientRect().width));
  check(widths[0] > widths[1] * 2, 'bar length follows the number of lines: ' + widths.map(Math.round));
  check((await page.$('#dash-branches div.br-row.other')) !== null, '"No branch" row is not a button');

  await page.click('#dash-branches .br-row:has-text("Advance")');
  await settle(page, 900);
  check((await text(page, '#stat-lines')) === '1' && (await page.inputValue('#dash-tag')) === String(s.adv), 'tapping a branch filters the dashboard to it');
  check((await page.getAttribute('#dash-branches .br-row:has-text("Advance")', 'aria-pressed')) === 'true', 'picked branch highlighted');
  await page.click('#dash-branches .br-row:has-text("Advance")');
  await settle(page, 900);
  check((await text(page, '#stat-lines')) === '4' && (await page.inputValue('#dash-tag')) === '', 'tapping it again shows all lines');

  // ---- streak rows list their lines ----------------------------------------------------
  const row3 = '#dash-streaks .sb-row[data-key="3"]';
  check((await page.isHidden('#sb-lines-3')) && (await page.getAttribute(`${row3} .sb-label`, 'aria-expanded')) === 'false', 'streak rows start closed');
  await page.click(`${row3} .sb-label`);
  await settle(page, 200);
  const items = await page.$$eval('#sb-lines-3 .sb-line', (els) => els.map((e) => e.textContent));
  check(items.length === 1 && items[0].includes('1.e4 c6 2.d4 d5 3.e5 Bf5') && items[0].includes('Advance') && items[0].includes('In 7 days'), '3× row lists its line, branch and next review: ' + items);
  const newItems = await page.$$eval('#dash-streaks .sb-row[data-key="new"] + .sb-lines .sb-line', (els) => els.length);
  check(newItems === 2, 'new row holds two lines');
  check((await page.$('#dash-streaks .sb-row.zero button.sb-label')) === null, 'empty rows have nothing to open');
  await page.selectOption('#dash-tag', String(s.adv)); // redraws the dashboard
  await settle(page, 900);
  await page.selectOption('#dash-tag', '');
  await settle(page, 900);
  check(await page.isVisible('#sb-lines-3'), 'an open row stays open when the dashboard redraws');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/progress-desktop.png`, fullPage: true });
  await page.click('#sb-lines-3 .sb-line');
  await settle(page, 700);
  check((await page.isVisible('main.layout')) && (await page.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '))) === 'e4 c6 d4 d5 e5 Bf5', 'tapping a listed line shows it on the board');

  // ---- early review: training a line before it's due doesn't move it up ----------------
  await page.click('#view-dashboard');
  await settle(page, 800);
  await page.click(`${row3} .sb-train`);
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  for (const uci of ['c7c6', 'd7d5', 'c8f5']) {
    await waitUserTurn(page);
    await move(page, uci);
  }
  await page.waitForSelector('#train-end:not([hidden])', { timeout: 5000 });
  await page.waitForFunction(() => /Early review|Streak|Not saved/.test(document.querySelector('.train-result')?.textContent ?? ''), null, { timeout: 5000 });
  const result = await page.textContent('.train-result');
  check(/Early review \(not due yet\): streak stays at 3, next review in 7 days/.test(result), 'end card says the early review left the schedule alone: ' + result);
  await page.click('#train-stop');
  await settle(page);
  const after = await page.evaluate(async (id) => {
    const d = await fetch(`/api/openings/${(mpct.repertoire._opening()).id}/dashboard`).then((r) => r.json());
    return d.lines.find((l) => l.id === id);
  }, s.ids[0]);
  check(after.streak === 3 && after.reviews === 4 && after.correct === 4, 'streak still 3, the review counted: ' + JSON.stringify({ streak: after.streak, reviews: after.reviews }));

  // ---- overview: whole repertoire + branches per opening ----------------------------
  await page.click('#view-dashboard');
  await settle(page, 800);
  await page.click('#dash-tab-overview');
  await settle(page, 300);
  const total = await text(page, '.ov-total');
  check(total.startsWith('All openings') && total.includes('5 lines') && total.includes('3 due') && total.includes('100%'), 'whole-repertoire row: ' + total);
  check((await page.$$('.ov-expand')).length === 1, 'only the opening with branches can expand');
  const caroBox = `#ov-branches-${s.caro}`;
  check(await page.isHidden(caroBox), 'branches start hidden');
  await page.click('.ov-expand');
  await settle(page, 200);
  check((await page.$$eval(`${caroBox} .br-name`, (els) => els.map((e) => e.textContent))).join() === 'Main line,Advance,No branch', 'opening expands to its branches');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/overview-branches.png`, fullPage: true });
  await page.click(`${caroBox} .br-row:has-text("Main line")`);
  await settle(page, 1200);
  check(
    (await page.getAttribute('#dash-tab-progress', 'aria-selected')) === 'true' && (await page.inputValue('#dash-tag')) === String(s.main) && (await text(page, '#stat-lines')) === '3',
    'tapping a branch in the overview opens Progress filtered to it',
  );

  // ---- phone layout ------------------------------------------------------------------
  const phone = await browser.newPage({ ...devices['Pixel 7'] });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(URL);
  await settle(phone, 900);
  await phone.click('#view-dashboard');
  await settle(phone, 900);
  await phone.click('#dash-tab-progress');
  await settle(phone, 300);
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow on Progress');
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/progress-phone.png`, fullPage: true });
  await phone.click('#dash-tab-overview');
  await settle(phone, 300);
  await phone.click('.ov-expand');
  await settle(phone, 200);
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow on Overview');
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/overview-phone.png`, fullPage: true });

  check(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await browser.close();
})();
