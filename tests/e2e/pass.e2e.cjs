const { chromium } = require('playwright');
// Browser checks for passing a move on the analysis board (empty database).
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/pass.e2e.cjs
const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (page, ms = 300) => page.waitForTimeout(ms);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const { repId } = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Pass test' });
    await post(`/api/repertoires/${rep.id}/openings`, { name: 'Open games', color: 'white' });
    return { repId: rep.id };
  });
  await page.reload();
  await page.waitForSelector('cg-board piece');
  await settle(page, 800);

  const play = (sans) =>
    page.evaluate((sans) => {
      for (const s of sans) mpct.game.playSan(s);
      mpct.render();
    }, sans);
  const lines = () =>
    page.evaluate(async (id) => (await (await fetch(`/api/repertoires/${id}/openings`)).json()).reduce((n, o) => n + (o.lines ?? 0), 0), repId);
  const toast = () => page.evaluate(() => document.getElementById('toast')?.textContent ?? '');

  // ---- pass after 1.e4: White moves again --------------------------------
  await page.click('#btn-new');
  await play(['e4']);
  check(await page.isEnabled('#nav-pass'), 'Pass is available on the analysis board');
  await page.click('#nav-pass');
  await settle(page);
  check((await page.evaluate(() => mpct.game.turn())) === 'white', 'after passing, the same side is to move again');
  const passCell = page.locator('#moves .move.pass');
  check((await passCell.count()) === 1 && (await passCell.textContent()) === '--', 'the pass shows as "--" in the move list');
  check((await page.textContent('#status')).includes('after a pass'), 'status says the line is analysis only');
  check(await page.isDisabled('#comment-current'), 'no position notes after a pass');

  // real moves can carry on after the pass
  await play(['d4']);
  check((await page.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '))) === 'e4 -- d4', 'moves continue after the pass');

  // ---- nothing can be saved ----------------------------------------------
  await page.click('#line-add');
  await settle(page, 500);
  check((await toast()).includes('passed move'), 'Add line explains why it refuses');
  check((await lines()) === 0, 'no line was saved');

  await page.click('#review-start').catch(() => {});
  await settle(page, 300);
  check((await toast()).includes('passed move'), 'Review refuses a line with a pass');
  check(!(await page.evaluate(() => mpct.review.running)), 'no review started');

  // ---- stepping back before the pass makes saving possible again -----------
  await page.evaluate(() => {
    mpct.game.goTo(1);
    mpct.render();
  });
  await settle(page);
  check(!(await page.textContent('#status')).includes('after a pass'), 'before the pass the status is normal');
  check(await page.isEnabled('#comment-current'), 'notes are available again before the pass');
  await page.click('#line-add');
  await settle(page, 600);
  check((await lines()) === 1, 'the line up to before the pass can be saved');

  // ---- a pass survives a reload -------------------------------------------
  await page.evaluate(() => {
    mpct.game.toEnd();
    mpct.render();
  });
  await page.reload();
  await page.waitForSelector('cg-board piece');
  await settle(page, 600);
  check((await page.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '))) === 'e4 -- d4', 'the board keeps the pass across a reload');

  // ---- no passing in check -------------------------------------------------
  await page.click('#btn-new');
  await play(['e4', 'd5', 'Bb5+']);
  check(await page.isDisabled('#nav-pass'), 'Pass is disabled when in check');
  await page.click('#btn-new');
  await play(['f3', 'e5', 'g4', 'Qh4#']);
  check(await page.isDisabled('#nav-pass'), 'Pass is disabled when the game is over');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})();
