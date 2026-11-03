// Browser checks for confusable positions (dashboard list + drill). Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/confusable.e2e.cjs
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

const expected = (p) => p.evaluate(() => mpct.drill.drill.expected());
const otherMove = (p) => p.evaluate(() => mpct.drill.drill.otherSide.expected_uci);
const diffShapes = (p) => p.evaluate(() => (mpct.board.layers.drill ?? []).length);

const SLAV = ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3'];
const LINES = [
  [...SLAV, 'c8f5', 'c4d5'],
  [...SLAV, 'c8g4', 'f3e5'],
  [...SLAV, 'g8f6', 'b1c3'],
  [...SLAV, 'b8d7', 'c1f4'],
];

async function seed(page) {
  return page.evaluate(async (LINES) => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const slav = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Slav', color: 'white' });
    for (const m of LINES) await post(`/api/openings/${slav.id}/lines`, { moves: m });
    return { rep: rep.id, slav: slav.id };
  }, LINES);
}

async function answerSide(page) {
  await move(page, await expected(page));
  await page.waitForSelector('#drill-next:not([hidden])', { timeout: 3000 });
  await page.click('#drill-next');
  await settle(page, 200);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const { rep } = await seed(page);
  await page.reload();
  await settle(page, 800);
  await page.click('#view-dashboard');
  await page.waitForSelector('#cp-list .cp-item', { timeout: 5000 });

  // ---- dashboard list -------------------------------------------------------------
  const items = await page.$$eval('#cp-list .cp-item', (els) => els.map((e) => e.textContent));
  check(items.length >= 2, `pairs listed: ${items.length}`);
  check(/cxd5/.test(items[0]) && /Ne5/.test(items[0]), 'closest pair first: Bf5 cxd5 / Bg4 Ne5');
  check(/Black bishop on f5: cxd5\. Black bishop on g4: Ne5\./.test(items[0]) || /Black bishop on g4: Ne5\. Black bishop on f5: cxd5\./.test(items[0]), 'difference described');
  check(/2 squares differ/.test(items[0]), 'distance shown');
  check(!(await page.isHidden('#cp-drill-top')) && /Drill top \d/.test(await text(page, '#cp-drill-top')), 'Drill top button');
  if (SHOTS) await page.locator('#cp-list').screenshot({ path: `${SHOTS}/confusable-list.png` });

  // ---- drill one pair -------------------------------------------------------------------
  await page.click('#cp-list .cp-item:first-child button.primary');
  await settle(page, 600);
  check(!(await page.isHidden('#drill')), 'drill panel shown on the board view');
  check((await text(page, '#mode-badge')) === 'Drill' && !(await page.isHidden('#mode-badge')), 'Drill badge');
  check(await page.isHidden('#rep-build'), 'repertoire controls hidden');
  check(await page.isDisabled('#view-dashboard'), 'views locked while drilling');
  check(/position 1 of 2/.test(await text(page, '#drill-progress')), 'progress: position 1 of 2');
  check((await diffShapes(page)) === 0, 'differences not marked before answering');

  await move(page, await otherMove(page)); // the classic mix-up
  check(/That’s the move with/.test(await text(page, '#drill-message')), 'mix-up named: ' + (await text(page, '#drill-message')));
  check((await diffShapes(page)) === 2, 'differing squares marked after a mistake');
  check(await page.isHidden('#drill-next'), 'no Next after a wrong move');
  await move(page, await expected(page));
  check(/^✓/.test(await text(page, '#drill-message')), 'right move accepted');
  await page.click('#drill-next');
  await settle(page, 200);
  check(/position 2 of 2/.test(await text(page, '#drill-progress')), 'second position of the pair');
  await answerSide(page);
  check(!(await page.isHidden('#drill-end')), 'pair result shown');
  check(/1 wrong try/.test(await text(page, '#drill-result')), 'result counts the mix-up');
  check((await page.$$('#drill-compare li')).length === 2, 'both positions compared');

  // rule goes into both positions' comments
  await page.fill('#drill-rule', 'Bishop f5: cxd5. Bishop g4: Ne5.');
  await page.click('#drill-rule-save');
  await settle(page, 600);
  const saved = await page.evaluate(async (rep) => {
    const pair = mpct.drill.drill.pair;
    const get = (fen) => fetch(`/api/repertoires/${rep}/comment?fen=${encodeURIComponent(fen)}`).then((r) => r.json());
    return [(await get(pair.a.fen)).comment, (await get(pair.b.fen)).comment];
  }, rep);
  check(saved.every((c) => c === 'Bishop f5: cxd5. Bishop g4: Ne5.'), 'rule saved to both comments');
  check((await text(page, '#drill-rule-save')) === 'Added ✓', 'rule button confirms');
  if (SHOTS) await page.locator('.panel.repertoire').screenshot({ path: `${SHOTS}/confusable-pair.png` });

  await page.click('#drill-again');
  await settle(page, 200);
  check(/position 1 of 2/.test(await text(page, '#drill-progress')), 'Again restarts the pair');
  await answerSide(page);
  await answerSide(page);
  check(/Both positions right/.test(await text(page, '#drill-result')), 'clean run');
  check((await page.$$('#drill-comments li')).length === 2, 'existing comments shown with the pair');
  await page.click('#drill-next-pair'); // Finish
  check(/1 pair drilled: 1 right first time\./.test(await text(page, '#drill-summary-text')), 'summary');
  await page.click('#drill-done');
  await settle(page, 300);
  check(await page.isHidden('#drill'), 'drill closed');
  check(await page.isHidden('#mode-badge') && !(await page.isHidden('#rep-build')), 'normal board view back');

  // ---- hide and show again ------------------------------------------------------------
  await page.click('#view-dashboard');
  await page.waitForSelector('#cp-list .cp-item', { timeout: 5000 });
  const before = (await page.$$('#cp-list .cp-item')).length;
  await page.click('#cp-list .cp-item:first-child button:not(.primary):not(.cp-show)');
  await settle(page, 700);
  check((await page.$$('#cp-list .cp-item')).length === before - 1, 'Hide removes the pair');
  check(/1 pair hidden/.test(await text(page, '#cp-count')) && !(await page.isHidden('#cp-unhide')), 'hidden count with Show hidden');
  await page.click('#cp-unhide');
  await settle(page, 700);
  check((await page.$$('#cp-list .cp-item')).length === before, 'Show hidden brings it back');

  // ---- drill top: several pairs ------------------------------------------------------------
  await page.click('#cp-drill-top');
  await settle(page, 600);
  const total = await page.evaluate(() => mpct.drill.drill.total);
  check(total === before, `drill top takes every listed pair (${total})`);
  for (let i = 0; i < total; i++) {
    await answerSide(page);
    await answerSide(page);
    await page.click('#drill-next-pair');
    await settle(page, 200);
  }
  check(new RegExp(`${total} pairs drilled: ${total} right first time`).test(await text(page, '#drill-summary-text')), 'summary after several pairs');
  await page.click('#drill-done');

  // ---- phone ----------------------------------------------------------------------------------
  if (SHOTS) {
    const phone = await browser.newPage({ ...devices['Pixel 7'] });
    await phone.goto(URL);
    await phone.click('#view-dashboard');
    await phone.waitForSelector('#cp-list .cp-item', { timeout: 5000 });
    await phone.locator('#cp-list').scrollIntoViewIfNeeded();
    await phone.locator('#cp-list').evaluate((e) => e.closest('.dash-card').scrollIntoView());
    await phone.screenshot({ path: `${SHOTS}/confusable-phone-list.png` });
    await phone.click('#cp-list .cp-item:first-child button.primary');
    await settle(phone, 600);
    await move(phone, await otherMove(phone));
    await phone.screenshot({ path: `${SHOTS}/confusable-phone-drill.png`, fullPage: false });
  }

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})();
