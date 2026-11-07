// Browser checks for time tracking and the Stats tab:
//   uvicorn app.main:app --port 8010   (EMPTY database)
//   MPCT_URL=http://localhost:8010/ node tests/e2e/stats.e2e.cjs
const { chromium } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const rows = (p) => p.evaluate(() => fetch('/api/time?tz=UTC').then((r) => r.json()));

(async () => {
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.waitForFunction(() => window.mpct?.timeTracking);

  const act = () => page.evaluate(() => mpct.currentActivity());
  check((await act()).activity === 'analysis', 'the board with no opening counts as free analysis');
  await page.click('#view-courses');
  check((await act()) === null, 'the Training hub is not counted');
  await page.click('#view-dashboard');
  check((await act()).activity === 'dashboard', 'the dashboard counts as openings');
  await page.click('#view-board');

  // a few seconds of activity on the board, then hand it to the server
  for (let i = 0; i < 4; i++) {
    await page.mouse.click(1200, 900);
    await page.waitForTimeout(1000);
  }
  await page.evaluate(() => mpct.timeTracking.flush());
  let d = await rows(page);
  const analysis = d.rows.find((r) => r.activity === 'analysis');
  check(analysis && analysis.seconds >= 3 && analysis.category === 'analysis', `free analysis time recorded (${analysis?.seconds}s)`);
  check(Boolean(d.tracking_since), 'tracking has started');

  // switching activity ends the stretch: the dashboard gets its own
  await page.click('#view-dashboard');
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(600 + i * 10, 500);
    await page.keyboard.press('Shift');
    await page.waitForTimeout(1000);
  }
  await page.click('#view-board');
  await page.waitForTimeout(1500);
  d = await rows(page);
  check(d.rows.some((r) => r.activity === 'dashboard' && r.category === 'openings' && r.seconds >= 2), 'the dashboard stretch was sent when it ended');

  // a hidden page isn't counted
  const before = await page.evaluate(() => mpct.timeTracking.tracker.current.seconds);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => mpct.timeTracking.tracker.current.seconds);
  check(after - before < 1.1, `nothing counted while hidden (${(after - before).toFixed(1)}s)`);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  // the Stats tab: some older days and other categories
  await page.evaluate(async () => {
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const post = (b) => fetch('/api/time', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post({ key: 'seed-0001-tactics', category: 'tactics', activity: 'woodpecker', detail: 'The Woodpecker Method', started_at: day(2), seconds: 1800 });
    await post({ key: 'seed-0002-endgames', category: 'endgames', activity: 'endgame-drill', detail: 'lucena', started_at: day(3), seconds: 900 });
    await post({ key: 'seed-0003-openings', category: 'openings', activity: 'opening-training', detail: 'Italian', started_at: day(20), seconds: 3600 });
  });
  await page.click('#view-stats');
  await page.waitForSelector('.st-split');
  check((await page.evaluate(() => mpct.currentActivity())) === null, 'the Stats tab is not counted');
  await page.click('.tr-chip-btn[data-period="week"]');
  const legend = async (cat) => page.textContent(`.st-legend li[data-category="${cat}"] .st-legend-time`);
  check((await legend('tactics')) === '30m' && (await legend('endgames')) === '15m', '7 days: Woodpecker 30m, endgame drills 15m');
  check((await legend('openings')) !== '1h 00m', '7 days leaves out the opening training 20 days ago');
  await page.click('.tr-chip-btn[data-period="month"]');
  check((await legend('openings')).startsWith('1h 0'), '30 days includes it');
  check((await page.textContent('.st-act[data-activity="endgame-drill"] .st-act-details')).includes('Lucena'), 'endgame drills named in the breakdown');
  check((await page.locator('.st-bar-seg').count()) >= 4, 'the share bar has a segment per category used');
  check((await page.locator('.st-col').count()) === 30, '30 days in the chart');
  await page.hover('.st-col.today');
  check((await page.textContent('.st-tip')).includes('Analysis'), 'hovering today shows its split');
  await page.click('.st-table summary');
  check((await page.locator('.st-tbl tr').count()) >= 4, 'the chart as a table');
  await page.click('.tr-chip-btn[data-period="today"]');
  await page.reload();
  await page.waitForSelector('.st-split');
  check((await page.getAttribute('.tr-chip-btn[data-period="today"]', 'aria-pressed')) === 'true', 'the period is remembered');

  // training locks the tabs, Stats included
  await page.click('#view-board');
  check(!(await page.isDisabled('#view-stats')), 'Stats tab enabled normally');

  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await browser.close();
})();
