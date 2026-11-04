// Browser checks for the repertoire gap finder (Dashboard card). Needs a server with an EMPTY
// database, started with LICHESS_TOKEN=lip_e2e and LICHESS_EXPLORER_URL pointing at the fake
// explorer (tests/e2e/fake_explorer.py, which knows a few Caro-Kann positions):
//   python tests/e2e/fake_explorer.py 8099 &
//   LICHESS_TOKEN=lip_e2e LICHESS_EXPLORER_URL=http://127.0.0.1:8099 uvicorn app.main:app --port 8010
//   MPCT_URL=http://localhost:8010/ node tests/e2e/gaps.e2e.cjs
const { chromium, devices } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 400) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);
const FAKE = process.env.MPCT_FAKE_EXPLORER || 'http://127.0.0.1:8099';
const fakeLog = () => fetch(`${FAKE}/log`).then((r) => r.json()); // lookups the fake explorer has answered
const rows = (p) => p.$$eval('#gaps-list .pp-path', (els) => els.map((e) => e.textContent));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const ids = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const caro = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro-Kann', color: 'black' });
    const exch = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro Exchange', color: 'black' });
    await post(`/api/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'] });
    await post(`/api/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'] });
    await post(`/api/openings/${exch.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4d5', 'c6d5'] });
    return { caro: caro.id, exch: exch.id };
  });
  await page.reload();
  await settle(page, 600);
  await page.selectOption('#opening-select', String(ids.caro));
  await settle(page, 300);
  await page.click('#view-dashboard');
  await settle(page, 800);

  // ---- before checking ------------------------------------------------------------------
  check(await page.isVisible('.gaps-card'), 'Repertoire gaps card on the Dashboard');
  check((await text(page, '#gaps-status')).startsWith('Not checked yet: 3 positions'), 'status: ' + (await text(page, '#gaps-status')));
  check(await page.isEnabled('#gaps-check') && (await text(page, '#gaps-check')) === 'Check with Lichess masters', 'Check button ready');
  check((await page.inputValue('#gaps-min')) === '5', 'default threshold 5%');
  check((await rows(page)).length === 0 && (await page.isHidden('#gaps-empty')), 'no list yet');

  // ---- check -------------------------------------------------------------------------------
  await page.click('#gaps-check');
  await settle(page, 300);
  check(await page.isVisible('#gaps-progress') && (await page.isVisible('#gaps-stop')), 'progress bar and Stop while checking');
  await page.waitForFunction(() => document.getElementById('gaps-list').children.length > 0, null, { timeout: 15000 });
  await settle(page, 300);
  const r5 = await rows(page);
  check(r5.join(' | ') === '1.e4 c6 2.Nc3 | 1.e4 c6 2.d4 d5 3.Nd2 | 1.e4 c6 2.Nf3', 'gaps, most often met first: ' + r5.join(' | '));
  const first = await page.$eval('#gaps-list li', (li) => li.textContent);
  check(first.includes('10% of masters games here (100 of 1,000)') && first.includes('about 5 of every 100 games'), 'facts: ' + first);
  check(first.includes('Your repertoire: d4'), 'shows what the repertoire plays there');
  const nd2 = await page.$eval('#gaps-list li:nth-child(2)', (li) => li.textContent);
  check(nd2.includes('Your repertoire: Nc3, e5, exd5'), '3.exd5 counts as covered by the other Black opening: ' + nd2);
  check((await text(page, '#gaps-status')) === 'All 3 positions checked against masters games.', 'status: all checked');
  check((await text(page, '#gaps-check')) === 'Check again' && (await page.isHidden('#gaps-progress')), 'Check again offered, progress gone');
  const log = await fakeLog();
  check(log.length === 3, 'three lookups made: ' + log.length);

  // threshold
  await page.selectOption('#gaps-min', '2');
  await settle(page, 500);
  check((await rows(page)).length === 4 && (await rows(page)).some((r) => r.endsWith('2.c4')), '2%: 2.c4 (4%) added');
  await page.selectOption('#gaps-min', '10');
  await settle(page, 500);
  check((await rows(page)).join() === '1.e4 c6 2.Nc3', '10%: only 2.Nc3');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/gaps-card.png`, fullPage: true });

  // check again: nothing asked twice
  await page.click('#gaps-check');
  await settle(page, 2500);
  check((await fakeLog()).length === 3, 'Check again: cached, no new lookups');

  // Show → board with the reply played
  await page.selectOption('#gaps-min', '5');
  await settle(page, 500);
  await page.click('#gaps-list li:nth-child(2) button:text("Show")');
  await settle(page, 600);
  const sans = await page.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '));
  check(sans === 'e4 c6 d4 d5 Nd2' && (await page.isVisible('main.layout')), 'Show: board with 1.e4 c6 2.d4 d5 3.Nd2: ' + sans);
  check(await page.isEnabled('#line-add'), 'Add line available to cover it');

  // ---- without a token (status faked) -------------------------------------------------------
  await page.route('**/api/explorer/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ running: false, opening_id: null, total: 0, done: 0, error: null, token: false }) }),
  );
  await page.click('#view-dashboard');
  await settle(page, 800);
  check(await page.isDisabled('#gaps-check'), 'no token: Check disabled');
  check((await text(page, '#gaps-error')).includes('LICHESS_TOKEN'), 'no token: says how to add one');
  await page.unroute('**/api/explorer/status');

  // ---- phone --------------------------------------------------------------------------------
  const phone = await browser.newPage({ ...devices['Pixel 7'] });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(URL);
  await settle(phone, 600);
  await phone.evaluate((id) => localStorage.setItem('mpct.openingId', JSON.stringify(id)), ids.caro);
  await phone.reload();
  await settle(phone, 600);
  await phone.click('#view-dashboard');
  await settle(phone, 900);
  const fit = await phone.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    rows: document.querySelectorAll('#gaps-list li').length,
  }));
  check(!fit.overflow && fit.rows === 3, 'phone: card fits, gaps listed ' + JSON.stringify(fit));
  if (SHOTS) {
    await phone.locator('.gaps-card').scrollIntoViewIfNeeded();
    await phone.screenshot({ path: `${SHOTS}/gaps-phone.png` });
  }

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
