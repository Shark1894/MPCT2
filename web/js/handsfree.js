// Hands-free training: the app reads the opponent's moves aloud and listens for yours.
// Speech out is the browser's speechSynthesis. Speech in is the browser's SpeechRecognition
// (Chrome, Edge, Samsung Internet, Safari) or, where there is none (Firefox) or if chosen, Vosk
// running offline in the page (vosk-listener.js). Typing moves always works.
//
// Safeguards so a mishearing never fails a line:
// - every guess the recogniser makes is checked; if any is the expected move, it counts;
// - a legal move that isn't the expected one is read back ("I heard knight D3, is that
//   right?") and only counts as a mistake after "yes";
// - nothing recognisable: "say that again", no penalty;
// - "that was a mishearing" (or the button) takes the last mistake back.
// Sessions count as real reviews, exactly like training on the board.

import { interpret, interpretTyped, heardYesNo, pieceName, sanToSpeech } from './speech-core.js';
import { store } from './ui.js';
import { VoskListener } from './vosk-listener.js';

const $ = (id) => document.getElementById(id);

class Speaker {
  constructor() {
    this.synth = window.speechSynthesis ?? null;
    this.chain = Promise.resolve();
    this.gen = 0;
    this.voice = null;
    const pick = () => {
      const voices = this.synth?.getVoices?.() ?? [];
      this.voice = voices.find((v) => v.lang === 'en-GB') ?? voices.find((v) => v.lang?.startsWith('en')) ?? null;
    };
    pick();
    this.synth?.addEventListener?.('voiceschanged', pick);
  }

  get available() {
    return Boolean(this.synth && window.SpeechSynthesisUtterance);
  }

  /** Queue a sentence; resolves when it has been said (or skipped by cancel). */
  get busy() {
    return this.pending > 0;
  }

  say(text) {
    const gen = this.gen;
    this.pending = (this.pending ?? 0) + 1;
    const done = () => {
      this.pending = Math.max(0, this.pending - 1);
    };
    this.chain = this.chain.then(
      () =>
        new Promise((resolve) => {
          if (gen !== this.gen || !this.available || !text) return resolve();
          const u = new window.SpeechSynthesisUtterance(text);
          u.lang = 'en-GB';
          if (this.voice) u.voice = this.voice;
          u.rate = 1;
          // Chrome sometimes never fires onend: don't wait forever.
          const timer = setTimeout(resolve, 1500 + text.length * 110);
          u.onend = u.onerror = () => {
            clearTimeout(timer);
            resolve();
          };
          this.synth.speak(u);
        }),
    );
    this.chain = this.chain.then(done, done);
    return this.chain;
  }

  /** Resolves once everything queued has been said. */
  idle() {
    return this.chain;
  }

  cancel() {
    this.gen += 1;
    this.pending = 0;
    this.synth?.cancel();
    this.chain = Promise.resolve();
  }
}

class Listener {
  constructor(onHeard, onState) {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.available = Boolean(this.SR);
    this.onHeard = onHeard; // (alternatives[]) => void
    this.onState = onState; // ('listening'|'idle'|'blocked'|'error'|'needs-tap'|'note'|'log', message?) => void
    this.want = false;
    this.running = false;
    this.starting = false;
    this.failures = 0;
    this.rec = null;
  }

  _log(text) {
    this.onState('log', text);
  }

  /** A new recogniser. Chrome on Android can leave one stuck after a start it ignored. */
  _make() {
    if (this.rec) {
      for (const k of ['onstart', 'onresult', 'onerror', 'onend', 'onaudiostart', 'onspeechstart']) this.rec[k] = null;
      try {
        this.rec.abort();
      } catch {
        // already dead
      }
    }
    const rec = new this.SR();
    rec.lang = 'en-GB';
    rec.interimResults = false;
    rec.continuous = false; // Android stops after a pause anyway; restarted while wanted
    rec.maxAlternatives = 5;
    rec.onstart = () => {
      this._log('recogniser: start');
      this.starting = false;
      this.running = true;
      this.onState('listening');
    };
    rec.onaudiostart = () => this._log('recogniser: microphone on');
    rec.onspeechstart = () => this._log('recogniser: speech heard');
    rec.onresult = (e) => {
      const res = e.results[e.results.length - 1];
      const alts = [];
      for (let i = 0; i < res.length; i++) if (res[i].transcript?.trim()) alts.push(res[i].transcript.trim());
      this._log(`recogniser: result ${JSON.stringify(alts)}`);
      if (!alts.length) return;
      this.failures = 0;
      this.want = false; // the controller decides whether to listen again
      this.onHeard(alts);
    };
    rec.onerror = (e) => {
      this._log(`recogniser: error ${e.error}${e.message ? ` (${e.message})` : ''}`);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        // Either the microphone is refused, or (Chrome on Android) listening has to start from a tap.
        this.want = false;
        this.onState('needs-tap', `Tap 🎙 to talk. If nothing happens, allow the microphone for this site in Chrome’s site settings (recogniser said: ${e.error}).`);
        return;
      }
      if (e.error === 'no-speech') this.onState('note', 'Didn’t hear anything: still listening.');
      if (e.error === 'network' || e.error === 'audio-capture') {
        this.failures += 1;
        if (this.failures >= 3) {
          this.want = false;
          this.onState('error', e.error === 'network' ? 'Speech recognition needs an internet connection. Type your moves meanwhile.' : 'No microphone found. Type your moves.');
        }
      }
      // 'no-speech' and 'aborted': just listen again (onend restarts if still wanted)
    };
    rec.onend = () => {
      this._log('recogniser: end');
      this.starting = false;
      this.running = false;
      if (this.want) setTimeout(() => this.want && !this.running && this._start(), 250);
      else this.onState('idle');
    };
    this.rec = rec;
    return rec;
  }

  _start(fresh = false) {
    if (fresh || !this.rec) this._make();
    this.starting = true;
    clearTimeout(this.startTimer);
    // Chrome on Android may ignore a start that didn't come from a tap, without any event.
    this.startTimer = setTimeout(() => {
      if (this.starting && !this.running) {
        this._log('recogniser: no answer to start() after 2.5 s');
        this.starting = false;
        this.want = false;
        this._make(); // that one is stuck: the next start (from a tap) gets a new one
        this.onState('needs-tap', 'Listening didn’t start. Tap 🎙 to talk.');
      }
    }, 2500);
    try {
      this._log(`recogniser: start() ${fresh ? '(new, from a tap)' : ''}`);
      this.rec.start();
    } catch (err) {
      this.starting = false;
      clearTimeout(this.startTimer);
      this._log(`recogniser: start() threw ${err?.name}: ${err?.message}`);
      if (err?.name === 'InvalidStateError' && !fresh) return; // already listening
      this.onState('needs-tap', `Couldn’t start listening (${err?.name || ''} ${err?.message || err}). Tap 🎙 to talk.`);
    }
  }

  listen() {
    if (!this.available) return;
    this.want = true;
    if (!this.running && !this.starting) this._start();
  }

  /** Listen, starting from scratch: for a tap, which Chrome always allows. */
  listenNow() {
    if (!this.available) return;
    this.want = true;
    this.running = false;
    this._start(true);
  }

  stop() {
    this.want = false;
    this.starting = false;
    clearTimeout(this.startTimer);
    if (this.running) this.rec?.abort();
  }

  release() {
    this.stop();
  }
}

export class HandsFree {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {() => import('./training.js').TrainingController} deps.trainer
   */
  constructor({ game, trainer }) {
    this.game = game;
    this.getTrainer = trainer;
    this.on = false;
    this.mode = 'idle'; // 'idle' | 'move' | 'confirm'
    this.pending = null; // move waiting for "yes"
    this.unclear = 0;
    this.lastSpoken = '';
    this.wakeLock = null;
    this.el = {
      toggle: $('train-handsfree'),
      box: $('hf'),
      status: $('hf-status'),
      heard: $('hf-heard'),
      form: $('hf-type'),
      input: $('hf-input'),
      undo: $('hf-undo'),
      blind: $('hf-blind'),
      engineBox: $('hf-engine-box'),
      engine: $('hf-engine'),
      talk: $('hf-talk'),
      note: $('hf-note'),
      log: $('hf-log'),
    };
    this.speaker = new Speaker();
    const heard = (alts) => this._heard(alts);
    this.listeners = {
      builtin: new Listener(heard, (state, msg) => this._listenState('builtin', state, msg)),
      offline: new VoskListener(heard, (state, msg) => this._listenState('offline', state, msg)),
    };
    this.engine = this._pickEngine(store.get('voiceEngine', null));
    this.el.engine.value = this.engine;
    this.el.engine.addEventListener('change', () => this.setEngine(this.el.engine.value));
    this.blind = Boolean(store.get('blindfold', false));
    this.el.toggle.addEventListener('click', () => {
      if (!this.on) this._primeMic(); // in the tap itself: Chrome on Android only asks for the mic then
      this.setOn(!this.on);
    });
    this.el.talk.addEventListener('click', () => {
      this._log('tap: Tap to talk');
      if (!this.micPrimed) this._primeMic();
      this.micProblem = null;
      this.el.note.hidden = true;
      if (this.mode === 'idle' && this.trainer?.canMove()) this.mode = 'move';
      if (this.listener.listenNow) this.listener.listenNow(); // a fresh start from a tap
      else this.listener.listen();
      this._render();
    });
    this.el.undo.addEventListener('click', () => this._mishearing());
    this.el.blind.addEventListener('click', () => {
      this.blind = !this.blind;
      store.set('blindfold', this.blind);
      this._applyBlind();
      this._render();
    });
    this.el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._typed(this.el.input.value);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.on) this._keepAwake();
    });
  }

  get trainer() {
    return this.getTrainer();
  }

  get listener() {
    return this.listeners[this.engine];
  }

  /** The browser's own recogniser where there is one, else offline (Vosk); a saved choice wins if it works here. */
  _pickEngine(wanted) {
    const ok = (e) => this.listeners[e]?.available;
    if (wanted && ok(wanted)) return wanted;
    return ok('builtin') ? 'builtin' : 'offline';
  }

  setEngine(engine) {
    engine = this._pickEngine(engine);
    if (engine === this.engine) return;
    const mode = this.mode;
    this.listener.release();
    this.engine = engine;
    store.set('voiceEngine', engine);
    this.micProblem = null;
    if (this.on && (mode === 'move' || mode === 'confirm')) this._listenFor(mode);
    this._render();
  }

  /** Training started: switch on if it was on last time. */
  sessionStarted() {
    this.el.toggle.hidden = false;
    if (store.get('handsFree', false)) {
      this._primeMic(); // still within the tap on Train
      this.setOn(true, { quiet: true, resume: false });
    }
    else this._render();
  }

  sessionEnded() {
    this.setOn(false, { remember: false });
    this.el.toggle.hidden = true;
  }

  setOn(on, { remember = true, quiet = false, resume = true } = {}) {
    if (on === this.on) return this._render();
    this.on = on;
    if (remember) store.set('handsFree', on);
    this.mode = 'idle';
    this.pending = null;
    if (on) {
      this.micProblem = null;
      this._keepAwake();
      if (!quiet || !this.listener.available) {
        this.speaker.say(this.listener.available ? 'Hands-free on.' : 'Hands-free on. I can read moves out, but this browser can’t listen: type your moves.');
      }
      if (resume) this._afterTrainerChange(true);
    } else {
      this.speaker.cancel();
      this.listener.release();
      this.wakeLock?.release().catch(() => {});
      this.wakeLock = null;
    }
    this._applyBlind();
    this._render();
  }

  // ---- hooks from the trainer -------------------------------------------------------

  lineStarted(s) {
    if (!this.on) return;
    this._cancelListen();
    this.el.heard.hidden = true;
    const tag = s.practice ? ', practice' : s.retry ? ', retry' : '';
    this._say(`Line ${s.index + 1} of ${s.total}${tag}. You play ${s.color}.`);
    this._render();
  }

  opponentMoved(san) {
    if (!this.on) return Promise.resolve();
    this._cancelListen();
    return this._say(sanToSpeech(san));
  }

  /** It's the user's turn: listen (after anything still being said). */
  yourTurn(first) {
    if (!this.on) return;
    if (first) this._say('Your move.');
    this._listenFor('move');
  }

  wrong(hint, expectedSan) {
    if (!this.on) return;
    this._cancelListen();
    let text = 'No, that’s not the repertoire move. Try again.';
    if (hint?.type === 'piece') text = `No. Hint: move your ${this._pieceAt(hint.from)} on ${hint.from.toUpperCase()}.`;
    if (hint?.type === 'move') text = `No. The move is ${sanToSpeech(expectedSan)}.`;
    this._say(text);
    this._listenFor('move');
    this._render();
  }

  lineFinished(text, last) {
    if (!this.on) return;
    this._cancelListen();
    this._say(text.replace(/^[✓✗]\s*/, ''));
    this.speaker.idle().then(() => {
      if (!this.on || !this.trainer.active) return;
      setTimeout(() => {
        const t = this.trainer;
        if (this.on && t.active && t.session.lineComplete()) t.nextLine();
      }, last ? 400 : 1200);
    });
  }

  summary(text) {
    if (!this.on) return;
    this._cancelListen();
    this._say(`Session complete. ${text}`);
  }

  // ---- listening ------------------------------------------------------------------

  _say(text) {
    this.lastSpoken = text;
    return this.speaker.say(text);
  }

  _cancelListen() {
    this.mode = 'idle';
    this.pending = null;
    this.listener.stop();
  }

  _listenFor(mode) {
    this.mode = mode;
    this._render();
    const gen = this.speaker.gen;
    this.speaker.idle().then(() => {
      if (this.on && this.mode === mode && this.speaker.gen === gen) this.listener.listen();
      this._render();
    });
  }

  _afterTrainerChange(justOn) {
    const t = this.trainer;
    if (!t?.active || !t.session) return;
    if (t.canMove()) {
      if (justOn) {
        const last = this.game.moves[this.game.ply - 1];
        this._say(last ? `${sanToSpeech(last.san)}. Your move.` : 'Your move.');
      }
      this._listenFor('move');
    }
  }

  /** A line in the panel's "Microphone details" log (for working out what a phone does). */
  _log(text) {
    const t = new Date();
    const stamp = `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0').slice(0, 1)}`;
    this.logLines = [...(this.logLines ?? []), `${stamp} ${text}`].slice(-60);
    if (this.el.log) this.el.log.textContent = this.logLines.join('\n');
  }

  _listenState(engine, state, msg) {
    if (state === 'log') return this._log(`${engine} ${msg}`);
    if (engine !== this.engine) return;
    if (state === 'blocked' || state === 'error' || state === 'needs-tap') this.micProblem = msg;
    if (state === 'note') {
      this.el.note.textContent = msg;
      this.el.note.hidden = false;
    }
    if (state === 'listening') {
      this.micProblem = null;
      this.micError = null;
      this.el.note.hidden = true;
    }
    this._render();
  }

  /**
   * Ask for the microphone while a tap is being handled. Chrome on Android won't show its
   * permission prompt otherwise, and the built-in recogniser then fails without asking.
   */
  _primeMic() {
    const sr = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    this._log(`page: secure=${window.isSecureContext} mediaDevices=${Boolean(navigator.mediaDevices?.getUserMedia)} recogniser=${sr} engine=${this.engine}`);
    this._log(`browser: ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 120)}`);
    navigator.permissions
      ?.query({ name: 'microphone' })
      .then((p) => this._log(`mic permission: ${p.state}`))
      .catch((err) => this._log(`mic permission: can't tell (${err?.name})`));
    const blocked = this._micBlockedReason();
    if (blocked) {
      this._log(`mic: blocked: ${blocked}`);
      return this._render();
    }
    if (this.engine !== 'builtin' || this.micPrimed) return;
    this.micPrimed = true;
    this._log('mic: asking (getUserMedia, inside the tap)');
    let answered = false;
    setTimeout(() => !answered && this._log('mic: no answer after 6 s (permission prompt not shown or not answered?)'), 6000);
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        answered = true;
        const tracks = stream?.getTracks?.() ?? [];
        this._log(`mic: allowed (${tracks.map((t) => t.label || 'track').join(', ') || 'no label'})`);
        tracks.forEach((t) => t.stop?.());
      })
      .catch((err) => {
        answered = true;
        this.micPrimed = false;
        this._log(`mic: refused ${err?.name}: ${err?.message}`);
        this.micError =
          err?.name === 'NotAllowedError'
            ? `Microphone refused (${err.name}: ${err.message}). Allow it for this site in Chrome’s site settings, then tap 🎙 to talk. Or type your moves.`
            : `Microphone unavailable (${err?.name || 'error'}: ${err?.message || err}). Type your moves.`;
        this._render();
      });
  }

  _heard(alts) {
    this.el.heard.textContent = `Heard: “${alts[0]}”`;
    this.el.heard.hidden = false;
    const t = this.trainer;
    if (!this.on || !t?.active) return;
    if (this.mode === 'confirm') return this._confirmAnswer(alts);
    if (this.mode !== 'move' || !t.canMove()) return;
    const r = interpret(alts, this._legal(), t.session.expected()?.uci ?? null);
    this._handle(r, false);
  }

  _typed(text) {
    const t = this.trainer;
    if (!t?.active || !text.trim()) return;
    if (!t.canMove()) {
      this.el.heard.textContent = 'Wait for your turn.';
      this.el.heard.hidden = false;
      return;
    }
    const r = interpretTyped(text, this._legal(), t.session.expected()?.uci ?? null);
    this.el.input.value = '';
    this._handle(r, true);
  }

  _handle(r, typed) {
    const t = this.trainer;
    if (r.kind === 'command') return this._command(r.command);
    if (r.kind === 'expected' || (r.kind === 'other' && typed)) {
      this.unclear = 0;
      this._cancelListen();
      t.voiceMove(r.move.uci); // wrong typed moves count straight away: nothing was misheard
      return;
    }
    if (r.kind === 'other') {
      this.unclear = 0;
      this._cancelListen();
      this.pending = r.move; // after _cancelListen, which clears it
      this._say(`I heard ${sanToSpeech(r.move.san)}. Is that right?`);
      this._listenFor('confirm');
      return;
    }
    this.unclear += 1;
    if (typed) {
      this.el.heard.textContent = `Couldn’t read “${r.heard}” as a legal move.`;
      this.el.heard.hidden = false;
      return;
    }
    this._cancelListen();
    this._say(this.unclear >= 2 ? 'Sorry, I didn’t catch a move. Say the piece and the square, like knight F3.' : 'Sorry, say that again.');
    this._listenFor('move');
  }

  _confirmAnswer(alts) {
    const answer = alts.map(heardYesNo).find(Boolean);
    const move = this.pending;
    if (answer === 'yes' && move) {
      this._cancelListen();
      this.trainer.voiceMove(move.uci);
      return;
    }
    if (answer === 'no') {
      this._cancelListen();
      this._say('OK, say your move again.');
      this._listenFor('move');
      return;
    }
    this._cancelListen();
    this.pending = move;
    this._say('Please say yes or no.');
    this._listenFor('confirm');
  }

  _command(cmd) {
    const t = this.trainer;
    this._cancelListen();
    if (cmd === 'stop') {
      this.setOn(false);
      return;
    }
    if (cmd === 'mishearing') return this._mishearing();
    if (cmd === 'repeat') {
      const last = this.game.moves[this.game.ply - 1];
      this._say(last ? `${sanToSpeech(last.san)}. Your move.` : 'Your move.');
    } else if (cmd === 'moves') {
      const sans = this.game.moves.slice(0, this.game.ply).map((m) => sanToSpeech(m.san));
      this._say(sans.length ? `${sans.join(', ')}. Your move.` : 'No moves yet. Your move.');
    }
    if (t?.canMove()) this._listenFor('move');
  }

  _mishearing() {
    const t = this.trainer;
    if (!t?.active) return;
    if (t.undoMistake()) {
      this._cancelListen();
      if (this.on) {
        this._say('OK, that one doesn’t count. Your move.');
        this._listenFor('move');
      }
    } else if (this.on) {
      this._cancelListen();
      this._say('There’s no mistake on this move to take back.');
      if (t.canMove()) this._listenFor('move');
    }
    this._render();
  }

  // ---- helpers ------------------------------------------------------------------------

  _legal() {
    return this.game.legalMoves();
  }

  _pieceAt(square) {
    return pieceName(this.game.pieceAt(square)?.type);
  }

  _applyBlind() {
    document.querySelector('.board-area')?.classList.toggle('blindfold', this.on && this.blind);
  }

  async _keepAwake() {
    try {
      if (!this.wakeLock && 'wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => (this.wakeLock = null));
      }
    } catch {
      // not allowed here: the screen may turn off
    }
  }

  /** Why the microphone can't work here at all, or null. */
  _micBlockedReason() {
    if (!window.isSecureContext) {
      const url = `https://${location.host}${location.pathname}`;
      return `The microphone only works over a secure connection: open ${url} (this page is http://). Type your moves meanwhile.`;
    }
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    if (policy?.allowsFeature && !policy.allowsFeature('microphone')) {
      return 'The server switches the microphone off for this site (a Permissions-Policy header with microphone=()). Allow it for the site, e.g. microphone=(self). Type your moves meanwhile.';
    }
    if (!navigator.mediaDevices?.getUserMedia) return 'This browser gives the page no microphone access. Type your moves.';
    return null;
  }

  _render() {
    const e = this.el;
    e.toggle.setAttribute('aria-pressed', String(this.on));
    e.toggle.textContent = this.on ? '🎧 Hands-free on' : '🎧 Hands-free';
    e.box.hidden = !this.on;
    if (!this.on) return;
    const t = this.trainer;
    let status;
    const both = this.listeners.builtin.available && this.listeners.offline.available;
    e.engineBox.hidden = !both;
    e.engine.value = this.engine;
    const insecure = this._micBlockedReason();
    if (insecure) status = insecure;
    else if (this.micError) status = this.micError;
    else if (!this.listener.available) status = 'This browser can’t listen: type your moves below.';
    else if (this.micProblem) status = this.micProblem;
    else if (this.listener.loading) status = '⏳ Loading the offline speech model (about 30 MB, first time only)…';
    else if (this.mode === 'confirm' && this.listener.running) status = '🎙 Yes or no?';
    else if (this.mode === 'move' && (this.listener.running || this.listener.starting)) status = '🎙 Listening for your move…';
    else if ((this.mode === 'move' || this.mode === 'confirm') && this.speaker.busy) status = '🔊 …then your move';
    else if (this.mode === 'move' || this.mode === 'confirm') status = 'Not listening: tap 🎙 to talk.';
    else status = '🔊 Reading out the moves';
    e.status.textContent = status;
    const waiting = (this.mode === 'move' || this.mode === 'confirm') && !this.speaker.busy;
    e.talk.hidden = !(!insecure && this.listener.available && waiting && !this.listener.running && !this.listener.starting && !this.listener.loading);
    e.undo.hidden = !t?.session?.canUndoMistake?.();
    e.blind.setAttribute('aria-pressed', String(this.blind));
    e.blind.textContent = this.blind ? 'Show pieces' : 'Hide pieces';
  }

  /** Call after the trainer changes state (a move, a hint, a new line). */
  refresh() {
    if (this.on) this._render();
  }
}
