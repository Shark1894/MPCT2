// Browser checks for hands-free training, with fake speech in and out (a test browser has no
// microphone): window.__hear([...guesses]) is what the recogniser "heard", window.__spoken
// collects everything read aloud. Needs a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/handsfree.e2e.cjs
const { chromium } = require('playwright');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const SHOTS = process.env.MPCT_SHOTS;
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);
const text = (p, sel) => p.textContent(sel);

const FAKE_SPEECH = () => {
  window.__spoken = [];
  window.SpeechSynthesisUtterance = class {
    constructor(t) {
      this.text = t;
    }
  };
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speak(u) {
        window.__spoken.push(u.text);
        setTimeout(() => u.onend && u.onend(), 5);
      },
      cancel() {},
      getVoices() {
        return [];
      },
      addEventListener() {},
    },
  });
  window.__gum = 0;
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = () => {
      window.__gum += 1;
      return Promise.resolve({ getTracks: () => [{ label: 'Fake mic', stop() {} }] });
    };
  }
  if (window.__noListening) return;
  window.__recMode = 'ok'; // 'silent': start() ignored (Chrome on Android without a tap); 'notallowed'
  class FakeRec {
    constructor() {
      window.__rec = this;
      this.running = false;
    }
    start() {
      if (window.__recMode === 'silent') return;
      if (window.__recMode === 'notallowed') {
        setTimeout(() => {
          this.onerror && this.onerror({ error: 'not-allowed' });
          this.onend && this.onend();
        }, 1);
        return;
      }
      if (this.running) throw new Error('already started');
      this.running = true;
      setTimeout(() => this.onstart && this.onstart(), 1);
    }
    abort() {
      if (!this.running) return;
      this.running = false;
      setTimeout(() => this.onend && this.onend(), 1);
    }
    stop() {
      this.abort();
    }
  }
  window.SpeechRecognition = FakeRec;
  window.webkitSpeechRecognition = FakeRec;
  window.__listening = () => Boolean(window.__rec && window.__rec.running);
  window.__hear = (alts) => {
    const r = window.__rec;
    if (!r || !r.running) return false;
    r.onresult({ results: [alts.map((t) => ({ transcript: t }))] });
    r.running = false;
    setTimeout(() => r.onend && r.onend(), 1);
    return true;
  };
};

async function hear(page, alts) {
  await page.waitForFunction(() => window.__listening(), null, { timeout: 5000 });
  await page.evaluate((a) => window.__hear(a), alts);
  await settle(page, 250);
}
const spokenSince = (page, n) => page.evaluate((k) => window.__spoken.slice(k), n);
const spokenCount = (page) => page.evaluate(() => window.__spoken.length);
const sans = (page) => page.evaluate(() => mpct.game.moves.slice(0, mpct.game.ply).map((m) => m.san).join(' '));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(FAKE_SPEECH);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const ids = await page.evaluate(async () => {
    const post = (url, body) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const caro = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Caro-Kann', color: 'black' });
    await post(`/api/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5', 'c8f5'] });
    await post(`/api/openings/${caro.id}/lines`, { moves: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'] });
    return { caro: caro.id };
  });
  await page.reload();
  await settle(page, 800);
  await page.selectOption('#opening-select', String(ids.caro));
  await settle(page, 400);

  check(await page.isHidden('#train-handsfree'), 'Hands-free button only while training');
  await page.click('#train-all');
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  await settle(page, 900);
  check(await page.isVisible('#train-handsfree') && (await page.isHidden('#hf')), 'Hands-free button shows when training, off by default');

  // ---- switch on mid-line ------------------------------------------------------------------
  let n = await spokenCount(page);
  await page.click('#train-handsfree');
  await page.waitForFunction(() => window.__listening(), null, { timeout: 5000 });
  check(JSON.stringify(await spokenSince(page, n)) === JSON.stringify(['Hands-free on.', 'E4. Your move.']), 'switching on reads the last move and asks for yours: ' + JSON.stringify(await spokenSince(page, n)));
  check(await page.isVisible('#hf') && (await text(page, '#hf-status')).includes('Listening'), 'panel: listening');

  // ---- right move by voice; opponent's reply read out ------------------------------------------
  n = await spokenCount(page);
  await hear(page, ['C6']);
  await settle(page, 700);
  check((await sans(page)) === 'e4 c6 d4', 'said C6: played, then the opponent replied: ' + (await sans(page)));
  check((await spokenSince(page, n)).includes('D4'), 'opponent move read aloud: ' + JSON.stringify(await spokenSince(page, n)));
  check((await text(page, '#hf-heard')) === 'Heard: “C6”', 'shows what it heard');

  // ---- a different legal move is read back; "no" costs nothing --------------------------------
  n = await spokenCount(page);
  await hear(page, ['knight f6']);
  check((await spokenSince(page, n)).includes('I heard knight F6. Is that right?'), 'wrong-sounding move read back for confirmation');
  check((await text(page, '#hf-status')).includes('Yes or no'), 'panel asks yes or no');
  await hear(page, ['no']);
  check((await page.evaluate(() => mpct.trainer.session.mistakes)) === 0 && (await sans(page)) === 'e4 c6 d4', '"no": not counted, nothing played');
  n = await spokenCount(page);
  await hear(page, ['banana bread']);
  check((await spokenSince(page, n)).includes('Sorry, say that again.'), 'nothing recognisable: asked again, no penalty');
  // any of the guesses being the expected move counts
  await hear(page, ['be 5', 'D5', 'B5']);
  await settle(page, 700);
  check((await sans(page)) === 'e4 c6 d4 d5 e5', 'expected move among the guesses accepted: ' + (await sans(page)));

  // ---- commands --------------------------------------------------------------------------------
  n = await spokenCount(page);
  await hear(page, ['repeat']);
  check((await spokenSince(page, n)).includes('E5. Your move.'), 'repeat');
  n = await spokenCount(page);
  await hear(page, ['moves']);
  check((await spokenSince(page, n)).includes('E4, C6, D4, D5, E5. Your move.'), 'moves: the line so far');

  // ---- line ends: result read out, next line starts on its own ---------------------------------
  n = await spokenCount(page);
  await hear(page, ['bishop F5']);
  await page.waitForFunction(() => mpct.trainer.session && mpct.trainer.session.index === 1 && mpct.game.ply >= 1, null, { timeout: 8000 });
  await settle(page, 800);
  const said = await spokenSince(page, n);
  check(said.some((t) => t.startsWith('Line complete, no mistakes. Streak 1')), 'line result read aloud: ' + JSON.stringify(said));
  check(said.includes('Line 2 of 2. You play black.') && said.includes('E4'), 'next line started by itself');

  // ---- a confirmed mistake, then taken back -------------------------------------------------------
  await hear(page, ['c6']);
  await settle(page, 700);
  await hear(page, ['d5']);
  await settle(page, 700);
  check((await sans(page)) === 'e4 c6 d4 d5 Nc3', 'line 2 to Nc3');
  await hear(page, ['knight f6']);
  n = await spokenCount(page);
  await hear(page, ['yes']);
  check((await page.evaluate(() => mpct.trainer.session.mistakes)) === 1, '"yes": counted as a mistake');
  check((await spokenSince(page, n)).some((t) => t.startsWith('No, that’s not the repertoire move')), 'mistake read out');
  check(await page.isVisible('#hf-undo'), '"That was a mishearing" offered');
  n = await spokenCount(page);
  await hear(page, ['that was a mishearing']);
  check((await page.evaluate(() => mpct.trainer.session.mistakes)) === 0 && (await page.isHidden('#hf-undo')), 'mishearing: mistake taken back');
  check((await spokenSince(page, n)).includes('OK, that one doesn’t count. Your move.'), 'and says so');

  // ---- typing works too ----------------------------------------------------------------------------
  n = await spokenCount(page);
  await page.fill('#hf-input', 'dxe4');
  await page.press('#hf-input', 'Enter');
  await page.waitForFunction(() => mpct.trainer.session && mpct.trainer.session.finished, null, { timeout: 8000 });
  await settle(page, 400);
  check((await spokenSince(page, n)).some((t) => t.startsWith('Session complete. 2 lines reviewed: 2 correct')), 'typed move; session summary read aloud');
  const lines = await page.evaluate((id) => fetch(`/api/openings/${id}/dashboard`).then((r) => r.json()).then((d) => d.lines.map((l) => l.streak)), ids.caro);
  check(JSON.stringify(lines) === '[1,1]', 'both lines saved as real reviews (streak 1): ' + JSON.stringify(lines));
  await page.click('#train-done');
  await settle(page, 400);
  check(await page.isHidden('#train-handsfree') && !(await page.evaluate(() => window.__listening())), 'stopping training stops listening');

  // ---- remembered; typed wrong moves count straight away; blindfold; "stop" -----------------------
  await page.click('#train-all');
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  await page.waitForFunction(() => window.__listening(), null, { timeout: 5000 });
  check(await page.isVisible('#hf'), 'hands-free comes back on for the next session');
  await page.fill('#hf-input', 'e5');
  await page.press('#hf-input', 'Enter');
  await settle(page, 300);
  check((await page.evaluate(() => mpct.trainer.session.mistakes)) === 1, 'typed wrong move counts without asking (nothing misheard)');
  await page.click('#hf-undo');
  await settle(page, 200);
  check((await page.evaluate(() => mpct.trainer.session.mistakes)) === 0, 'the button takes it back too');
  await page.click('#hf-blind');
  await settle(page, 200);
  check(await page.evaluate(() => document.querySelector('.board-area').classList.contains('blindfold')), 'Hide pieces: blindfold board');
  check(await page.$eval('cg-board piece', (p) => getComputedStyle(p).visibility === 'hidden'), 'pieces not visible');
  check((await text(page, '#hf-blind')) === 'Show pieces' && (await page.getAttribute('#hf-blind', 'aria-pressed')) === 'true', 'button now offers Show pieces');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/handsfree.png` });
  await hear(page, ['stop']);
  await settle(page, 300);
  check(await page.isHidden('#hf') && !(await page.evaluate(() => document.querySelector('.board-area').classList.contains('blindfold'))), '"stop": hands-free off, pieces back');
  check(await page.evaluate(() => mpct.trainer.active), 'training carries on');

  // ---- Chrome on Android: listening may only start from a tap ------------------------------------
  const gum = await page.evaluate(() => window.__gum);
  await page.evaluate(() => (window.__recMode = 'silent'));
  await page.click('#train-handsfree');
  check((await page.evaluate(() => window.__gum)) > gum || (await page.evaluate(() => mpct.handsFree.micPrimed)), 'microphone asked for in the tap itself (so Chrome shows its prompt)');
  await page.waitForSelector('#hf-talk', { state: 'visible', timeout: 6000 }).catch(() => {});
  check(await page.isVisible('#hf-talk'), 'start ignored: "Tap to talk" appears');
  check((await text(page, '#hf-status')).includes('Listening didn’t start. Tap 🎙 to talk.'), 'and says why: ' + (await text(page, '#hf-status')));
  const log = await text(page, '#hf-log');
  check(log.includes('page: secure=true') && log.includes('recogniser: no answer to start() after 2.5 s'), 'Microphone details log shows what happened');
  await page.evaluate(() => (window.__recMode = 'ok'));
  await page.click('#hf-talk');
  await settle(page, 200);
  check((await text(page, '#hf-log')).includes('recogniser: start() (new, from a tap)'), 'the tap starts a fresh recogniser');
  check((await page.evaluate(() => window.__listening())) && (await page.isHidden('#hf-talk')), 'tap: listening');
  await hear(page, ['c6']);
  await page.evaluate(() => (window.__recMode = 'notallowed'));
  await page.waitForSelector('#hf-talk', { state: 'visible', timeout: 6000 }).catch(() => {});
  check((await text(page, '#hf-status')).startsWith('Tap 🎙 to talk. If nothing happens, allow the microphone') && (await text(page, '#hf-status')).includes('(recogniser said: not-allowed)'), '"not-allowed": tap to talk, or allow the mic: ' + (await text(page, '#hf-status')));
  await page.evaluate(() => (window.__recMode = 'ok'));
  await page.click('#hf-talk');
  await hear(page, ['d5']);
  await settle(page, 700);
  check((await sans(page)) === 'e4 c6 d4 d5 e5', 'and carries on after the tap: ' + (await sans(page)));
  await page.click('#train-stop');

  // ---- a browser without built-in recognition (Firefox) --------------------------------------------
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx2.addInitScript(() => {
    window.__noListening = true;
    delete window.webkitSpeechRecognition;
    delete window.SpeechRecognition;
  });
  await ctx2.addInitScript(FAKE_SPEECH);
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(String(e)));
  await p2.goto(URL);
  await settle(p2, 600);
  await p2.evaluate((id) => localStorage.setItem('mpct.openingId', JSON.stringify(id)), ids.caro);
  await p2.reload();
  await settle(p2, 800);
  await p2.click('#train-all');
  await p2.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  await settle(p2, 900);
  await p2.click('#train-handsfree');
  await settle(p2, 300);
  check((await p2.evaluate(() => mpct.handsFree.engine)) === 'offline' && (await p2.isHidden('#hf-engine-box')), 'no built-in recognition (Firefox): the offline recogniser is used, no choice to make');
  check(await p2.isVisible('#hf-input'), 'typing offered too');
  await p2.fill('#hf-input', 'c6');
  await p2.press('#hf-input', 'Enter');
  await settle(p2, 800);
  check((await p2.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '))) === 'e4 c6 d4', 'typed move played');

  // ---- opened over http:// (not localhost): the microphone can't work, and it says so --------------
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx3.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
  await ctx3.addInitScript(FAKE_SPEECH);
  const p3 = await ctx3.newPage();
  await p3.goto(URL);
  await settle(p3, 600);
  await p3.evaluate((id) => {
    localStorage.setItem('mpct.openingId', JSON.stringify(id));
    localStorage.setItem('mpct.voiceEngine', '"builtin"');
  }, ids.caro);
  await p3.reload();
  await settle(p3, 800);
  await p3.click('#train-all');
  await p3.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  await settle(p3, 900);
  await p3.click('#train-handsfree');
  await settle(p3, 400);
  check((await text(p3, '#hf-status')).startsWith('The microphone only works over a secure connection: open https://'), 'http://: says to open the https address: ' + (await text(p3, '#hf-status')));
  check(await p3.isHidden('#hf-talk'), 'no pointless Tap to talk');

  // ---- a Permissions-Policy header switching the microphone off ---------------------------------------
  const ctx4 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx4.route('**/', async (route) => {
    const res = await route.fetch();
    route.fulfill({ response: res, headers: { ...res.headers(), 'permissions-policy': 'microphone=()' } });
  });
  await ctx4.addInitScript(FAKE_SPEECH);
  const p4 = await ctx4.newPage();
  await p4.goto(URL);
  await p4.evaluate((id) => localStorage.setItem('mpct.openingId', JSON.stringify(id)), ids.caro);
  await p4.reload();
  await settle(p4, 800);
  await p4.click('#train-all');
  await p4.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  await settle(p4, 900);
  await p4.click('#train-handsfree');
  await settle(p4, 400);
  check((await text(p4, '#hf-status')).startsWith('The server switches the microphone off'), 'Permissions-Policy microphone=(): says the server switches it off: ' + (await text(p4, '#hf-status')));

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})();
