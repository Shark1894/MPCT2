// Browser checks for "repertoire in the wild". Needs a server with an EMPTY database started with
// WILD_FETCH=false, and MPCT_DATABASE_URL pointing at the same database (games are loaded with
// app.tools.import_wild_pgn, since the test can't reach Lichess or TWIC).
// Usage: MPCT_URL=http://localhost:8010/ MPCT_DATABASE_URL=postgresql+psycopg://... node tests/e2e/wild.e2e.cjs
const { chromium, devices } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const DB = process.env.MPCT_DATABASE_URL;
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);

const day = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};
const game = (white, black, moves, result, n, event, elo = ['2750', '2740']) =>
  `[Event "${event}"]\n[Site "?"]\n[Date "${day(n)}"]\n[Round "4"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[WhiteElo "${elo[0]}"]\n[BlackElo "${elo[1]}"]\n\n${moves} ${result}\n\n`;

function importPgn(name, pgn) {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, pgn);
  return execFileSync('python3', ['-m', 'app.tools.import_wild_pgn', file], {
    env: { ...process.env, DATABASE_URL: DB },
    cwd: path.resolve(__dirname, '../..'),
  }).toString();
}

(async () => {
  if (!DB) throw new Error('Set MPCT_DATABASE_URL');
  const out = importPgn(
    'wild-e2e-1.pgn',
    game('Carlsen, Magnus', 'Caruana, Fabiano', '1. d4 d5 2. c4 c6 3. Nf3 Bf5 4. cxd5 cxd5 5. Qb3 Nc6 6. Nc3', '1-0', 6, 'Grand Chess Tour') +
      game('Giri, Anish', 'So, Wesley', '1. Nf3 d5 2. d4 c6 3. c4 Bf5 4. e3 e6 5. Nc3 Nd7', '1/2-1/2', 2, 'Tata Steel') +
      game('Nobody, A', 'Nobody, B', '1. e4 e5 2. Nf3 Nc6', '0-1', 1, 'Club Open'),
  );
  check(/3 new/.test(out), 'import tool stores games: ' + out.trim());

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const slav = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Slav', color: 'white' });
    await post(`/api/openings/${slav.id}/lines`, { moves: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'c8f5', 'c4d5'] });
  });
  await page.reload();
  await settle(page, 900);

  // ---- watch from the board -------------------------------------------------------------
  check((await page.isDisabled('#watch-toggle')), 'Watch disabled at the start position');
  await page.evaluate(() => {
    for (const san of ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Bf5']) mpct.game.playSan(san);
    mpct.render();
  });
  await settle(page, 400);
  check((await text(page, '#watch-toggle')) === 'Watch in the wild' && !(await page.isDisabled('#watch-toggle')), 'Watch button offered');
  await page.click('#watch-toggle');
  await settle(page, 700);
  check((await text(page, '#watch-toggle')) === 'In the wild: 2 games', 'watched: 2 games already reach it (one by transposition)');
  check((await page.getAttribute('#watch-toggle', 'aria-pressed')) === 'true', 'button shows the watched state');

  // ---- Wild tab ------------------------------------------------------------------------------
  await page.click('#view-wild');
  await page.waitForSelector('#wild-games .wild-row', { timeout: 5000 });
  check(/turned off/.test(await text(page, '#wild-status-text')) && (await page.isDisabled('#wild-check')), 'status says fetching is off here');
  const watches = await page.$$eval('#wild-watches .wild-watch', (els) => els.map((e) => e.textContent));
  check(watches.length === 1 && /3\.\.\.Bf5/.test(watches[0]) && /2 games/.test(watches[0]), 'watch listed with its game count');
  const rows = await page.$$eval('#wild-games .wild-row', (els) => els.map((e) => e.textContent));
  check(rows.length === 2, 'two spotted games (the e4 game isn’t listed)');
  check(/Giri, Anish \(2750\) – So, Wesley \(2740\)/.test(rows[0]) && /Carlsen/.test(rows[1]), 'newest first, with ratings');
  check(/Reached 3\.\.\.Bf5 at move 3/.test(rows[0]) && /Tata Steel, round 4/.test(rows[0]) && /½–½/.test(rows[0]), 'match, event and result shown');
  if (SHOTS) await page.locator('#wild-view').screenshot({ path: `${SHOTS}/wild-desktop.png` });

  await page.fill('#wild-search', 'carlsen');
  await settle(page, 600);
  check((await page.$$('#wild-games .wild-row')).length === 1, 'search narrows the list');
  await page.fill('#wild-search', '');
  await settle(page, 600);

  // Save to Games, then open on the board
  await page.click('#wild-games .wild-row:first-child button:not(.primary)');
  await settle(page, 600);
  check((await text(page, '#wild-games .wild-row:first-child button:not(.primary)')) === 'Saved ✓', 'saved to Games');
  const saved = await page.evaluate(() => fetch('/api/games').then((r) => r.json()));
  check(saved.length === 1 && saved[0].white === 'Giri, Anish', 'game appears in Games');

  await page.click('#wild-games .wild-row:first-child button.primary');
  await settle(page, 700);
  const at = await page.evaluate(() => ({ ply: mpct.game.ply, total: mpct.game.moves.length, view: !document.querySelector('main.layout').hidden }));
  check(at.view && at.ply === 6 && at.total === 10, `opened on the board at the watched position (ply ${at.ply} of ${at.total})`);
  check((await text(page, '#watch-toggle')) === 'In the wild: 2 games', 'board shows it as watched (transposed move order)');

  // ---- rename, new-games badge, unwatch -----------------------------------------------------
  await page.click('#view-wild');
  await page.waitForSelector('#wild-watches .wild-watch');
  await page.click('#wild-watches .wild-watch button:has-text("Rename")');
  await page.fill('dialog input[name="label"]', 'Slav with Bf5');
  await page.click('dialog button[type="submit"]');
  await settle(page, 600);
  check(/Slav with Bf5/.test(await text(page, '#wild-watches')), 'watch renamed');
  check(/Reached Slav with Bf5 at move 3/.test(await text(page, '#wild-games')), 'games use the new name');

  await page.click('#view-board');
  await page.evaluate(() => localStorage.setItem('mpct.wildSeen', JSON.stringify(new Date().toISOString()))); // seen everything so far
  importPgn('wild-e2e-2.pgn', game('Firouzja, Alireza', 'Gukesh, D', '1. d4 d5 2. c4 c6 3. Nf3 Bf5 4. Qb3 Qb6', '1-0', 0, 'Norway Chess'));
  await page.reload();
  await settle(page, 1200);
  check((await text(page, '#wild-new')) === '1' && !(await page.isHidden('#wild-new')), 'tab shows 1 new game');
  await page.click('#view-wild');
  await settle(page, 800);
  check(await page.isHidden('#wild-new'), 'badge cleared after looking');
  check((await page.$$('#wild-games .wild-row')).length === 3, 'new game listed');

  if (SHOTS) {
    const phone = await browser.newPage({ ...devices['Pixel 7'] });
    await phone.goto(URL);
    await settle(phone, 900);
    await phone.click('#view-wild');
    await phone.waitForSelector('#wild-games .wild-row');
    await phone.screenshot({ path: `${SHOTS}/wild-phone.png` });
    await phone.close();
  }

  await page.click('#wild-watches .wild-watch button:has-text("Unwatch")');
  await page.click('dialog button[type="submit"]');
  await settle(page, 700);
  check(!(await page.isHidden('#wild-watches-empty')) && (await page.$$('#wild-games .wild-row')).length === 0, 'unwatched: lists empty');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})();
