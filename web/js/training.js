// Training mode controller: connects a TrainingSession (rules) to the board, the
// game state and the training panel. The page routes board moves here while active.

import { api } from './api.js';
import { START_FEN } from './game.js';
import { TrainingSession } from './trainer.js';
import { daysFromToday, plural, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const OPPONENT_DELAY_MS = 450;

function describeReviewDate(isoDate) {
  const days = daysFromToday(isoDate);
  if (days <= 0) return 'due again today';
  if (days === 1) return 'next review tomorrow';
  return `next review in ${days} days (${isoDate})`;
}

export class TrainingController {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {import('./board.js').BoardView} deps.board
   * @param {import('./repertoire.js').RepertoirePanel} deps.panel
   * @param {() => void} deps.render       redraw everything from game state
   * @param {(active: boolean) => void} deps.onModeChange
   */
  constructor({ game, board, panel, render, onModeChange }) {
    Object.assign(this, { game, board, panel, render, onModeChange });
    this.session = null;
    this.hintShapes = [];
    this.timer = null;
    this.el = {
      box: $('training'),
      title: $('train-title'),
      progress: $('train-progress'),
      message: $('train-message'),
      end: $('train-end'),
      result: $('train-result'),
      next: $('train-next'),
      retry: $('train-retry'),
      stop: $('train-stop'),
      summary: $('train-summary'),
      done: $('train-done'),
    };
    this.el.next.addEventListener('click', () => this.nextLine());
    this.el.retry.addEventListener('click', () => this.retryLine());
    this.el.stop.addEventListener('click', () => this.stop());
    this.el.done.addEventListener('click', () => this.stop());
  }

  get active() {
    return this.session !== null;
  }

  /** Whether the user may move pieces right now. */
  canMove() {
    return this.active && !this.session.finished && !this.session.lineComplete() && this.session.isUserTurn();
  }

  // ---- session lifecycle ------------------------------------------------

  async start(opening, mode, lineId = null) {
    let data;
    try {
      data = await api.training(opening.id, mode, lineId);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (data.lines.length === 0) {
      toast(mode === 'due' ? `Nothing due in ${opening.name}.` : `${opening.name} has no lines yet.`);
      return;
    }
    this.session = new TrainingSession(data);
    this.board.setOrientation(data.opening.color);
    this.el.title.textContent = `Training: ${data.opening.name}`;
    this.el.box.hidden = false;
    this.el.summary.hidden = true;
    this.onModeChange(true);
    this._beginLine();
    // On phones the Train button is below the board: bring the board back into view.
    const boardTop = document.querySelector('.board-area').getBoundingClientRect().top;
    if (boardTop < 0) window.scrollTo({ top: window.scrollY + boardTop - 8, behavior: 'smooth' });
  }

  stop() {
    clearTimeout(this.timer);
    this.session = null;
    this._setHint(null);
    this.el.box.hidden = true;
    this.onModeChange(false);
    this.render();
  }

  _beginLine() {
    clearTimeout(this.timer);
    const s = this.session;
    this.el.end.hidden = true;
    this.el.progress.textContent = `Line ${s.index + 1} of ${s.total}${s.practice ? ' · practice' : ''}`;
    this._setHint(null);
    this.game.load(START_FEN);
    this._message('');
    this.panel.setCommentsVisible(s.showComments());
    this.render();
    this._continue();
  }

  /** Play the opponent's replies until it's the user's turn or the line ends. */
  _continue() {
    const s = this.session;
    if (!s) return;
    if (s.lineComplete()) {
      this._finishLine();
      return;
    }
    if (s.isUserTurn()) {
      this._message(s.ply === 0 ? `You play ${s.color}. Your move.` : 'Your move.');
      this.render();
      return;
    }
    this._message('');
    this.timer = setTimeout(() => {
      if (this.session !== s) return; // stopped meanwhile
      const m = s.opponentMove();
      this.game.play(m.uci.slice(0, 2), m.uci.slice(2, 4), m.uci[4]);
      this.render();
      this._continue();
    }, OPPONENT_DELAY_MS);
  }

  /** Called by the page when the user drops a piece (promotion already chosen). */
  onUserMove(from, to, promotion) {
    const s = this.session;
    if (!this.canMove()) {
      this.render(); // not your turn: put the piece back
      return;
    }
    const result = s.tryMove(`${from}${to}${promotion ?? ''}`);
    if (result.correct) {
      this._setHint(null);
      this.game.play(from, to, promotion);
      this.render();
      this._continue();
      return;
    }
    this.render(); // snap the piece back
    this.panel.setCommentsVisible(true);
    this._setHint(result.hint);
    const tip =
      result.hint?.type === 'move'
        ? 'Play the move shown by the arrow.'
        : result.hint?.type === 'piece'
          ? 'Hint: move the highlighted piece.'
          : 'Try again.';
    this._message(`Not the repertoire move. ${tip}`, 'wrong');
  }

  async _finishLine() {
    const s = this.session;
    const review = s.review();
    const mistakes = s.mistakes;
    s.recordResult();
    this.render();
    this._message('');
    let resultText =
      mistakes === 0 ? '✓ Line complete, no mistakes.' : `✗ Line complete with ${plural(mistakes, 'mistake')}.`;
    try {
      const saved = await api.recordReview(review.lineId, review.practice, review.attempts);
      resultText += review.practice
        ? ' Practice run: the schedule is unchanged.'
        : ` Streak ${saved.streak}, ${describeReviewDate(saved.next_review_on)}.`;
    } catch (err) {
      resultText += ` (Not saved: ${err.message})`;
    }
    if (this.session !== s) return; // stopped while saving
    this.el.result.textContent = resultText;
    this.el.result.className = `train-result ${mistakes === 0 ? 'good' : 'bad'}`;
    const last = s.index + 1 >= s.total;
    this.el.next.textContent = last ? 'Finish' : 'Next line';
    this.el.end.hidden = false;
    this.el.next.focus();
  }

  retryLine() {
    this.session.retryLine();
    this._beginLine();
  }

  nextLine() {
    const s = this.session;
    s.nextLine();
    if (s.finished) {
      this._showSummary();
    } else {
      this._beginLine();
    }
  }

  _showSummary() {
    const sum = this.session.summary();
    this.el.end.hidden = true;
    this.el.progress.textContent = 'Session complete';
    this._message('');
    this.el.summary.hidden = false;
    $('train-summary-text').textContent =
      `${plural(sum.reviewed, 'line')} reviewed: ${sum.correct} correct` +
      (sum.failed ? `, ${sum.failed} to repeat (due again today).` : '.');
    this.el.done.focus();
  }

  // ---- display helpers ----------------------------------------------------

  _message(text, kind = '') {
    this.el.message.textContent = text;
    this.el.message.className = `train-message ${kind}`;
  }

  _setHint(hint) {
    this.hintShapes = !hint
      ? []
      : hint.type === 'piece'
        ? [{ orig: hint.from, brush: 'yellow' }]
        : [{ orig: hint.from, dest: hint.to, brush: 'red' }];
    this.board.setShapes(this.hintShapes);
  }
}
