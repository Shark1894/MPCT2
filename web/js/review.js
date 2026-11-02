// Move-by-move engine review of the moves leading to the board position: analyses
// every position with Stockfish in this browser (a separate engine from the live
// analysis), saves each result on the server so nothing is analysed twice, and
// shows an evaluation graph, a judgement of every move and a per-side summary.

import { api } from './api.js';
import { Engine, formatScore, pvToSan } from './engine.js';
import { START_FEN } from './game.js';
import {
  LABELS,
  SPEEDS,
  describeDuration,
  estimateSeconds,
  judgeMoves,
  normaliseEval,
  positionWhite,
  reviewPositions,
  reviewStillApplies,
  summarise,
  terminalEval,
} from './review-core.js';
import { formDialog, plural, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const ENGINE_NAME = 'Stockfish 19 Lite';
const SAVE_BATCH = 5;
const SIDE = { w: 'White', b: 'Black' };
const pct = (x) => `${Math.round(x)}%`;

export class ReviewController {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {import('./board.js').BoardView} deps.board
   * @param {import('./analysis.js').AnalysisPanel} deps.analysis
   * @param {() => object|null} deps.getOpening   selected repertoire opening (for book moves)
   * @param {() => boolean} deps.isBusy           training or playing: no review
   * @param {(ply: number) => void} deps.onJump
   * @param {() => void} deps.onChanged           results changed: redraw the move list
   */
  constructor({ game, board, analysis, getOpening, isBusy, onJump, onChanged }) {
    Object.assign(this, { game, board, analysis, getOpening, isBusy, onJump, onChanged });
    this.review = null;
    this.run = null;
    this.wakeLock = null;
    this.el = {
      start: $('review-start'),
      box: $('review'),
      title: $('review-title'),
      close: $('review-close'),
      progress: $('review-progress'),
      bar: $('review-bar'),
      progressText: $('review-progress-text'),
      cancel: $('review-cancel'),
      graph: $('review-graph'),
      summary: $('review-summary'),
      move: $('review-move'),
      book: $('review-book'),
    };
    this.el.start.addEventListener('click', () => this.start());
    this.el.cancel.addEventListener('click', () => this.cancel());
    this.el.close.addEventListener('click', () => this.close());
    this.el.graph.addEventListener('click', (e) => this._graphClick(e));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.run) this._keepAwake(); // the lock is dropped when the tab hides
    });
    window.addEventListener('resize', () => this.review && this._renderGraph());
  }

  get running() {
    return this.run !== null;
  }

  // ---- starting ------------------------------------------------------------

  async start() {
    if (this.running || this.isBusy()) return;
    const g = this.game;
    const ply = g.ply;
    if (ply === 0) {
      toast('Play or open some moves first: the review covers the moves up to the board position.');
      return;
    }
    const moves = g.moves.slice(0, ply).map((m) => ({ san: m.san, uci: m.uci }));
    const positions = reviewPositions(g.startFen, g.moves, ply);
    const terminals = positions.map((fen) => terminalEval(fen));
    let saved;
    try {
      saved = (await api.evalsLookup(positions, 0)).evals.map(normaliseEval);
    } catch (err) {
      toast(`Couldn't check saved analysis: ${err.message}`, 'error');
      saved = positions.map(() => null);
    }
    const todo = (ms) => positions.filter((_, i) => !terminals[i] && !(saved[i] && saved[i].movetime_ms >= ms)).length;

    const coarse = matchMedia('(pointer: coarse)').matches;
    const options = Object.entries(SPEEDS).map(([key, s]) => {
      const n = todo(s.ms);
      const time = n === 0 ? 'already analysed' : `${describeDuration(estimateSeconds(n, s.ms))}`;
      return [key, `${s.label}: ${s.ms / 1000} s per position (${time})`];
    });
    const preferred = SPEEDS[store.get('reviewSpeed')] ? store.get('reviewSpeed') : 'standard';
    const reused = positions.length - todo(SPEEDS[preferred].ms);
    const res = await formDialog({
      title: 'Review with the engine',
      message:
        `Analyses ${plural(positions.length, 'position')} (${plural(ply, 'move')}, up to the board position) one at a time, ` +
        `then marks each move and draws the evaluation graph.` +
        (reused ? ` ${plural(reused, 'position')} analysed before at ${SPEEDS[preferred].label} or longer will be reused.` : '') +
        `\n\nThe engine runs in this browser: keep this tab open until it finishes` +
        (coarse ? ' (the screen stays on while it works).' : '.') +
        ` You can look through the moves while it runs.`,
      fields: [
        { name: 'speed', label: 'Thinking time', type: 'select', options, value: preferred },
      ],
      submit: 'Start review',
    });
    if (!res) return;
    const speed = SPEEDS[res.speed] ? res.speed : 'standard';
    store.set('reviewSpeed', speed);
    const ms = SPEEDS[speed].ms;

    this.review = {
      startFen: g.startFen,
      ucis: moves.map((m) => m.uci),
      moves,
      positions,
      // Show the best analysis available straight away; `fresh` marks what meets the chosen speed.
      evals: positions.map((_, i) => terminals[i] ?? saved[i] ?? null),
      fresh: positions.map((_, i) => Boolean(terminals[i] || (saved[i] && saved[i].movetime_ms >= ms))),
      judged: [],
      speed,
      ms,
      book: null,
    };
    this._persist();
    this._judge();
    this._checkBook();
    this.el.box.hidden = false;
    this.update();
    await this._run();
  }

  /** Rebuild a review from saved analysis after a reload (no engine needed). */
  async restore() {
    const saved = store.get('review');
    const g = this.game;
    if (!saved || !reviewStillApplies(saved, g.startFen, g.moves.map((m) => m.uci))) return;
    const moves = g.moves.slice(0, saved.ucis.length).map((m) => ({ san: m.san, uci: m.uci }));
    const positions = reviewPositions(g.startFen, g.moves, saved.ucis.length);
    let found;
    try {
      found = (await api.evalsLookup(positions, 0)).evals.map(normaliseEval);
    } catch {
      return;
    }
    if (!reviewStillApplies(saved, this.game.startFen, this.game.moves.map((m) => m.uci))) return; // changed meanwhile
    const ms = SPEEDS[saved.speed]?.ms ?? SPEEDS.standard.ms;
    this.review = {
      startFen: g.startFen,
      ucis: saved.ucis,
      moves,
      positions,
      evals: positions.map((fen, i) => terminalEval(fen) ?? found[i] ?? null),
      fresh: positions.map((fen, i) => Boolean(terminalEval(fen) || (found[i] && found[i].movetime_ms >= ms))),
      judged: [],
      speed: saved.speed,
      ms,
      book: null,
    };
    this._judge();
    this._checkBook();
    this.el.box.hidden = false;
    this.update();
  }

  // ---- running -------------------------------------------------------------

  async _run() {
    const r = this.review;
    const queue = r.fresh.map((ok, i) => (ok ? null : i)).filter((i) => i !== null);
    const engine = new Engine({ onUpdate: () => {}, onStatus: () => {} });
    this.run = { engine, total: queue.length, done: 0, started: performance.now(), cancelled: false, pending: [] };
    this.analysis.pause('review'); // don't compete with the live engine for the CPU
    this.el.start.disabled = true;
    this._keepAwake();
    this._renderProgress();
    try {
      for (const i of queue) {
        if (this.run.cancelled || this.review !== r) break;
        const result = await engine.evaluate(r.positions[i], { multipv: 2, movetime: r.ms });
        if (!result || this.run.cancelled || this.review !== r) break;
        const ev = {
          depth: result.depth,
          movetime_ms: r.ms,
          lines: result.lines.map((l) => ({ uci: l.pv[0], score: l.score, pv: l.pv.slice(0, 12) })),
        };
        r.evals[i] = ev;
        r.fresh[i] = true;
        this.run.done += 1;
        this.run.pending.push({ fen: r.positions[i], movetime_ms: r.ms, depth: ev.depth, engine: ENGINE_NAME, lines: ev.lines });
        if (this.run.pending.length >= SAVE_BATCH) this._flush();
        this._judge();
        this.update();
        this.onChanged();
      }
    } finally {
      const run = this.run;
      this._flush();
      engine.terminate();
      this.run = null;
      this.el.start.disabled = false;
      this._releaseAwake();
      this.analysis.resume('review');
      if (this.review === r) {
        if (run.cancelled) toast(`Review stopped after ${plural(run.done, 'position')}. Review again to continue.`);
        this.update();
        this.onChanged();
      }
    }
  }

  _flush() {
    const batch = this.run?.pending.splice(0) ?? [];
    if (!batch.length) return;
    api.saveEvals(batch).catch((err) => toast(`Analysis not saved: ${err.message}`, 'error'));
  }

  cancel() {
    if (!this.run) return;
    this.run.cancelled = true;
    this.run.engine.stop();
  }

  close() {
    this.cancel();
    this.review = null;
    store.set('review', null);
    this.el.box.hidden = true;
    this.board.setLayer('review', []);
    this.onClosed?.();
  }

  async _keepAwake() {
    try {
      if (!this.wakeLock && 'wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => (this.wakeLock = null));
      }
    } catch {
      // not allowed (e.g. battery saver): the review still runs while the tab is open
    }
  }

  _releaseAwake() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  _persist() {
    const r = this.review;
    store.set('review', { startFen: r.startFen, ucis: r.ucis, speed: r.speed });
  }

  _judge() {
    const r = this.review;
    r.judged = judgeMoves(r.positions, r.moves, r.evals);
    r.summary = summarise(r.judged);
  }

  async _checkBook() {
    const r = this.review;
    const opening = this.getOpening();
    if (!opening || r.startFen !== START_FEN) return;
    try {
      const res = await api.checkGame(opening.id, r.ucis);
      if (this.review !== r) return;
      r.book = { plies: res.status === 'in_book' ? r.ucis.length : res.ply - 1, opening: opening.name, status: res.status };
      this.update();
      this.onChanged();
    } catch {
      // no book marks; the review itself is unaffected
    }
  }

  // ---- called by the page ---------------------------------------------------

  /** After any board change: drop the review if the moves changed, else redraw. */
  update() {
    const r = this.review;
    if (!r) return;
    if (!reviewStillApplies(r, this.game.startFen, this.game.moves.map((m) => m.uci))) {
      const wasRunning = this.running;
      this.close();
      if (wasRunning) toast('Review stopped: the moves changed.');
      return;
    }
    this.el.box.hidden = this.isBusy();
    this._renderProgress();
    this._renderGraph();
    this._renderSummary();
    this._renderMove();
  }

  /** Move-list marks: ply -> { symbol, cls, title, book }. */
  annotations() {
    const out = new Map();
    const r = this.review;
    if (!r || this.isBusy()) return out;
    for (const j of r.judged) {
      if (!j) continue;
      const book = r.book && j.ply <= r.book.plies;
      if (j.label || book) {
        out.set(j.ply, {
          symbol: j.label ? LABELS[j.label].symbol : '',
          cls: j.label ? `rv-${j.label}` : '',
          title: [j.label ? LABELS[j.label].text : '', book ? `In your ${r.book.opening} repertoire` : ''].filter(Boolean).join(' · '),
          book,
        });
      }
    }
    return out;
  }

  // ---- rendering --------------------------------------------------------------

  _renderProgress() {
    const run = this.run;
    const r = this.review;
    this.el.progress.hidden = !run;
    const analysed = r.fresh.filter(Boolean).length;
    const label = SPEEDS[r.speed]?.label ?? '';
    if (!run) {
      const missing = r.positions.length - analysed;
      this.el.title.textContent = missing
        ? `Review · ${analysed} of ${r.positions.length} positions analysed at ${label}`
        : `Review · ${plural(r.moves.length, 'move')} · ${label}`;
      return;
    }
    this.el.title.textContent = `Reviewing ${plural(r.moves.length, 'move')} · ${label}`;
    this.el.bar.max = Math.max(1, run.total);
    this.el.bar.value = run.done;
    const elapsed = (performance.now() - run.started) / 1000;
    const per = run.done ? elapsed / run.done : r.ms / 1000 + 0.08;
    const left = Math.ceil(per * (run.total - run.done));
    this.el.progressText.textContent =
      run.total === 0
        ? 'Everything was analysed before.'
        : `Analysing position ${Math.min(run.done + 1, run.total)} of ${run.total} · ${describeDuration(left)} left`;
  }

  _renderSummary() {
    const s = this.review.summary;
    const box = this.el.summary;
    box.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'rv-row rv-head';
    for (const t of ['', 'Accuracy', '?!', '?', '??', '!']) {
      const c = document.createElement('span');
      c.textContent = t;
      if (t && t !== 'Accuracy') c.title = { '?!': 'Inaccuracies', '?': 'Mistakes', '??': 'Blunders', '!': 'Only moves found' }[t];
      head.appendChild(c);
    }
    box.appendChild(head);
    for (const side of ['w', 'b']) {
      const row = document.createElement('div');
      row.className = 'rv-row';
      const v = s[side];
      const cells = [SIDE[side], v.accuracy === null ? '—' : pct(v.accuracy), v.inaccuracy, v.mistake, v.blunder, v.only];
      cells.forEach((t, i) => {
        const c = document.createElement('span');
        c.textContent = String(t);
        if (i >= 2 && t > 0) c.className = ['', '', 'rv-inaccuracy', 'rv-mistake', 'rv-blunder', 'rv-only'][i];
        row.appendChild(c);
      });
      box.appendChild(row);
    }
    const r = this.review;
    this.el.book.hidden = !r.book;
    if (r.book) {
      this.el.book.textContent =
        r.book.plies === 0
          ? `Leaves your ${r.book.opening} repertoire straight away.`
          : r.book.status === 'in_book'
            ? `Every move is in your ${r.book.opening} repertoire.`
            : `In your ${r.book.opening} repertoire up to ${moveLabel(r.book.plies, r.moves[r.book.plies - 1].san, r.startFen)}.`;
    }
  }

  _renderMove() {
    const r = this.review;
    const ply = this.game.ply;
    const box = this.el.move;
    box.innerHTML = '';
    const add = (cls, text) => {
      const p = document.createElement('p');
      p.className = cls;
      p.textContent = text;
      box.appendChild(p);
      return p;
    };
    const ev = ply <= r.moves.length ? r.evals[ply] : null;
    const evalText = (e) => {
      if (!e) return 'not analysed yet';
      if (e.terminal) return e.terminal === 'checkmate' ? 'checkmate' : 'draw';
      return `${formatScore(e.lines[0].score)} (depth ${e.depth})`;
    };
    let shapes = [];
    if (ply > r.moves.length) {
      add('meta', 'This position is after the reviewed moves.');
    } else if (ply === 0) {
      add('rv-move-head', 'Start position');
      add('meta', `Evaluation ${evalText(ev)}`);
    } else {
      const j = r.judged[ply - 1];
      const m = r.moves[ply - 1];
      const head = add('rv-move-head', moveLabel(ply, m.san, r.startFen) + (j?.label ? LABELS[j.label].symbol : ''));
      const book = r.book && ply <= r.book.plies;
      if (!j) {
        add('meta', 'Not analysed yet.');
      } else {
        const verdict = document.createElement('span');
        verdict.className = `rv-verdict ${j.label ? `rv-${j.label}` : ''}`;
        verdict.textContent = j.label ? LABELS[j.label].text : j.isBest ? 'Best move' : 'Good move';
        head.append(' ', verdict);
        if (book) {
          const b = document.createElement('span');
          b.className = 'rv-book-tag';
          b.textContent = 'Repertoire';
          b.title = `In your ${r.book.opening} repertoire`;
          head.append(' ', b);
        }
        add('rv-chances', `${SIDE[j.side]}'s winning chances: ${pct(j.before)} → ${pct(j.after)}`);
        for (const note of j.notes) add('rv-note', note);
        if (j.best) {
          const bestLine = pvToSan(r.positions[ply - 1], j.best.pv, 8).map((x) => x.text).join(' ');
          add('rv-best', `Best was ${moveLabel(ply, j.best.san, r.startFen)} (${formatScore(j.best.score)}): ${bestLine}`);
          if (j.label) shapes = [{ orig: j.best.uci.slice(0, 2), dest: j.best.uci.slice(2, 4), brush: 'green' }];
        }
      }
      add('meta', `Evaluation after the move: ${evalText(ev)}`);
    }
    this.board.setLayer('review', this.isBusy() ? [] : shapes);
  }

  _renderGraph() {
    const r = this.review;
    const svgNS = 'http://www.w3.org/2000/svg';
    const box = this.el.graph;
    const W = Math.max(200, box.clientWidth || 300);
    const H = 90;
    const PAD = 5; // room for the dots at 0% and 100%
    const n = Math.max(1, r.positions.length - 1);
    const x = (i) => PAD + (i / n) * (W - 2 * PAD);
    const y = (w) => H - PAD - (w / 100) * (H - 2 * PAD);
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Evaluation graph: White’s winning chances after each move');
    const el = (name, attrs) => {
      const e = document.createElementNS(svgNS, name);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.appendChild(e);
      return e;
    };
    el('rect', { x: 0, y: 0, width: W, height: H, class: 'rv-g-bg' });
    // White's share as a filled area, drawn in runs of analysed positions.
    const whites = r.evals.map((e) => positionWhite(e));
    let run = [];
    const flushRun = () => {
      if (run.length >= 1) {
        const pts = run.map((i) => `${x(i).toFixed(1)},${y(whites[i]).toFixed(1)}`);
        const first = run[0];
        const last = run.at(-1);
        el('polygon', { points: `${x(first)},${H} ${pts.join(' ')} ${x(last)},${H}`, class: 'rv-g-area' });
        el('polyline', { points: pts.join(' '), class: 'rv-g-line' });
      }
      run = [];
    };
    whites.forEach((w, i) => (w === null ? flushRun() : run.push(i)));
    flushRun();
    el('line', { x1: 0, x2: W, y1: y(50), y2: y(50), class: 'rv-g-mid' });
    if (r.book?.plies) el('rect', { x: 0, y: 0, width: x(r.book.plies), height: 4, class: 'rv-g-book' });
    // Marks for labelled moves.
    for (const j of r.judged) {
      if (!j?.label) continue;
      const c = el('circle', { cx: x(j.ply), cy: y(whites[j.ply]), r: 4, class: `rv-g-dot rv-${j.label}` });
      const t = document.createElementNS(svgNS, 'title');
      t.textContent = `${moveLabel(j.ply, j.san, r.startFen)} ${LABELS[j.label].text}`;
      c.appendChild(t);
    }
    if (this.game.ply <= r.moves.length) el('line', { x1: x(this.game.ply), x2: x(this.game.ply), y1: 0, y2: H, class: 'rv-g-now' });
    box.innerHTML = '';
    box.appendChild(svg);
    this._graphGeom = { W, n };
  }

  _graphClick(e) {
    const r = this.review;
    if (!r || !this._graphGeom) return;
    const rect = this.el.graph.getBoundingClientRect();
    const frac = (e.clientX - rect.left - 5) / Math.max(1, rect.width - 10);
    const ply = Math.max(0, Math.min(r.moves.length, Math.round(frac * this._graphGeom.n)));
    this.onJump(ply);
  }
}

/** "12.Nf3" / "12...Nf6" for the move at a ply, numbered from the start position. */
function moveLabel(ply, san, startFen) {
  const [, turn, , , , fullmove] = startFen.split(' ');
  const offset = turn === 'b' ? 1 : 0; // a start with Black to move shifts the numbering
  const p = ply + offset - 1; // 0-based half-move index counting from White's first move
  const number = Number(fullmove || 1) + Math.floor(p / 2);
  return p % 2 === 0 ? `${number}.${san}` : `${number}...${san}`;
}
