// Browser checks for importing (copying) an opening from another repertoire.
// Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/importopening.e2e.cjs
const { chromium } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (page) => page.waitForTimeout(400);

async function api(page, method, path, body) {
  return page.evaluate(
    async ([method, path, body]) => {
      const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return r.status === 204 ? null : r.json();
    },
    [method, path, body],
  );
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('409') && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());

  // Old repertoire with a Caro-Kann (2 lines, a tag, a comment); new empty repertoire
  const old = await api(page, 'POST', '/repertoires', { name: 'Old' });
  const caro = await api(page, 'POST', `/repertoires/${old.id}/openings`, { name: 'Caro-Kann', color: 'black' });
  await api(page, 'POST', `/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'] });
  await api(page, 'POST', `/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'] });
  await api(page, 'POST', `/openings/${caro.id}/tags`, { name: 'Advance', fen: 'rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3' });
  await api(page, 'PUT', `/repertoires/${old.id}/comment`, { fen: 'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', comment: 'solid' });
  const fresh = await api(page, 'POST', '/repertoires', { name: 'New' });
  await page.evaluate((id) => localStorage.setItem('mpct.repertoireId', JSON.stringify(id)), fresh.id);
  await page.reload();
  await settle(page);
  if ((await page.$eval('#rep-select', (s) => s.value)) !== String(fresh.id)) {
    await page.selectOption('#rep-select', String(fresh.id));
    await settle(page);
  }

  check(!(await page.isDisabled('#opening-import-rep')), 'import button enabled with two repertoires');
  await page.click('details.manage summary');
  await page.click('#opening-import-rep');
  await page.waitForSelector('dialog select[name=opening] option', { state: 'attached' });
  const options = await page.$$eval('dialog select[name=opening] option', (os) => os.map((o) => o.textContent));
  check(options.length === 1 && options[0] === 'Old › Caro-Kann (Black, 2 lines)', 'dialog lists the other repertoire\'s openings: ' + options);
  await page.click('dialog button[type=submit]');
  await settle(page);

  check((await page.$eval('#opening-select option:checked', (o) => o.textContent)) === 'Caro-Kann', 'copied opening selected');
  check((await page.textContent('#opening-info')).startsWith('Black · 2 lines'), 'copy has both lines: ' + (await page.textContent('#opening-info')));
  check((await page.evaluate(() => mpct.board.orientation())) === 'black', 'board oriented to the copy');
  check((await page.textContent('.toast')).includes('1 branch tag, 1 comment'), 'toast says what came along');

  // Same name again in this repertoire → error; with a new name → second copy
  await page.click('#opening-import-rep');
  await page.waitForSelector('dialog select[name=opening] option', { state: 'attached' });
  await page.click('dialog button[type=submit]');
  await settle(page);
  check((await page.$$eval('#opening-select option', (os) => os.length)) === 1, 'name clash refused');
  await page.click('#opening-import-rep');
  await page.waitForSelector('dialog select[name=opening] option', { state: 'attached' });
  await page.fill('dialog input[name=name]', 'Caro-Kann (2)');
  await page.click('dialog button[type=submit]');
  await settle(page);
  check((await page.$eval('#opening-select option:checked', (o) => o.textContent)) === 'Caro-Kann (2)', 'renamed copy created');

  const origin = await api(page, 'GET', `/repertoires/${old.id}/openings`);
  check(origin.length === 1 && origin[0].lines === 2, 'original left in place');

  check(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await browser.close();
})();
