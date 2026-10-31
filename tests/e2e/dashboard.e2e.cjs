// Browser checks for the review dashboard. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/dashboard.e2e.cjs
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
const rows = (p) => p.$$eval('#dash-lines .dash-line', (els) => els.map((e) => e.querySelector('.dash-moves').textContent));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());

  // Data: a Black opening with 3 lines and some review history, plus a second opening
  await page.evaluate(async () => {
    const call = (method, url, body) =>
      fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) =>
        r.status === 204 ? null : r.json(),
      );
    const rep = await call('POST', '/api/repertoires', { name: 'Main' });
    const caro = await call('POST', `/api/repertoires/${rep.id}/openings`, { name: 'Caro-Kann', color: 'black' });
    await call('POST', `/api/repertoires/${rep.id}/openings`, { name: 'Dutch', color: 'black' });
    const lines = [
      ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'],
      ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'],
      ['e2e4', 'c7c6', 'g1f3', 'd7d5'],
    ];
    const ids = [];
    for (const m of lines) ids.push((await call('POST', `/api/openings/${caro.id}/lines`, { moves: m })).line_id);
    const black = (m) => m.flatMap((uci, i) => (i % 2 ? [{ ply: i + 1, uci }] : []));
    for (const ok of [true, false, true, true]) {
      const attempts = black(lines[0]);
      if (!ok) attempts.unshift({ ply: 2, uci: 'e7e5' });
      await call('POST', `/api/lines/${ids[0]}/reviews`, { attempts });
    }
    await call('POST', `/api/lines/${ids[1]}/reviews`, { attempts: [{ ply: 2, uci: 'e7e5' }, ...black(lines[1])] });
  });
  await page.reload();
  await settle(page, 700);

  // ---- open the dashboard -------------------------------------------------
  await page.click('#view-dashboard');
  await settle(page);
  check(await page.isHidden('main.layout') && (await page.isVisible('#dashboard')), 'dashboard view replaces the board');
  check((await page.$eval('#dash-opening option:checked', (o) => o.textContent)) === 'Caro-Kann', 'dashboard follows the selected opening');
  check((await text(page, '#dash-color')) === 'You play Black', 'colour shown');
  const stats = await page.$$eval('.stat-value', (els) => els.map((e) => e.textContent));
  check(JSON.stringify(stats) === JSON.stringify(['3', '2', 'Today', '5', '60%']), 'stats: ' + stats);
  check((await text(page, '#dash-train-due')) === 'Train due (2)', 'train due button count');

  const order = await rows(page);
  check(order[order.length - 1] === '1.e4 c6 2.d4 d5 3.e5 Bf5', 'line with longest interval listed last');
  check(order.length === 3, 'three lines listed');
  const adv = page.locator('.dash-line', { hasText: '3.e5 Bf5' });
  check((await adv.locator('.dash-due').textContent()) === 'In 3 days', 'next review shown relative (streak 2 = 3 days): ' + (await adv.locator('.dash-due').textContent()));
  check((await adv.locator('.dash-streak').textContent()) === 'Streak 2', 'streak shown');
  const dots = await adv.locator('.dot').evaluateAll((els) => els.map((e) => e.className.replace('dot ', '')));
  check(JSON.stringify(dots) === '["empty","good","bad","good","good"]', 'last 5 results, oldest first: ' + dots);
  const classic = page.locator('.dash-line', { hasText: '3.Nc3 dxe4' });
  check(await classic.locator('.dash-due.is-due').count() === 1, 'due line highlighted');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/p5-desktop.png`, fullPage: true });

  // ---- show a line on the board ---------------------------------------------
  await adv.locator('button', { hasText: 'Show' }).click();
  await settle(page);
  check(await page.isVisible('main.layout'), 'Show switches to the board');
  check((await page.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '))) === 'e4 c6 d4 d5 e5 Bf5', 'Show plays the line on the board');

  // ---- train a single line from the dashboard --------------------------------
  await page.click('#view-dashboard');
  await settle(page);
  await page.locator('.dash-line', { hasText: '2.Nf3 d5' }).locator('button', { hasText: 'Train' }).click();
  await page.waitForFunction(() => mpct.trainer.active && mpct.trainer.canMove(), null, { timeout: 5000 });
  check((await text(page, '#train-progress')) === 'Line 1 of 1', 'Train on a row trains just that line');
  check(await page.isDisabled('#view-dashboard'), 'dashboard tab disabled while training');
  check(await page.isVisible('#mode-badge'), 'training badge shown');
  await page.click('#train-stop');
  await settle(page);
  check(!(await page.isDisabled('#view-dashboard')) && (await page.isHidden('#mode-badge')), 'stopping re-enables the dashboard');

  // ---- reset and delete a line ----------------------------------------------
  await page.click('#view-dashboard');
  await settle(page);
  await page.locator('.dash-line', { hasText: '3.e5 Bf5' }).locator('button', { hasText: 'Reset' }).click();
  await page.waitForSelector('dialog[open]');
  check((await text(page, 'dialog .modal-message')).includes('1.e4 c6 2.d4 d5 3.e5 Bf5'), 'reset confirmation names the line');
  await page.click('dialog button[type=submit]');
  await settle(page, 700);
  const advAfter = page.locator('.dash-line', { hasText: '3.e5 Bf5' });
  check((await advAfter.locator('.dash-due').textContent()) === 'Today' && (await advAfter.locator('.dot.empty').count()) === 5, 'reset line is due today with no history');
  check((await text(page, '#stat-due')) === '3', 'due count updated after reset');

  await page.locator('.dash-line', { hasText: '2.Nf3 d5' }).locator('button', { hasText: 'Delete' }).click();
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button:text("Cancel")');
  await settle(page);
  check((await rows(page)).length === 3, 'cancelled delete keeps the line');
  await page.locator('.dash-line', { hasText: '2.Nf3 d5' }).locator('button', { hasText: 'Delete' }).click();
  await page.click('dialog button[type=submit]');
  await settle(page, 700);
  check((await rows(page)).length === 2 && (await text(page, '#stat-lines')) === '2', 'line deleted');

  // ---- view persists across reload --------------------------------------------
  await page.reload();
  await settle(page, 900);
  check(await page.isVisible('#dashboard'), 'dashboard view remembered after reload');

  // ---- opening switcher + per-opening actions ------------------------------------
  await page.selectOption('#dash-opening', { label: 'Dutch' });
  await settle(page);
  check((await text(page, '#dash-empty')).includes('No lines yet'), 'empty opening explains how to add lines');
  check(await page.isDisabled('#dash-train-due') && (await page.isDisabled('#dash-train-all')), 'train buttons disabled with no lines');
  await page.selectOption('#dash-opening', { label: 'Caro-Kann' });
  await settle(page);

  await page.click('#dash-menu summary');
  await page.click('#dash-reset-all');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button[type=submit]');
  await settle(page, 700);
  check((await text(page, '#stat-reviews')) === '0' && (await text(page, '#stat-accuracy')) === '—', 'reset all clears history');

  await page.click('#dash-menu summary');
  await page.click('#dash-delete-all');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button[type=submit]');
  await settle(page, 700);
  check((await text(page, '#stat-lines')) === '0', 'delete all lines empties the opening');

  await page.click('#dash-menu summary');
  await page.click('#dash-delete-opening');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button[type=submit]');
  await settle(page, 800);
  const remaining = await page.$$eval('#dash-opening option', (os) => os.map((o) => o.textContent));
  check(JSON.stringify(remaining) === '["Dutch"]', 'opening deleted: ' + remaining);

  // ---- phone ---------------------------------------------------------------
  await page.evaluate(async () => {
    const o = (await fetch('/api/repertoires/1/openings').then((r) => r.json()))[0];
    for (const moves of [['e2e4', 'e7e6'], ['d2d4', 'f7f5', 'c2c4', 'g8f6']]) {
      await fetch(`/api/openings/${o.id}/lines`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moves }) });
    }
  });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await ctx.newPage();
  mp.on('pageerror', (e) => errors.push('phone: ' + e));
  await mp.goto(URL);
  await settle(mp, 700);
  await mp.click('#view-dashboard');
  await settle(mp, 700);
  check((await rows(mp)).length === 2, 'phone: lines listed');
  check(await mp.isHidden('.dash-header'), 'phone: table header hidden (cards)');
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow');
  if (SHOTS) await mp.screenshot({ path: `${SHOTS}/p5-phone.png`, fullPage: true });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
