// Confusable positions drill: each pair's two positions back to back, in random order.
// Pure logic, no DOM, so it can be unit tested in Node. Hints follow the trainer:
// after 2 wrong tries the piece to move is highlighted, after 3 the move is shown.
// The drill is practice: nothing is sent to the server, the schedule is untouched.

import { HINT_MOVE_AFTER, HINT_PIECE_AFTER } from './trainer.js';

export class PairDrill {
  /**
   * @param {object[]} pairs  pairs from GET /api/openings/{id}/confusable
   * @param {{ random?: () => number }} [opts]  injectable for tests
   */
  constructor(pairs, { random = Math.random } = {}) {
    this.pairs = pairs;
    this.random = random;
    this.index = 0; // which pair
    this.results = []; // { index, mistakes } latest result per pair
    this._startPair(this.random() < 0.5 ? ['a', 'b'] : ['b', 'a']);
  }

  get total() {
    return this.pairs.length;
  }

  get finished() {
    return this.index >= this.pairs.length;
  }

  get pair() {
    return this.pairs[this.index] ?? null;
  }

  /** 'a' or 'b': which side of the pair is being asked now. */
  get sideKey() {
    return this.order[this.step] ?? null;
  }

  get side() {
    return this.pair?.[this.sideKey] ?? null;
  }

  /** The other position of the pair (the one this one gets confused with). */
  get otherSide() {
    const other = this.sideKey === 'a' ? 'b' : 'a';
    return this.pair?.[other] ?? null;
  }

  /** Both positions answered. */
  get pairComplete() {
    return this.step >= 2;
  }

  _startPair(order) {
    this.order = order;
    this.step = 0; // 0 = first position, 1 = second, 2 = both done
    this.mistakes = 0; // wrong tries in this pair
    this._startSide();
  }

  _startSide() {
    this.wrongHere = 0;
    this.answered = false;
  }

  expected() {
    return this.side?.expected_uci ?? null;
  }

  /**
   * The user tried a move (UCI with promotion letter) in the current position.
   * @returns {{ correct: boolean, hint: null | {type: 'piece', from} | {type: 'move', from, to}, other?: boolean }}
   *   `other`: the wrong move was the other position's answer (the mix-up this drill is about).
   */
  tryMove(uci) {
    if (this.finished || this.pairComplete || this.answered) throw new Error('No position to answer');
    if (uci === this.expected()) {
      this.answered = true;
      return { correct: true, hint: null };
    }
    this.wrongHere += 1;
    this.mistakes += 1;
    return { correct: false, hint: this.hint(), other: uci === this.otherSide.expected_uci };
  }

  hint() {
    const uci = this.expected();
    if (!uci || this.answered) return null;
    const from = uci.slice(0, 2);
    if (this.wrongHere >= HINT_MOVE_AFTER) return { type: 'move', from, to: uci.slice(2, 4) };
    if (this.wrongHere >= HINT_PIECE_AFTER) return { type: 'piece', from };
    return null;
  }

  /** Move on to the pair's second position; after it, records the pair's result. */
  nextSide() {
    if (!this.answered) throw new Error('Answer this position first');
    this.step += 1;
    this._startSide();
    if (this.pairComplete) this._record();
  }

  _record() {
    const result = { index: this.index, mistakes: this.mistakes };
    const i = this.results.findIndex((r) => r.index === this.index);
    if (i >= 0) this.results[i] = result;
    else this.results.push(result);
  }

  /** Drill the same pair again, the other way round. */
  again() {
    this._startPair([...this.order].reverse());
  }

  nextPair() {
    this.index += 1;
    if (!this.finished) this._startPair(this.random() < 0.5 ? ['a', 'b'] : ['b', 'a']);
  }

  summary() {
    const clean = this.results.filter((r) => r.mistakes === 0).length;
    return { drilled: this.results.length, clean, withMistakes: this.results.length - clean, total: this.total };
  }
}

// ---- describing a pair ------------------------------------------------------------

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Pieces on their starting squares, e.g. "c8": "black bishop". A piece still at home is the
// less telling half of a difference ("knight on g8" vs "knight on f6"), so it's left out.
const HOME = {};
for (const [rank, color, row] of [['1', 'white', 'rnbqkbnr'], ['8', 'black', 'rnbqkbnr']]) {
  const names = { r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king' };
  [...row].forEach((p, i) => (HOME[`${'abcdefgh'[i]}${rank}`] = `${color} ${names[p]}`));
}
for (const f of 'abcdefgh') {
  HOME[`${f}2`] = 'white pawn';
  HOME[`${f}7`] = 'black pawn';
}

/**
 * What stands on the differing squares in one side of a pair, e.g. "black bishop on f5".
 * Pieces still on their starting square are left out when something else is listed. A side
 * with nothing there (the piece is missing) reads "no black pawn on c5".
 */
export function describeSide(differences, key) {
  const other = key === 'a' ? 'b' : 'a';
  const all = differences.filter((d) => d[key]);
  const moved = all.filter((d) => HOME[d.square] !== d[key]);
  const here = (moved.length ? moved : all).map((d) => `${d[key]} on ${d.square}`);
  if (here.length) return here.join(', ');
  const missing = differences.filter((d) => d[other]).map((d) => `no ${d[other]} on ${d.square}`);
  return missing.join(', ') || 'the same pieces';
}

/** One sentence per side: "Black bishop on f5: cxd5." */
export function describePair(pair) {
  return ['a', 'b'].map((k) => `${capital(describeSide(pair.differences, k))}: ${pair[k].expected_san}.`);
}
