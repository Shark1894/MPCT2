// Saved evaluation of the board position: if any review has analysed this position
// before (in any game or line), show White's winning chances and the score without
// opening a review or switching the engine on.

import { api } from './api.js';
import { formatScore } from './engine.js';
import { normaliseEval, positionWhite } from './review-core.js';

const key = (fen) => fen.split(' ').slice(0, 4).join(' '); // position, not move counters

export class SavedEval {
  constructor(el) {
    this.el = el;
    this.cache = new Map(); // key -> eval (hits only, so new analysis is always picked up)
    this.fen = null;
    this.hidden = true;
    this.timer = null;
  }

  /** Call on every render with the board position and whether to hide (review open, training, play). */
  update(fen, hidden) {
    const changed = fen !== this.fen || hidden !== this.hidden;
    this.fen = fen;
    this.hidden = hidden;
    if (!changed) return;
    if (hidden) {
      this.el.hidden = true;
      return;
    }
    const cached = this.cache.get(key(fen));
    if (cached) {
      this._show(cached);
      return;
    }
    this.el.hidden = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._lookup(fen), 120); // let rapid stepping settle
  }

  /** Newly saved analysis (from a review). */
  remember(fen, ev) {
    const k = key(fen);
    const old = this.cache.get(k);
    if (!old || (old.movetime_ms ?? 0) <= ev.movetime_ms) this.cache.set(k, normaliseEval(ev));
    if (this.fen && key(this.fen) === k && !this.hidden) this._show(this.cache.get(k));
  }

  async _lookup(fen) {
    let ev;
    try {
      ev = normaliseEval((await api.evalsLookup([fen])).evals[0]);
    } catch {
      return;
    }
    if (ev?.lines?.length) this.cache.set(key(fen), ev);
    if (fen === this.fen && !this.hidden && ev?.lines?.length) this._show(ev);
  }

  _show(ev) {
    const w = positionWhite(ev);
    if (w === null) {
      this.el.hidden = true;
      return;
    }
    this.el.textContent = `White's winning chances: ${Math.round(w)}% · ${formatScore(ev.lines[0].score)}`;
    this.el.title = `Saved analysis: depth ${ev.depth}, ${ev.movetime_ms / 1000} s`;
    this.el.hidden = false;
  }
}
