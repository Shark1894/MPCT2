// Browser checks for the Games tab's groups (OTB / Online / Practice / Other) and the board's
// "Your games" explorer. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/mygames.e2e.cjs
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
const rows = (p) => p.$$eval('#games-list .game-row .game-players', (els) => els.map((e) => e.textContent));
const counts = (p) => p.$$eval('#games-groups [data-group]', (els) => els.map((b) => `${b.dataset.group}:${b.querySelector('.meta').textContent}`).join(' '));
const moveRows = (p) => p.$$eval('#mine-moves .mx-move', (els) => els.map((e) => `${e.querySelector('.mx-san').textContent} ${e.querySelector('.mx-count').textContent} ${e.querySelector('.mx-elo').textContent}`));
const sans = (p) => p.evaluate(() => mpct.game.moves.slice(0, mpct.game.ply).map((m) => m.san).join(' '));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(async () => {
    const send = (method, url, body) =>
      fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    await send('PUT', '/api/game-puzzles/names', { names: ['Jason Sharkey'] });
    const g = (white, black, moves, result, played_on, category) => send('POST', '/api/games', { white, black, moves, result, played_on, category });
    await g('Jason Sharkey', 'Ally McLellan', ['e2e4', 'c7c5', 'g1f3', 'd7d6'], '1-0', '2026-01-10', 'otb');
    await g('Tom Brisbane', 'Jason Sharkey', ['e2e4', 'c7c5', 'b1c3'], '1/2-1/2', '2026-02-10', 'otb');
    await g('Jason Sharkey', 'Cat Moore', ['e2e4', 'e7e5'], '0-1', '2026-03-10', 'otb');
    await g('JasonS', 'LichessOpp', ['e2e4', 'e7e5', 'g1f3'], '1-0', '2026-04-01', 'online');
    await g('Jason Sharkey', 'Stockfish level 3', ['d2d4'], '0-1', '2026-04-02', 'practice');
    await g('Carlsen, Magnus', 'Caruana, Fabiano', ['e2e4', 'c7c6'], '1-0', '2018-11-09', 'other');
  });
  await page.reload();
  await settle(page, 800);

  // ---- Games tab: one group at a time ---------------------------------------------------------
  await page.click('#view-games');
  await settle(page, 700);
  check((await counts(page)) === 'otb:3 online:1 practice:1 other:1', 'group counts: ' + (await counts(page)));
  check((await page.getAttribute('#games-groups [data-group=otb]', 'aria-selected')) === 'true', 'OTB shown first');
  check(JSON.stringify(await rows(page)) === JSON.stringify(['Jason Sharkey v Cat Moore', 'Tom Brisbane v Jason Sharkey', 'Jason Sharkey v Ally McLellan']), 'only OTB games: ' + (await rows(page)));
  const players = await page.$$eval('#games-player option', (os) => os.map((o) => o.value).filter(Boolean));
  check(!players.includes('Carlsen, Magnus') && players.includes('Ally McLellan'), 'player filter lists only this group');
  await page.click('#games-groups [data-group=other]');
  await settle(page, 600);
  check(JSON.stringify(await rows(page)) === JSON.stringify(['Carlsen, Magnus v Caruana, Fabiano']), 'Other group');
  check((await page.getAttribute('#games-export', 'href')).includes('category=other'), 'export follows the group');
  await page.click('#games-groups [data-group=practice]');
  await settle(page, 600);
  check(JSON.stringify(await rows(page)) === JSON.stringify(['Jason Sharkey v Stockfish level 3']), 'Practice group');
  await page.reload();
  await settle(page, 800);
  await page.click('#view-games');
  await settle(page, 600);
  check((await page.getAttribute('#games-groups [data-group=practice]', 'aria-selected')) === 'true', 'group remembered after reload');

  // ---- Import PGN into a group; New game defaults to the shown group -----------------------
  await page.click('#games-groups [data-group=otb]');
  await settle(page, 500);
  await page.click('#games-import');
  check((await page.inputValue('dialog[open] select[name=category]')) === 'otb', 'import dialog: group defaults to the shown one');
  await page.selectOption('dialog[open] select[name=category]', 'online');
  await page.fill('dialog[open] textarea[name=pgn]', '[White "JasonS"]\n[Black "Opp2"]\n[Date "2026.05.01"]\n[Result "*"]\n\n1. d4 d5 *\n');
  await page.click('dialog[open] button[type=submit]');
  await settle(page, 900);
  check((await page.getAttribute('#games-groups [data-group=online]', 'aria-selected')) === 'true', 'switches to the group imported into');
  check((await rows(page)).includes('JasonS v Opp2'), 'imported game in Online');

  // ---- move a game to another group from its panel ------------------------------------------
  await page.click('#games-groups [data-group=practice]');
  await settle(page, 500);
  await page.click('#games-list .game-row button.primary');
  await settle(page, 800);
  check((await page.inputValue('#game-category')) === 'practice', 'panel shows the group');
  await page.selectOption('#game-category', 'otb');
  await settle(page, 200);
  check(!(await page.isDisabled('#game-save')), 'changing the group is a change to save');
  await page.click('#game-save');
  await settle(page, 600);
  await page.click('#game-close');
  await page.click('#view-games');
  await settle(page, 700);
  check((await counts(page)).startsWith('otb:4') && (await counts(page)).includes('practice:0'), 'game moved to OTB: ' + (await counts(page)));
  check((await text(page, '#games-empty')).includes('practice games against the engine'), 'empty group explained');
  // move it back so the explorer counts below stay simple
  await page.evaluate(async () => {
    const g = (await fetch('/api/games?category=otb').then((r) => r.json())).find((x) => x.black === 'Stockfish level 3');
    await fetch(`/api/games/${g.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'practice' }) });
  });

  // ---- Your games explorer on the board ------------------------------------------------------
  await page.click('#view-board');
  await settle(page, 500);
  await page.evaluate(() => {
    mpct.game.load('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'); // the closed game left 1.d4 on the board
    mpct.render();
  });
  check(await page.isVisible('#mine-box summary'), 'Your games section on the board');
  check(!(await page.evaluate(() => document.getElementById('mine-box').open)), 'closed by default');
  await page.click('#mine-box summary');
  await settle(page, 900);
  check((await text(page, '#mine-total')) === '3 games', 'OTB games from the start: ' + (await text(page, '#mine-total')));
  check(JSON.stringify(await moveRows(page)) === JSON.stringify(['e4 3 · 100% +1 =1 −1']), 'moves with your score: ' + JSON.stringify(await moveRows(page)));
  check((await text(page, '#mine-score')) === 'You +1 =1 −1 from here', 'score line');
  await page.click('#mine-moves .mx-move');
  await settle(page, 900);
  check((await sans(page)) === 'e4', 'tapping a move plays it');
  check(JSON.stringify(await moveRows(page)) === JSON.stringify(['c5 2 · 67% +1 =1 −0', 'e5 1 · 33% +0 =0 −1']), 'after 1.e4: ' + JSON.stringify(await moveRows(page)));
  const gamesList = await page.$$eval('#mine-games .mx-game', (els) => els.map((e) => e.textContent));
  check(gamesList.length === 3 && gamesList[0].includes('Cat Moore') && gamesList[0].includes('played e5'), 'games newest first, with the move played: ' + gamesList[0]);

  // ---- include online -------------------------------------------------------------------------
  await page.check('#mine-online');
  await settle(page, 900);
  check((await text(page, '#mine-total')) === '4 games', 'online switch adds the online game');
  check((await page.$$eval('#mine-games .mx-game', (els) => els.map((e) => e.textContent))).some((t) => t.includes('online')), 'online game marked');
  await page.uncheck('#mine-online');
  await settle(page, 700);
  check((await text(page, '#mine-total')) === '3 games', 'and off again');

  // ---- open a game at the position --------------------------------------------------------
  await page.click('#mine-games .mx-game >> nth=2'); // Jason v Ally, 1.e4 c5 2.Nf3 d6
  await settle(page, 900);
  check(await page.isVisible('#game-panel') && (await text(page, '#game-title')).includes('Ally McLellan'), 'game opened in the panel');
  check((await sans(page)) === 'e4', 'at the explorer position (after 1.e4)');
  check((await page.evaluate(() => mpct.game.moves.length)) === 4, 'whole game loaded');

  // ---- empty position and transposition-free note -----------------------------------------
  await page.click('#game-close');
  await settle(page, 300);
  await page.evaluate(() => {
    mpct.game.load('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    mpct.game.playSan('h4');
    mpct.render();
  });
  await settle(page, 900);
  check((await text(page, '#mine-status')) === 'Not reached in your OTB games.', 'unknown position explained');

  // ---- hidden while training --------------------------------------------------------------
  check(await page.evaluate(() => { mpct.myGames.update(mpct.game.fen(), true); return document.getElementById('mine-box').hidden; }), 'hidden when locked');
  await page.evaluate(() => mpct.myGames.update(mpct.game.fen(), false));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mygames-desktop.png` });

  // ---- phone ----------------------------------------------------------------------------------
  const phone = await browser.newPage({ ...devices['Pixel 7'] });
  phone.on('pageerror', (e) => errors.push('phone: ' + e));
  await phone.goto(URL);
  await settle(phone, 800);
  await phone.click('#view-games');
  await settle(phone, 700);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, 'phone: group tabs fit: ' + overflow);
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/mygames-phone-games.png` });
  await phone.click('#view-board');
  await settle(phone, 500);
  await phone.click('#mine-box summary');
  await settle(phone, 900);
  check((await phone.$$('#mine-moves .mx-move')).length === 1, 'phone: explorer works');
  const overflow2 = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow2 <= 0, 'phone: board view fits: ' + overflow2);
  if (SHOTS) {
    await phone.$eval('#mine-box', (e) => e.scrollIntoView());
    await phone.screenshot({ path: `${SHOTS}/mygames-phone-board.png` });
  }

  check(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await browser.close();
})();
