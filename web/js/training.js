// Training mode controller: connects a TrainingSession (rules) to the board, the
// game state and the training panel. The page routes board moves here while active.

import { api } from './api.js';
import { START_FEN } from './game.js';
import { TrainingSession } from './trainer.js';
import { confirmDialog, daysFromToday, plural, toast } from './ui.js';

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
      commentsNote: $('train-comments-note'),
      commentsNoteText: $('train-comments-note-text'),
      commentsShow: $('train-comments-show'),
      bookmark: $('train-bookmark'),
    };
    this.el.bookmark.addEventListener('click', () => this.toggleBookmark());
    this.commentsRevealed = false;
    this.el.next.addEventListener('click', () => this.nextLine());
    this.el.retry.addEventListener('click', () => this.retryLine());
    this.el.stop.addEventListener('click', () => this.stop());
    this.el.done.addEventListener('click', () => this.stop());
    this.el.commentsShow.addEventListener('click', () => {
      this.commentsRevealed = true; // a peek, not counted as a mistake
      this._applyComments();
    });
  }

  get active() {
    return this.session !== null;
  }

  /** Whether the user may move pieces right now. */
  canMove() {
    return this.active && !this.session.finished && !this.session.lineComplete() && this.session.isUserTurn();
  }

  // ---- session lifecycle ------------------------------------------------

  async start(opening, mode, lineId = null, tag = null, label = null) {
    let data;
    try {
      data = await api.training(opening.id, mode, lineId, tag?.id ?? null);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (data.lines.length === 0) {
      const where = tag ? `${opening.name} › ${tag.name}` : opening.name;
      toast(mode === 'due' ? `Nothing due in ${where}.` : `${where} has no lines yet.`);
      return;
    }
    this.session = new TrainingSession(data);
    this.board.setOrientation(data.opening.color);
    this.el.title.textContent = `Training: ${data.opening.name}${label ? ` › ${label}` : tag && !lineId ? ` › ${tag.name}` : ''}`;
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
    this.el.commentsNote.hidden = true;
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
    this.el.progress.textContent = `Line ${s.index + 1} of ${s.total}${s.practice ? ' · practice' : s.retry ? ' · retry' : ''}`;
    this._setHint(null);
    this.game.load(START_FEN);
    this._message('');
    this.commentsRevealed = false;
    this._applyComments();
    this._showBookmark();
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
    this._applyComments();
    this._setHint(result.hint);
    const tip =
      result.hint?.type === 'move'
        ? 'Play the move shown by the arrow.'
        : result.hint?.type === 'piece'
          ? 'Hint: move the highlighted piece.'
          : 'Try again.';
    this._message(`Not the repertoire move. ${tip}`, 'wrong');
    document.dispatchEvent(new CustomEvent('mpct:sound', { detail: 'wrong' }));
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
    if (mistakes === 0) setTimeout(() => document.dispatchEvent(new CustomEvent('mpct:sound', { detail: 'success' })), 250);
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
    this._showBookmark();
    $('train-summary-text').textContent =
      `${plural(sum.reviewed, 'line')} reviewed: ${sum.correct} correct` +
      (sum.fixed ? ` (${sum.fixed} on a retry)` : '') +
      (sum.failed ? `, ${sum.failed} to repeat (due again today).` : '.');
    this.el.done.focus();
  }

  // ---- bookmark -------------------------------------------------------------

  _showBookmark() {
    const line = this.session?.line;
    const b = this.el.bookmark;
    b.hidden = !line;
    if (!line) return;
    b.textContent = line.bookmarked ? '★' : '☆';
    b.setAttribute('aria-pressed', String(Boolean(line.bookmarked)));
    b.title = line.bookmarked ? 'Remove bookmark' : 'Bookmark this line';
    b.setAttribute('aria-label', b.title);
  }

  /** One tap, no dialog, so training isn't interrupted. Notes are edited on the Dashboard. */
  async toggleBookmark() {
    const line = this.session?.line;
    if (!line) return;
    try {
      if (line.bookmarked) {
        if (line.bookmark_note) {
          const ok = await confirmDialog('Remove this bookmark?', `Its note is deleted too:\n“${line.bookmark_note}”`, 'Remove');
          if (!ok) return;
        }
        await api.removeBookmark(line.id);
        Object.assign(line, { bookmarked: false, bookmark_note: null });
        toast('Bookmark removed');
      } else {
        await api.setBookmark(line.id);
        Object.assign(line, { bookmarked: true, bookmark_note: null });
        toast('Bookmarked. Add a note from the Dashboard.');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    if (this.session?.line === line) this._showBookmark();
  }

  // ---- display helpers ----------------------------------------------------

  /** Show or hide the comments for the current line, and say clearly when they're hidden. */
  _applyComments() {
    const state = this.session.commentState();
    const visible = state.show || this.commentsRevealed;
    this.panel.setCommentsVisible(visible);
    const note = this.el.commentsNote;
    note.classList.toggle('after-mistake', state.reason === 'mistake');
    if (!state.show && !this.commentsRevealed) {
      this.el.commentsNoteText.textContent = `Comments hidden: you've played this line correctly ${state.streak} times in a row.`;
      this.el.commentsShow.hidden = false;
      note.hidden = false;
    } else if (state.reason === 'mistake' && this.session.line?.streak >= 2) {
      this.el.commentsNoteText.textContent = 'Comments shown again after a mistake on this line.';
      this.el.commentsShow.hidden = true;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

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
    this.board.setLayer('hint', this.hintShapes);
  }
}
