// Browser checks for engine reviews of your games and the puzzles from them: review games (in a
// batch from the Games tab, and one on the board) with the real engine, see them marked reviewed,
// then practise the mistake found with spaced repetition. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8011/ node tests/e2e/gamepuzzles.e2e.cjs
const { chromium } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8011/';
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);

// You're Black. After 3.Qxe5+?? the knight takes the queen; you blocked with 3...Be7 instead.
const PGN = `[Event "Club night"]
[White "A. Opponent"]
[Black "Jason Sharkey"]
[Date "2026.10.01"]
[Result "*"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Be7 4. Qg3 Nf6 5. Nc3 O-O *
`;
// You're White and play Legal's mate; Black's 5...Bxd1?? is the opponent's mistake, not yours.
const LEGAL = `[Event "Blitz"]
[White "Jason Sharkey"]
[Black "B. Player"]
[Date "2026.10.02"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5# 1-0
`;

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

const waitTurn = (p) => p.waitForFunction(() => mpct.puzzles.canMove(), null, { timeout: 5000 });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settle(page, 800);

  const imported = await page.evaluate((pgn) =>
    fetch('/api/games/import-pgn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pgn }) }).then((r) => r.json()), PGN);
  check(imported.imported === 1, 'game imported');

  // ---- the panel before any review ----------------------------------------------------------------
  await page.click('#view-puzzles');
  await settle(page, 800);
  check(/They come from games reviewed with the engine/.test(await text(page, '#gp-text')), 'intro text: ' + (await text(page, '#gp-text')));
  check(/0 of 1 game reviewed\. 1 game not reviewed yet/.test(await text(page, '#gp-reviewed')), 'unreviewed game flagged: ' + (await text(page, '#gp-reviewed')));
  check(/You play as: You \(guessed\)/.test(await text(page, '#gp-names')), 'only the default name from one game: ' + (await text(page, '#gp-names')));

  await page.click('#gp-names .link-button');
  await page.fill('dialog input[name="names"]', 'Jason Sharkey, jsharkey');
  await page.click('dialog button[type="submit"]');
  await settle(page, 800);
  check(/You play as: Jason Sharkey, jsharkey\./.test(await text(page, '#gp-names')), 'names saved: ' + (await text(page, '#gp-names')));

  // ---- "Review them" goes to the Games tab and reviews in a batch with the real engine --------------------
  await page.click('#gp-reviewed .link-button');
  await page.waitForSelector('dialog.modal');
  check(!(await page.isHidden('#games-view')), 'Games tab shown');
  check(/Analyses every move of 1 game \(11 positions\)/.test(await text(page, 'dialog.modal')), 'batch dialog: ' + (await text(page, 'dialog.modal p')));
  await page.click('dialog button[type="submit"]');
  await settle(page, 300);
  check(!(await page.isHidden('#games-review-box')), 'progress shown while reviewing');
  await page.waitForSelector('#games-review-box', { state: 'hidden', timeout: 90000 });
  await settle(page, 1000);
  const row = await text(page, '.game-row');
  check(/✓ Reviewed · White \d+% · Black \d+%/.test(row), 'game marked reviewed with accuracy: ' + row);
  check(await page.isHidden('#games-review'), 'nothing left to review');
  const [g1] = await page.evaluate(() => fetch('/api/games').then((r) => r.json()));
  check(g1.review.black_accuracy < g1.review.white_accuracy && g1.review.counts.b.blunder === 1, 'Black blundered once: ' + JSON.stringify(g1.review));

  await page.click('#view-puzzles');
  await settle(page, 800);
  check(/1 puzzle from your games, 1 due today/.test(await text(page, '#gp-text')), 'puzzle found: ' + (await text(page, '#gp-text')));
  check(/1 of 1 game reviewed\.\s*$/.test(await text(page, '#gp-reviewed')), 'all reviewed: ' + (await text(page, '#gp-reviewed')));
  const listed = await text(page, '#gp-list li');
  check(/v A\. Opponent · move 3: you played Be7/.test(listed), 'puzzle listed: ' + listed);
  check(/\?\?/.test(listed), 'marked a blunder');
  const [p] = await page.evaluate(() => fetch('/api/game-puzzles').then((r) => r.json()));
  check(p.best_san === 'Nxe5' && p.color === 'black' && p.ply === 6, 'best move Nxe5 for Black at ply 6');

  // ---- practise: miss it first ------------------------------------------------------------------------
  await page.click('#gp-due');
  await settle(page, 600);
  check((await text(page, '#mode-badge')) === 'Puzzle', 'puzzle mode on the board');
  check(/From your game v A\. Opponent · move 3/.test(await text(page, '#puzzle-title')), 'title: ' + (await text(page, '#puzzle-title')));
  check(await page.isHidden('#puzzle-game'), 'no Lichess link');
  await waitTurn(page);
  check((await page.evaluate(() => mpct.board.orientation())) === 'black', 'board turned to your side');
  check(/Your move in the game/.test(await text(page, '#puzzle-message')), 'prompt');
  await move(page, 'f8e7'); // the same mistake again
  await settle(page, 800);
  if (await page.isHidden('#puzzle-end')) await page.click('#puzzle-reveal');
  await page.waitForSelector('#puzzle-end:not([hidden])', { timeout: 8000 });
  check(/✗ The move was Nxe5\. It comes back today\./.test(await text(page, '#puzzle-result')), 'missed: ' + (await text(page, '#puzzle-result')));
  const info = await text(page, '#puzzle-info');
  check(/In the game you played Be7: your winning chances \d+% → \d+% \(blunder\)\./.test(info), 'what happened in the game: ' + info);
  check(/Engine line: Nxe5/.test(info) && /Club night, 2026-10-01/.test(info), 'engine line and game details');
  check(!(await page.isHidden('#puzzle-open-game')), 'Open the game offered');
  let saved = (await page.evaluate(() => fetch('/api/game-puzzles').then((r) => r.json())))[0];
  check(saved.reviews === 1 && saved.correct === 0 && saved.streak === 0, 'miss recorded');

  // ---- retry in the same session: practice only -------------------------------------------------------------
  await page.click('#puzzle-retry');
  await waitTurn(page);
  check(/· practice/.test(await text(page, '#puzzle-title')), 'retry marked as practice');
  await move(page, 'c6e5');
  await page.waitForSelector('#puzzle-end:not([hidden])', { timeout: 8000 });
  check(/✓ Found it: Nxe5\.$/.test(await text(page, '#puzzle-result')), 'found on retry: ' + (await text(page, '#puzzle-result')));
  saved = (await page.evaluate(() => fetch('/api/game-puzzles').then((r) => r.json())))[0];
  check(saved.reviews === 1, 'retry not recorded');

  // ---- open the game at that move ---------------------------------------------------------------------------
  await page.click('#puzzle-open-game');
  await settle(page, 800);
  check(await page.isHidden('#puzzle') && (await page.isHidden('#mode-badge')), 'puzzle mode closed');
  const at = await page.evaluate(() => ({ ply: mpct.game.ply, n: mpct.game.moves.length }));
  check(at.ply === 5 && at.n === 10, 'game open just before the mistake: ' + JSON.stringify(at));
  check(/✓ Reviewed: accuracy White \d+% · Black \d+% · White 1 blunder; Black 1 blunder/.test(await text(page, '#game-review-info')), 'game panel shows the review: ' + (await text(page, '#game-review-info')));

  // ---- a new session: found first time --------------------------------------------------------------------------
  await page.click('#view-puzzles');
  await settle(page, 600);
  await page.click('#gp-list li button:has-text("Practise")');
  await waitTurn(page);
  await move(page, 'c6e5');
  await page.waitForSelector('#puzzle-end:not([hidden])', { timeout: 8000 });
  check(/✓ Found it: Nxe5\. Next review tomorrow\./.test(await text(page, '#puzzle-result')), 'found, scheduled: ' + (await text(page, '#puzzle-result')));
  check((await text(page, '#puzzle-next')) === 'Finish', 'last in the queue');
  await page.click('#puzzle-next');
  await settle(page, 600);
  check(await page.isHidden('#puzzle'), 'Finish ends puzzle mode');

  await page.click('#view-puzzles');
  await settle(page, 600);
  check(/0 due today/.test(await text(page, '#gp-text')) && (await page.isDisabled('#gp-due')), 'nothing due now');
  check(/tomorrow/.test(await text(page, '#gp-list li')), 'list shows next review');

  // ---- reviewing one game on the board marks it reviewed ------------------------------------------------------------
  await page.evaluate((pgn) =>
    fetch('/api/games/import-pgn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pgn }) }), LEGAL);
  await page.click('#view-games');
  await settle(page, 800);
  check((await text(page, '#games-review')) === 'Review 1 unreviewed game', 'new game to review');
  await page.click('.game-row:has-text("B. Player") button:has-text("Open")');
  await settle(page, 800);
  check(/Not reviewed yet/.test(await text(page, '#game-review-info')), 'open game says not reviewed');
  await page.evaluate(() => { mpct.game.goTo(6); mpct.render(); });
  await page.click('#review-start');
  await page.selectOption('dialog.modal select[name="speed"]', 'quick');
  await page.click('dialog button[type="submit"]');
  await page.waitForFunction(() => !mpct.review.running && mpct.review.review?.fresh.every(Boolean), null, { timeout: 60000 });
  await settle(page, 800);
  check(/Not reviewed yet/.test(await text(page, '#game-review-info')), 'a review up to move 3 doesn’t count');
  await page.evaluate(() => { mpct.game.toEnd(); mpct.render(); });
  await page.click('#review-start');
  await page.selectOption('dialog.modal select[name="speed"]', 'quick');
  await page.click('dialog button[type="submit"]');
  await page.waitForFunction(() => /Reviewed/.test(document.getElementById('game-review-info').textContent), null, { timeout: 60000 });
  check(/✓ Reviewed: accuracy White \d+% · Black \d+%/.test(await text(page, '#game-review-info')), 'whole-game review marks it reviewed: ' + (await text(page, '#game-review-info')));
  const legal = (await page.evaluate(() => fetch('/api/games').then((r) => r.json()))).find((g) => g.black === 'B. Player');
  check(legal.review && legal.review.white_accuracy > legal.review.black_accuracy, 'Black played worse: ' + JSON.stringify(legal.review));
  check((await page.evaluate(() => fetch('/api/game-puzzles').then((r) => r.json()))).length === 1, 'the opponent’s mistakes aren’t your puzzles');
  // Editing the moves: unreviewed again
  await page.evaluate(() => { mpct.game.goTo(12); mpct.render(); });
  await move(page, 'd2d3');
  await settle(page, 400);
  check(/Moves changed: save the game/.test(await text(page, '#game-review-info')), 'changed moves flagged');
  await page.click('#game-close');
  await page.waitForSelector('dialog.modal');
  await page.click('dialog button[type="submit"]'); // discard
  await settle(page, 400);

  await page.click('#view-puzzles');
  await settle(page, 600);

  // ---- remove ---------------------------------------------------------------------------------------------------------------
  await page.click('#gp-list li button:has-text("Remove")');
  await page.click('dialog button[type="submit"]');
  await settle(page, 600);
  check((await page.locator('#gp-list li').count()) === 0, 'puzzle removed');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
