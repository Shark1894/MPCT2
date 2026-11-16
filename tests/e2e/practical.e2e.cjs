// Browser checks for the Practical tab: choose an opening and a branch, analyse (real Stockfish in
// the browser, the fake Lichess explorer), read the results, show a line on the board, and a
// second run that uses the saved engine lines. Needs a server with an EMPTY database, started
// with LICHESS_EXPLORER_URL pointing at tests/e2e/fake_explorer.py and LICHESS_TOKEN=lip_e2e.
// Usage: MPCT_URL=http://localhost:8010/ FAKE_URL=http://localhost:8097 node tests/e2e/practical.e2e.cjs
const { chromium } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const FAKE = process.env.FAKE_URL || 'http://localhost:8097';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);

const WUSS = ['e2e4', 'd7d5', 'e4d5', 'g8f6', 'd2d4', 'c8g4', 'f1e2', 'g4e2'];
const LINES = [
  [...WUSS, 'd1e2', 'd8d5', 'g1f3', 'b8c6'],
  [...WUSS, 'g1e2', 'd8d5', 'e1g1', 'b8c6'],
  ['e2e4', 'd7d5', 'e4d5', 'g8f6', 'c2c4', 'c7c6'],
];
const TAG_FEN = 'rn1qkb1r/ppp1pppp/5n2/3P4/3P2b1/8/PPP1BPPP/RNBQK1NR b KQkq - 2 4';

async function api(page, method, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const r = await fetch(`/api${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return r.json();
  }, [method, path, body]);
}

(async () => {
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 800);

  const rep = await api(page, 'POST', '/repertoires', { name: 'Main' });
  const o = await api(page, 'POST', `/repertoires/${rep.id}/openings`, { name: 'Scandinavian (Modern)', color: 'black' });
  await api(page, 'POST', `/repertoires/${rep.id}/openings`, { name: 'London', color: 'white' });
  for (const moves of LINES) await api(page, 'POST', `/openings/${o.id}/lines`, { moves });
  const tag = await api(page, 'POST', `/openings/${o.id}/tags`, { name: 'Wuss', fen: TAG_FEN });

  // ---- the tab ------------------------------------------------------------------------------------
  await page.click('#view-practical');
  await settle(page, 800);
  check(await page.isVisible('#practical-view'), 'Practical tab opens');
  const opts = await page.$$eval('#pr-opening option', (os) => os.map((x) => x.textContent));
  check(opts.includes('Scandinavian (Modern) (black)') && opts.includes('London (white)'), `openings listed (${opts.join(', ')})`);
  await page.selectOption('#pr-opening', String(o.id));
  await settle(page);
  const tags = await page.$$eval('#pr-tag option', (os) => os.map((x) => x.textContent));
  check(tags[0] === 'Whole opening' && tags.some((t) => t.startsWith('Wuss')), `branches listed (${tags.join(' | ')})`);
  await page.selectOption('#pr-tag', String(tag.id));
  await page.selectOption('#pr-think', '300');

  // ---- analyse ------------------------------------------------------------------------------------
  const t0 = Date.now();
  await page.click('#pr-go');
  await page.waitForFunction(() => document.querySelector('#pr-go').textContent === 'Stop', null, { timeout: 5000 });
  check(true, 'analysis starts (button becomes Stop)');
  await page.waitForFunction(() => /^(Done|Stopped)/.test(document.querySelector('#pr-progress').textContent), null, { timeout: 240000 });
  const progress = await page.textContent('#pr-progress');
  check(progress.startsWith('Done: 5 positions of 5'), `done (${progress})`);
  console.log(`  first run: ${Math.round((Date.now() - t0) / 1000)} s`);
  const cards = await page.$$eval('.pr-pos .pr-pos-moves', (hs) => hs.map((h) => h.textContent));
  check(cards.length === 5 && cards[0] === '1.e4 d5 2.exd5 Nf6 3.d4 Bg4 4.Be2 …', `a card per position, the branch's first (${cards[0]})`);
  const firstRows = await page.$$eval('.pr-pos:first-of-type tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  check(firstRows.length >= 3, `candidate rows (${firstRows.length})`);
  const yours = firstRows.find((r) => r[0].includes('yours'));
  check(yours && yours[0].startsWith('Bxe2'), 'your repertoire move is marked');
  check(firstRows.every((r) => /%/.test(r[1]) && /%/.test(r[2])), 'practical and engine values');
  const actuals = await page.$$eval('.pr-pos tbody tr td:nth-child(7)', (tds) => tds.map((td) => td.textContent));
  check(actuals.some((a) => /% \(\d/.test(a)), 'actual scores from the explorer');
  check(firstRows.some((r) => /→/.test(r[7])), 'their likely replies');
  check(await page.isVisible('#pr-worth'), 'worth-a-look section shown');
  const log = await (await fetch(`${FAKE}/log`)).json();
  check(log.some((x) => x.startsWith('lichess:') && x.endsWith('|2000,2200,2500')), 'Lichess asked at 2000+');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/practical.png`, fullPage: true });

  // ---- a second run uses the saved engine lines -------------------------------------------------------
  await page.click('#pr-go');
  await page.waitForFunction(() => document.querySelector('#pr-go').textContent === 'Stop', null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('#pr-go').textContent === 'Analyse', null, { timeout: 60000 });
  const again = await page.textContent('#pr-progress');
  check(/engine: 0 new/.test(again), `second run from saved lines (${again})`);
  const againRows = await page.$$eval('.pr-pos:first-of-type tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  check(JSON.stringify(againRows) === JSON.stringify(firstRows), 'saved lines give the same results');
  check(new Set(againRows.map((r) => r[2])).size > 1, `engine values differ between moves (${againRows.map((r) => r[2]).join(' ')})`);

  // ---- show on board --------------------------------------------------------------------------------
  await page.click('.pr-pos:first-of-type .pr-pos-title button');
  await settle(page, 800);
  check(!(await page.isHidden('main.layout')), 'Show on board opens the Board tab');
  const sans = await page.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '));
  check(sans === 'e4 d5 exd5 Nf6 d4 Bg4 Be2', `the position's moves (${sans})`);

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
})();
