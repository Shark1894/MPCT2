// Browser checks for the Practical tab: choose an opening and a branch, analyse (real Stockfish in
// the browser), read the results, sort the sharpest alternatives, show a line on the board, and a
// second run that uses the saved engine lines. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/practical.e2e.cjs
const { chromium } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
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
  check(!(await page.$('#pr-data')) && !(await page.$('#pr-strength')), 'no opponent model or game-data settings');

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
  const heads = await page.$$eval('.pr-pos:first-of-type thead th', (ths) => ths.map((t) => t.textContent));
  check(heads.join('|') === 'Move|Eval|Engine|Cost|Good replies|Gap|Sharpness|Their replies → you', `columns (${heads.join('|')})`);
  const yours = firstRows.find((r) => r[0].includes('yours'));
  check(yours && yours[0].startsWith('Bxe2'), 'your repertoire move is marked');
  const evalRe = /^([+−]\d+\.\d\d|0\.00|#.*)$/;
  check(firstRows.every((r) => evalRe.test(r[1]) && /%/.test(r[2]) && /^\d+$/.test(r[3]) && /^(\d+(recapture)?|–)$/.test(r[6])), `eval, engine, cost and sharpness (${firstRows[0].slice(1, 7).join(' ')})`);
  const costs = firstRows.map((r) => Number(r[3]));
  check(costs.every((c, i) => i === 0 || c >= costs[i - 1]), `moves listed least cost first (${costs.join(' ')})`);
  const allRows = await page.$$eval('.pr-pos tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  check(allRows.some((r) => r[4] === '1'), 'an only move somewhere');
  check(/recapture/.test(yours[6]), `your Bxe2 is marked as a recapture (${yours[6]})`);
  check(firstRows.some((r) => /→ \d+%/.test(r[7])), 'their replies with your winning chances');
  check(!(await page.textContent('#practical-view')).match(/go wrong|Trap value|Practical\b(?! choices)/), 'no opponent-model measures on the page');
  check(await page.isVisible('#pr-worth'), 'sharpest alternatives shown');
  const wHeads = await page.$$eval('#pr-worth-table thead th', (ths) => ths.map((t) => t.textContent.replace(/[↕▼▲]/g, '').trim()));
  check(wHeads.join('|') === 'After|Play|Sharpness|Yours|Difference|Good replies|Gap|Cost|Eval|Yours (eval)|Eval change|Only move(s) → you|Next best → you', `sharpest alternatives as a table (${wHeads.join('|')})`);
  const sharps = await page.$$eval('#pr-worth-table tbody tr td:nth-child(3)', (tds) => tds.map((td) => Number(td.textContent)));
  check(sharps.length > 0 && sharps.every((t, i) => i === 0 || t <= sharps[i - 1]), `sorted by sharpness (${sharps.join(' ')})`);
  const num = (t) => Number(t.replace('−', '-'));
  const diffs = await page.$$eval('#pr-worth-table tbody tr', (trs) => trs.map((tr) => [3, 4, 5].map((i) => tr.children[i - 1].textContent)));
  check(diffs.every(([, y, d]) => y.includes('recapture') || num(d) >= 0), `never less sharp than yours (${diffs.map((r) => r[2]).join(' ')})`);
  check(diffs.every(([t, y, d]) => y === '–' || num(t) - num(y.split(' ')[0]) === num(d)), `difference = sharpness − yours (${diffs.map((r) => r.join('/')).join(' ')})`);
  const goodGap = await page.$$eval('#pr-worth-table tbody tr', (trs) => trs.map((tr) => [Number(tr.children[5].textContent), Number(tr.children[6].textContent)]));
  check(goodGap.every(([g, gap]) => g <= 2 && gap >= 5), `at most two good replies and a gap of 5+ (${goodGap.map((r) => r.join('/')).join(' ')})`);
  await page.click('#pr-worth-table .pr-sort[data-sort="good"]');
  const goods = await page.$$eval('#pr-worth-table tbody tr td:nth-child(6)', (tds) => tds.map((td) => Number(td.textContent)));
  check(goods.every((g, i) => i === 0 || g >= goods[i - 1]) && (await page.getAttribute('#pr-worth-table th:nth-child(6)', 'aria-sort')) === 'ascending', `sorted by good replies (${goods.join(' ')})`);
  await page.click('#pr-worth-table .pr-sort[data-sort="diff"]');
  const sortedDiffs = await page.$$eval('#pr-worth-table tbody tr td:nth-child(5)', (tds) => tds.map((td) => td.textContent));
  check(sortedDiffs.map(num).every((d, i, a) => i === 0 || d <= a[i - 1]), `sorted by difference (${sortedDiffs.join(' ')})`);
  const evals = await page.$$eval('#pr-worth-table tbody tr', (trs) => trs.map((tr) => [tr.children[8].textContent, tr.children[9].textContent]));
  check(evals.every(([e, y]) => evalRe.test(e) && evalRe.test(y)), `evals for the suggestion and yours (${evals.map((r) => r.join(' vs ')).join('; ')})`);
  const changes = await page.$$eval('#pr-worth-table tbody tr', (trs) => trs.map((tr) => [tr.children[8].textContent, tr.children[9].textContent.split(' ')[0], tr.children[10].textContent, tr.children[10].className]));
  const pawns = (t) => Number(t.replace('−', '-'));
  check(changes.every(([e, y, d, cls]) => Math.abs(pawns(e) - pawns(y) - pawns(d)) < 0.011 && (pawns(d) > 0 ? cls.includes('down') : pawns(d) < 0 ? cls.includes('up') : cls.includes('same'))),
    `eval change = eval − yours, red when worse for Black (${changes.map((r) => `${r[2]} ${r[3].split(' ').pop()}`).join('; ')})`);
  const firstWhere = await page.textContent('#pr-worth-table tbody tr:first-child td:first-child');
  check(!firstWhere.startsWith('1.e4'), `positions shown from the branch (${firstWhere})`);
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
