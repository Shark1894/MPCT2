// Analysis panel: Stockfish evaluation and best lines for the board position, an
// evaluation bar beside the board and blue arrows for the engine's moves.
//
// The engine pauses (without forgetting it's switched on) during training, while
// playing against the engine, on the
// dashboard, and while the tab is in the background.

import { Engine, formatScore, whiteShare } from './engine.js';
import { store } from './ui.js';

const $ = (id) => document.getElementById(id);
const DEPTHS = [12, 16, 20, 24, 30, 0]; // 0 = no limit
const DEFAULTS = { on: false, multipv: 3, depth: 20 };

export class AnalysisPanel {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {import('./board.js').BoardView} deps.board
   * @param {(ucis: string[]) => void} deps.onPlayMoves  play engine moves on the board
   */
  constructor({ game, board, onPlayMoves }) {
    Object.assign(this, { game, board, onPlayMoves });
    this.settings = { ...DEFAULTS, ...store.get('engine', {}) };
    this.paused = new Set(); // reasons: 'training', 'play', 'away', 'hidden'
    this.engine = null;
    this.latest = null; // last update for the current position
    this.timer = null;
    this.frame = null;
    this.el = {
      panel: $('engine-panel'),
      toggle: $('engine-toggle'),
      eval: $('engine-eval'),
      depth: $('engine-depth'),
      body: $('engine-body'),
      lines: $('engine-lines'),
      multipv: $('engine-multipv'),
      depthLimit: $('engine-depth-limit'),
      status: $('engine-status'),
      bar: $('eval-bar'),
      barFill: $('eval-fill'),
      barLabel: $('eval-label'),
    };

    for (let n = 1; n <= 5; n++) this.el.multipv.appendChild(new Option(String(n), n));
    for (const d of DEPTHS) this.el.depthLimit.appendChild(new Option(d ? String(d) : 'No limit', d));
    this.el.multipv.value = String(this.settings.multipv);
    this.el.depthLimit.value = String(this.settings.depth);

    this.el.toggle.addEventListener('click', () => this.setOn(!this.settings.on));
    this.el.multipv.addEventListener('change', () => this._changeSetting('multipv', Number(this.el.multipv.value)));
    this.el.depthLimit.addEventListener('change', () => this._changeSetting('depth', Number(this.el.depthLimit.value)));
    document.addEventListener('visibilitychange', () =>
      document.hidden ? this.pause('hidden') : this.resume('hidden'),
    );
    board.onOrientationChange = () => this._renderBar();
    this._renderShell();
  }

  get running() {
    return this.settings.on && this.paused.size === 0;
  }

  setOn(on) {
    this.settings.on = on;
    this._save();
    this.onToggle?.(on);
    this._renderShell();
    if (this.running) this._analyse();
    else this._halt();
  }

  /** Pause for a reason (training, dashboard, background tab); resumes when all reasons clear. */
  pause(reason) {
    const wasRunning = this.running;
    this.paused.add(reason);
    if (wasRunning) this._halt();
    this._renderShell();
  }

  resume(reason) {
    this.paused.delete(reason);
    this._renderShell();
    if (this.running) this._analyse();
  }

  /** Call whenever the board position changes. */
  positionChanged() {
    if (!this.running) return;
    this.latest = null;
    this.board.setLayer('engine', []);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._analyse(), 150); // let rapid stepping settle
  }

  _changeSetting(key, value) {
    this.settings[key] = value;
    this._save();
    if (this.running) this._analyse();
  }

  _save() {
    store.set('engine', this.settings);
  }

  _analyse() {
    clearTimeout(this.timer);
    const status = this.game.status();
    if (status.over) {
      this.engine?.stop();
      this.latest = null;
      this._renderLines([]);
      this.el.eval.textContent = '';
      this.el.depth.textContent = '';
      this.el.status.textContent = `${status.text}: nothing to analyse.`;
      this.board.setLayer('engine', []);
      this._renderBar();
      return;
    }
    if (!this.engine) {
      this.engine = new Engine({
        onUpdate: (u) => this._update(u),
        onStatus: (text) => {
          this.el.status.textContent = text || this._engineLabel();
        },
      });
    }
    this.el.status.textContent = this._engineLabel();
    this.engine.analyse(this.game.fen(), { multipv: this.settings.multipv, depth: this.settings.depth });
  }

  _halt() {
    clearTimeout(this.timer);
    this.engine?.stop();
    this.latest = null;
    this.board.setLayer('engine', []);
    this._renderBar();
  }

  /** Training and play hide the engine entirely (not just pause it). */
  _hiddenByMode() {
    return this.paused.has('training') || this.paused.has('play');
  }

  _engineLabel() {
    if (!this.engine?.ready) return '';
    return `Stockfish 19 Lite · ${this.engine.threads} thread${this.engine.threads === 1 ? '' : 's'}`;
  }

  _update(update) {
    if (update.fen !== this.game.fen() || !this.running) return; // stale or switched off
    this.latest = update;
    if (this.frame) return; // render at most once per frame
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this._render();
    });
  }

  // ---- rendering ----------------------------------------------------------

  _renderShell() {
    const on = this.settings.on;
    this.el.toggle.setAttribute('aria-checked', String(on));
    this.el.toggle.textContent = on ? 'Engine on' : 'Engine off';
    this.el.body.hidden = !on;
    document.body.classList.toggle('engine-on', on && !this._hiddenByMode());
    if (!on) {
      this.el.eval.textContent = '';
      this.el.depth.textContent = '';
    }
    this._renderBar();
  }

  _render() {
    const u = this.latest;
    if (!u) return;
    const best = u.lines[0];
    this.el.eval.textContent = best ? formatScore(best.score) : '';
    const limit = this.settings.depth;
    this.el.depth.textContent = `Depth ${u.depth}${limit ? `/${limit}` : ''}${u.done ? ' ✓' : ''}`;
    this._renderLines(u.lines);
    this.board.setLayer(
      'engine',
      u.lines
        .filter((l) => l.pv.length)
        .map((l, i) => ({ orig: l.pv[0].slice(0, 2), dest: l.pv[0].slice(2, 4), brush: i === 0 ? 'blue' : 'paleBlue' }))
        .reverse(), // draw the best move last so it's on top
    );
    this._renderBar();
  }

  _renderLines(lines) {
    const box = this.el.lines;
    box.innerHTML = '';
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'engine-line';
      const score = document.createElement('span');
      score.className = 'engine-score';
      const white = (line.score.mate ?? line.score.cp) > 0 || (line.score.mate === undefined && line.score.cp === 0);
      score.classList.add(white ? 'for-white' : 'for-black');
      score.textContent = formatScore(line.score);
      row.appendChild(score);
      const moves = document.createElement('span');
      moves.className = 'engine-moves';
      for (const m of line.moves) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'engine-move';
        btn.textContent = m.text;
        btn.title = 'Play up to this move';
        btn.addEventListener('click', () => this.onPlayMoves(line.pv.slice(0, m.index + 1)));
        moves.appendChild(btn);
      }
      row.appendChild(moves);
      box.appendChild(row);
    }
  }

  _renderBar() {
    const show = this.settings.on && !this._hiddenByMode();
    this.el.bar.hidden = !show;
    if (!show) return;
    const score = this.latest?.lines[0]?.score ?? null;
    const share = whiteShare(score);
    // White's share fills from White's side of the board.
    this.el.bar.classList.toggle('flipped', this.board.orientation() === 'black');
    this.el.barFill.style.height = `${share}%`;
    this.el.barLabel.textContent = score ? formatScore(score).replace(/^\+/, '') : '';
    this.el.barLabel.classList.toggle('white-ahead', share >= 50);
  }
}
