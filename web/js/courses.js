// The Training tab: courses (tactics, strategy, endgames) worked through move by move.
//
// CoursesView is the tab: your courses with their progress, chapters and exercises, and the
// import. CourseTrainer runs exercises on the board (like puzzles): the opponent's moves are
// played for you, a wrong move gets one more try before the move is shown, and the author's
// notes appear as each move is played. Progress is new / solved / missed, in course order.

import { api } from './api.js';
import { Chess } from '../vendor/chess.js/chess.js';
import { pickFile, readCourse, slimLine } from './courseimport.js';
import { ExerciseRun } from './exercise.js';
import { WoodpeckerPage } from './woodpecker.js';
import { clock, days } from './woodpecker-core.js';
import { confirmDialog, formDialog, plural, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const START_DELAY_MS = 600;
const REPLY_DELAY_MS = 500;
const SHOW_DELAY_MS = 900;

export const KINDS = [
  ['woodpecker', 'Woodpecker'],
  ['tactics', 'Tactics'],
  ['strategy', 'Strategy'],
  ['endgames', 'Endgames'],
  ['other', 'Other'],
];
const kindName = (k) => (KINDS.find(([v]) => v === k) ?? [k, k])[1];

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
   * course}: a Woodpecker cycle (each puzzle timed, first go recorded in the cycle).
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
    if (r.finished) {
      this.queue = [];
      this.wp.finished = r.cycle;
      if (this.run === run) {
        this.el.result.textContent += ` Cycle ${r.cycle.number} complete!`;
        this.el.next.textContent = 'Finish';
      }
    }
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

// ---- the Training tab ----------------------------------------------------------------------------

/** The puzzle pages at the top of the list (the Puzzles tab's two parts). */
export const PUZZLE_PAGES = [
  ['pz:rated', 'Rated puzzles'],
  ['pz:mine', 'From your games'],
];
const isPuzzlePage = (id) => typeof id === 'string' && id.startsWith('pz:');

/** The groups in the tab's list, in order. */
export const GROUPS = [['woodpecker', 'Woodpecker'], ...KINDS.filter(([k]) => k !== 'woodpecker')];

/** Courses grouped by kind, in GROUPS order, empty groups left out. */
export function groupCourses(courses) {
  return GROUPS.map(([kind, title]) => ({ kind, title, courses: courses.filter((c) => c.kind === kind) })).filter((g) => g.courses.length);
}

/** Short progress text for the list: "45%" or, for Woodpecker, "Cycle 2 · 340/1128". */
export function progressText(c) {
  if (c.kind === 'woodpecker') {
    if (!c.cycle) return 'No cycle yet';
    return c.cycle.finished_at ? `Cycle ${c.cycle.number} done` : `Cycle ${c.cycle.number} · ${c.cycle.done}/${c.cycle.total}`;
  }
  if (!c.total) return 'empty';
  return c.new + c.missed === 0 ? 'all done' : `${Math.round((100 * c.solved) / c.total)}%`;
}

export class CoursesView {
  /**
   * @param {object} deps
   * @param {(list: {id: number}[], label: string, opts?: object) => void} deps.onStart
   * @param {{refresh: () => Promise<void>, hide: () => void}} deps.puzzles  the puzzle pages (Lichess + your games)
   */
  constructor({ onStart, puzzles }) {
    this.onStart = onStart;
    this.puzzles = puzzles;
    this.el = {
      groups: $('cv-groups'),
      main: $('cv-main'),
      puzzles: $('puzzles-view'),
      empty: $('cv-empty'),
      import: $('cv-import'),
    };
    this.selected = store.get('coursesSelected', null);
    this.el.import.addEventListener('click', () => this.importCourse());
    this.woodpecker = new WoodpeckerPage({
      onSolve: (cycle, todo, course) =>
        this.onStart(
          todo.map((id) => ({ id })),
          `Cycle ${cycle.number}`,
          { woodpecker: { cycleId: cycle.id, number: cycle.number, done: cycle.done, total: cycle.total, course: course.name } },
        ),
      onPractise: (id) => this.onStart([{ id }], 'Practice'),
      onChanged: () => this.refresh(),
    });
  }

  async refresh() {
    this.visible = true;
    const [courses, pz, mine] = await Promise.allSettled([api.courses(), api.puzzleSummary(), api.gamePuzzles(true)]);
    if (courses.status === 'rejected') {
      this.el.empty.hidden = false;
      this.el.empty.textContent = `Couldn't load your courses: ${courses.reason.message}`;
      this.courses = [];
    } else {
      this.courses = courses.value;
    }
    this.puzzleInfo = {
      'pz:rated': pz.status === 'fulfilled' ? `${pz.value.rating}${pz.value.provisional ? '?' : ''}` : '',
      'pz:mine': mine.status === 'fulfilled' ? (mine.value.length ? `${mine.value.length} due` : 'none due') : '',
    };
    this.details.clear(); // statuses change as you work through a course
    if (!isPuzzlePage(this.selected) && !this.courses.some((c) => c.id === this.selected)) {
      this.selected = groupCourses(this.courses)[0]?.courses[0]?.id ?? 'pz:rated';
    }
    this._drawList();
    await this._drawMain();
  }

  /** Leaving the tab: the puzzle pages stop polling. */
  hide() {
    this.visible = false;
    this.puzzles.hide();
  }

  /** Show one of the puzzle pages ('rated' or 'mine'). */
  showPuzzles(which = 'rated') {
    this.selected = `pz:${which}`;
    store.set('coursesSelected', this.selected);
  }

  select(id) {
    this.selected = id;
    store.set('coursesSelected', id);
    this._drawList();
    this._drawMain();
  }

  _drawList() {
    const courses = this.courses ?? [];
    this.el.empty.hidden = courses.length > 0;
    this.el.empty.textContent = 'No courses yet. Import a Chessable course (tactics, strategy, endgames or the Woodpecker Method).';
    const puzzles = el('div', 'cv-group');
    const ph = el('h3', 'cv-group-h');
    ph.append(el('span', 'cv-kind-dot cv-kind-puzzles'), el('span', '', 'Puzzles'));
    puzzles.appendChild(ph);
    for (const [id, name] of PUZZLE_PAGES) {
      const b = el('button', `cv-item${id === this.selected ? ' selected' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-current', id === this.selected ? 'true' : 'false');
      b.dataset.puzzles = id.slice(3);
      b.appendChild(el('span', 'cv-item-name', name));
      b.appendChild(el('span', 'meta cv-item-progress', this.puzzleInfo?.[id] ?? ''));
      b.title = id === 'pz:rated' ? 'Lichess puzzles near your rating' : 'Your mistakes in your own games, practised like your lines';
      b.addEventListener('click', () => this.select(id));
      puzzles.appendChild(b);
    }
    this.el.groups.replaceChildren(
      puzzles,
      ...groupCourses(courses).map((g) => {
        const sec = el('div', 'cv-group');
        const h = el('h3', 'cv-group-h');
        h.append(el('span', `cv-kind-dot cv-kind-${g.kind}`), el('span', '', g.title), el('span', 'meta', String(g.courses.length)));
        sec.appendChild(h);
        for (const c of g.courses) {
          const b = el('button', `cv-item${c.id === this.selected ? ' selected' : ''}`);
          b.type = 'button';
          b.setAttribute('aria-current', c.id === this.selected ? 'true' : 'false');
          b.dataset.course = c.id;
          b.appendChild(el('span', 'cv-item-name', c.name));
          b.appendChild(el('span', 'meta cv-item-progress', progressText(c)));
          const prog = c.kind === 'woodpecker' && c.cycle ? { total: c.cycle.total, solved: c.cycle.solved, missed: c.cycle.done - c.cycle.solved } : c;
          b.appendChild(this._bar(prog, 'cv-bar-mini'));
          b.addEventListener('click', () => this.select(c.id));
          sec.appendChild(b);
        }
        return sec;
      }),
    );
  }

  async _drawMain() {
    const main = this.el.main;
    if (isPuzzlePage(this.selected)) {
      main.hidden = true;
      this.el.puzzles.hidden = false;
      this.el.puzzles.dataset.show = this.selected.slice(3);
      if (this.visible) await this.puzzles.refresh();
      return;
    }
    this.el.puzzles.hidden = true;
    this.puzzles.hide();
    const c = (this.courses ?? []).find((x) => x.id === this.selected);
    if (!c) {
      main.replaceChildren();
      main.hidden = true;
      return;
    }
    main.hidden = false;
    const head = el('section', 'dash-card cv-head-card');
    const top = el('div', 'cv-head');
    const title = el('div', 'cv-title');
    title.appendChild(el('h2', 'dash-h', c.name));
    title.appendChild(el('span', `cv-kind cv-kind-${c.kind}`, kindName(c.kind)));
    top.appendChild(title);
    const actions = el('div', 'cv-actions');
    if (c.kind !== 'woodpecker') {
      const go = el('button', 'primary', c.solved === 0 && c.missed === 0 ? 'Start' : c.new ? 'Continue' : c.missed ? 'Retry missed' : 'Go again');
      go.type = 'button';
      go.addEventListener('click', () => this._startCourse(c, c.new || c.missed ? 'continue' : 'all'));
      actions.appendChild(go);
      if (c.missed && c.new) {
        const missed = el('button', '', `Retry missed (${c.missed})`);
        missed.type = 'button';
        missed.addEventListener('click', () => this._startCourse(c, 'missed'));
        actions.appendChild(missed);
      }
    }
    const edit = el('button', 'small', 'Edit');
    edit.type = 'button';
    edit.title = 'Rename, change the kind (group), reset progress or delete';
    edit.addEventListener('click', () => this._edit(c));
    actions.appendChild(edit);
    top.appendChild(actions);
    head.appendChild(top);

    if (c.kind === 'woodpecker') {
      const body = el('div', 'wp-page');
      main.replaceChildren(head, body);
      await this.woodpecker.render(body, c);
      return;
    }
    head.appendChild(this._bar(c));
    head.appendChild(
      el('p', 'meta cv-counts', `${plural(c.total, 'exercise')} · ${c.solved} solved · ${c.missed} missed · ${c.new + c.missed ? `${c.new} to do` : 'all done'}`),
    );
    const chapters = el('section', 'dash-card cv-chapters');
    chapters.appendChild(el('h3', 'wp-h', 'Chapters'));
    const list = el('div', 'cv-chapter-list');
    list.appendChild(el('p', 'meta', 'Loading…'));
    chapters.appendChild(list);
    main.replaceChildren(head, chapters);
    if (!this.details.has(c.id)) await this._load(c.id);
    const full = this.details.get(c.id);
    if (this.selected !== c.id) return;
    list.replaceChildren(...(full ? full.chapters.map((ch) => this._chapterRow(c, ch)) : []));
  }

  get details() {
    this._details ??= new Map();
    return this._details;
  }

  async _load(id) {
    try {
      this.details.set(id, await api.course(id));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  _bar(p, extra = '') {
    const bar = el('div', `cv-bar ${extra}`);
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${p.solved} solved, ${p.missed} missed of ${p.total}`);
    const w = (n) => `${p.total ? (100 * n) / p.total : 0}%`;
    const solved = el('span', 'cv-bar-solved');
    solved.style.width = w(p.solved);
    const missed = el('span', 'cv-bar-missed');
    missed.style.width = w(p.missed);
    bar.append(solved, missed);
    return bar;
  }

  _chapterRow(course, ch) {
    const row = el('details', 'cv-chapter');
    row.open = (store.get('chaptersOpen', []) ?? []).includes(ch.id);
    row.addEventListener('toggle', () => {
      const open = new Set(store.get('chaptersOpen', []));
      if (row.open) open.add(ch.id);
      else open.delete(ch.id);
      store.set('chaptersOpen', [...open]);
    });
    const sum = el('summary', 'cv-chapter-head');
    sum.appendChild(el('span', 'cv-chapter-title', ch.title));
    sum.appendChild(el('span', 'meta cv-chapter-counts', `${ch.solved}/${ch.total}${ch.missed ? ` · ${ch.missed} missed` : ''}`));
    const start = el('button', 'small', ch.new || ch.missed ? 'Start' : 'Again');
    start.type = 'button';
    start.addEventListener('click', (e) => {
      e.preventDefault(); // not the details toggle
      this.onStart(queueFor([ch], ch.new || ch.missed ? 'continue' : 'all'), ch.title);
    });
    sum.appendChild(start);
    row.appendChild(sum);
    const ul = el('ul', 'cv-exercises');
    ch.exercises.forEach((e, i) => {
      const li = el('li', `cv-ex cv-${e.status}`);
      const b = el('button', 'link', e.title || `Exercise ${i + 1}`);
      b.type = 'button';
      b.title = e.kind === 'line' ? 'Open this exercise' : 'Read this page';
      b.addEventListener('click', () => this.onStart(ch.exercises.slice(i), ch.title)); // on through the chapter from here
      li.appendChild(el('span', 'cv-dot', ''));
      li.appendChild(b);
      if (e.kind !== 'line') li.appendChild(el('span', 'meta', e.kind === 'info' ? 'read' : 'reference'));
      ul.appendChild(li);
    });
    row.appendChild(ul);
    return row;
  }

  async _startCourse(c, which) {
    if (!this.details.has(c.id)) await this._load(c.id);
    const full = this.details.get(c.id);
    if (!full) return;
    this.onStart(queueFor(full.chapters, which), which === 'missed' ? `${c.name} · missed` : c.name);
  }

  async _edit(c) {
    const values = await formDialog({
      title: 'Edit course',
      fields: [
        { name: 'name', label: 'Name', value: c.name, maxLength: 100 },
        { name: 'kind', label: 'Group', type: 'select', options: KINDS, value: c.kind },
        { name: 'reset', label: 'Reset progress (every exercise back to new; Woodpecker cycles are kept)', type: 'checkbox', value: false },
        { name: 'delete', label: 'Delete this course', type: 'checkbox', value: false },
      ],
    });
    if (!values) return;
    try {
      if (values.delete) {
        if (!(await confirmDialog('Delete course', `Delete “${c.name}” and your progress in it?`))) return;
        await api.deleteCourse(c.id);
        toast(`Deleted “${c.name}”.`);
      } else {
        if (values.name !== c.name || values.kind !== c.kind) await api.updateCourse(c.id, { name: values.name, kind: values.kind });
        if (values.reset) {
          const r = await api.resetCourse(c.id);
          toast(`Progress reset (${plural(r.reset, 'exercise')}).`);
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    this.details.delete(c.id);
    await this.refresh();
  }

  /** Choose a combined Chessable course file, the chapters, name and kind; import. */
  async importCourse() {
    const file = await pickFile();
    if (!file) return;
    let course;
    try {
      course = readCourse(JSON.parse(await file.text()));
    } catch (err) {
      toast(`Couldn't read ${file.name}: ${err.message}`, 'error');
      return;
    }
    const values = await formDialog({
      title: 'Import a course for Training',
      message:
        `${course.name}: ${plural(course.chapters.length, 'chapter')}. Tick the chapters to import. ` +
        'Importing the same course again updates it and keeps your progress.',
      fields: [
        { name: 'name', label: 'Course name', value: course.name.slice(0, 100), maxLength: 100 },
        { name: 'kind', label: 'Kind', type: 'select', options: KINDS, value: guessKind(course.name) },
        ...course.chapters.map((c) => ({
          name: `ch_${c.id}`,
          label: `${c.title} (${plural(c.lines.length, 'exercise')})${c.listed ? '' : ' · not in the course contents'}`,
          type: 'checkbox',
          value: c.listed,
        })),
      ],
      submit: 'Import',
    });
    if (!values) return;
    const chosen = course.chapters.filter((c) => values[`ch_${c.id}`]);
    const lines = chosen.flatMap((c) => c.lines).map(slimLine);
    if (!lines.length) {
      toast('No exercises chosen: tick at least one chapter.', 'error');
      return;
    }
    toast(`Importing ${plural(lines.length, 'exercise')}…`);
    let r;
    try {
      r = await api.importTrainingCourse({
        name: values.name,
        kind: values.kind,
        lines,
        chapters: course.chapters.map((c) => ({ id: c.id, title: c.title })),
      });
    } catch (err) {
      toast(`Not imported: ${err.message}`, 'error');
      return;
    }
    const parts = [
      `${r.created_course ? 'Created' : 'Updated'} “${r.course}”: ${plural(r.added, 'new exercise')}`,
      r.updated ? `${plural(r.updated, 'exercise')} updated` : '',
      r.unchanged ? `${r.unchanged} unchanged` : '',
      r.reset ? `${plural(r.reset, 'exercise')} changed, so they're new again` : '',
    ].filter(Boolean);
    const skipped = r.skipped.map((t) => `Skipped: ${t}`);
    this.details.delete(r.course_id);
    this.selected = r.course_id;
    store.set('coursesSelected', r.course_id);
    await this.refresh();
    await formDialog({
      title: 'Course imported',
      message: parts.join('\n') + (skipped.length ? `\n\n${skipped.join('\n')}` : ''),
      submit: 'OK',
    });
  }
}
