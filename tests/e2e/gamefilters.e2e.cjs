// Browser checks for the Games tab filters and for a reviewed game opening with its
// evaluation graph (from saved analysis: no engine needed). Needs an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/gamefilters.e2e.cjs
const { chromium, devices } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 400) => p.waitForTimeout(ms);
const rows = (p) => p.$$eval('#games-list .game-players', (els) => els.map((e) => e.textContent));
const options = (p, sel) => p.$$eval(`${sel} option`, (o) => o.map((x) => x.value));

const ITALIAN = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6'];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());

  // Five games; the first is reviewed, with saved analysis for every position.
  const reviewedId = await page.evaluate(async (moves) => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const other = ['d2d4', 'd7d5', 'c2c4', 'e7e6'];
    const g = (white, black, result, played_on, m = other) => post('/api/games', { white, black, result, played_on, moves: m });
    const a = await g('Jason Sharkey', 'Peter Swan', '1-0', '2026-10-05', moves);
    await g('Peter Swan', 'Jason Sharkey', '1-0', '2026-10-04');
    await g('Jason Sharkey', 'Anna Bell', '1/2-1/2', '2026-10-03');
    await g('Anna Bell', 'Peter Swan', '0-1', '2026-10-02');
    await g('Anna Bell', 'Jason Sharkey', '0-1', '2026-10-01');
    // positions of the game, from the board's own move logic
    mpct.game.load(mpct.game.startFen);
    for (const u of moves) mpct.game.play(u.slice(0, 2), u.slice(2, 4), u[4]);
    const fens = [mpct.game.startFen, ...mpct.game.moves.map((m) => m.fen)];
    const cps = [20, 30, 25, 30, 30, 35, 40, -600, 60]; // 4...Bc5?? 5.c3: a big swing to show on the graph
    await post('/api/evals', {
      evals: fens.map((fen, i) => ({
        fen,
        movetime_ms: 1000,
        depth: 18,
        engine: 'test',
        // best move = the move played, except 5.c3?? (best was 5.d3)
        lines: [{ uci: i === 6 ? 'd2d3' : moves[i] ?? 'a2a3', score: { cp: cps[i] }, pv: [i === 6 ? 'd2d3' : moves[i] ?? 'a2a3'] }],
      })),
    });
    const counts = { w: { inaccuracy: 0, mistake: 0, blunder: 0 }, b: { inaccuracy: 0, mistake: 0, blunder: 1 } };
    await post(`/api/game-reviews/${a.id}`, { moves, movetime_ms: 1000, accuracy: { w: 95, b: 60 }, counts, candidates: [] });
    mpct.game.load(mpct.game.startFen);
    return a.id;
  }, ITALIAN);
  await page.reload();
  await settle(page, 600);

  // ---- filters ------------------------------------------------------------------------
  await page.click('#view-games');
  await settle(page);
  check((await rows(page)).length === 5, 'all 5 games listed');
  const players = await page.$$eval('#games-player option', (o) => o.map((x) => x.textContent));
  check(players.join('|') === 'All players|Jason Sharkey (4)|Anna Bell (3)|Peter Swan (3)', 'players by number of games: ' + players.join('|'));
  check(await page.isHidden('#games-color') && (await page.isHidden('#games-clear')), 'no colour filter or Clear without a player');
  check((await options(page, '#games-result')).join(',') === ',white,black,draw,unfinished', 'results by colour without a player');

  await page.selectOption('#games-result', 'white');
  await settle(page);
  check((await rows(page)).length === 2 && (await page.textContent('#games-count')) === '2 games found', 'White won: 2 games');
  await page.selectOption('#games-player', 'Jason Sharkey');
  await settle(page);
  check(await page.isVisible('#games-color'), 'colour filter appears once a player is chosen');
  check((await options(page, '#games-result')).join(',') === ',won,lost,drawn,unfinished', "result options become the player's own");
  check((await page.inputValue('#games-result')) === '', '"White won" dropped when switching to own results');
  check((await rows(page)).length === 4, 'Jason: 4 games');
  await page.selectOption('#games-result', 'won');
  await settle(page);
  const won = await rows(page);
  check(won.length === 2 && won.every((r) => r.includes('Jason')), 'Jason won: 2 games (as White and as Black) ' + JSON.stringify(won));
  await page.selectOption('#games-color', 'black');
  await settle(page);
  check((await rows(page)).join() === 'Anna Bell v Jason Sharkey', 'won as Black: 1 game');
  await page.selectOption('#games-color', '');
  await page.selectOption('#games-result', 'lost');
  await settle(page);
  check((await rows(page)).join() === 'Peter Swan v Jason Sharkey', 'Jason lost: 1 game');
  const href = await page.getAttribute('#games-export', 'href');
  check(href.includes('player=Jason+Sharkey') && href.includes('result=lost'), 'Export PGN uses the filters: ' + href);
  check(await page.isVisible('#games-clear'), 'Clear filters shown');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/games-filters.png` });

  // remembered across a reload
  await page.reload();
  await settle(page, 600);
  await page.click('#view-games');
  await settle(page);
  check((await page.inputValue('#games-player')) === 'Jason Sharkey' && (await page.inputValue('#games-result')) === 'lost' && (await rows(page)).length === 1, 'filters remembered after a reload');

  await page.click('#games-clear');
  await settle(page);
  check((await rows(page)).length === 5 && (await page.isHidden('#games-clear')), 'Clear filters: all games again');
  await page.selectOption('#games-reviewed', 'yes');
  await settle(page);
  check((await rows(page)).join() === 'Jason Sharkey v Peter Swan', 'Reviewed: the one reviewed game');
  await page.selectOption('#games-reviewed', 'no');
  await settle(page);
  check((await rows(page)).length === 4, 'Not reviewed: 4 games');
  await page.selectOption('#games-player', 'Anna Bell');
  await page.selectOption('#games-reviewed', '');
  await page.fill('#games-search', 'peter');
  await settle(page, 700);
  check((await rows(page)).join() === 'Anna Bell v Peter Swan', 'search and filters together');
  await page.fill('#games-search', 'nobody');
  await settle(page, 700);
  check((await page.textContent('#games-empty')) === 'No games in this group match the search and filters.', 'empty message mentions filters');
  await page.fill('#games-search', '');
  await page.click('#games-clear');
  await settle(page, 700);

  // ---- a reviewed game opens with its graph ------------------------------------------
  check(await page.isHidden('#review'), 'no review panel before opening a game');
  const openRow = async (players) => {
    const row = page.locator('.game-row', { has: page.locator('.game-players', { hasText: players }) }).first();
    await row.locator('button:text("Open")').click();
    await settle(page, 800);
  };
  await openRow('Jason Sharkey v Peter Swan');
  check(await page.isVisible('#review'), 'reviewed game: review panel shown');
  const graph = await page.evaluate(() => {
    const svg = document.querySelector('#review-graph svg');
    return svg ? { w: svg.getBoundingClientRect().width, box: document.getElementById('review-graph').clientWidth, paths: svg.querySelectorAll('path, polyline').length } : null;
  });
  check(graph && graph.paths > 0 && Math.abs(graph.w - graph.box) < 4, 'evaluation graph drawn at the panel width: ' + JSON.stringify(graph));
  const marks = await page.$$eval('.move-mark', (m) => m.map((x) => x.textContent));
  check(marks.includes('??'), 'move list marks the blunder: ' + JSON.stringify(marks));
  check((await page.textContent('#review-summary')).length > 0, 'per-side summary shown');
  check(await page.evaluate(() => !mpct.review.running), 'no engine run: saved analysis only');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/reviewed-open.png` });

  // stays after a reload
  await page.reload();
  await settle(page, 1200);
  check(await page.isVisible('#review') && (await page.$('#review-graph svg')) !== null, 'graph still shown after a reload');

  // an unreviewed game: no graph
  await page.click('#view-games');
  await settle(page);
  await openRow('Peter Swan v Jason Sharkey');
  check(await page.isHidden('#review'), 'unreviewed game: no review panel');
  await page.click('#view-games');
  await settle(page);
  await openRow('Jason Sharkey v Peter Swan');
  check(await page.isVisible('#review'), 'back to the reviewed game: graph again');

  // ---- phone ------------------------------------------------------------------------
  const phone = await browser.newPage({ ...devices['Pixel 7'] });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(URL);
  await settle(phone, 600);
  await phone.evaluate(() => localStorage.clear());
  await phone.reload();
  await settle(phone, 600);
  await phone.click('#view-games');
  await settle(phone);
  await phone.selectOption('#games-player', 'Jason Sharkey');
  await settle(phone);
  const fit = await phone.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    selects: [...document.querySelectorAll('.games-filters select')].filter((s) => !s.hidden).map((s) => Math.round(s.getBoundingClientRect().right)),
    vw: window.innerWidth,
  }));
  check(!fit.overflow && fit.selects.every((r) => r <= fit.vw), 'phone: filters fit ' + JSON.stringify(fit));
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/games-filters-phone.png` });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
