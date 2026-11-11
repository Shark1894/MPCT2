// Browser checks for the puzzles' openings filter: one of your openings, or a Lichess opening.
// Needs a server with an EMPTY database and MPCT_DATABASE_URL pointing at the same database
// (the puzzles are loaded with app.tools.import_puzzles).
// Usage: MPCT_URL=http://localhost:8010/ MPCT_DATABASE_URL=postgresql+psycopg://... node tests/e2e/puzzleopenings.e2e.cjs
const { chromium } = require('playwright');
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

// One real Lichess position (0000D) under three ids with different opening tags.
const POS = '5rk1/1p3ppp/pq3b2/8/8/1P1Q1N2/P4PPP/3R2K1 w - - 2 27,d3d6 f8d8 d6d8 f6d8';
const CSV = [
  'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate',
  `0caro,${POS},1500,74,96,25000,advantage endgame short,https://lichess.org/a#53,Caro-Kann_Defense Caro-Kann_Defense_Advance_Variation,`,
  `0cpan,${POS},1500,74,96,25000,advantage endgame short,https://lichess.org/b#53,Caro-Kann_Defense Caro-Kann_Defense_Panov_Attack,`,
  `0none,${POS},1500,74,96,25000,advantage endgame short,https://lichess.org/c#53,,`,
].join('\n');

const waitTurn = (p) => p.waitForFunction(() => mpct.puzzles.canMove(), null, { timeout: 5000 });
const currentId = (p) => p.evaluate(() => mpct.puzzles.run.puzzle.id);
const openRated = async (p) => {
  await p.click('#view-courses');
  await p.evaluate(() => mpct.coursesView.go({ view: 'puzzles', which: 'rated' }));
  await settle(p, 800);
};
const stop = async (p) => {
  await p.click('#puzzle-stop');
  await settle(p, 300);
};

(async () => {
  if (!DB) throw new Error('Set MPCT_DATABASE_URL');
  const file = path.join(os.tmpdir(), 'puzzle-openings-e2e.csv');
  fs.writeFileSync(file, CSV);
  const out = execFileSync('python3', ['-m', 'app.tools.import_puzzles', file], { env: { ...process.env, DATABASE_URL: DB }, cwd: path.resolve(__dirname, '../..') }).toString();
  check(/Imported 3 puzzles/.test(out), 'import tool: ' + out.trim());

  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 800);

  // A Black Caro-Kann (Advance) and a White opening with no lines yet
  const ids = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const caro = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro', color: 'black' });
    const lon = await post(`/api/repertoires/${rep.id}/openings`, { name: 'London', color: 'white' });
    await post(`/api/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'] });
    return { caro: caro.id, lon: lon.id };
  });

  // ---- the picker -------------------------------------------------------------------------------
  await openRated(page);
  const groups = await page.$$eval('#pz-opening optgroup', (gs) => gs.map((g) => `${g.label}: ${[...g.children].map((o) => o.textContent).join(',')}`));
  check(groups.join(' | ') === 'Your openings · White: London | Your openings · Black: Caro', 'your openings grouped by colour: ' + groups.join(' | '));
  const last = await page.$eval('#pz-opening', (s) => s.options[s.options.length - 1].value);
  check(last === 'lichess' && (await page.isHidden('#pz-opening-search-label')) && (await page.isHidden('#pz-opening-note')), 'Lichess option last; search and note hidden at Any opening');
  const names = await page.$$eval('#pz-opening-names option', (o) => o.length);
  check(names > 1000, `Lichess openings to search (${names})`);

  await page.selectOption('#pz-opening', `o:${ids.lon}`);
  check(/None of its lines reach a named Lichess opening/.test(await text(page, '#pz-opening-note')), 'an opening with no lines says it has no puzzles');
  await page.selectOption('#pz-opening', `o:${ids.caro}`);
  const note = await text(page, '#pz-opening-note');
  check(/Puzzles from games in: .*Caro-Kann Defense: Advance Variation/.test(note), 'your opening shows the Lichess openings it matches: ' + note);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/puzzle-openings-mine.png` });

  // ---- puzzles from your opening ----------------------------------------------------------------
  await page.click('#pz-start');
  await waitTurn(page);
  check((await currentId(page)) === '0caro', 'your opening: a puzzle from a Caro-Kann Advance game');
  await page.click('#puzzle-skip');
  await settle(page, 300);
  await page.evaluate(() => mpct.puzzles.next());
  await settle(page, 700);
  check(/No untried puzzles left in your Caro/.test(await text(page, '#puzzle-message')), 'then says none are left in your opening');
  await stop(page);

  // ---- a Lichess opening ------------------------------------------------------------------------
  await openRated(page);
  await page.selectOption('#pz-opening', 'lichess');
  check(!(await page.isHidden('#pz-opening-search-label')), 'search box shown for a Lichess opening');
  check(/Type to search/.test(await text(page, '#pz-opening-note')), 'asks to type and pick');
  await page.fill('#pz-opening-search', 'Caro-Kann');
  await page.dispatchEvent('#pz-opening-search', 'change');
  await page.click('#pz-start');
  await settle(page, 500);
  check(await page.isHidden('#puzzle'), 'a name not in the list doesn’t start puzzles');
  await page.fill('#pz-opening-search', 'caro-kann defense: panov attack');
  await page.dispatchEvent('#pz-opening-search', 'change');
  check((await text(page, '#pz-opening-note')) === 'Puzzles from games in the Caro-Kann Defense: Panov Attack.', 'variation note: ' + (await text(page, '#pz-opening-note')));
  await page.click('#pz-start');
  await waitTurn(page);
  check((await currentId(page)) === '0cpan', 'Lichess variation: the Panov puzzle');
  await stop(page);

  // Remembered after a reload, and shown on the Training hub
  await page.reload();
  await settle(page, 800);
  await openRated(page);
  check((await page.$eval('#pz-opening', (s) => s.value)) === 'lichess' && (await page.inputValue('#pz-opening-search')) === 'Caro-Kann Defense: Panov Attack', 'choice remembered');
  await page.evaluate(() => mpct.coursesView.go({ view: 'hub' }));
  await settle(page, 800);
  const hub = await text(page, '.tr-pz-opening');
  check(/Opening: Caro-Kann Defense: Panov Attack/.test(hub), 'hub shows the opening filter: ' + hub);

  // A whole family, from the hub's Start (uses the saved filter)
  await page.click('.tr-pz-opening button');
  await settle(page, 800);
  await page.fill('#pz-opening-search', 'Caro-Kann Defense');
  await page.dispatchEvent('#pz-opening-search', 'change');
  check(/any Caro-Kann Defense line/.test(await text(page, '#pz-opening-note')), 'family note');
  await page.evaluate(() => mpct.coursesView.go({ view: 'hub' }));
  await settle(page, 800);
  await page.click('#tr-theme ~ button, .tr-row:has(#tr-theme) button');
  await waitTurn(page);
  check(['0caro', '0cpan'].includes(await currentId(page)), 'hub Start uses the saved family filter');
  await stop(page);

  // Back to any opening: the untagged puzzle can come up again
  await openRated(page);
  await page.selectOption('#pz-opening', '');
  await page.click('#pz-start');
  await waitTurn(page);
  check(['0caro', '0cpan', '0none'].includes(await currentId(page)), 'Any opening');
  await stop(page);

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
