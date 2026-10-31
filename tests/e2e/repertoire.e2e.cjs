// Browser checks for the repertoire panel. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/repertoire.e2e.cjs
const { chromium, devices } = require('playwright');

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
    await page.waitForTimeout(120);
  }
}

const explorerSans = (page) => page.$$eval('#explorer .explorer-move .san', (els) => els.map((e) => e.textContent));
const settle = (page) => page.waitForTimeout(400);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  // The duplicate-name check below triggers an expected 409, which the browser logs.
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('409') && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page);

  check(await page.isDisabled('#line-add'), 'add line disabled before any opening exists');

  // Create repertoire + opening through the dialogs
  await page.click('#rep-new');
  await page.fill('dialog input[name=name]', 'Main');
  await page.click('dialog button[type=submit]');
  await settle(page);
  check((await page.$eval('#rep-select option:checked', (o) => o.textContent)) === 'Main', 'repertoire created and selected');

  await page.click('#opening-new');
  await page.fill('dialog input[name=name]', 'Caro-Kann');
  await page.selectOption('dialog select[name=color]', 'black');
  await page.click('dialog button[type=submit]');
  await settle(page);
  check((await page.textContent('#opening-info')).startsWith('Black · 0 lines'), 'opening created: ' + (await page.textContent('#opening-info')));
  check((await page.evaluate(() => mpct.board.orientation())) === 'black', 'board oriented to the opening colour');

  // Add a line, then the explorer shows it from the start
  await play(page, 'e2e4', 'c7c6', 'd2d4', 'd7d5');
  await page.click('#line-add');
  await settle(page);
  check((await page.textContent('#toast')).includes('Added a new line'), 'toast after adding a line');
  check((await page.textContent('#opening-info')).includes('1 line'), 'opening info updated');
  await page.click('#nav-start');
  await settle(page);
  check(JSON.stringify(await explorerSans(page)) === '["e4"]', 'explorer shows e4 at the start');
  check((await page.evaluate(() => mpct.board.cg.state.drawable.autoShapes.length)) === 1, 'explorer move drawn as an arrow');

  // Clicking an explorer move plays it
  await page.click('#explorer .explorer-move');
  await settle(page);
  check((await page.evaluate(() => mpct.game.ply)) === 1 && JSON.stringify(await explorerSans(page)) === '["c6"]', 'clicking explorer move plays it');

  // Branch: 3.e5 and 3.Nc3 lines
  await page.click('#nav-end');
  await play(page, 'e4e5');
  await page.click('#line-add');
  await settle(page);
  check((await page.textContent('#toast')).includes('Extended a line by 1 move'), 'extending a line');
  await page.click('.move >> text=d5');
  await play(page, 'b1c3');
  await page.click('#line-add');
  await settle(page);
  await page.click('.move >> text=d4');
  await settle(page);
  const after2 = await explorerSans(page);
  check(JSON.stringify(after2) === '["d5"]', 'explorer after 2.d4: ' + after2);
  await page.click('.move >> text=d5');
  await settle(page);
  const branch = (await explorerSans(page)).sort();
  check(JSON.stringify(branch) === '["Nc3","e5"]', 'branch shows both moves: ' + branch);
  check((await page.$$eval('#explorer .count', (e) => e.map((x) => x.textContent))).every((t) => t === '1 line'), 'line counts shown');

  // Already covered
  await page.click('#nav-back');
  await page.click('#line-add');
  await settle(page);
  check((await page.textContent('#toast')).includes('Already in the repertoire'), 'prefix of existing line reports already in repertoire');

  // Comments autosave and are shown as "previous position" one move later
  await page.click('.move >> text=d5');
  await settle(page);
  await page.fill('#comment-current', 'Main tabiya: choose e5 or Nc3');
  await page.waitForTimeout(1200);
  check((await page.textContent('#comment-status')) === 'Saved', 'comment autosaved');
  await play(page, 'e4e5');
  await settle(page);
  check((await page.inputValue('#comment-current')) === '', 'new position has no comment');
  check((await page.inputValue('#comment-previous')) === 'Main tabiya: choose e5 or Nc3', 'previous position comment shown');
  await page.click('#nav-back');
  await settle(page);
  check((await page.inputValue('#comment-current')) === 'Main tabiya: choose e5 or Nc3', 'comment reloads on returning');

  // Typing then immediately moving saves to the ORIGINAL position
  await page.fill('#comment-current', 'Edited quickly');
  await page.click('#nav-forward');
  await settle(page);
  await page.click('#nav-back');
  await settle(page);
  check((await page.inputValue('#comment-current')) === 'Edited quickly', 'comment flushed to the position it was typed in');

  // Delete lines through 3.e5 position, with confirmation
  await play(page, 'e4e5');
  await page.click('#line-delete');
  await page.waitForSelector('dialog[open]');
  check((await page.textContent('dialog h2')) === 'Delete 1 line?', 'delete asks for confirmation with count');
  await page.click('dialog button[type=submit]');
  await settle(page);
  await page.click('#nav-back');
  await settle(page);
  check(JSON.stringify(await explorerSans(page)) === '["Nc3"]', 'line through e5 deleted, Nc3 remains');

  // Cancel delete leaves it
  await page.click('#nav-start');
  await settle(page);
  await page.click('#line-delete');
  await page.waitForSelector('dialog[open]');
  check((await page.textContent('dialog .modal-message')).includes('every line'), 'warns when deleting from the start position');
  await page.click('dialog button:text("Cancel")');
  await settle(page);
  check(JSON.stringify(await explorerSans(page)) === '["e4"]', 'cancelled delete keeps lines');

  // Reload keeps the game and the selection
  await play(page, 'e2e4', 'c7c6');
  await page.reload();
  await settle(page);
  const restored = await page.evaluate(() => [mpct.game.ply, mpct.game.moves.map((m) => m.san).join(' ')]);
  check(restored[0] === 2 && restored[1].startsWith('e4 c6 d4'), 'game and position restored after reload: ' + restored);
  check((await page.$eval('#opening-select option:checked', (o) => o.textContent)) === 'Caro-Kann', 'opening selection restored');
  check((await page.$eval('#opening-select option:checked', (o) => o.parentElement.label)) === 'Black', 'opening listed under the Black heading');
  check(JSON.stringify(await explorerSans(page)) === '["d4"]', 'explorer works after reload');

  // Duplicate opening name is reported
  await page.click('#opening-new');
  await page.fill('dialog input[name=name]', 'Caro-Kann');
  await page.click('dialog button[type=submit]');
  await settle(page);
  check((await page.textContent('#toast')).includes('already exists'), 'duplicate opening name shows error');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/p3-desktop.png` });

  // FEN-loaded positions can't be added as lines
  await page.fill('#fen', '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1');
  await page.click('#btn-fen-load');
  await settle(page);
  check((await page.textContent('#explorer')).includes('set up from a FEN'), 'explorer explains FEN positions');
  await page.click('#btn-new');

  // Phone: same data, single column, explorer + comments right below the controls
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const mp = await ctx.newPage();
  mp.on('pageerror', (e) => errors.push('phone: ' + e));
  await mp.goto(URL);
  await settle(mp);
  await play(mp, 'e2e4', 'c7c6', 'd2d4', 'd7d5');
  await settle(mp);
  const order = await mp.evaluate(() =>
    ['.board-area', '.controls', '.repertoire', '.history', '.tools'].map((s) => document.querySelector(s).getBoundingClientRect().top),
  );
  check(order.every((v, i) => i === 0 || v > order[i - 1]), 'phone order: board, controls, repertoire, moves, tools');
  check((await mp.inputValue('#comment-current')) === 'Edited quickly', 'phone sees the same comment');
  check(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no horizontal overflow');
  if (SHOTS) await mp.screenshot({ path: `${SHOTS}/p3-phone.png`, fullPage: true });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
