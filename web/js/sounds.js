// Move sounds, made in the browser with the Web Audio API (no sound files, nothing to license).
//
//   move     a short wooden click          capture  a sharper, lower knock
//   check    a bright two-note ping        castle   two quick clicks
//   promote  a rising pair                 wrong    a soft low buzz (training, puzzles)
//   success  a short rising chime (line complete without mistakes, puzzle solved)
//
// Browsers only allow audio after the user has interacted with the page, so the audio
// context is created (or resumed) on the first tap, click or key press. The mute choice
// is remembered per device.

import { store } from './ui.js';

/** Which sound a move makes, from its SAN ("Nxe5+", "O-O", "e8=Q#"). Pure, unit tested. */
export function soundFor(san) {
  if (!san) return null;
  if (san.includes('+') || san.includes('#')) return 'check';
  if (san.startsWith('O-O')) return 'castle';
  if (san.includes('=')) return 'promote';
  if (san.includes('x')) return 'capture';
  return 'move';
}

/**
 * Whether a board change deserves a sound: exactly one move further along the same game
 * (a move played, or stepping forward one move). Jumps, stepping back and new games are silent.
 */
export function movedOneForward(prev, next) {
  return Boolean(prev) && next.startFen === prev.startFen && next.ply === prev.ply + 1 && next.ply > 0;
}

// Each sound: a list of notes { f: Hz, t: start (s), d: duration (s), type, gain, noise? }.
const SOUNDS = {
  move: [{ noise: true, t: 0, d: 0.045, f: 1800, q: 1.2, gain: 0.9 }, { f: 520, t: 0, d: 0.05, type: 'triangle', gain: 0.35 }],
  capture: [{ noise: true, t: 0, d: 0.07, f: 900, q: 1, gain: 1.1 }, { f: 300, t: 0, d: 0.08, type: 'triangle', gain: 0.5 }],
  check: [{ f: 880, t: 0, d: 0.09, type: 'sine', gain: 0.35 }, { f: 1320, t: 0.08, d: 0.14, type: 'sine', gain: 0.3 }],
  castle: [
    { noise: true, t: 0, d: 0.045, f: 1800, q: 1.2, gain: 0.9 },
    { f: 520, t: 0, d: 0.05, type: 'triangle', gain: 0.35 },
    { noise: true, t: 0.09, d: 0.045, f: 1600, q: 1.2, gain: 0.9 },
    { f: 470, t: 0.09, d: 0.05, type: 'triangle', gain: 0.35 },
  ],
  promote: [{ f: 660, t: 0, d: 0.08, type: 'triangle', gain: 0.35 }, { f: 990, t: 0.08, d: 0.12, type: 'triangle', gain: 0.35 }],
  wrong: [{ f: 150, t: 0, d: 0.18, type: 'sawtooth', gain: 0.3, lowpass: 600 }],
  success: [
    { f: 660, t: 0, d: 0.1, type: 'sine', gain: 0.25 },
    { f: 880, t: 0.09, d: 0.1, type: 'sine', gain: 0.25 },
    { f: 1320, t: 0.18, d: 0.18, type: 'sine', gain: 0.22 },
  ],
};

export class Sounds {
  constructor() {
    this.enabled = store.get('sound', true);
    this.ctx = null;
    this.noise = null;
    const unlock = () => this._unlock();
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, unlock, { capture: true, passive: true });
  }

  _unlock() {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
        // One second of white noise, reused for the wooden clicks.
        const len = this.ctx.sampleRate;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      this.ctx = null; // no audio here: stay silent
    }
  }

  setEnabled(on) {
    this.enabled = on;
    store.set('sound', on);
    if (on) this._unlock();
  }

  /** Play a sound by name (see SOUNDS). Silent when muted or before the first interaction. */
  play(name) {
    this.last = name; // for tests
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const notes = SOUNDS[name];
    if (!notes) return;
    const now = this.ctx.currentTime + 0.005;
    for (const n of notes) this._note(n, now);
  }

  playMove(san) {
    const name = soundFor(san);
    if (name) this.play(name);
  }

  _note(n, now) {
    const c = this.ctx;
    const start = now + n.t;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(n.gain, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
    let src;
    let last;
    if (n.noise) {
      src = c.createBufferSource();
      src.buffer = this.noise;
      const band = c.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = n.f;
      band.Q.value = n.q ?? 1;
      src.connect(band);
      last = band;
    } else {
      src = c.createOscillator();
      src.type = n.type ?? 'sine';
      src.frequency.setValueAtTime(n.f, start);
      last = src;
      if (n.lowpass) {
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = n.lowpass;
        src.connect(lp);
        last = lp;
      }
    }
    last.connect(gain);
    gain.connect(c.destination);
    src.start(start);
    src.stop(start + n.d + 0.02);
  }
}
