// Hands-free with the OFFLINE recogniser (Vosk in the page, as Firefox uses it), end to end with
// real speech: Chrome's fake microphone plays a recorded phrase on a loop. Optional suite: needs
//   - the speech model where the server looks (VOICE_MODEL_DIR, see scripts/fetch_voice_model.py)
//   - two recordings made with espeak-ng (16-bit WAV, a second of silence before, two after):
//       espeak-ng -v en-gb -s 130 -w knight_f_three.wav "knight f three"   (and "e four")
//     in MPCT_VOICE_WAVS (default /tmp/voicewav)
// and a server with an EMPTY database.
// Usage: MPCT_URL=http://localhost:8010/ node tests/e2e/voskvoice.e2e.cjs
const { chromium } = require('playwright');
const path = require('path');

const URL = process.env.MPCT_URL || 'http://localhost:8010/';
const WAVS = process.env.MPCT_VOICE_WAVS || '/tmp/voicewav';
const errors = [];
const check = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) process.exitCode = 1;
};
const settle = (p, ms = 500) => p.waitForTimeout(ms);

// Speech OUT is faked (no voices in a test browser); speech IN is real, through Vosk.
const FAKE_VOICE_OUT = () => {
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
      getVoices: () => [],
      addEventListener() {},
    },
  });
};

async function session(wav, seed) {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(WAVS, wav)}`],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone'] });
  await ctx.addInitScript(FAKE_VOICE_OUT);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  const ids = await page.evaluate(seed);
  await page.evaluate((id) => {
    localStorage.setItem('mpct.openingId', JSON.stringify(id));
    localStorage.setItem('mpct.handsFree', 'true');
    localStorage.setItem('mpct.voiceEngine', '"offline"');
  }, ids.opening);
  await page.reload();
  await settle(page, 800);
  return { browser, page, ids };
}

(async () => {
  const voice = await fetch(new globalThis.URL('/api/voice', URL)).then((r) => r.json());
  check(Boolean(voice.model_url), 'server has the offline model: ' + voice.model_url);
  const head = await fetch(new globalThis.URL(voice.model_url, URL), { method: 'GET' });
  check(head.ok && /immutable/.test(head.headers.get('cache-control') || ''), 'model served, cached for good');

  // ---- "knight f three" when Nf3 is expected: played --------------------------------------------
  const seedWhite = async () => {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Main' });
    const op = await post(`/api/repertoires/${rep.id}/openings`, { name: 'Reti', color: 'white' });
    await post(`/api/openings/${op.id}/lines`, { moves: ['g1f3', 'd7d5', 'g2g3'] });
    return { opening: op.id };
  };
  let { browser, page } = await session('knight_f_three.wav', seedWhite);
  await page.click('#train-all');
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  check(await page.isVisible('#hf') && (await page.inputValue('#hf-engine')) === 'offline', 'hands-free on with the offline recogniser (choice shown: this browser has both)');
  const t0 = Date.now();
  await page.waitForFunction(() => mpct.game.moves.length >= 2, null, { timeout: 90000 }).catch(() => {});
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const moves = await page.evaluate(() => mpct.game.moves.map((m) => m.san).join(' '));
  check(moves.startsWith('Nf3 d5'), `said "knight f three": Nf3 played, opponent replied (${secs}s incl. loading the model): ${moves}`);
  check((await page.textContent('#hf-heard')).includes('knight f three'), 'heard: ' + (await page.textContent('#hf-heard')));
  check((await page.evaluate(() => mpct.trainer.session.mistakes)) === 0, 'no mistakes');
  await browser.close();

  // ---- "e four" when g3 is expected: read back, not counted ------------------------------------------
  ({ browser, page } = await session('e_four.wav', async () => {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const rep = await post('/api/repertoires', { name: 'Second' });
    const op = await post(`/api/repertoires/${rep.id}/openings`, { name: 'English', color: 'white' });
    await post(`/api/openings/${op.id}/lines`, { moves: ['c2c4', 'e7e5'] });
    return { opening: op.id };
  }));
  await page.click('#train-all');
  await page.waitForFunction(() => mpct.trainer.active, null, { timeout: 5000 });
  await page.waitForFunction(() => window.__spoken.some((t) => t.startsWith('I heard')), null, { timeout: 60000 }).catch(() => {});
  const asked = await page.evaluate(() => window.__spoken.find((t) => t.startsWith('I heard')));
  check(asked === 'I heard E4. Is that right?', 'said "e four" when c4 was expected: read back for confirmation: ' + asked);
  check((await page.evaluate(() => mpct.trainer.session.mistakes)) === 0 && (await page.evaluate(() => mpct.game.moves.length)) === 0, 'not counted, nothing played');
  await browser.close();

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
})();
