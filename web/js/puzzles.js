// Puzzles: the Puzzles tab (rating, history, themes, recent puzzles, the database import)
// and the puzzle mode on the board (PuzzleController), which connects a PuzzleRun (rules)
// to the board like training does.

import { api } from './api.js';
import { Chess } from '../vendor/chess.js/chess.js';
import { PuzzleRun, historyPath } from './puzzle.js';
import { daysFromToday, plural, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const REPLY_DELAY_MS = 500;
const SETUP_DELAY_MS = 600;
const POLL_MS = 2000;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

// ---- puzzle mode on the board --------------------------------------------------------------

export class PuzzleController {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {import('./board.js').BoardView} deps.board
   * @param {() => void} deps.render
   * @param {(active: boolean) => void} deps.onModeChange   puzzle mode on/off (panel, views)
   * @param {(locked: boolean) => void} deps.onLock         navigation/engine locked while solving
   */
  constructor({ game, board, render, onModeChange, onLock }) {
    Object.assign(this, { game, board, render, onModeChange, onLock });
    this.run = null;
    this.active = false;
    this.theme = null;
    this.seen = []; // puzzle ids shown this session (skipped ones aren't recorded)
    this.timer = null;
    this.el = {
      box: $('puzzle'),
      title: $('puzzle-title'),
      progress: $('puzzle-progress'),
      message: $('puzzle-message'),
      playing: $('puzzle-playing'),
      reveal: $('puzzle-reveal'),
      skip: $('puzzle-skip'),
      end: $('puzzle-end'),
      result: $('puzzle-result'),
      info: $('puzzle-info'),
      next: $('puzzle-next'),
      retry: $('puzzle-retry'),
      gameLink: $('puzzle-game'),
      stop: $('puzzle-stop'),
    };
    this.el.stop.addEventListener('click', () => this.stop());
    this.el.next.addEventListener('click', () => this.next());
    this.el.retry.addEventListener('click', () => this.retry());
    this.el.reveal.addEventListener('click', () => this.reveal());
    this.el.skip.addEventListener('click', () => this.skip());
  }

  /** Solving (the board belongs to the puzzle; navigation and engine locked). */
  get locked() {
    return this.active && Boolean(this.run) && !this.run.done;
  }

  canMove() {
    return this.locked && this.run.index > 0 && this.run.index % 2 === 1 && !this.busy;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Start solving puzzles near your rating (optionally one theme). */
  async start(theme = null) {
    this.theme = theme;
    this.seen = [];
    this.session = { solved: 0, failed: 0 };
    await this.next();
  }

  /** Open one puzzle by id (e.g. a retry from the Puzzles tab). */
  async open(puzzleId) {
    let p;
    try {
      p = await api.puzzle(puzzleId);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    this.session = this.session ?? { solved: 0, failed: 0 };
    this._begin(p);
  }

  async next() {
    clearTimeout(this.timer);
    let p;
    try {
      p = await api.nextPuzzle(this.theme, this.seen.slice(-50));
    } catch (err) {
      toast(err.message, 'error');
      if (!this.active) return;
      this._message(err.message, 'wrong');
      return;
    }
    this._begin(p);
  }

  _begin(p) {
    clearTimeout(this.timer);
    this.seen.push(p.id);
    this.run = new PuzzleRun(p);
    this.lastResult = null;
    if (!this.active) {
      this.active = true;
      this.el.box.hidden = false;
      this.onModeChange(true);
    }
    this.onLock(true);
    this._shapes(null);
    this.el.end.hidden = true;
    this.el.playing.hidden = false;
    this.el.title.textContent = `Puzzle · rated ${p.rating}${p.tried ? ' · retry (not rated)' : ''}`;
    this._progress();
    this.game.load(p.fen);
    this.board.setOrientation(this.run.color);
    this._message('');
    this.busy = true;
    this.render();
    const boardTop = document.querySelector('.board-area').getBoundingClientRect().top;
    if (boardTop < 0) window.scrollTo({ top: window.scrollY + boardTop - 8, behavior: 'smooth' });
    const run = this.run;
    this.timer = setTimeout(() => {
      if (this.run !== run) return;
      this._play(run.setupMove());
      this.busy = false;
      this._message(`Your move: find the best move for ${run.color === 'white' ? 'White' : 'Black'}.`);
      this.render();
    }, SETUP_DELAY_MS);
  }

  stop() {
    clearTimeout(this.timer);
    this.run = null;
    this.active = false;
    this._shapes(null);
    this.el.box.hidden = true;
    this.onLock(false);
    this.onModeChange(false);
    this.render();
  }

  // ---- moves -------------------------------------------------------------------------------------

  _play(uci) {
    this.game.play(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
  }

  /** Called by the page when the user drops a piece (promotion already chosen). */
  onUserMove(from, to, promotion) {
    const run = this.run;
    if (!this.canMove()) {
      this.render();
      return;
    }
    const uci = `${from}${to}${promotion ?? ''}`;
    let mates = false;
    try {
      const c = new Chess(this.game.fen());
      c.move({ from, to, promotion });
      mates = c.isCheckmate();
    } catch {
      this.render(); // illegal: snap back
      return;
    }
    const res = run.tryMove(uci, mates);
    if (!res.correct) {
      this.render(); // snap back
      if (res.firstMistake) this._report();
      this._shapes(run.failed && !res.firstMistake ? run.hintSquare() : null);
      this._message(
        res.firstMistake
          ? '✗ Not the move: puzzle failed. Keep trying, or show the solution.'
          : 'Not that either. The highlighted piece moves.',
        'wrong',
      );
      return;
    }
    this._shapes(null);
    this._play(uci);
    this.render();
    if (res.finished && !res.reply) {
      this._finish();
      return;
    }
    this._message(run.failed ? 'Right. Carry on.' : '✓ Best move! Keep going.', 'good');
    this.busy = true;
    this.timer = setTimeout(() => {
      if (this.run !== run) return;
      this._play(res.reply);
      this.busy = false;
      this.render();
      if (res.finished) this._finish();
    }, REPLY_DELAY_MS);
  }

  reveal() {
    const run = this.run;
    if (!run || run.done) return;
    const { rest } = run.reveal();
    this._report();
    this._shapes(null);
    this.busy = true;
    let i = 0;
    const step = () => {
      if (this.run !== run) return;
      if (i >= rest.length) {
        this.busy = false;
        this._finish();
        return;
      }
      this._play(rest[i++]);
      this.render();
      this.timer = setTimeout(step, REPLY_DELAY_MS);
    };
    this._message('The solution:');
    step();
  }

  /** Skip: counts as failed if you've started (a move made), otherwise just moves on. */
  async skip() {
    const run = this.run;
    if (run && run.index > 1 && !run.failed) {
      run.failed = true;
      await this._report();
    }
    await this.next();
  }

  retry() {
    if (this.run) this._begin({ ...this.run.puzzle, tried: (this.run.puzzle.tried ?? 0) + 1 });
  }

  async _report() {
    const run = this.run;
    const r = run.result();
    if (!r) return;
    try {
      this.lastResult = await api.puzzleAttempt(run.puzzle.id, r.solved, r.seconds);
      if (this.lastResult.rated) this.session[r.solved ? 'solved' : 'failed'] += 1;
      if (this.run === run) this._progress();
      if (this.run === run && run.done) this._showEnd();
    } catch (err) {
      toast(`Result not saved: ${err.message}`, 'error');
    }
  }

  async _finish() {
    const run = this.run;
    this.el.playing.hidden = true;
    this._message('');
    this.onLock(false); // free to step through it and analyse
    this.render();
    await this._report();
    if (this.run === run) this._showEnd();
  }

  _showEnd() {
    const run = this.run;
    const p = run.puzzle;
    const r = this.lastResult;
    const rating = r ? (r.rated ? `Rating ${r.rating_after} (${signed(r.change)})` : 'Not rated: you’ve tried it before.') : '';
    this.el.result.textContent = run.solved ? `✓ Solved! ${rating}` : `✗ ${run.revealed ? 'Solution shown.' : 'Failed.'} ${rating}`;
    this.el.result.className = `train-result ${run.solved ? 'good' : 'bad'}`;
    const facts = [`Puzzle rated ${p.rating}`, p.theme_names.join(', ')];
    if (p.opening_tags.length) facts.push(p.opening_tags[p.opening_tags.length - 1]);
    facts.push(`${p.nb_plays.toLocaleString('en-GB')} plays`);
    this.el.info.textContent = facts.filter(Boolean).join(' · ');
    this.el.gameLink.hidden = !p.game_url;
    this.el.gameLink.href = p.game_url || '#';
    this.el.end.hidden = false;
    this.el.playing.hidden = true;
    this.el.next.focus();
  }

  _progress() {
    const r = this.lastResult;
    const s = this.session ?? { solved: 0, failed: 0 };
    const parts = [];
    if (s.solved + s.failed) parts.push(`This session: ${s.solved} solved, ${s.failed} failed`);
    if (r) parts.push(`Your rating ${r.rating_after}${r.provisional ? '?' : ''}`);
    this.el.progress.textContent = parts.join(' · ');
  }

  _message(text, kind = '') {
    this.el.message.textContent = text;
    this.el.message.className = `train-message ${kind}`;
  }

  _shapes(square) {
    this.board.setLayer('hint', square ? [{ orig: square, brush: 'yellow' }] : []);
  }
}

// ---- the Puzzles tab -----------------------------------------------------------------------------

export class PuzzlesView {
  /**
   * @param {object} deps
   * @param {(theme: string|null) => void} deps.onStart
   * @param {(puzzleId: string) => void} deps.onRetry
   */
  constructor({ onStart, onRetry }) {
    Object.assign(this, { onStart, onRetry });
    this.visible = false;
    this.timer = null;
    this.el = {
      rating: $('pz-rating'),
      ratingMeta: $('pz-rating-meta'),
      theme: $('pz-theme'),
      start: $('pz-start'),
      dbText: $('pz-db-text'),
      dbProgress: $('pz-db-progress'),
      dbBar: $('pz-db-bar'),
      import: $('pz-import'),
      chart: $('pz-chart'),
      chartEmpty: $('pz-chart-empty'),
      themes: $('pz-themes'),
      themesEmpty: $('pz-themes-empty'),
      recent: $('pz-recent'),
      recentEmpty: $('pz-recent-empty'),
    };
    this.el.start.addEventListener('click', () => this.onStart(this.el.theme.value || null));
    this.el.theme.addEventListener('change', () => store.set('puzzleTheme', this.el.theme.value));
    this.el.import.addEventListener('click', () => this.startImport());
  }

  async refresh() {
    this.visible = true;
    if (!this.themesLoaded) {
      try {
        for (const t of await api.puzzleThemes()) this.el.theme.appendChild(new Option(t.name, t.theme));
        this.themesLoaded = true;
        this.el.theme.value = store.get('puzzleTheme', '');
      } catch {
        /* offered next time */
      }
    }
    await Promise.all([this.loadStatus(), this.loadSummary()]);
  }

  hide() {
    this.visible = false;
    clearTimeout(this.timer);
  }

  async loadStatus() {
    let st;
    try {
      st = await api.puzzleStatus();
    } catch (err) {
      this.el.dbText.textContent = `Couldn’t load: ${err.message}`;
      return;
    }
    const e = this.el;
    const have = st.puzzles > 0;
    e.start.disabled = !have || st.importing;
    e.import.disabled = st.importing;
    e.import.textContent = have ? 'Update puzzles' : 'Download puzzles';
    e.import.classList.toggle('primary', !have);
    e.dbProgress.hidden = !st.importing;
    if (st.importing) {
      e.dbBar.style.width = `${Math.min(100, (st.loaded / st.expected) * 100).toFixed(1)}%`;
      e.dbText.textContent = `${st.step}… ${st.loaded.toLocaleString('en-GB')} puzzles so far.`;
    } else if (have) {
      const days = st.imported_at ? -daysFromToday(st.imported_at.slice(0, 10)) : null;
      const when = days === null ? '' : days <= 0 ? ' today' : days === 1 ? ' yesterday' : ` ${days} days ago`;
      e.dbText.textContent = `${st.puzzles.toLocaleString('en-GB')} puzzles from the Lichess puzzle database, downloaded${when}.` +
        (st.error ? ` The last update failed: ${st.error}` : '');
    } else {
      e.dbText.textContent = st.error
        ? `The download failed: ${st.error}`
        : 'No puzzles yet. Download the Lichess puzzle database: about 260 MB, 6 million puzzles, a few minutes. ' +
          'It takes about 2 GB in the database.';
    }
    clearTimeout(this.timer);
    if (st.importing && this.visible) {
      this.timer = setTimeout(async () => {
        await this.loadStatus();
      }, POLL_MS);
    }
    this.wasImporting = st.importing;
  }

  async startImport() {
    try {
      await api.puzzleImport();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    await this.loadStatus();
  }

  async loadSummary() {
    let s;
    try {
      s = await api.puzzleSummary();
    } catch {
      return;
    }
    const e = this.el;
    e.rating.textContent = `${s.rating}${s.provisional ? '?' : ''}`;
    e.rating.title = s.provisional ? 'Still settling: it moves fast for your first few dozen puzzles' : `± ${s.rd}`;
    const acc = s.rated ? Math.round((s.rated_solved / s.rated) * 100) : null;
    e.ratingMeta.textContent = [
      s.rated ? `${plural(s.rated, 'puzzle')} rated, ${acc}% solved` : 'No puzzles solved yet',
      s.today.attempts ? `today ${s.today.solved}/${s.today.attempts}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    this._chart(s.history);
    e.themes.innerHTML = '';
    e.themesEmpty.hidden = s.themes.length > 0;
    for (const t of s.themes.slice(0, 8)) {
      const li = el('li', 'pz-theme-row');
      const pct = Math.round((t.solved / t.attempts) * 100);
      const bar = el('span', 'pz-theme-bar');
      bar.style.setProperty('--pct', `${pct}%`);
      li.append(el('span', 'pz-theme-name', t.name), bar, el('span', 'meta', `${pct}% of ${t.attempts}`));
      const go = el('button', 'small', 'Practise');
      go.type = 'button';
      go.addEventListener('click', () => {
        this.el.theme.value = t.theme;
        store.set('puzzleTheme', t.theme);
        this.onStart(t.theme);
      });
      li.appendChild(go);
      e.themes.appendChild(li);
    }
    e.recent.innerHTML = '';
    e.recentEmpty.hidden = s.recent.length > 0;
    for (const r of s.recent) {
      const li = el('li', 'pz-recent-row');
      li.append(
        el('span', r.solved ? 'pz-mark good' : 'pz-mark bad', r.solved ? '✓' : '✗'),
        el('span', 'pz-recent-main', `Puzzle ${r.puzzle_rating}${r.themes.length ? ` · ${r.themes.join(', ')}` : ''}`),
        el('span', 'meta pz-change', r.rated ? signed(r.change) : 'retry'),
      );
      const again = el('button', 'small', 'Retry');
      again.type = 'button';
      again.title = 'Try this puzzle again (not rated)';
      again.addEventListener('click', () => this.onRetry(r.puzzle_id));
      li.appendChild(again);
      e.recent.appendChild(li);
    }
  }

  _chart(history) {
    const box = this.el.chart;
    box.innerHTML = '';
    this.el.chartEmpty.hidden = history.length > 0;
    if (!history.length) return;
    const W = 600;
    const H = 140;
    const { path, min, max, points } = historyPath(history, W - 50, H);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'pz-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Puzzle rating from ${history[0].rating} to ${history[history.length - 1].rating}`);
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', 'translate(44,0)');
    for (const [y, label] of [[6, max], [H - 6, min]]) {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', '-8');
      t.setAttribute('y', String(y + 4));
      t.setAttribute('text-anchor', 'end');
      t.setAttribute('class', 'pz-axis');
      t.textContent = label;
      g.appendChild(t);
    }
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', path);
    line.setAttribute('class', 'pz-line');
    g.appendChild(line);
    const last = points[points.length - 1];
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', String(last.x));
    dot.setAttribute('cy', String(last.y));
    dot.setAttribute('r', '4');
    dot.setAttribute('class', 'pz-dot');
    const tip = document.createElementNS(ns, 'title');
    tip.textContent = `${last.date}: ${last.rating}`;
    dot.appendChild(tip);
    g.appendChild(dot);
    svg.appendChild(g);
    box.appendChild(svg);
  }
}
