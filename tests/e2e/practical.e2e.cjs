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
  const depths = await page.$$eval('#pr-depth option', (os) => os.map((x) => x.value));
  check(depths.join() === '12,16,20,24' && (await page.inputValue('#pr-depth')) === '16', `engine depth options, 16 by default (${depths.join()})`);
  await page.selectOption('#pr-depth', '12');
  check(!(await page.$('#pr-data')) && !(await page.$('#pr-strength')), 'no opponent model or game-data settings');

  // ---- analyse ------------------------------------------------------------------------------------
  const t0 = Date.now();
  await page.click('#pr-go');
  await page.waitForFunction(() => document.querySelector('#pr-go').textContent === 'Stop', null, { timeout: 5000 });
  check(true, 'analysis starts (button becomes Stop)');
  await page.waitForFunction(() => /^(Done|Stopped)/.test(document.querySelector('#pr-progress').textContent), null, { timeout: 240000 });
  const progress = await page.textContent('#pr-progress');
  check(progress.startsWith('Done: 5 positions of 5') && progress.includes('at depth 12'), `done (${progress})`);
  console.log(`  first run: ${Math.round((Date.now() - t0) / 1000)} s`);
  const cards = await page.$$eval('.pr-pos .pr-pos-moves', (hs) => hs.map((h) => h.textContent));
  check(cards.length === 5 && cards[0] === '1.e4 d5 2.exd5 Nf6 3.d4 Bg4 4.Be2 …', `a card per position, the branch's first (${cards[0]})`);
  const firstRows = await page.$$eval('.pr-pos:first-of-type tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  check(firstRows.length >= 3, `candidate rows (${firstRows.length})`);
  const heads = await page.$$eval('.pr-pos:first-of-type thead th', (ths) => ths.map((t) => t.textContent));
  check(heads.join('|') === 'Move|Eval|Engine|Cost|Good replies|In a row|Gap|Sharpness|Depth|Their replies → you', `columns (${heads.join('|')})`);
  check((await page.inputValue('#pr-decisions')) === '3', 'follows 3 of their decisions by default');
  const yours = firstRows.find((r) => r[0].includes('yours'));
  check(yours && yours[0].startsWith('Bxe2'), 'your repertoire move is marked');
  const evalRe = /^([+−]\d+\.\d\d|0\.00|#.*)$/;
  check(firstRows.every((r) => evalRe.test(r[1]) && /%/.test(r[2]) && /^\d+$/.test(r[3]) && /^(\d+(recapture)?|–)$/.test(r[7])), `eval, engine, cost and sharpness (${firstRows[0].slice(1, 8).join(' ')})`);
  const chainRe = /^((\d+|r)( → (\d+|r)){0,2}|–)$/;
  check(firstRows.every((r) => chainRe.test(r[4]) && /^(\d|–)$/.test(r[5])), `good replies decision by decision, and in a row (${firstRows.map((r) => `${r[4]}/${r[5]}`).join('  ')})`);
  check(firstRows.some((r) => r[4].split(' → ').length === 3), 'three decisions followed');
  const costs = firstRows.map((r) => Number(r[3]));
  check(costs.every((c, i) => i === 0 || c >= costs[i - 1]), `moves listed least cost first (${costs.join(' ')})`);
  const allRows = await page.$$eval('.pr-pos tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  check(allRows.some((r) => r[4].split(' → ').includes('1')), 'an only move somewhere');
  check(allRows.every((r) => r[5] === '–' || (() => { let n = 0; for (const g of r[4].split(' → ')) { if (g === 'r') continue; if (g !== '1') break; n += 1; } return n === Number(r[5]); })()), 'in a row = only moves from the start (recaptures skipped)');
  check(yours[4].startsWith('r') && /^\d+$/.test(yours[7]), `your Bxe2: recapture first, sharpness from later on (${yours[4]} / ${yours[7]})`);
  check(firstRows.some((r) => /→ \d+%/.test(r[9])), 'their replies with your winning chances');
  check(allRows.every((r) => r[8] === '–' || Number(r[8]) <= 12 && Number(r[8]) >= 1), `depth reached per line (${[...new Set(allRows.map((r) => r[8]))].join(' ')})`);
  check(allRows.filter((r) => r[8] !== '–').some((r) => r[8] === '12'), 'searched to the chosen depth');
  check(/searched to depth 12/.test(await page.textContent('.pr-pos:first-of-type .pr-pos-title')), 'each position says how deep your moves were searched');
  check(!(await page.textContent('#practical-view')).match(/go wrong|Trap value|Practical\b(?! choices)/), 'no opponent-model measures on the page');
  check(await page.isVisible('#pr-worth'), 'sharpest alternatives shown');
  const wHeads = await page.$$eval('#pr-worth-table thead th', (ths) => ths.map((t) => t.textContent.replace(/[↕▼▲]/g, '').trim()));
  check(wHeads.join('|') === 'After|Play|Break-even|Sharpness|Yours|Difference|Good replies|In a row|Gap|Cost|Eval|Yours (eval)|Eval change|Depth|Seen', `sharpest alternatives as a table (${wHeads.join('|')})`);
  const cellsOf = () => page.$$eval('#pr-worth-table tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  let wrows = await cellsOf();
  check(wrows.length > 0 && wrows.every((r) => /^(\d+\.|\d+…)\S+$/.test(r[0])), `After shows just the last move (${wrows.map((r) => r[0]).join(', ')})`);
  const be = (t) => (t === 'free' ? 0 : t === 'never' ? Infinity : t === '–' ? Infinity : Number(t.replace('%', '')));
  check(wrows.every((r) => /^(\d+%|free|never|–)$/.test(r[2])) && wrows.map((r) => be(r[2])).every((v, i, a) => i === 0 || v >= a[i - 1]), `sorted by break-even, lowest first (${wrows.map((r) => r[2]).join(' ')})`);
  const num = (t) => Number(t.replace('−', '-'));
  check(wrows.every((r) => r[4].includes('recapture') || num(r[5]) >= 0), `never less sharp than yours (${wrows.map((r) => r[5]).join(' ')})`);
  check(wrows.every((r) => r[4] === '–' || (r[4].includes('recapture') ? r[5] === '–' : num(r[3]) - num(r[4].split(' ')[0]) === num(r[5]))), `difference = sharpness − yours, none against a recapture (${wrows.map((r) => `${r[4]}/${r[5]}`).join(' ')})`);
  check(wrows.every((r) => r[6].split(' → ').some((g) => g !== 'r' && Number(g) <= 2) && Number(r[8]) >= 1), `at most two good replies at one of their decisions (${wrows.map((r) => r[6]).join(' | ')})`);
  const pawns = (t) => Number(t.replace('−', '-'));
  check(wrows.every((r) => evalRe.test(r[10]) && evalRe.test(r[11]) && Math.abs(pawns(r[10]) - pawns(r[11]) - pawns(r[12])) < 0.011), `eval change = eval − yours (${wrows.map((r) => r[12]).join(' ')})`);
  await page.click('#pr-worth-table .pr-sort[data-sort="sharpness"]');
  const sharps = (await cellsOf()).map((r) => Number(r[3]));
  check(sharps.every((t, i) => i === 0 || t <= sharps[i - 1]), `sorted by sharpness (${sharps.join(' ')})`);

  // ---- the line behind the chain -------------------------------------------------------------------
  const line = await page.getAttribute('#pr-worth-table tbody tr:first-child .pr-chain-btn', 'title');
  const lineMoves = line.match(/Main line: ([^.]+)\./)[1].split(' ');
  check(lineMoves.length === 5, `the main line: your move and two more of each (${lineMoves.join(' ')})`);
  await page.click('#pr-worth-table tbody tr:first-child .pr-chain-btn');
  await settle(page, 800);
  const shownLine = await page.evaluate(() => mpct.game.moves.map((m) => m.san));
  check(shownLine.slice(-5).join(' ') === lineMoves.join(' '), `tapping the chain shows the line on the board (${shownLine.slice(-5).join(' ')})`);
  await page.click('#view-practical');
  await settle(page, 600);
  check((await page.$$('#pr-worth-table tbody tr.seen')).length === 1, 'opening the line ticks the move as seen');
  for (let i = 0; i < 5 && (await page.$('#pr-worth-table tbody tr.seen .pr-seen')); i++) {
    await page.click('#pr-worth-table tbody tr.seen .pr-seen'); // start the seen checks clean
    await settle(page, 400);
  }

  // ---- seen ---------------------------------------------------------------------------------------
  check((await cellsOf()).every((r) => r[14] === ''), 'nothing seen yet');
  const opened = (await cellsOf())[0];
  await page.click('#pr-worth-table tbody tr:first-child .pr-move-btn');
  await settle(page, 800);
  const onBoard = await page.evaluate(() => mpct.game.moves.map((m) => m.san));
  check(!(await page.isHidden('main.layout')) && onBoard[onBoard.length - 1] === opened[1].split('not')[0].trim(), `the move opens on the board (${onBoard.slice(-2).join(' ')})`);
  await page.click('#view-practical');
  await settle(page, 600);
  const afterSeen = await cellsOf();
  const seenRow = afterSeen.find((r) => r[0] === opened[0] && r[1] === opened[1]);
  check(seenRow && seenRow[14] === '✓', 'back on the tab: that one is ticked as seen');
  check((await page.$$('#pr-worth-table tbody tr.seen')).length === 1, 'and shown dimmed');
  const saved = await api(page, 'POST', '/practical/seen/lookup', { keys: (await page.evaluate(() => mpct.practicalView.info.positions.map((p) => p.key))) });
  check(saved.length === 1, 'remembered on the server');
  await page.check('#pr-hide-seen');
  check((await cellsOf()).length === afterSeen.length - 1, 'Hide the ones you’ve seen');
  await page.uncheck('#pr-hide-seen');
  await page.click('#pr-worth-table tbody tr.seen .pr-seen');
  await settle(page, 400);
  check((await cellsOf()).every((r) => r[14] === ''), 'untick: not seen any more');
  check((await api(page, 'POST', '/practical/seen/lookup', { keys: (await page.evaluate(() => mpct.practicalView.info.positions.map((p) => p.key))) })).length === 0, 'and forgotten on the server');
  const firstWhere = (await cellsOf())[0][0];
  check(!firstWhere.startsWith('1.e4'), `positions shown by their last move (${firstWhere})`);
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
