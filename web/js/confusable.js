// Confusable positions: the dashboard list and the drill controller. The drill connects a
// PairDrill (rules) to the board and the drill panel; the page routes board moves here
// while it's active, just like training.

import { api } from './api.js';
import { START_FEN } from './game.js';
import { formatMoves } from './insights.js';
import { PairDrill, describePair, describeSide } from './pairdrill.js';
import { plural, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
export const DRILL_TOP = 10; // "Drill top" takes the first pairs of the list

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const sideToMove = (fen) => (fen.split(' ')[1] === 'w' ? 'white' : 'black');

function sideRow(side, openingId, onShow) {
  const row = el('div', 'cp-side');
  const path = el('span', 'cp-path');
  path.append(el('span', 'pp-before', side.moves.length ? `${formatMoves(side.moves)} ` : 'Start: '));
  path.append(el('strong', 'pp-move', formatMoves([side.expected_san], side.ply)));
  if (side.opening_id !== openingId) path.append(el('span', 'meta cp-opening', ` · ${side.opening_name}`));
  const show = el('button', 'small cp-show', 'Show');
  show.type = 'button';
  show.title = 'Show this position on the board';
  show.addEventListener('click', () => onShow(side.moves));
  row.append(path, show);
  return row;
}

/** Dashboard list of confusable pairs. */
export function renderConfusable(list, empty, data, { openingId, onDrill, onShow, onHide }) {
  list.innerHTML = '';
  const pairs = data?.pairs ?? [];
  empty.hidden = pairs.length > 0;
  empty.textContent = !data
    ? 'Couldn’t load confusable positions.'
    : data.hidden
      ? 'No other confusable positions found.'
      : 'No confusable positions: none of your positions here look nearly the same but need a different move.';
  for (const pair of pairs) {
    const li = el('li', 'cp-item');
    const sides = el('div', 'cp-sides');
    sides.append(sideRow(pair.a, openingId, onShow), sideRow(pair.b, openingId, onShow));
    const [da, db] = describePair(pair);
    const diff = el('div', 'cp-diff', `${da} ${db}`);
    const mixed = pair.mixups.a_as_b + pair.mixups.b_as_a;
    const facts = [pair.distance === 1 ? '1 square differs' : `${pair.distance} squares differ`];
    if (mixed) facts.unshift(`Mixed up ${mixed}× in training`);
    const meta = el('div', mixed ? 'meta cp-meta mixed' : 'meta cp-meta', facts.join(' · '));
    const actions = el('div', 'pp-actions');
    const drill = el('button', 'small primary', 'Drill');
    drill.type = 'button';
    drill.title = 'Drill these two positions back to back';
    drill.addEventListener('click', () => onDrill([pair], `${pair.a.expected_san} / ${pair.b.expected_san}`));
    const hide = el('button', 'small', 'Hide');
    hide.type = 'button';
    hide.title = 'Not confusing: hide this pair';
    hide.addEventListener('click', () => onHide(pair));
    actions.append(drill, hide);
    li.append(sides, diff, meta, actions);
    list.appendChild(li);
  }
}

export class PairDrillController {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {import('./board.js').BoardView} deps.board
   * @param {import('./repertoire.js').RepertoirePanel} deps.panel
   * @param {() => void} deps.render
   * @param {(active: boolean) => void} deps.onModeChange
   */
  constructor({ game, board, panel, render, onModeChange }) {
    Object.assign(this, { game, board, panel, render, onModeChange });
    this.drill = null;
    this.el = {
      box: $('drill'),
      title: $('drill-title'),
      progress: $('drill-progress'),
      message: $('drill-message'),
      next: $('drill-next'),
      end: $('drill-end'),
      result: $('drill-result'),
      compare: $('drill-compare'),
      comments: $('drill-comments'),
      rule: $('drill-rule'),
      ruleSave: $('drill-rule-save'),
      nextPair: $('drill-next-pair'),
      again: $('drill-again'),
      stop: $('drill-stop'),
      summary: $('drill-summary'),
      summaryText: $('drill-summary-text'),
      done: $('drill-done'),
    };
    this.el.next.addEventListener('click', () => this.nextSide());
    this.el.nextPair.addEventListener('click', () => this.nextPair());
    this.el.again.addEventListener('click', () => this.again());
    this.el.stop.addEventListener('click', () => this.stop());
    this.el.done.addEventListener('click', () => this.stop());
    this.el.ruleSave.addEventListener('click', () => this.saveRule());
    this.el.rule.addEventListener('input', () => {
      this.el.ruleSave.disabled = !this.el.rule.value.trim();
    });
  }

  get active() {
    return this.drill !== null;
  }

  canMove() {
    const d = this.drill;
    return Boolean(d) && !d.finished && !d.pairComplete && !d.answered;
  }

  // ---- lifecycle ----------------------------------------------------------------

  start(pairs, label) {
    if (!pairs.length) return;
    this.drill = new PairDrill(pairs);
    this.el.title.textContent = `Drill: ${label}`;
    this.el.box.hidden = false;
    this.el.summary.hidden = true;
    this.onModeChange(true);
    this.panel.setCommentsVisible(false); // comments could give the answer away
    this._beginSide();
    const boardTop = document.querySelector('.board-area').getBoundingClientRect().top;
    if (boardTop < 0) window.scrollTo({ top: window.scrollY + boardTop - 8, behavior: 'smooth' });
  }

  stop() {
    this.drill = null;
    this._shapes(null, false);
    this.el.box.hidden = true;
    this.onModeChange(false);
    this.render();
  }

  _beginSide() {
    const d = this.drill;
    const side = d.side;
    this.el.end.hidden = true;
    this.el.next.hidden = true;
    this.el.progress.textContent = `Pair ${d.index + 1} of ${d.total} · position ${d.step + 1} of 2`;
    this.game.load(START_FEN);
    let ok = true;
    for (const san of side.moves) if (!(ok = this.game.playSan(san))) break;
    if (!ok) this.game.load(side.fen); // shouldn't happen; the position still drills
    this.board.setOrientation(sideToMove(side.fen));
    this._shapes(null, false);
    this._message('Your move.');
    this.render();
  }

  onUserMove(from, to, promotion) {
    const d = this.drill;
    if (!this.canMove()) {
      this.render();
      return;
    }
    const result = d.tryMove(`${from}${to}${promotion ?? ''}`);
    const here = describeSide(d.pair.differences, d.sideKey);
    const there = describeSide(d.pair.differences, d.sideKey === 'a' ? 'b' : 'a');
    if (result.correct) {
      this.game.play(from, to, promotion);
      this._shapes(null, true);
      this._message(`✓ ${d.side.expected_san}. Here: ${here}. With ${there} it’s ${d.otherSide.expected_san}.`, 'good');
      this.el.next.textContent = d.step === 0 ? 'Next position' : 'See the pair';
      this.el.next.hidden = false;
      this.render();
      this.el.next.focus();
      return;
    }
    this.render(); // snap back
    this._shapes(result.hint, true);
    const tip =
      result.hint?.type === 'move'
        ? 'Play the move shown by the arrow.'
        : result.hint?.type === 'piece'
          ? 'Hint: move the highlighted piece.'
          : 'Try again.';
    const why = result.other
      ? `That’s the move with ${there}. Here: ${here}.`
      : `Not the move here. The marked squares are what differ.`;
    this._message(`${why} ${tip}`, 'wrong');
  }

  nextSide() {
    const d = this.drill;
    d.nextSide();
    if (d.pairComplete) this._showPair();
    else this._beginSide();
  }

  async _showPair() {
    const d = this.drill;
    const pair = d.pair;
    this.el.next.hidden = true;
    this._message('');
    this.el.progress.textContent = `Pair ${d.index + 1} of ${d.total}`;
    this.el.result.textContent =
      d.mistakes === 0 ? '✓ Both positions right first time.' : `✗ ${d.mistakes} wrong ${d.mistakes === 1 ? 'try' : 'tries'} in this pair.`;
    this.el.result.className = `train-result ${d.mistakes === 0 ? 'good' : 'bad'}`;
    this.el.compare.innerHTML = '';
    for (const text of describePair(pair)) this.el.compare.appendChild(el('li', '', text));
    this.el.rule.value = '';
    this.el.ruleSave.disabled = true;
    this.el.ruleSave.textContent = 'Add rule';
    this.el.nextPair.textContent = d.index + 1 >= d.total ? 'Finish' : 'Next pair';
    this.el.end.hidden = false;
    this.el.nextPair.focus();
    this.el.comments.innerHTML = '';
    const repId = this.panel.repId;
    if (!repId) return;
    const comments = await Promise.all(
      ['a', 'b'].map((k) => api.comment(repId, pair[k].fen).then((c) => c.comment).catch(() => '')),
    );
    if (this.drill !== d || d.pair !== pair) return;
    ['a', 'b'].forEach((k, i) => {
      if (!comments[i]) return;
      const item = el('li', '');
      item.append(el('strong', '', `${pair[k].expected_san}: `), document.createTextNode(comments[i]));
      this.el.comments.appendChild(item);
    });
  }

  /** Append the rule to both positions' comments (kept per repertoire, shown on the board). */
  async saveRule() {
    const d = this.drill;
    const rule = this.el.rule.value.trim();
    const repId = this.panel.repId;
    if (!d || !rule || !repId) return;
    this.el.ruleSave.disabled = true;
    try {
      for (const k of ['a', 'b']) {
        const fen = d.pair[k].fen;
        const { comment } = await api.comment(repId, fen);
        await api.saveComment(repId, fen, comment ? `${comment}\n${rule}` : rule);
      }
      this.el.ruleSave.textContent = 'Added ✓';
      toast('Rule added to both positions’ comments.');
    } catch (err) {
      this.el.ruleSave.disabled = false;
      toast(err.message, 'error');
    }
  }

  again() {
    this.drill.again();
    this._beginSide();
  }

  nextPair() {
    const d = this.drill;
    d.nextPair();
    if (d.finished) this._showSummary();
    else this._beginSide();
  }

  _showSummary() {
    const s = this.drill.summary();
    this.el.end.hidden = true;
    this.el.progress.textContent = 'Drill complete';
    this._message('');
    this._shapes(null, false);
    this.el.summaryText.textContent =
      `${plural(s.drilled, 'pair')} drilled: ${s.clean} right first time` +
      (s.withMistakes ? `, ${s.withMistakes} with mistakes. Drill those again soon.` : '.');
    this.el.summary.hidden = false;
    this.el.done.focus();
  }

  // ---- display helpers ------------------------------------------------------------

  _message(text, kind = '') {
    this.el.message.textContent = text;
    this.el.message.className = `train-message ${kind}`;
  }

  /** Hint shapes (as in training) and, once shown, circles on the squares that differ. */
  _shapes(hint, showDiff) {
    const hintShapes = !hint
      ? []
      : hint.type === 'piece'
        ? [{ orig: hint.from, brush: 'yellow' }]
        : [{ orig: hint.from, dest: hint.to, brush: 'red' }];
    const diff = showDiff && this.drill ? this.drill.pair.differences.map((x) => ({ orig: x.square, brush: 'blue' })) : [];
    this.board.setLayer('hint', hintShapes);
    this.board.setLayer('drill', diff);
  }
}
