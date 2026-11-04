// Browser checks for "Play on vs engine" at the end of a training line (real Stockfish).
// Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/continue.e2e.cjs
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
async function move(page, uci) {
  const box = await page.locator('cg-board').boundingBox();
  const flipped = (await page.evaluate(() => mpct.board.orientation())) === 'black';
  const a = sq(box, uci.slice(0, 2), flipped), b = sq(box, uci.slice(2, 4), flipped);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(150);
}
const waitUserTurn = (page) => page.waitForFunction(() => mpct.trainer.canMove(), null, { timeout: 5000 });
const waitLineEnd = (page) => page.waitForSelector('#train-end:not([hidden])', { timeout: 5000 });
const yourMove = (page) => page.waitForFunction(() => document.getElementById('play-status').textContent === 'Your move', null, { timeout: 20000 });
const sans = (page) => page.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '));
const text = (page, sel) => page.textContent(sel);
const api = (page, url) => page.evaluate((u) => fetch(u).then((r) => r.json()), url);

/** Play line `n` of the Caro-Kann session correctly (Black). */
async function playLine(page, second) {
  await waitUserTurn(page);
  await move(page, 'c7c6');
  await waitUserTurn(page);
  await move(page, 'd7d5');
  await waitUserTurn(page);
  await move(page, second ? 'd5e4' : 'c8f5');
  await waitLineEnd(page);
}
/** Play whichever line the session is on, correctly, through the controller. */
async function finishLine(page) {
  await page.waitForFunction(() => mpct.trainer.canMove(), null, { timeout: 5000 });
  await page.evaluate(async () => {
    const t = mpct.trainer;
    while (!t.session.lineComplete()) {
      if (t.canMove()) {
        const uci = t.session.expected().uci;
        t.onUserMove(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await page.waitForSelector('#train-end:not([hidden])', { timeout: 5000 });
}
async function chooseLevel(page, level = '1') {
  await page.click('#train-continue');
  await page.waitForSelector('dialog[open]');
  await page.selectOption('dialog select[name=level]', level);
  await page.click('dialog button[type=submit]');
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const o = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro-Kann', color: 'black' });
    await post(`/api/openings/${o.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'] });
    await post(`/api/openings/${o.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'] });
  });
  await page.reload();
  await page.waitForTimeout(600);

  // ---- line 1, then play on ----------------------------------------------------------
  await page.click('#train-due');
  check(await page.isHidden('#train-continue'), 'no Play on button while the line is being played');
  await playLine(page, false);
  check(await page.isVisible('#train-continue'), 'Play on vs engine offered on the end-of-line card');
  const before = await sans(page);

  // Cancel keeps training as it was
  await page.click('#train-continue');
  await page.waitForSelector('dialog[open]');
  const msg = await text(page, 'dialog .modal-message');
  check(msg.includes('Caro-Kann') && msg.includes("doesn't change"), 'dialog names the opening and says practice only: ' + msg);
  check((await page.$$('dialog select')).length === 1, 'only the strength is asked (side comes from the repertoire)');
  await page.click('dialog button:text("Cancel")');
  await page.waitForTimeout(200);
  check((await page.evaluate(() => mpct.trainer.active)) && (await page.isVisible('#train-end')), 'cancel: still training, end card still shown');

  await chooseLevel(page, '1');
  check(!(await page.evaluate(() => mpct.trainer.active)) && (await page.evaluate(() => mpct.play.active)), 'training put aside, game against the engine started');
  check(await page.isHidden('#training') && (await page.isHidden('#mode-badge')), 'training panel and badge hidden');
  check(await page.isVisible('#play-panel') && (await page.isHidden('#engine-panel')), 'play panel shown, engine panel hidden');
  check((await text(page, '#play-title')) === 'You (Black) v Stockfish (Beginner ~800)', 'you play the repertoire side: ' + (await text(page, '#play-title')));
  check((await page.evaluate(() => mpct.board.orientation())) === 'black', 'board still from Black');
  check((await page.evaluate(() => mpct.play.startPly)) === 6, 'game starts at the end of the line (ply 6)');
  check(await page.isVisible('#play-back') && (await text(page, '#play-back')) === 'Next line', 'Next line button back to training');
  check(await page.isHidden('#play-again'), 'no Play again while a training session waits');

  // Engine (White) to move first after ...Bf5
  await yourMove(page);
  check((await sans(page)).startsWith(before) && (await page.evaluate(() => mpct.game.moves.length)) === 7, 'engine replied from the line end: ' + (await sans(page)));

  // Leaving mid-game asks first
  await page.click('#play-back');
  await page.waitForSelector('dialog[open]');
  check((await text(page, 'dialog h2')) === 'Leave the game?', 'leaving mid-game asks first');
  await page.click('dialog button:text("Cancel")');
  await page.waitForTimeout(200);
  check(await page.evaluate(() => mpct.play.active), 'cancel: still playing');
  await page.click('#play-back');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button[type=submit]');
  await waitUserTurn(page);
  check(await page.evaluate(() => mpct.trainer.active && !mpct.play.active), 'back to training');
  check((await text(page, '#train-progress')) === 'Line 2 of 2', 'next line started: ' + (await text(page, '#train-progress')));
  check((await sans(page)) === 'e4', 'board reset to the next line');
  check(await page.isVisible('#mode-badge') && (await page.isHidden('#play-panel')), 'training mode again, play panel gone');

  // ---- line 2: play on, resign, save → back to training (summary) ------------------------
  await playLine(page, true);
  await chooseLevel(page, '1');
  check((await text(page, '#play-back')) === 'Finish training', 'last line: Finish training');
  await yourMove(page);
  await page.click('#play-resign');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button[type=submit]');
  await page.waitForTimeout(300);
  check(await page.isVisible('#play-save') && (await page.isHidden('#play-again')), 'after resigning: Save shown, Play again hidden');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/continue-over.png` });
  await page.click('#play-save');
  await page.waitForSelector('#train-summary:not([hidden])', { timeout: 5000 });
  check(await page.evaluate(() => mpct.trainer.active), 'save returns to training');
  check((await text(page, '#train-summary-text')).startsWith('2 lines reviewed: 2 correct'), 'session summary: ' + (await text(page, '#train-summary-text')));
  const games = await api(page, '/api/games');
  const list = games.games ?? games;
  const g = list[0];
  check(list.length === 1 && g.competition === 'Practice vs engine (Caro-Kann)' && g.result === '1-0', 'game saved with the opening named: ' + JSON.stringify({ c: g?.competition, r: g?.result }));
  check(g.black === 'You' && g.white === 'Stockfish (Beginner ~800)', 'players saved: ' + `${g?.white} v ${g?.black}`);
  await page.click('#train-done');
  await page.waitForTimeout(300);

  // ---- schedule untouched by the game: both lines streak 1 ---------------------------
  const dash = await api(page, '/api/openings/1/dashboard');
  const lines = dash.lines ?? dash;
  check(Array.isArray(lines) && lines.every((l) => l.streak === 1), 'schedule unchanged by the games: streaks ' + JSON.stringify(Array.isArray(lines) ? lines.map((l) => l.streak) : dash));

  // ---- stopping the game ends the waiting session ------------------------------------
  await page.evaluate(() => mpct.trainer.stop());
  // A session with a line left over: train both lines, play on after the first
  await page.evaluate(() => mpct.trainer.start({ id: 1, name: 'Caro-Kann' }, 'all'));
  await finishLine(page);
  await chooseLevel(page, '1');
  await yourMove(page);
  await page.click('#play-stop');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog button[type=submit]');
  await page.waitForTimeout(400);
  check(!(await page.evaluate(() => mpct.trainer.active || mpct.play.active)), 'Stop ends both the game and the waiting session');
  check((await page.evaluate(() => mpct.trainer.suspended)) === null, 'no session left waiting');
  check((await text(page, '#toast')).includes('Training session ended with 1 line still to go'), 'toast: ' + (await text(page, '#toast')));
  check(await page.isHidden('#play-panel') && (await page.isHidden('#training')), 'back to free analysis');

  // ---- phone ----------------------------------------------------------------------
  const phone = await browser.newPage({ ...devices['Pixel 7'] });
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(URL);
  await phone.waitForTimeout(600);
  await phone.evaluate(() => mpct.trainer.start({ id: 1, name: 'Caro-Kann' }, 'all'));
  await finishLine(phone);
  const wrap = await phone.evaluate(() => {
    const b = document.getElementById('train-continue').getBoundingClientRect();
    return { visible: b.width > 0, right: b.right, vw: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  check(wrap.visible && wrap.right <= wrap.vw && !wrap.overflow, 'phone: Play on button fits on screen ' + JSON.stringify(wrap));
  if (SHOTS) await phone.screenshot({ path: `${SHOTS}/continue-phone.png` });

  check(errors.length === 0, 'no console/page errors ' + JSON.stringify(errors));
  await browser.close();
})();
