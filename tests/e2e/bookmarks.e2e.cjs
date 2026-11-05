// Browser checks for bookmarked lines. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/bookmarks.e2e.cjs
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
const row = (id) => `#dash-lines .dash-line[data-line-id="${id}"]`;
const shownIds = (p) => p.$$eval('#dash-lines .dash-line', (els) => els.map((e) => Number(e.dataset.lineId)));
const pressed = async (p, sel) => (await p.getAttribute(sel, 'aria-pressed')) === 'true';
const lineApi = (p, openingId) =>
  p.evaluate(async (id) => (await fetch(`/api/openings/${id}/dashboard`).then((r) => r.json())).lines, openingId);
const waitUserTurn = (page) => page.waitForFunction(() => mpct.trainer.canMove(), null, { timeout: 5000 });

const LINES = [
  ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'],
  ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'],
  ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4'],
];

async function seed(page) {
  return page.evaluate(async (LINES) => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const o = await post(`/api/repertoires/${rep.id}/openings`, { name: '1.e4 e5', color: 'white' });
    const ids = [];
    for (const m of LINES) ids.push((await post(`/api/openings/${o.id}/lines`, { moves: m })).line_id);
    return { opening: o.id, ids };
  }, LINES);
}

async function setFilter(page, value) {
  await page.selectOption('#dash-filter', value);
  await settle(page, 200);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const { opening, ids } = await seed(page);
  const [ruy, italian, scotch] = ids;
  await page.reload();
  await settle(page, 800);
  await page.click('#view-dashboard');
  await page.click('#dash-tab-lines'); // Dashboard opens on Overview
  await settle(page, 900);

  // ---- nothing bookmarked yet --------------------------------------------------------
  check((await page.$$(`#dash-lines button.star[aria-pressed="false"]`)).length === 3, 'every line has an empty star');
  check((await page.$$('#dash-lines .line-note')).length === 0, 'no notes shown');
  check(await page.isHidden('#dash-train-shown'), 'Train shown hidden while the list shows everything');
  await setFilter(page, 'bookmarked');
  check((await shownIds(page)).length === 0, 'Bookmarked filter: empty');
  check((await text(page, '#dash-empty')).includes('No bookmarked lines'), 'empty message explains bookmarks');
  check(await page.isHidden('#dash-train-shown'), 'nothing to train');
  await setFilter(page, 'all');

  // ---- bookmark from the dashboard, add a note --------------------------------------------
  await page.click(`${row(italian)} button.star`);
  await settle(page, 400);
  check(await pressed(page, `${row(italian)} button.star`), 'star pressed after a tap');
  check((await text(page, `${row(italian)} button.star`)) === '★', 'filled star');
  check((await text(page, `${row(italian)} .line-note`)) === 'Add a note', 'bookmarked line offers a note');
  check((await page.$$('#dash-lines .line-note')).length === 1, 'only the bookmarked line shows a note button');
  let api = await lineApi(page, opening);
  check(api.find((l) => l.id === italian).bookmarked === true, 'saved on the server');

  await page.click(`${row(italian)} .line-note`);
  await page.waitForSelector('dialog.modal[open]');
  check((await text(page, 'dialog.modal .modal-message')) === '1.e4 e5 2.Nf3 Nc6 3.Bc4', 'note dialog names the line');
  await page.fill('dialog.modal input[name="note"]', 'Show Sam the Fried Liver trap');
  await page.click('dialog.modal button[type="submit"]');
  await settle(page, 400);
  check((await text(page, `${row(italian)} .line-note`)) === 'Show Sam the Fried Liver trap', 'note shown under the moves');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bm-dashboard.png` });

  await page.click(`${row(scotch)} button.star`);
  await settle(page, 400);
  await page.reload();
  await settle(page, 800);
  await page.click('#view-dashboard');
  await settle(page, 900);
  check(await pressed(page, `${row(italian)} button.star`) && (await pressed(page, `${row(scotch)} button.star`)), 'bookmarks survive a reload');
  check(!(await pressed(page, `${row(ruy)} button.star`)), 'other line untouched');
  check((await text(page, `${row(italian)} .line-note`)) === 'Show Sam the Fried Liver trap', 'note survives a reload');

  // ---- filter + Train bookmarked ----------------------------------------------------------
  await setFilter(page, 'bookmarked');
  check(JSON.stringify((await shownIds(page)).sort()) === JSON.stringify([italian, scotch].sort()), 'Bookmarked filter shows the two');
  check(await page.isVisible('#dash-train-shown'), 'Train bookmarked offered');
  check((await text(page, '#dash-train-shown')) === 'Train bookmarked (2)', 'label: ' + (await text(page, '#dash-train-shown')));
  await page.fill('#dash-search', 'Bc4');
  await settle(page, 200);
  check((await text(page, '#dash-train-shown')) === 'Train shown (1)', 'with a search it trains what is shown');
  await page.fill('#dash-search', '');
  await settle(page, 200);

  await page.click('#dash-train-shown');
  await waitUserTurn(page);
  check((await text(page, '#train-title')).endsWith('› bookmarked lines'), 'training title: ' + (await text(page, '#train-title')));
  check((await text(page, '#train-progress')) === 'Line 1 of 2', 'trains the two bookmarked lines');
  check(await page.isVisible('#train-bookmark') && (await pressed(page, '#train-bookmark')), 'training star shows the line is bookmarked');

  // Remove a bookmark that has a note while training: asks first.
  const current = await page.evaluate(() => mpct.trainer.session.line.id);
  await page.click('#train-bookmark');
  if (current === italian) {
    await page.waitForSelector('dialog.modal[open]');
    check((await text(page, 'dialog.modal .modal-message')).includes('Fried Liver'), 'removing a noted bookmark asks first');
    await page.click('dialog.modal button[type="submit"]');
  }
  await settle(page, 400);
  check(!(await pressed(page, '#train-bookmark')) && (await text(page, '#train-bookmark')) === '☆', 'unbookmarked from training');
  api = await lineApi(page, opening);
  check(api.find((l) => l.id === current).bookmarked === false, 'removal saved');
  check(await page.evaluate(() => mpct.trainer.canMove()), 'still your move: training not interrupted');

  // Bookmark again with one tap: no dialog.
  await page.click('#train-bookmark');
  await settle(page, 400);
  check(await page.isHidden('dialog.modal[open]'), 'bookmarking during training needs no dialog');
  check(await pressed(page, '#train-bookmark'), 'bookmarked again');
  check((await text(page, '.toast')).includes('Dashboard'), 'toast points to the Dashboard for notes');
  await page.click('#train-stop');
  await settle(page, 300);
  check(await page.isHidden('#train-bookmark'), 'training star hidden after stopping');

  // ---- remove from the dashboard without a note: no dialog -----------------------------------
  await page.click('#view-dashboard');
  await settle(page, 900);
  await setFilter(page, 'all');
  await page.click(`${row(scotch)} button.star`);
  await settle(page, 400);
  check(await page.isHidden('dialog.modal[open]'), 'no confirmation for a bookmark without a note');
  check(!(await pressed(page, `${row(scotch)} button.star`)), 'removed from the dashboard');

  // ---- phone ----------------------------------------------------------------------------------
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(String(e)));
  await pp.goto(URL);
  await settle(pp, 800);
  await pp.click('#view-dashboard');
  await pp.click('#dash-tab-lines'); // Dashboard opens on Overview
  await settle(pp, 900);
  await pp.selectOption('#dash-filter', 'bookmarked');
  await settle(pp, 200);
  check(await pp.isVisible(`${row(current)} button.star`), 'phone: star visible in the row');
  check(await pp.isVisible('#dash-train-shown'), 'phone: Train bookmarked visible');
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, 'phone: no horizontal overflow (' + overflow + ')');
  if (SHOTS) await pp.screenshot({ path: `${SHOTS}/bm-phone-dashboard.png`, fullPage: false });
  await pp.click('#dash-train-shown');
  await pp.waitForFunction(() => mpct.trainer.canMove(), null, { timeout: 5000 });
  check(await pp.isVisible('#train-bookmark'), 'phone: training star visible');
  if (SHOTS) await pp.screenshot({ path: `${SHOTS}/bm-phone-training.png` });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
