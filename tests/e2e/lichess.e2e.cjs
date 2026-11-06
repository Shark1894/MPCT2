// Browser checks for the Lichess game import (Games tab). Needs a server with an EMPTY database,
// started with LICHESS_API_URL pointing at the fake Lichess (tests/e2e/fake_explorer.py):
//   python tests/e2e/fake_explorer.py 8099 &
//   LICHESS_API_URL=http://127.0.0.1:8099 uvicorn app.main:app --port 8010
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/lichess.e2e.cjs
const { chromium, devices } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const FAKE = process.env.FAKE_EXPLORER || 'http://127.0.0.1:8099';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);
const log = () => fetch(`${FAKE}/log`).then((r) => r.json());
const sans = (p) => p.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '));
const row = (id) => `.lichess-row[data-id="${id}"]`;

async function answerUsername(page, name) {
  await page.waitForSelector('dialog[open] input[name=username]');
  await page.fill('dialog[open] input[name=username]', name);
  await page.click('dialog[open] button[type=submit]');
  await settle(page, 700);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d|status of 50\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 600);
  await page.click('#view-games');
  await settle(page);

  // ---- first use asks for the username; an unknown one says so --------------------------------
  check(await page.isVisible('#games-lichess'), 'From Lichess button in the Games tab');
  check(await page.isHidden('#lichess-box'), 'Lichess box closed at first');
  const before = (await log()).length;
  await page.click('#games-lichess');
  await answerUsername(page, 'nobody99');
  check(await page.isVisible('#lichess-box'), 'box opens after the username is set');
  check((await text(page, '#lichess-status')).includes('Lichess has no player called nobody99'), 'unknown user: ' + (await text(page, '#lichess-status')));
  check((await text(page, '#lichess-user')) === 'as nobody99', 'shows the username');

  // ---- change it: the recent games list ---------------------------------------------------------
  await page.click('#lichess-change');
  await answerUsername(page, 'JasonS');
  await settle(page, 400);
  const ids = await page.$$eval('.lichess-row', (els) => els.map((e) => e.dataset.id));
  check(JSON.stringify(ids) === '["lgame003","lgame002","lgame001","lgame000"]', 'newest first: ' + ids);
  check((await text(page, '#lichess-status')) === 'Your last 4 games on Lichess · 3 not in Games yet', 'status: ' + (await text(page, '#lichess-status')));
  check((await text(page, `${row('lgame003')} .game-result`)) === 'Won', 'result from your side (won as Black)');
  check((await text(page, `${row('lgame000')} .game-result`)) === 'Lost', 'lost game');
  check((await text(page, `${row('lgame002')} .game-result`)) === 'Drawn', 'drawn game');
  check((await text(page, `${row('lgame003')} .game-players`)) === 'Opponent2 (1850) v JasonS (1790)', 'players with ratings');
  check((await text(page, `${row('lgame003')} .game-sub`)).startsWith('Blitz 3+2 · rated · Caro-Kann Defense'), 'details: ' + (await text(page, `${row('lgame003')} .game-sub`)));
  check(await page.$eval(`${row('lgame001')} button`, (b) => b.disabled), 'Chess960 game cannot be opened');
  check((await text(page, row('lgame001'))).includes("Chess960 games can't be imported"), 'says why');
  check((await page.getAttribute(`${row('lgame003')} a`, 'href')) === 'https://lichess.org/lgame003/black', 'Lichess link from your side');
  check(!(await page.isHidden('#lichess-import-new')) && (await text(page, '#lichess-import-new')) === 'Import 3 new games', 'Import new games button');
  const names = await page.evaluate(() => fetch('/api/game-puzzles/status').then((r) => r.json()).then((s) => s.names));
  check(names.includes('JasonS'), 'username joins your names: ' + names);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lichess-desktop.png`, fullPage: true });

  // ---- Open imports the game and shows it on the board -------------------------------------
  await page.click(`${row('lgame002')} button`);
  await settle(page, 900);
  check(await page.evaluate(() => document.getElementById('games-view').hidden), 'switched to the board');
  check((await sans(page)) === 'd4 d5 c4 e6', 'moves on the board: ' + (await sans(page)));
  check((await text(page, '#game-title')).startsWith('JasonS v Opponent1'), 'game panel: ' + (await text(page, '#game-title')));
  check((await text(page, '#game-source')) === 'Imported from Lichess · View on lichess.org', 'source line: ' + (await text(page, '#game-source')));
  check((await page.inputValue('#game-competition')) === 'Lichess · Blitz 3+2 · rated', 'competition: ' + (await page.inputValue('#game-competition')));
  check(await page.isDisabled('#game-save'), 'opens saved (nothing to save)');

  // ---- back on Games: the box is still open and marks it -------------------------------------
  await page.click('#view-games');
  await settle(page, 900);
  check(await page.isVisible('#lichess-box'), 'box stays open');
  check((await text(page, row('lgame002'))).includes('✓ In your Games'), 'imported game marked');
  check((await text(page, '#lichess-status')).endsWith('2 not in Games yet'), 'count updated');
  check((await page.$$('#games-list .game-row')).length === 1, 'one game in Games');
  await page.click(`${row('lgame002')} button`); // again: the same copy
  await settle(page, 700);
  await page.click('#view-games');
  await settle(page, 900);
  check((await page.$$('#games-list .game-row')).length === 1, 'opening again makes no copy');

  // ---- Open latest ----------------------------------------------------------------------------
  await page.click('#lichess-latest');
  await settle(page, 900);
  check((await sans(page)) === 'e4 c6 d4 d5 e5 Bf5 Nf3 e6', 'latest game on the board: ' + (await sans(page)));
  check((await text(page, '#game-title')).startsWith('Opponent2 v JasonS'), 'latest game details');

  // ---- Import new games ----------------------------------------------------------------------
  await page.click('#view-games');
  await settle(page, 900);
  check((await text(page, '#lichess-import-new')) === 'Import 1 new game', 'one left: ' + (await text(page, '#lichess-import-new')));
  await page.click('#lichess-import-new');
  await settle(page, 900);
  check((await page.$$('#games-list .game-row')).length === 3, 'three games in Games');
  check(await page.isHidden('#lichess-import-new'), 'nothing left to import');
  check((await text(page, '#lichess-status')).endsWith('all in Games'), 'all in Games');
  const exports = (await log()).slice(before).filter((x) => x.startsWith('game:'));
  check(JSON.stringify(exports) === '["game:lgame002"]', 'only Open by id fetches a single game: ' + exports);

  // ---- Close, and reload keeps the choice --------------------------------------------------
  await page.click('#lichess-close');
  check(await page.isHidden('#lichess-box'), 'Close hides the box');
  await page.reload();
  await settle(page, 800);
  await page.click('#view-games');
  await settle(page, 600);
  check(await page.isHidden('#lichess-box'), 'stays closed after reload');
  await page.click('#games-lichess');
  await settle(page, 800);
  check(await page.isVisible('#lichess-box') && (await page.$$('.lichess-row')).length === 4, 'opens straight away once the username is known');
  check(!(await page.isVisible('dialog[open]')), 'no username question the second time');

  // ---- phone ----------------------------------------------------------------------------------
  const phone = await browser.newPage({ ...devices['Pixel 7'] });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(URL);
  await settle(phone, 800);
  await phone.click('#view-games');
  await settle(phone, 600);
  await phone.click('#games-lichess');
  await settle(phone, 900);
  check(await phone.isVisible('#lichess-box') && (await phone.$$('.lichess-row')).length === 4, 'phone: box opens with the games');
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, 'phone: no sideways scrolling: ' + overflow);
  const spill = await phone.$$eval('.lichess-row', (els) =>
    els.filter((r) => [...r.querySelectorAll('*')].some((c) => c.getBoundingClientRect().right > r.getBoundingClientRect().right + 0.5)).length,
  );
  check(spill === 0, 'phone: nothing sticks out of a row');
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/lichess-phone.png`, fullPage: true });

  check(errors.length === 0, 'no page errors: ' + errors.join(' | '));
  await browser.close();
})();
