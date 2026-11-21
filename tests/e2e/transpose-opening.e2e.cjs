// Browser checks: moves that transpose into ANOTHER opening are shown in orchid (purple).
// Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/transpose-opening.e2e.cjs
const { chromium } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};

function sq(box, s, flipped) {
  const f = s.charCodeAt(0) - 97, r = Number(s[1]) - 1, z = box.width / 8;
  const col = flipped ? 7 - f : f, row = flipped ? r : 7 - r;
  return { x: box.x + (col + 0.5) * z, y: box.y + (row + 0.5) * z };
}

async function play(page, ...moves) {
  for (const m of moves) {
    const box = await page.locator('cg-board').boundingBox();
    const flipped = (await page.evaluate(() => mpct.board.orientation())) === 'black';
    const a = sq(box, m.slice(0, 2), flipped), b = sq(box, m.slice(2, 4), flipped);
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(150);
  }
}

const explorer = (page) => page.$$eval('#explorer .explorer-move', (els) => els.map((e) => [e.querySelector('.san').textContent, e.querySelector('.count').textContent, e.className]));
const settle = (page, ms = 500) => page.waitForTimeout(ms);

(async () => {
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  const london = await page.evaluate(async () => {
    localStorage.clear();
    const post = (url, body) => fetch(`/api${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/repertoires', { name: 'Main' });
    const qgd = await post(`/repertoires/${rep.id}/openings`, { name: 'QGD', color: 'white' });
    await post(`/openings/${qgd.id}/lines`, { moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'g1f3', 'g8f6'] });
    await post(`/openings/${qgd.id}/lines`, { moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'g1f3', 'c7c5'] });
    const london = await post(`/repertoires/${rep.id}/openings`, { name: 'London', color: 'white' });
    await post(`/openings/${london.id}/lines`, { moves: ['d2d4', 'd7d5', 'g1f3', 'e7e6', 'c1f4'] });
    return london;
  });
  await page.reload();
  await settle(page, 800);
  await page.selectOption('#opening-select', String(london.id));
  await settle(page);

  await play(page, 'd2d4', 'd7d5');
  await settle(page);
  check((await explorer(page)).map((m) => m[0]).join() === 'Nf3', 'after 1.d4 d5: 2.c4 (the QGD\'s own move order) is not flagged');

  await play(page, 'g1f3', 'e7e6');
  await settle(page);
  const moves = await explorer(page);
  check(moves.length === 2 && moves[0][0] === 'Bf4' && !moves[0][2].includes('into-opening'), `own move first (${JSON.stringify(moves)})`);
  check(moves[1][0] === 'c4' && moves[1][2].includes('into-opening') && !moves[1][2].includes(' transposes'), 'c4 marked as into another opening');
  check(moves[1][1] === '→ QGD · 2 lines', `names the opening and its lines (${moves[1][1]})`);
  const brushes = await page.evaluate(() => mpct.board.layers.explorer.map((s) => `${s.orig}${s.dest}:${s.brush}`));
  check(brushes.join() === 'c1f4:green,c2c4:intoOpening', `arrows: green, then orchid (${brushes.join()})`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/transpose-opening.png` });

  check(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await browser.close();
})();
