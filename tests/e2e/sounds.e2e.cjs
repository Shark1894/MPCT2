// Browser checks for move sounds. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/sounds.e2e.cjs
const { chromium } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 300) => p.waitForTimeout(ms);

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

// Record every sound played (and whether audio actually ran).
const spy = (p) =>
  p.evaluate(() => {
    window.heard = [];
    const s = mpct.sounds;
    const orig = s.play.bind(s);
    s.play = (name) => {
      window.heard.push({ name, audible: Boolean(s.enabled && s.ctx && s.ctx.state === 'running') });
      orig(name);
    };
  });
const heard = (p) => p.evaluate(() => window.heard.splice(0));

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 800);
  await spy(page);

  check((await page.textContent('#btn-sound')) === 'Sound on', 'sound on by default');
  check((await page.evaluate(() => mpct.sounds.ctx)) === null, 'no audio until the first interaction');

  // ---- moves ------------------------------------------------------------------------------
  await move(page, 'e2e4');
  check((await page.evaluate(() => mpct.sounds.ctx?.state)) === 'running', 'audio unlocked by the first tap');
  let h = await heard(page);
  check(h.length === 1 && h[0].name === 'move' && h[0].audible, 'a move clicks: ' + JSON.stringify(h));
  for (const m of ['d7d5', 'e4d5']) await move(page, m);
  h = await heard(page);
  check(h.map((x) => x.name).join() === 'move,capture', 'capture knocks: ' + h.map((x) => x.name));
  for (const m of ['d8d5', 'b1c3', 'd5e5']) await move(page, m);
  h = await heard(page);
  check(h.at(-1).name === 'check', 'check pings (…Qe5+): ' + h.map((x) => x.name));

  // ---- navigation ---------------------------------------------------------------------------
  await page.click('#nav-back');
  await settle(page);
  check((await heard(page)).length === 0, 'stepping back is silent');
  await page.click('#nav-forward');
  await settle(page);
  h = await heard(page);
  check(h.length === 1 && h[0].name === 'check', 'stepping forward replays the sound');
  await page.click('#nav-start');
  await page.click('#nav-end');
  await settle(page);
  check((await heard(page)).length === 0, 'jumping to the start or end is silent');

  // ---- mute ---------------------------------------------------------------------------------------
  await page.click('#btn-sound');
  check((await page.textContent('#btn-sound')) === 'Sound off' && (await page.getAttribute('#btn-sound', 'aria-pressed')) === 'false', 'Sound off');
  await page.click('#btn-new');
  await heard(page);
  await move(page, 'g1f3');
  h = await heard(page);
  check(h.length === 1 && !h[0].audible, 'muted: nothing audible');
  await page.reload();
  await settle(page, 800);
  check((await page.textContent('#btn-sound')) === 'Sound off', 'mute remembered after a reload');
  await page.keyboard.press('m');
  check((await page.textContent('#btn-sound')) === 'Sound on', 'M key turns it back on');
  await spy(page);

  // ---- training: wrong move and a clean line -------------------------------------------------------
  await page.evaluate(async () => {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const o = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Italian', color: 'white' });
    await post(`/api/openings/${o.id}/lines`, { moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] });
  });
  await page.reload();
  await settle(page, 900);
  await spy(page);
  await page.click('#train-all');
  await page.waitForFunction(() => mpct.trainer.canMove(), null, { timeout: 5000 });
  await move(page, 'd2d4'); // not the repertoire move
  h = await heard(page);
  check(h.some((x) => x.name === 'wrong'), 'wrong answer buzzes: ' + h.map((x) => x.name));
  await move(page, 'e2e4');
  await page.waitForFunction(() => mpct.trainer.canMove(), null, { timeout: 5000 });
  h = await heard(page);
  check(h.map((x) => x.name).join() === 'move,move', 'your move and the trainer’s reply click: ' + h.map((x) => x.name));
  await page.click('#train-retry').catch(() => {});
  await move(page, 'g1f3');
  await page.waitForSelector('#train-end:not([hidden])', { timeout: 5000 });
  await settle(page, 800);
  h = await heard(page);
  check(!h.some((x) => x.name === 'success'), 'no success chime after a line with a mistake: ' + h.map((x) => x.name));
  await page.click('#train-retry');
  await page.waitForFunction(() => mpct.trainer.canMove(), null, { timeout: 5000 });
  await move(page, 'e2e4');
  await page.waitForFunction(() => mpct.trainer.canMove(), null, { timeout: 5000 });
  await move(page, 'g1f3');
  await page.waitForSelector('#train-end:not([hidden])', { timeout: 5000 });
  await settle(page, 800);
  h = await heard(page);
  check(h.at(-1)?.name === 'success', 'clean line chimes: ' + h.map((x) => x.name));

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})();
