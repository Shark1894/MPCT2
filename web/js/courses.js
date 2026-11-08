// The Training tab: courses (tactics, strategy, endgames) worked through move by move.
//
// The tab itself is training-hub.js. CourseTrainer runs exercises on the board (like puzzles): the opponent's moves are
// played for you, a wrong move gets one more try before the move is shown, and the author's
// notes appear as each move is played. Progress is new / solved / missed, in course order.

import { api } from './api.js';
import { Chess } from '../vendor/chess.js/chess.js';
import { ExerciseRun } from './exercise.js';
import { clock, days } from './woodpecker-core.js';
import { store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const START_DELAY_MS = 600;
const REPLY_DELAY_MS = 500;
const SHOW_DELAY_MS = 900;

export const KINDS = [
  ['woodpecker', 'Woodpecker'],
  ['tactics', 'Tactics'],
  ['strategy', 'Strategy'],
  ['endgames', 'Endgame courses'],
  ['other', 'Other'],
];

/** A guess at a course's kind from its name. */
export function guessKind(name) {
  if (/woodpecker/i.test(name)) return 'woodpecker';
  if (/endgame|ending/i.test(name)) return 'endgames';
  if (/strateg|positional|middlegame|plans?\b|structure/i.test(name)) return 'strategy';
  return 'tactics';
}

/** The exercises to go through, in course order: 'continue' = not solved yet (new first, then
 * missed); 'missed' = missed ones; 'all' = everything. Info pages are left out of 'missed'. */
export function queueFor(chapters, which) {
  const all = chapters.flatMap((c) => c.exercises);
  if (which === 'missed') return all.filter((e) => e.status === 'missed');
  if (which === 'all') return all;
  const fresh = all.filter((e) => e.status === 'new');
  return fresh.length ? fresh : all.filter((e) => e.status === 'missed');
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---- exercises on the board --------------------------------------------------------------------

export class CourseTrainer {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {import('./board.js').BoardView} deps.board
   * @param {() => void} deps.render
   * @param {(active: boolean) => void} deps.onModeChange  exercise mode on/off
   * @param {(locked: boolean) => void} deps.onLock        navigation/engine locked while solving
   * @param {() => void} deps.onFinished                   the session is over (back to the tab)
   */
  constructor({ game, board, render, onModeChange, onLock, onFinished }) {
    Object.assign(this, { game, board, render, onModeChange, onLock, onFinished });
    this.active = false;
    this.run = null;
    this.timer = null;
    this.busy = false;
    this.el = {
      box: $('cx'),
      title: $('cx-title'),
      sub: $('cx-sub'),
      progress: $('cx-progress'),
      message: $('cx-message'),
      notes: $('cx-notes'),
      playing: $('cx-playing'),
      show: $('cx-show'),
      step: $('cx-step'),
      skip: $('cx-skip'),
      end: $('cx-end'),
      result: $('cx-result'),
      next: $('cx-next'),
      retry: $('cx-retry'),
      accept: $('cx-accept'),
      stop: $('cx-stop'),
      clockBox: $('cx-clock'),
      timer: $('cx-timer'),
      pause: $('cx-pause'),
      auto: $('cx-auto'),
    };
    this.el.pause.addEventListener('click', () => this.togglePause());
    this.el.auto.checked = store.get('wpAutoNext', true);
    this.el.auto.addEventListener('change', () => store.set('wpAutoNext', this.el.auto.checked));
    this.el.stop.addEventListener('click', () => this.stop(true));
    this.el.show.addEventListener('click', () => this.show());
    this.el.step.addEventListener('click', () => this.step());
    this.el.skip.addEventListener('click', () => this.next());
    this.el.next.addEventListener('click', () => this.next());
    this.el.retry.addEventListener('click', () => this.retry());
    this.el.accept.addEventListener('click', () => this.accept());
  }

  /** Solving (the board belongs to the exercise): no navigation, no engine. */
  get locked() {
    return this.active && Boolean(this.run) && !this.run.done;
  }

  canMove() {
    return this.locked && this.run.yourTurn && !this.busy && !this.paused;
  }

  /** Reading a reference line or info page: "Next move" (or →) steps on. */
  get canStep() {
    return this.locked && !this.run.tested && !this.busy;
  }

  /**
   * Go through these exercises ({id}) in order. opts.woodpecker = {cycleId, number, done, total,
   * course}: a Woodpecker cycle (each puzzle timed, first go recorded in the cycle). opts.course =
   * {name, kind}: the course they come from (for the time spent on it).
   */
  start(list, label, opts = {}) {
    if (!list.length) {
      toast('Nothing to do here.');
      return;
    }
    this.queue = list.slice();
    this.total = list.length;
    this.label = label;
    this.wp = opts.woodpecker ? { ...opts.woodpecker } : null;
    this.course = opts.course ? { name: opts.course.name, kind: opts.course.kind } : null;
    this.session = { solved: 0, missed: 0, read: 0, seconds: 0 };
    this.el.clockBox.hidden = !this.wp;
    clearInterval(this.ticker);
    if (this.wp) this.ticker = setInterval(() => this._showClock(), 250);
    this.next();
  }

  // ---- the Woodpecker clock: runs from your first move being due to the end of the puzzle ----------

  _clockReset() {
    this.clock = { from: null, elapsed: 0 };
    this._setPaused(false);
    this._showClock();
  }

  _clockStart() {
    if (this.wp && this.clock && this.clock.from === null && !this.paused) this.clock.from = performance.now();
  }

  _clockStop() {
    if (this.clock?.from != null) {
      this.clock.elapsed += (performance.now() - this.clock.from) / 1000;
      this.clock.from = null;
    }
  }

  _seconds() {
    if (!this.clock) return 0;
    return this.clock.elapsed + (this.clock.from != null ? (performance.now() - this.clock.from) / 1000 : 0);
  }

  _showClock() {
    if (this.wp) this.el.timer.textContent = clock(this._seconds());
  }

  togglePause() {
    if (!this.wp || !this.locked) return;
    this._setPaused(!this.paused);
  }

  _setPaused(paused) {
    if (paused && !this.paused) {
      this.pausedRunning = this.clock?.from != null; // resume only a clock that was running
      this._clockStop();
    }
    const resume = !paused && this.paused && this.pausedRunning;
    this.paused = paused;
    if (resume) {
      this.pausedRunning = false;
      this._clockStart();
    }
    this.el.pause.textContent = paused ? 'Resume' : 'Pause';
    document.body.classList.toggle('cx-paused', paused);
    this._showClock();
    if (this.active) this.render();
  }

  async next() {
    clearTimeout(this.timer);
    if (!this.queue?.length) {
      this._summary();
      return;
    }
    const { id } = this.queue.shift();
    let ex;
    try {
      ex = await api.exercise(id);
    } catch (err) {
      toast(`Couldn't open the exercise: ${err.message}`, 'error');
      if (!this.active) return;
      this._message(err.message, 'wrong');
      return;
    }
    this._begin(ex);
  }

  retry() {
    if (this.run) this._begin(this.run.ex, true);
  }

  stop(back = false) {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    this._setPaused(false);
    this.run = null;
    this.queue = [];
    if (!this.active) return;
    this.active = false;
    this.busy = false;
    this._arrow(null);
    this.el.box.hidden = true;
    this.onLock(false);
    this.onModeChange(false);
    this.render();
    if (back) this.onFinished();
  }

  _begin(ex, retrying = false) {
    clearTimeout(this.timer);
    const run = new ExerciseRun(ex);
    this.run = run;
    this.retrying = retrying;
    this.recorded = false;
    this.missedGo = null; // a recorded Woodpecker miss that can still be counted as correct
    this.el.accept.hidden = true;
    this._clockReset();
    this.el.pause.hidden = !this.wp;
    if (!this.active) {
      this.active = true;
      this.el.box.hidden = false;
      this.onModeChange(true);
    }
    this.onLock(!run.done);
    this._arrow(null);
    this.el.title.textContent = ex.title || (run.tested ? 'Exercise' : 'Reading');
    this.el.sub.textContent = `${ex.course} · ${ex.chapter}`;
    this._progress();
    this.el.notes.replaceChildren();
    this.el.end.hidden = true;
    this.el.playing.hidden = false;
    this.el.show.hidden = !run.tested;
    this.el.step.hidden = run.tested || run.done;
    this.el.skip.hidden = false;
    this.game.load(ex.start_fen);
    this.board.setOrientation(ex.color);
    this._note(0);
    this.render();
    const boardTop = document.querySelector('.board-area')?.getBoundingClientRect().top ?? 0;
    if (boardTop < 0) window.scrollTo({ top: window.scrollY + boardTop - 8, behavior: 'smooth' });

    if (ex.kind === 'info') {
      // A page to read: all of it at once (moves played, every note shown), then on.
      for (let uci = run.nextAuto(); uci; uci = run.nextAuto()) this._play(uci, run.index);
      this.render();
      this._message('');
      this._finish();
      return;
    }
    if (run.done) {
      this._finish();
      return;
    }
    if (!run.tested) {
      this._message('Step through the moves with Next move (or →).');
      this.el.step.focus();
      return;
    }
    const side = run.color === 'white' ? 'White' : 'Black';
    if (run.yourTurn) {
      this._message(`Your move: you play ${side}.`);
      this._clockStart();
      return;
    }
    this.busy = true;
    this._message(`You play ${side}.`);
    this.timer = setTimeout(() => this._autoPlay(run), START_DELAY_MS);
  }

  /** Play the opponent's moves until it's your turn (or the end). */
  _autoPlay(run) {
    if (this.run !== run) return;
    const uci = run.nextAuto();
    if (uci) {
      this._play(uci, run.index);
      this.render();
    }
    if (run.done) {
      this.busy = false;
      this._finish();
      return;
    }
    if (!run.yourTurn) {
      this.timer = setTimeout(() => this._autoPlay(run), REPLY_DELAY_MS);
      return;
    }
    this.busy = false;
    this._clockStart(); // first time it's your move: the clock starts
    if (!this.el.message.classList.contains('wrong')) this._message('Your move.'); // a shown move stays on screen
    this.render();
  }

  _play(uci, ply) {
    this.game.play(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
    this._note(ply);
  }

  /** Reading: the next move. */
  step() {
    const run = this.run;
    if (!this.canStep) return;
    const uci = run.nextAuto();
    if (uci) this._play(uci, run.index);
    this.render();
    if (run.done) this._finish();
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
    let expectedMates = false;
    try {
      const c = new Chess(this.game.fen());
      c.move({ from, to, promotion });
      mates = c.isCheckmate();
      const want = run.expected();
      const e = new Chess(this.game.fen());
      e.move({ from: want.slice(0, 2), to: want.slice(2, 4), promotion: want[4] });
      expectedMates = e.isCheckmate();
    } catch {
      this.render(); // illegal: snap back
      return;
    }
    const res = run.tryMove(uci, { mates, expectedMates });
    if (res.correct) {
      this._arrow(null);
      this._play(res.uci, run.index);
      this.render();
      if (run.done) {
        this._finish();
        return;
      }
      this._message(run.failed ? 'Right. Carry on.' : '✓ Right!', 'good');
      this.busy = true;
      this.timer = setTimeout(() => this._autoPlay(run), REPLY_DELAY_MS);
      return;
    }
    this.render(); // snap back
    document.dispatchEvent(new CustomEvent('mpct:sound', { detail: 'wrong' }));
    if (res.show) {
      this._showPlayed(run, res.show, 'Not that either.');
      return;
    }
    this._message('✗ Not the move. Try again.', 'wrong');
  }

  /** "Show move": play the right move for you (the exercise counts as missed). */
  show() {
    const run = this.run;
    if (!this.canMove()) return;
    const uci = run.showMove();
    if (uci) this._showPlayed(run, uci, '');
  }

  _showPlayed(run, uci, prefix) {
    const ply = run.index;
    const label = run.moveLabel(ply);
    this._arrow(uci);
    this._message(`${prefix ? `${prefix} ` : ''}The move was ${label}.`, 'wrong');
    this.busy = true;
    this.timer = setTimeout(() => {
      if (this.run !== run) return;
      this._arrow(null);
      this._play(uci, ply);
      this.render();
      if (run.done) {
        this.busy = false;
        this._finish();
        return;
      }
      this.timer = setTimeout(() => this._autoPlay(run), REPLY_DELAY_MS);
    }, SHOW_DELAY_MS);
  }

  async _finish() {
    const run = this.run;
    this.busy = false;
    this._clockStop();
    this.el.pause.hidden = true;
    this._setPaused(false);
    const seconds = this._seconds();
    this.onLock(false); // free to step through it
    this.el.playing.hidden = true;
    const solved = run.solved;
    const timed = this.wp && run.tested ? ` in ${clock(seconds)}` : '';
    if (run.tested) {
      if (solved) setTimeout(() => document.dispatchEvent(new CustomEvent('mpct:sound', { detail: 'success' })), 250);
      this.el.result.textContent = solved
        ? `✓ Solved${timed}!`
        : this.wp
          ? `✗ Missed (${clock(seconds)}).`
          : '✗ Missed: it comes round again with Retry missed.';
      if (this.retrying && this.wp) this.el.result.textContent += ' Practice: not recorded.';
      this.el.result.className = `train-result ${solved ? 'good' : 'bad'}`;
      this._message('');
    } else {
      this.el.result.textContent = run.ucis.length ? 'End of the line.' : '';
      this.el.result.className = 'train-result';
    }
    this.el.next.textContent = this.queue.length ? (this.wp ? 'Next puzzle' : 'Next exercise') : 'Finish';
    this.el.end.hidden = false;
    this.el.next.focus();
    this.render();
    if (this.recorded) return;
    this.recorded = true;
    if (!this.retrying) {
      this.session[!run.tested ? 'read' : solved ? 'solved' : 'missed'] += 1;
      if (run.tested) this.session.seconds += seconds;
    }
    if (this.wp && run.tested) {
      if (!this.retrying) await this._recordWoodpecker(run, solved, seconds);
    } else {
      try {
        await api.exerciseAttempt(run.ex.id, solved);
      } catch (err) {
        toast(`Result not saved: ${err.message}`, 'error');
      }
    }
    if (this.run !== run) return;
    this._progress();
    if (this.wp && solved && !this.retrying && this.el.auto.checked && this.queue.length) {
      this.timer = setTimeout(() => {
        if (this.run === run && !this.el.end.hidden) this.next();
      }, 1200);
    }
  }

  async _recordWoodpecker(run, solved, seconds) {
    let r;
    try {
      r = await api.woodpeckerAttempt(this.wp.cycleId, run.ex.id, solved, Math.round(seconds * 10) / 10);
    } catch (err) {
      toast(`Time not saved: ${err.message}`, 'error');
      return;
    }
    this.wp.done = r.cycle.done;
    this.wp.total = r.cycle.total;
    this.wp.last = r.cycle;
    if (r.recorded && !solved) {
      this.missedGo = { run, seconds };
      if (this.run === run) this.el.accept.hidden = false;
    }
    if (r.finished) {
      this.queue = [];
      this.wp.finished = r.cycle;
      if (this.run === run) {
        this.el.result.textContent += ` Cycle ${r.cycle.number} complete!`;
        this.el.next.textContent = 'Finish';
      }
    }
  }

  /** Count the missed first go as solved: the answer was another solution the course doesn't give. */
  async accept() {
    const go = this.missedGo;
    if (!go || go.run !== this.run || !this.wp) return;
    this.el.accept.disabled = true;
    let cycle;
    try {
      cycle = await api.acceptWoodpeckerAttempt(this.wp.cycleId, go.run.ex.id);
    } catch (err) {
      toast(`Not changed: ${err.message}`, 'error');
      this.el.accept.disabled = false;
      return;
    }
    this.el.accept.disabled = false;
    this.missedGo = null;
    this.el.accept.hidden = true;
    this.session.missed -= 1;
    this.session.solved += 1;
    this.wp.last = cycle;
    if (this.wp.finished) this.wp.finished = cycle;
    if (this.run !== go.run) return;
    const done = this.wp.finished ? ` Cycle ${cycle.number} complete!` : '';
    this.el.result.textContent = `✓ Counted as solved (${clock(go.seconds)}).${done}`;
    this.el.result.className = 'train-result good';
    this._progress();
  }

  _summary() {
    const s = this.session ?? { solved: 0, missed: 0, read: 0, seconds: 0 };
    if (this.wp) {
      const f = this.wp.finished;
      const n = s.solved + s.missed;
      toast(
        f
          ? `Cycle ${f.number} complete: ${f.solved}/${f.total} solved (${Math.round(f.accuracy)}%) in ${clock(f.seconds)} over ${days(f.days)}.`
          : `Cycle ${this.wp.number}: ${n} puzzle${n === 1 ? '' : 's'} this session in ${clock(s.seconds)}, ${s.solved} solved.`,
      );
      this.stop(true);
      return;
    }
    const parts = [`${s.solved} solved`, `${s.missed} missed`];
    if (s.read) parts.push(`${s.read} read`);
    toast(`${this.label ? `${this.label}: ` : ''}done. ${parts.join(', ')}.`);
    this.stop(true);
  }

  _progress() {
    const s = this.session;
    if (this.wp) {
      const at = Math.min(this.wp.total, this.wp.done + (this.recorded || this.retrying ? 0 : 1));
      const tally = s.solved + s.missed ? ` · this session ${s.solved} solved, ${s.missed} missed in ${clock(s.seconds)}` : '';
      this.el.progress.textContent = `Cycle ${this.wp.number} · puzzle ${at} of ${this.wp.total}${tally}`;
      return;
    }
    const at = this.total - this.queue.length;
    const tally = s.solved + s.missed ? ` · ${s.solved} solved, ${s.missed} missed` : '';
    this.el.progress.textContent = `${this.label ? `${this.label} · ` : ''}${at} of ${this.total}${tally}`;
  }

  /** Add the note for the position after `ply` moves (if any) under the ones shown so far. */
  _note(ply) {
    const text = this.run?.note(ply);
    if (!text) return;
    const row = el('div', 'cx-note');
    if (ply > 0) row.appendChild(el('span', 'cx-move', this.run.moveLabel(ply)));
    row.appendChild(el('span', 'cx-text', text));
    this.el.notes.appendChild(row);
    this.el.notes.scrollTop = this.el.notes.scrollHeight;
  }

  _message(text, kind = '') {
    this.el.message.textContent = text;
    this.el.message.className = `train-message ${kind}`;
  }

  _arrow(uci) {
    this.board.setLayer('hint', uci ? [{ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'green' }] : []);
  }
}
