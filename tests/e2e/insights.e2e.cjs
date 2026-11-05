// Browser checks for the dashboard insights. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/insights.e2e.cjs
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
const lineIds = (p) => p.$$eval('#dash-lines .dash-line', (els) => els.map((e) => Number(e.dataset.lineId)));

const CARO = [
  ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'],
  ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'],
  ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4d5', 'c6d5'],
  ['e2e4', 'c7c6', 'c2c4', 'd7d5'],
];

async function seed(page) {
  return page.evaluate(async (CARO) => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const caro = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro-Kann', color: 'black' });
    const london = await post(`/api/repertoires/${rep.id}/openings`, { name: 'London', color: 'white' });
    await post(`/api/openings/${london.id}/lines`, { moves: ['d2d4', 'd7d5', 'c1f4'] });
    const ids = [];
    for (const m of CARO) ids.push((await post(`/api/openings/${caro.id}/lines`, { moves: m })).line_id);
    const review = (id, moves, wrong = {}) => {
      const attempts = [];
      for (let p = 2; p <= moves.length; p += 2) {
        if (wrong[p]) attempts.push({ ply: p, uci: wrong[p] });
        attempts.push({ ply: p, uci: moves[p - 1] });
      }
      return post(`/api/lines/${id}/reviews`, { attempts });
    };
    // Advance: 5 clean reviews -> mastered. Classical: 2 clean -> known.
    for (let i = 0; i < 5; i++) await review(ids[0], CARO[0]);
    await review(ids[1], CARO[1]);
    await review(ids[1], CARO[1]);
    // Exchange: 3...cxd5 wrong twice (Qxd5), 2...c6 wrong once (e5). Panov line: 2...c6 wrong (e5).
    await review(ids[2], CARO[2], { 6: 'd8d5' });
    await review(ids[2], CARO[2], { 6: 'd8d5', 2: 'e7e5' });
    await review(ids[3], CARO[3], { 2: 'e7e5' });
    return { rep: rep.id, caro: caro.id, london: london.id, ids };
  }, CARO);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const { ids } = await seed(page);
  await page.reload();
  await settle(page, 800);
  await page.selectOption('#opening-select', { label: 'Caro-Kann' });
  await settle(page);
  await page.click('#view-dashboard');
  await settle(page, 900);

  // ---- sub-tabs -------------------------------------------------------------------
  const selected = () => page.$$eval('.dash-tab', (els) => els.filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.textContent));
  check(JSON.stringify(await page.$$eval('.dash-tab', (els) => els.map((e) => e.textContent))) === '["Lines","Progress","Gaps","Overview"]', 'four sub-tabs');
  check(JSON.stringify(await selected()) === '["Lines"]' && (await page.isVisible('#dash-lines')) && (await page.isHidden('#fc-chart')) && (await page.isHidden('.gaps-card')) && (await page.isHidden('#ov-list')), 'Lines tab first, others hidden');
  check((await page.isVisible('#dash-train-due')) && (await page.isVisible('#stat-lines')), 'picker, Train buttons and stats above the tabs');
  await page.click('#dash-tab-overview');
  await settle(page, 200);
  check(JSON.stringify(await selected()) === '["Overview"]' && (await page.isVisible('#ov-list')) && (await page.isHidden('#dash-lines')), 'Overview tab shows openings + activity');

  // ---- overview -------------------------------------------------------------------
  const ov = await page.$$eval('.ov-row', (rows) => rows.map((r) => r.textContent));
  check(ov.length === 2 && ov[0].startsWith('London') && ov[1].startsWith('Caro-Kann'), 'overview lists openings, White first: ' + ov);
  check(ov[1].includes('4 lines') && ov[1].includes('2 due') && ov[1].includes('70%'), 'Caro row: lines, due, accuracy: ' + ov[1]);
  check((await page.getAttribute('.ov-row:nth-child(2)', 'aria-pressed')) === 'true', 'selected opening highlighted');
  check((await text(page, '#ov-rep')) === '· Main', 'repertoire named');

  // ---- learning progress -------------------------------------------------------------
  await page.click('#dash-tab-progress');
  await settle(page, 200);
  check((await text(page, '#dash-mastery .mastery-text')) === '1 mastered · 1 known · 2 learning', 'progress: ' + (await text(page, '#dash-mastery .mastery-text')));
  check((await page.$$('#dash-mastery .seg')).length === 3, 'three stage segments');
  await page.hover('#dash-mastery .seg.m-mastered');
  await settle(page, 200);
  check((await text(page, '.tip')) === 'Mastered: 1 line (25%)' && (await page.isVisible('.tip')), 'hover tooltip on a segment');

  // ---- forecast -----------------------------------------------------------------------
  check((await page.$$('.fc-col')).length === 14, '14 forecast days');
  check((await text(page, '.fc-col:first-child .fc-value')) === '2' && (await page.$('.fc-col:first-child .fc-tick.today')) !== null, 'today: 2 due, tick highlighted');
  check((await page.getAttribute('.fc-col:first-child', 'data-tip')).startsWith('Today:'), 'today tooltip');
  const ticks = await page.$$eval('.fc-tick', (els) => els.map((e) => e.textContent));
  const want = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(d); });
  check(ticks.join('') === want.join(''), 'every day has its letter: ' + ticks.join(' '));
  const tip = await page.getAttribute('.fc-col:nth-child(4)', 'data-tip');
  check(/: 1 line$/.test(tip), 'classical line due in 3 days: ' + tip);
  // Every day's baseline must line up.
  const baselines = await page.$$eval('.fc-plot', (els) => els.map((e) => Math.round(e.getBoundingClientRect().bottom)));
  check(new Set(baselines).size === 1, 'forecast baselines level: ' + baselines.join(','));
  check((await text(page, '#fc-note')) === '3 lines in the next 14 days, 1 later.', 'forecast note: ' + (await text(page, '#fc-note')));

  // ---- problem positions card removed (v0.25.3) ------------------------------------------
  check((await page.$$('#pp-list, .pp-item')).length === 0 && !(await page.isVisible('text=Problem positions')), 'no problem positions card');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dash-insights.png`, fullPage: true });

  // ---- activity ------------------------------------------------------------------------
  await page.click('#dash-tab-overview');
  await settle(page, 200);
  check((await page.$$('.act-week')).length >= 26, 'activity grid: 26+ weeks');
  check((await page.$$('.cell.today.l3')).length === 1, 'today shaded for 11 reviews');
  check((await text(page, '#act-summary')).startsWith('Current run: 1 day. Longest: 1 day. 1 day trained.'), 'activity summary: ' + (await text(page, '#act-summary')));

  // ---- line list: sort, filter, search -------------------------------------------------
  await page.click('#dash-tab-lines');
  await settle(page, 200);
  check((await text(page, '#dash-train-weak')) === 'Train weakest (2)', 'Train weakest counts lines with recent mistakes');
  await page.selectOption('#dash-sort', 'weak');
  await settle(page, 200);
  check(JSON.stringify((await lineIds(page)).slice(0, 2)) === JSON.stringify([ids[2], ids[3]]), 'weakest first');
  await page.selectOption('#dash-filter', 'mistakes');
  await settle(page, 200);
  check((await lineIds(page)).length === 2 && (await text(page, '#dash-showing')) === 'Showing 2 of 4 lines', 'filter: recent mistakes');
  await page.selectOption('#dash-filter', 'all');
  await page.fill('#dash-search', 'Bf5');
  await settle(page, 200);
  check(JSON.stringify(await lineIds(page)) === JSON.stringify([ids[0]]), 'search by move');
  await page.fill('#dash-search', 'zz');
  await settle(page, 200);
  check((await text(page, '#dash-empty')).includes('No lines match'), 'no matches explained');
  await page.fill('#dash-search', '');
  await page.reload();
  await settle(page, 1000);
  check((await page.inputValue('#dash-sort')) === 'weak', 'sort choice remembered');
  await page.click('#dash-tab-overview');
  await page.reload();
  await settle(page, 1000);
  check(JSON.stringify(await selected()) === '["Overview"]', 'sub-tab remembered after reload');

  // ---- overview switches opening ----------------------------------------------------------
  await page.click('.ov-row:has-text("London")');
  await settle(page, 800);
  check((await page.inputValue('#dash-opening')) === (await page.evaluate(() => String(mpct.repertoire._opening().id))) && (await text(page, '#dash-color')) === 'You play White', 'clicking an overview row selects that opening');
  await page.click('.ov-row:has-text("Caro-Kann")');
  await settle(page, 800);

  await page.click('#dash-train-weak');
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  check((await text(page, '#train-title')) === 'Training: Caro-Kann › weakest lines' && (await text(page, '#train-progress')).endsWith('of 2'), 'Train weakest: 2 lines');
  check((await page.evaluate(() => mpct.trainer.session.line.id)) === ids[2], 'weakest line first');
  await page.click('#train-stop');
  await settle(page);

  // ---- phone ----------------------------------------------------------------------------------
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await ctx.newPage();
  mp.on('pageerror', (e) => errors.push('phone: ' + e));
  await mp.goto(URL);
  await settle(mp, 700);
  await mp.click('#view-dashboard');
  await settle(mp, 1000);
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow');
  const scrolled = await mp.evaluate(() => {
    const s = document.querySelector('.act-scroll');
    return s.scrollWidth <= s.clientWidth || s.scrollLeft > 0;
  });
  check(scrolled, 'phone: activity shows the latest weeks');
  if (SHOTS) await mp.screenshot({ path: `${SHOTS}/dash-insights-phone.png`, fullPage: true });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
