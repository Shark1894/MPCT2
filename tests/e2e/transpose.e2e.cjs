// Browser checks: the board's repertoire moves include moves that transpose into the opening's
// lines from a position that isn't in them. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/transpose.e2e.cjs
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

const explorer = (page) => page.$$eval('#explorer .explorer-move', (els) => els.map((e) => [e.querySelector('.san').textContent, e.querySelector('.count').textContent, e.classList.contains('transposes')]));
const settle = (page, ms = 500) => page.waitForTimeout(ms);

(async () => {
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(async () => {
    localStorage.clear();
    const post = (url, body) => fetch(`/api${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/repertoires', { name: 'Main' });
    const op = await post(`/repertoires/${rep.id}/openings`, { name: 'QGD', color: 'white' });
    await post(`/openings/${op.id}/lines`, { moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'g1f3', 'g8f6'] });
    await post(`/openings/${op.id}/lines`, { moves: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'g1f3', 'c7c5'] });
    await post(`/openings/${op.id}/tags`, { name: 'QGD', fen: 'rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3' });
  });
  await page.reload();
  await settle(page, 800);

  await play(page, 'd2d4', 'd7d5', 'g1f3', 'e7e6');
  await settle(page);
  const moves = await explorer(page);
  check(moves.length === 1 && moves[0][0] === 'c4' && moves[0][2], `after 1.d4 d5 2.Nf3 e6 (not in the lines): c4 transposes (${JSON.stringify(moves)})`);
  check(moves[0][1] === 'transposes · 2 lines', `marked, with the lines through it (${moves[0][1]})`);
  const brushes = await page.evaluate(() => mpct.board.layers.explorer.map((s) => `${s.orig}${s.dest}:${s.brush}`));
  check(brushes.join() === 'c2c4:blue', `drawn as a blue arrow (${brushes.join()})`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/transpose.png` });
  const chips = (p) => p.$$eval('#branch-path .branch-chip', (els) => els.map((e) => `${e.textContent}${e.classList.contains('transposed') ? ':transposed' : ''}`));
  check((await chips(page)).length === 0, 'no branch yet after 2...e6');
  await page.click('#explorer .explorer-move');
  await settle(page);
  check((await chips(page)).join() === 'QGD:transposed', `transposed into the QGD branch: shown in blue (${(await chips(page)).join()})`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/transpose-branch.png` });
  const next = await explorer(page);
  check(next.map((m) => m[0]).sort().join() === 'Nf6,c5' && next.every((m) => !m[2]), `playing it joins the lines: ${next.map((m) => m[0]).join(', ')}`);
  await play(page, 'a7a6');
  await settle(page);
  check((await page.textContent('#explorer')).includes('No repertoire moves'), 'a position nothing leads into: none');
  check((await chips(page)).length === 0, 'out of the lines: no branch');
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  await page.click('#branch-path .branch-chip.transposed');
  await settle(page, 800);
  const moves2 = await page.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '));
  check(moves2 === 'd4 d5 c4 e6', `tapping it shows the branch's position (${moves2})`);
  check((await chips(page)).join() === 'QGD', `reached by its own moves: the usual chip (${(await chips(page)).join()})`);

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
})();
