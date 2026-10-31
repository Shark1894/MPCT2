// Browser checks for branch tags. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/tags.e2e.cjs
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
const chips = (p) => p.$$eval('#branch-path .branch-chip', (els) => els.map((e) => e.textContent + (e.classList.contains('here') ? '*' : '')));
const playSans = (p, sans) => p.evaluate((list) => list.forEach((s) => mpct.game.playSan(s)), sans);
const goTo = async (p, sans) => {
  await p.evaluate(() => document.getElementById('btn-new').click());
  await playSans(p, sans);
  await p.evaluate(() => mpct.render());
  await settle(p, 400);
};

async function dialog(p, name) {
  await p.waitForSelector('dialog[open]');
  if (name !== undefined) await p.fill('dialog input[name=name]', name);
  await p.click('dialog button[type=submit]');
  await settle(p, 600);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  // Deliberate invalid tag requests below make the browser log 4xx responses
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const o = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Queen’s Gambit', color: 'black' });
    for (const moves of [
      ['d2d4', 'd7d5', 'c2c4', 'd5c4', 'e2e4', 'e7e5'],
      ['d2d4', 'd7d5', 'c2c4', 'd5c4', 'e2e3', 'g8f6'],
      ['d2d4', 'd7d5', 'c2c4', 'd5c4', 'g1f3', 'g8f6'],
      ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6'],
    ])
      await post(`/api/openings/${o.id}/lines`, { moves });
  });
  await page.reload();
  await settle(page, 800);

  check(await page.isHidden('#train-tag-box'), 'no Lines filter while the opening has no tags');
  check(await page.isDisabled('#tag-add'), 'cannot tag the starting position');
  check((await text(page, '#branch-path')).includes('No branch tags'), 'empty branches message');

  // ---- tag the QGA position ----------------------------------------------
  await goTo(page, ['d4', 'd5', 'c4', 'dxc4']);
  await page.click('#tag-add');
  await dialog(page, 'Queen’s Gambit Accepted');
  check((await text(page, '#toast')).includes('3 lines'), 'tag created, covering 3 lines');
  check(JSON.stringify(await chips(page)) === '["Queen’s Gambit Accepted*"]', 'chip shown for the current position');
  check(await page.isVisible('#tag-rename') && (await page.isHidden('#tag-add')), 'rename/remove offered at a tagged position');

  // ---- nested tag ------------------------------------------------------------
  await goTo(page, ['d4', 'd5', 'c4', 'dxc4', 'e4']);
  check(JSON.stringify(await chips(page)) === '["Queen’s Gambit Accepted"]', 'parent branch shown along the path');
  await page.click('#tag-add');
  await dialog(page, 'QGA 3.e4');
  check(JSON.stringify(await chips(page)) === '["Queen’s Gambit Accepted","QGA 3.e4*"]', 'nested branches shown as a path');
  await page.click('#branch-path .branch-chip >> nth=0');
  await settle(page);
  check((await page.evaluate(() => mpct.game.ply)) === 4, 'clicking a branch chip jumps to that position');

  // ---- invalid tags ------------------------------------------------------------
  await goTo(page, ['d4', 'd5', 'h3']);
  await page.click('#tag-add');
  await dialog(page, 'Nonsense');
  check((await text(page, '#toast')).includes('No line in this opening'), 'tagging a position outside the lines is refused');
  await goTo(page, ['d4', 'd5', 'c4', 'dxc4', 'e4']);
  check(await page.isHidden('#tag-add'), 'already-tagged position can’t be tagged twice');

  // ---- training filter ----------------------------------------------------------
  check(await page.isVisible('#train-tag-box'), 'Lines filter appears once tags exist');
  const options = await page.$$eval('#train-tag option', (os) => os.map((o) => o.textContent));
  check(JSON.stringify(options) === '["All lines","Queen’s Gambit Accepted (3)","QGA 3.e4 (1)"]', 'filter options: ' + options);
  check((await text(page, '#train-due')) === 'Train due (4)', 'all lines: 4 due');
  await page.selectOption('#train-tag', { label: 'Queen’s Gambit Accepted (3)' });
  check((await text(page, '#train-due')) === 'Train due (3)', 'branch filter: 3 due');
  await page.click('#train-due');
  await page.waitForFunction(() => mpct.trainer.active && mpct.trainer.canMove(), null, { timeout: 5000 });
  check((await text(page, '#train-progress')) === 'Line 1 of 3', 'training only the branch’s lines');
  check((await text(page, '#train-title')).includes('› Queen’s Gambit Accepted'), 'training title names the branch');
  await page.click('#train-stop');
  await settle(page);
  await page.selectOption('#train-tag', { label: 'QGA 3.e4 (1)' });
  check((await text(page, '#train-due')) === 'Train due (1)', 'nested branch filter: 1 due');

  // ---- dashboard -----------------------------------------------------------------
  await page.click('#view-dashboard');
  await settle(page, 700);
  check((await page.$eval('#dash-tag option:checked', (o) => o.textContent)) === 'QGA 3.e4', 'dashboard keeps the branch filter');
  check((await text(page, '#stat-lines')) === '1', 'dashboard stats for the branch only');
  await page.selectOption('#dash-tag', { label: 'All lines' });
  await settle(page, 700);
  check((await text(page, '#stat-lines')) === '4', 'all lines again');
  const e4Row = page.locator('.dash-line', { hasText: '3.e4 e5' });
  const rowTags = await e4Row.locator('.line-tag').allTextContents();
  check(JSON.stringify(rowTags) === '["Queen’s Gambit Accepted","QGA 3.e4"]', 'line shows its branch tags: ' + rowTags);
  check((await page.locator('.dash-line', { hasText: '2...e6' }).locator('.line-tag').count()) === 0, 'line outside the branches has no tags');
  await page.selectOption('#dash-tag', { label: 'Queen’s Gambit Accepted' });
  await settle(page, 700);
  check((await text(page, '#train-tag option:checked')) === 'Queen’s Gambit Accepted (3)', 'board filter follows the dashboard filter');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tags-dashboard.png` });
  await page.click('#dash-train-all');
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  await settle(page);
  check((await text(page, '#train-progress')) === 'Line 1 of 3', 'dashboard Train all respects the branch');
  await page.click('#train-stop');
  await settle(page);

  // ---- rename and remove ---------------------------------------------------------------
  await goTo(page, ['d4', 'd5', 'c4', 'dxc4', 'e4']);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tags-board.png` });
  await page.click('#tag-rename');
  await dialog(page, 'QGA Central');
  check(JSON.stringify(await chips(page)) === '["Queen’s Gambit Accepted","QGA Central*"]', 'tag renamed');
  await page.click('#tag-delete');
  await dialog(page);
  check(JSON.stringify(await chips(page)) === '["Queen’s Gambit Accepted"]', 'tag removed');
  check((await page.$$eval('#train-tag option', (os) => os.length)) === 2, 'filter updated after removal');
  check((await page.evaluate(() => fetch('/api/openings/1/lines').then((r) => r.json()))).length === 4, 'removing a tag keeps the lines');

  // ---- phone ----------------------------------------------------------------------------
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await ctx.newPage();
  mp.on('pageerror', (e) => errors.push('phone: ' + e));
  await mp.goto(URL);
  await settle(mp, 700);
  await goTo(mp, ['d4', 'd5', 'c4', 'dxc4', 'Nf3']);
  check(JSON.stringify(await chips(mp)) === '["Queen’s Gambit Accepted"]', 'phone: branch chip shown');
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow');
  if (SHOTS) await mp.screenshot({ path: `${SHOTS}/tags-phone.png`, fullPage: true });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
