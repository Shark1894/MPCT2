// Position drill on the board: random positions from your repertoire where it's your move,
// shown on their own (no moves leading to them), answered once each. Uses the trainer's
// hints, can play the rest of a line on, and ends with the positions you missed.
// Practice only: answers are stored for problem positions but never change a schedule.

import { api } from './api.js';
import { DrillRun, moveLabel } from './drill-core.js';
import { formDialog, plural, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const OPPONENT_DELAY_MS = 450;
const COUNTS = [10, 20, 50];
const SIDE = { white: 'White', black: 'Black' };

export class DrillController {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {import('./board.js').BoardView} deps.board
   * @param {import('./repertoire.js').RepertoirePanel} deps.panel  comments shown once a position is answered
   * @param {() => void} deps.render
   * @param {(active: boolean) => void} deps.onModeChange
   * @param {(sans: string[]) => void} deps.onShowLine  leave the drill and show these moves from the start
   */
  constructor({ game, board, panel, render, onModeChange, onShowLine }) {
    Object.assign(this, { game, board, panel, render, onModeChange, onShowLine });
    this.run = null;
    this.label = '';
    this.timer = null;
    this.busy = false;
    this.el = {
      box: $('drill'),
      title: $('drill-title'),
      progress: $('drill-progress'),
      message: $('drill-message'),
      stop: $('drill-stop'),
      playing: $('drill-playing'),
      reveal: $('drill-reveal'),
      end: $('drill-end'),
      result: $('drill-result'),
      next: $('drill-next'),
      line: $('drill-line'),
      summary: $('drill-summary'),
      summaryText: $('drill-summary-text'),
      missed: $('drill-missed'),
      again: $('drill-again'),
      done: $('drill-done'),
    };
    this.el.stop.addEventListener('click', () => this.stop());
    this.el.done.addEventListener('click', () => this.stop());
    this.el.reveal.addEventListener('click', () => this.reveal());
    this.el.next.addEventListener('click', () => this.next());
    this.el.line.addEventListener('click', () => this.playLine());
    this.el.again.addEventListener('click', () => this.drillMissed());
  }

  get active() {
    return this.run !== null;
  }

  canMove() {
    const r = this.run;
    if (!r || this.busy) return false;
    return r.phase === 'answer' || (r.phase === 'line' && r.isUserTurnInLine());
  }

  // ---- starting ------------------------------------------------------------------------

  /** Ask for the scope and size, then start. Resolves false if cancelled or nothing to drill. */
  async setup({ repertoire, opening, tags = [], tag = null }) {
    if (!repertoire) return false;
    const saved = store.get('drillSettings', {});
    const scopes = [['rep', `Whole repertoire: ${repertoire.name}`]];
    if (opening) scopes.push(['opening', `${opening.name} (${SIDE[opening.color]})`]);
    for (const t of tags) scopes.push([`tag:${t.id}`, `${opening.name} › ${t.name}`]);
    const preferred = tag ? `tag:${tag.id}` : opening && saved.scope !== 'rep' ? 'opening' : 'rep';
    const values = await formDialog({
      title: 'Position drill',
      message:
        'Random positions from your repertoire where it’s your move, shown without the moves that led there. ' +
        'Practice only: line schedules don’t change, but mistakes show up as problem positions on the Dashboard.',
      fields: [
        { name: 'scope', label: 'Positions from', type: 'select', options: scopes, value: scopes.some(([v]) => v === preferred) ? preferred : 'rep' },
        { name: 'count', label: 'How many', type: 'select', options: COUNTS.map((n) => [n, `${n} positions`]), value: saved.count ?? 10 },
      ],
      submit: 'Start',
    });
    if (!values) return false;
    store.set('drillSettings', { scope: values.scope.startsWith('tag:') ? 'opening' : values.scope, count: Number(values.count) });
    const params = { count: Number(values.count) };
    if (values.scope === 'rep') {
      params.repertoire_id = repertoire.id;
      this.label = repertoire.name;
    } else if (values.scope === 'opening') {
      params.opening_id = opening.id;
      this.label = opening.name;
    } else {
      const t = tags.find((x) => `tag:${x.id}` === values.scope);
      params.tag_id = t.id;
      this.label = `${opening.name} › ${t.name}`;
    }
    let data;
    try {
      data = await api.drill(params);
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
    if (!data.positions.length) {
      toast(`No positions to drill in ${this.label}: add some lines first.`);
      return false;
    }
    if (data.total < params.count) toast(`${this.label} has ${plural(data.total, 'position')} where it’s your move: drilling them all.`);
    this.start(data.positions);
    return true;
  }

  start(positions) {
    this.run = new DrillRun(positions);
    this.el.box.hidden = false;
    this.el.summary.hidden = true;
    this.onModeChange(true);
    this._show();
    const boardTop = document.querySelector('.board-area').getBoundingClientRect().top;
    if (boardTop < 0) window.scrollTo({ top: window.scrollY + boardTop - 8, behavior: 'smooth' });
  }

  stop() {
    clearTimeout(this.timer);
    this.run = null;
    this.busy = false;
    this._hint(null);
    this.el.box.hidden = true;
    this.onModeChange(false);
    this.render();
  }

  // ---- one position ------------------------------------------------------------------------

  _show() {
    const r = this.run;
    const p = r.current;
    clearTimeout(this.timer);
    this.busy = false;
    this._hint(null);
    this.el.title.textContent = `Position drill: ${this.label}`;
    this.el.progress.textContent = `Position ${r.index + 1} of ${r.total} · ${p.opening.name} · move ${Math.floor((p.ply - 1) / 2) + 1}`;
    this.el.end.hidden = true;
    this.el.summary.hidden = true;
    this.el.playing.hidden = false;
    this.game.load(p.fen);
    this.board.setOrientation(p.opening.color);
    this.panel.setCommentsVisible(false); // a comment could give the answer away
    this._message(`${SIDE[p.opening.color]} to play. What does your repertoire play here?`);
    this.render();
  }

  /** Called by the page when the user drops a piece (promotion already chosen). */
  onUserMove(from, to, promotion) {
    const r = this.run;
    if (!this.canMove()) {
      this.render(); // put the piece back
      return;
    }
    const uci = `${from}${to}${promotion ?? ''}`;
    const res = r.phase === 'line' ? r.tryLineMove(uci) : r.tryMove(uci);
    if (!res.correct) {
      this.render(); // snap back
      this._hint(res.hint);
      const tip = res.hint?.type === 'move' ? 'Play the move shown by the arrow.' : res.hint?.type === 'piece' ? 'Hint: move the highlighted piece.' : 'Try again.';
      this._message(`Not the repertoire move. ${tip}`, 'wrong');
      document.dispatchEvent(new CustomEvent('mpct:sound', { detail: 'wrong' }));
      return;
    }
    this._hint(null);
    this.game.play(from, to, promotion);
    this.render();
    if (r.phase === 'line') {
      this._continueLine();
      return;
    }
    this._answered(res.firstTry ? 'good' : 'fixed');
  }

  reveal() {
    const r = this.run;
    if (!r || r.phase !== 'answer') return;
    const e = r.reveal();
    this._hint({ type: 'move', from: e.uci.slice(0, 2), to: e.uci.slice(2, 4) });
    this.game.play(e.uci.slice(0, 2), e.uci.slice(2, 4), e.uci[4]);
    this.render();
    this._answered('revealed');
  }

  _answered(kind) {
    const r = this.run;
    const p = r.current;
    const san = p.expected.find((e) => e.uci === r.played)?.san ?? p.expected[0].san;
    const move = moveLabel(p.ply, san);
    const text = {
      good: `✓ ${move}. Right first time.`,
      fixed: `✓ ${move}, after ${r.wrong.length === 1 ? '1 wrong try' : `${r.wrong.length} wrong tries`}.`,
      revealed: `The repertoire move is ${move}.`,
    }[kind];
    if (kind === 'good') setTimeout(() => document.dispatchEvent(new CustomEvent('mpct:sound', { detail: 'success' })), 250);
    this._message('');
    this.el.result.textContent = text;
    this.el.result.className = `train-result ${kind === 'good' ? 'good' : 'bad'}`;
    this.panel.setCommentsVisible(true);
    this._showEnd();
    api.drillResults([r.resultPayload()]).catch((err) => toast(`Answer not saved: ${err.message}`, 'error'));
  }

  _showEnd() {
    const r = this.run;
    this.el.playing.hidden = true;
    this.el.end.hidden = false;
    this.el.line.hidden = !r.canPlayLine();
    this.el.next.textContent = r.index + 1 >= r.total ? 'Finish' : 'Next position';
    this.el.next.focus();
  }

  // ---- playing the line on -------------------------------------------------------------

  playLine() {
    const r = this.run;
    if (!r?.startLine()) return;
    this.el.end.hidden = true;
    this._hint(null);
    this._message('');
    this._continueLine();
  }

  _continueLine() {
    const r = this.run;
    if (r.lineComplete()) {
      r.endLine();
      this.el.result.textContent = `End of the line (${r.current.rest.length} moves from the drilled position).`;
      this.el.result.className = 'train-result good';
      this._showEnd();
      return;
    }
    if (r.isUserTurnInLine()) {
      this._message('Your move.');
      this.render();
      return;
    }
    this.busy = true;
    this._message('');
    this.timer = setTimeout(() => {
      if (this.run !== r) return;
      const m = r.opponentMove();
      this.game.play(m.uci.slice(0, 2), m.uci.slice(2, 4), m.uci[4]);
      this.busy = false;
      this.render();
      this._continueLine();
    }, OPPONENT_DELAY_MS);
  }

  // ---- moving on -----------------------------------------------------------------------

  next() {
    const r = this.run;
    if (!r) return;
    r.next();
    if (r.done) this._summary();
    else this._show();
  }

  _summary() {
    const s = this.run.summary();
    this._hint(null);
    this.el.playing.hidden = true;
    this.el.end.hidden = true;
    this.el.summary.hidden = false;
    this.el.progress.textContent = 'Drill complete';
    this._message('');
    this.el.summaryText.textContent =
      s.missed.length === 0
        ? `All ${s.answered} right first time.`
        : `${s.correct} of ${s.answered} right first time. Missed:`;
    this.el.missed.innerHTML = '';
    for (const { position: p, result } of s.missed) {
      const li = document.createElement('li');
      const text = document.createElement('span');
      const tried = result.wrong.length ? ` (you tried ${result.wrong.length > 1 ? `${result.wrong.length} moves` : 'another move'})` : ' (shown)';
      text.textContent = `${p.opening.name}: ${moveLabel(p.ply, p.expected[0].san)}${tried}`;
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'small';
      show.textContent = 'Show';
      show.title = 'Leave the drill and show the line up to this position';
      show.addEventListener('click', () => {
        this.stop();
        this.onShowLine(p.path);
      });
      li.append(text, show);
      this.el.missed.appendChild(li);
    }
    this.el.again.hidden = s.missed.length === 0;
    this.el.again.textContent = `Drill missed again (${s.missed.length})`;
    (s.missed.length ? this.el.again : this.el.done).focus();
  }

  drillMissed() {
    const missed = this.run?.summary().missed.map((m) => m.position) ?? [];
    if (!missed.length) return;
    this.label = `${this.label} (missed)`.replace(' (missed) (missed)', ' (missed)');
    this.start(missed.sort(() => Math.random() - 0.5));
  }

  // ---- display helpers ----------------------------------------------------------------

  _message(text, kind = '') {
    this.el.message.textContent = text;
    this.el.message.className = `train-message ${kind}`;
  }

  _hint(hint) {
    const shapes = !hint ? [] : hint.type === 'piece' ? [{ orig: hint.from, brush: 'yellow' }] : [{ orig: hint.from, dest: hint.to, brush: 'red' }];
    this.board.setLayer('hint', shapes);
  }
}
