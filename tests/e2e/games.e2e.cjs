// Browser checks for the games database. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/games.e2e.cjs
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
const sans = (p) => p.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '));

const PGN = `[Event "Glasgow League"]
[Site "?"]
[Date "2025.02.27"]
[Round "?"]
[White "Tom Brisbane"]
[Black "Jason Sharkey"]
[WhiteTeam "East Kilbride"]
[BlackTeam "Stepps"]
[Result "1/2-1/2"]

1. d4 d5 2. c4 dxc4 3. e4 e5 1/2-1/2

[Event "Club night"]
[Date "2025.03.01"]
[White "Jason Sharkey"]
[Black "Ally McLellan"]
[Result "1-0"]

1. e4 c5 2. Nf3 d6 1-0

[Event "Broken"]
[White "Bad"]
[Black "Game"]
[Result "*"]

1. e4 e5 2. Ke3 Ke6 *
`;

async function submitDialog(p) {
  await p.click('dialog button[type=submit]');
  await settle(p, 700);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 700);

  // ---- empty Games tab ------------------------------------------------------
  await page.click('#view-games');
  await settle(page);
  check(await page.isVisible('#games-view') && (await page.isHidden('main.layout')), 'Games tab replaces the board');
  check((await text(page, '#games-empty')).includes('No games yet'), 'empty state explains how to add games');

  // ---- import PGN ---------------------------------------------------------------
  await page.click('#games-import');
  await page.fill('dialog textarea[name=pgn]', PGN);
  await submitDialog(page);
  check((await text(page, '#toast')).includes('Imported 2 games'), 'two valid games imported');
  check((await text(page, 'dialog h2')).includes('1 game couldn’t be imported') && (await text(page, 'dialog .modal-message')).includes('Bad v Game'), 'bad game reported');
  await page.click('dialog button[type=submit]');
  await settle(page);
  const list = await rows(page);
  check(JSON.stringify(list) === JSON.stringify(['Jason Sharkey v Ally McLellan', 'Tom Brisbane (East Kilbride) v Jason Sharkey (Stepps)']), 'newest first, with teams: ' + list);
  const sub = await text(page, '#games-list .game-row:nth-child(2) .game-sub');
  check(sub.includes('Glasgow League') && sub.includes('1.d4 d5 2.c4 dxc4 3.e4 e5') && sub.includes('3 moves'), 'competition, opening and length shown: ' + sub);
  check((await text(page, '#games-list .game-row:nth-child(2) .game-result')) === '½-½', 'draw shown as ½-½');

  await page.click('#games-import');
  await page.fill('dialog textarea[name=pgn]', PGN);
  await submitDialog(page);
  check((await text(page, '#toast')).includes('Imported 0 games, 2 already in the app'), 're-import skips duplicates');
  await page.click('dialog button[type=submit]'); // dismiss the error list again
  await settle(page);

  // ---- search ----------------------------------------------------------------------
  await page.fill('#games-search', 'kilbride');
  await settle(page, 700);
  check(JSON.stringify(await rows(page)) === JSON.stringify(['Tom Brisbane (East Kilbride) v Jason Sharkey (Stepps)']), 'search by team');
  check((await page.getAttribute('#games-export', 'href')).includes('q=kilbride'), 'export follows the search');
  await page.fill('#games-search', '');
  await settle(page, 700);

  // ---- new game from the moves on the board -----------------------------------------
  await page.click('#view-board');
  await page.evaluate(() => {
    for (const s of ['e4', 'e5', 'Nf3', 'Nc6']) mpct.game.playSan(s);
    mpct.render();
  });
  await page.click('#view-games');
  await settle(page);
  await page.click('#games-new');
  await page.fill('dialog input[name=white]', 'Jason Sharkey');
  await page.fill('dialog input[name=white_team]', 'Stepps');
  await page.fill('dialog input[name=black]', 'Peter Swan');
  await page.fill('dialog input[name=competition]', 'GCL2');
  await page.fill('dialog input[name=played_on]', '2024-12-16');
  check((await page.$eval('dialog select[name=moves_from] option:checked', (o) => o.textContent)) === 'Use the 4 moves on the board', 'offers the moves on the board');
  await submitDialog(page);
  check(await page.isVisible('main.layout') && (await page.isVisible('#game-panel')), 'new game opens on the board with the game panel');
  check((await text(page, '#game-title')) === 'Jason Sharkey (Stepps) v Peter Swan · *', 'game title: ' + (await text(page, '#game-title')));
  check((await sans(page)) === 'e4 e5 Nf3 Nc6' && (await page.isDisabled('#game-save')), 'moves kept; nothing unsaved yet');

  // ---- edit, save, reload -------------------------------------------------------------
  await page.evaluate(() => {
    mpct.game.playSan('Bb5');
    mpct.render();
  });
  check(await page.isVisible('#game-dirty') && !(await page.isDisabled('#game-save')), 'playing a move marks the game unsaved');
  await page.selectOption('#game-result', '1-0');
  check((await text(page, '#game-title')).endsWith('· 1-0'), 'title follows the details');
  await page.click('#game-save');
  await settle(page);
  check((await text(page, '#toast')) === 'Game saved' && (await page.isHidden('#game-dirty')), 'saved');
  await page.reload();
  await settle(page, 1200);
  check(await page.isVisible('#game-panel') && (await sans(page)) === 'e4 e5 Nf3 Nc6 Bb5', 'open game reopened after a reload, from the server');
  check((await page.inputValue('#game-played-on')) === '2024-12-16' && (await page.inputValue('#game-result')) === '1-0', 'details reloaded');

  // ---- compare with the repertoire -----------------------------------------------------
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const o = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Italian', color: 'white' });
    await post(`/api/openings/${o.id}/lines`, { moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'] });
  });
  await page.reload();
  await settle(page, 1200);
  await page.click('#game-compare');
  await settle(page);
  const cmp = await text(page, '#game-compare-result p');
  check(cmp === 'You left Italian with 3.Bb5. Repertoire: Bc4.', 'compare: ' + cmp);
  await page.click('#game-compare-result button');
  await settle(page);
  check((await page.evaluate(() => mpct.game.ply)) === 4, 'Show that position jumps to before the deviation');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/games-board.png` });

  // ---- PGN download ---------------------------------------------------------------------
  const pgn = await page.evaluate(async () => (await fetch(document.getElementById('game-pgn').href)).text());
  check(pgn.includes('[White "Jason Sharkey"]') && pgn.includes('[WhiteTeam "Stepps"]') && pgn.includes('1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0'), 'PGN download');

  // ---- unsaved changes are protected ------------------------------------------------------
  await page.fill('#game-black', 'Pete Swan');
  await page.click('#game-close');
  await page.waitForSelector('dialog[open]');
  check((await text(page, 'dialog h2')) === 'Discard unsaved changes?', 'closing with unsaved changes asks first');
  await page.click('dialog button:text("Cancel")');
  await settle(page);
  check(await page.isVisible('#game-panel'), 'cancel keeps the game open');
  await page.click('#train-due');
  await page.waitForSelector('dialog[open]');
  await submitDialog(page); // discard
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  check(await page.isHidden('#game-panel') && (await page.isDisabled('#view-games')), 'training closes the game (after confirming) and locks the Games tab');
  await page.click('#train-stop');
  await settle(page);

  // ---- delete -----------------------------------------------------------------------------
  await page.click('#view-games');
  await settle(page);
  await page.locator('.game-row', { hasText: 'Peter Swan' }).locator('button', { hasText: 'Open' }).click();
  await settle(page, 800);
  check((await page.inputValue('#game-black')) === 'Peter Swan', 'unsaved name change was discarded');
  await page.click('#view-games');
  await settle(page);
  check(await page.locator('.game-row.open').count() === 1, 'open game highlighted in the list');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/games-list.png` });
  await page.locator('.game-row', { hasText: 'Peter Swan' }).locator('button', { hasText: 'Delete' }).click();
  await submitDialog(page);
  check((await rows(page)).length === 2, 'game deleted');
  await page.click('#view-board');
  await settle(page);
  check(await page.isHidden('#game-panel'), 'deleting the open game closes it');

  // ---- phone ----------------------------------------------------------------------------------
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await ctx.newPage();
  mp.on('pageerror', (e) => errors.push('phone: ' + e));
  await mp.goto(URL);
  await settle(mp, 700);
  await mp.click('#view-games');
  await settle(mp);
  check((await rows(mp)).length === 2, 'phone: games listed');
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: games list has no horizontal overflow');
  if (SHOTS) await mp.screenshot({ path: `${SHOTS}/games-phone-list.png`, fullPage: true });
  await mp.locator('.game-row', { hasText: 'Tom Brisbane' }).locator('button', { hasText: 'Open' }).click();
  await settle(mp, 800);
  const order = await mp.evaluate(() =>
    ['.controls', '.engine', '.game', '.repertoire'].map((s) => document.querySelector(s).getBoundingClientRect().top),
  );
  check(order.every((v, i) => i === 0 || v > order[i - 1]), 'phone: game panel after the engine, before the repertoire');
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: board view has no horizontal overflow');

  // ---- import several PGN files at once --------------------------------------------------------
  await page.click('#view-games');
  await settle(page);
  const before = (await rows(page)).length;
  const pgnText = (white, black, date, moves) => `[Event "Club"]\n[Date "${date}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "*"]\n\n${moves} *\n`;
  const fileA = pgnText('Ann One', 'Bob Two', '2026.10.01', '1. e4 c5') + '\n' + pgnText('Cat Three', 'Dan Four', '2026.10.02', '1. d4 Nf6');
  const fileB = pgnText('Eve Five', 'Fay Six', '2026.10.03', '1. c4 e5');
  await page.click('#games-import');
  await page.waitForSelector('dialog[open] input[type=file]', { state: 'attached' });
  check((await text(page, 'dialog[open] .modal-field button')) === 'Choose files…', 'file button says files');
  await page.setInputFiles('dialog[open] input[type=file]', [
    { name: 'a.pgn', mimeType: 'text/plain', buffer: Buffer.from(fileA) },
    { name: 'b.pgn', mimeType: 'text/plain', buffer: Buffer.from(fileB) },
    { name: 'c.pgn', mimeType: 'text/plain', buffer: Buffer.from(fileA) }, // the same games again
  ]);
  await settle(page, 400);
  check((await text(page, 'dialog[open] .modal-files')) === '3 files: a.pgn, b.pgn, c.pgn', 'chosen files listed');
  check((await page.inputValue('dialog[open] textarea[name=pgn]')).split('[Event ').length - 1 === 5, 'all files loaded into the box');
  await submitDialog(page);
  check((await text(page, '#toast')).includes('Imported 3 games, 2 already in the app'), 'three files imported together: ' + (await text(page, '#toast')));
  check((await rows(page)).length === before + 3, 'three new games listed');

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
