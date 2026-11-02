import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../../web/vendor/chess.js/chess.js';
import {
  describeDuration,
  estimateSeconds,
  judgeMoves,
  moveAccuracy,
  normaliseEval,
  positionWhite,
  reviewPositions,
  reviewStillApplies,
  summarise,
  terminalEval,
  winChance,
} from '../../web/js/review-core.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Moves as the Game keeps them: { san, uci, fen } with fen = position after the move. */
function play(sans, start = START) {
  const chess = new Chess(start);
  return sans.map((san) => {
    const m = chess.move(san);
    return { san: m.san, uci: m.from + m.to + (m.promotion ?? ''), fen: chess.fen() };
  });
}
const line = (uci, score, pv = [uci]) => ({ uci, score, pv });

// Scholar's mate: 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#
const MOVES = play(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
const POSITIONS = reviewPositions(START, MOVES);
const EVALS = [
  { lines: [line('e2e4', { cp: 30 }), line('d2d4', { cp: 25 })] },
  { lines: [line('e7e5', { cp: 30 }), line('c7c5', { cp: 35 })] },
  { lines: [line('g1f3', { cp: 30 }), line('b1c3', { cp: 20 })] }, // 2.Qh5 is not best: +0.30 -> -0.20
  { lines: [line('b8c6', { cp: -20 }), line('g8f6', { cp: 60 })] },
  { lines: [line('f1c4', { cp: -10 }), line('b1c3', { cp: -15 })] },
  { lines: [line('g7g6', { cp: 0 }), line('d8e7', { cp: 50 })] }, // ...Nf6 is not best
  { lines: [line('h5f7', { mate: 1 }), line('h5e5', { cp: 300 })] },
  terminalEval(POSITIONS[7]),
];

test('winChance follows the Lichess curve and handles mates', () => {
  assert.equal(winChance({ cp: 0 }), 50);
  assert.ok(Math.abs(winChance({ cp: 100 }) - 59.1) < 0.1);
  assert.ok(Math.abs(winChance({ cp: -100 }) - 40.9) < 0.1);
  assert.equal(winChance({ mate: 3 }), 100);
  assert.equal(winChance({ mate: -1 }), 0);
  assert.equal(winChance(null), 50);
});

test('moveAccuracy: 100 for no loss, falls with bigger drops', () => {
  assert.ok(moveAccuracy(0) > 99.9);
  assert.ok(moveAccuracy(10) > 60 && moveAccuracy(10) < 70);
  assert.equal(moveAccuracy(100), 0);
});

test('reviewPositions stops at the current ply', () => {
  assert.equal(POSITIONS.length, 8);
  assert.deepEqual(reviewPositions(START, MOVES, 2), [START, MOVES[0].fen, MOVES[1].fen]);
});

test('terminalEval: checkmate, stalemate, ongoing', () => {
  assert.deepEqual(terminalEval(POSITIONS[7]), { terminal: 'checkmate', white: 100, lines: [] });
  assert.equal(terminalEval('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').terminal, 'draw');
  assert.equal(terminalEval(START), null);
  assert.equal(positionWhite(terminalEval(POSITIONS[7])), 100);
  assert.equal(positionWhite(null), null);
});

test('judgeMoves labels both sides objectively', () => {
  const j = judgeMoves(POSITIONS, MOVES, EVALS);
  assert.equal(j.length, 7);
  assert.deepEqual(j.map((m) => m.label), [null, null, 'inaccuracy', null, null, 'blunder', 'only']);
  assert.deepEqual(j.map((m) => m.side), ['w', 'b', 'w', 'b', 'w', 'b', 'w']);

  const e4 = j[0];
  assert.ok(e4.isBest && e4.loss === 0 && e4.best === null);

  const qh5 = j[2];
  assert.ok(!qh5.isBest && qh5.loss > 4.5 && qh5.loss < 5, 'half a pawn from about level: ' + qh5.loss);
  assert.equal(qh5.best.san, 'Nf3');

  const nf6 = j[5];
  assert.equal(nf6.side, 'b');
  assert.ok(nf6.before > 49 && nf6.before < 51 && nf6.after === 0, 'Black from ~50% to 0%');
  assert.equal(nf6.best.san, 'g6');
  assert.deepEqual(nf6.notes, ['Allows mate in 1']);

  const mate = j[6];
  assert.ok(mate.isBest && mate.label === 'only' && mate.loss === 0);
});

test('judgeMoves: missed mate, and moves without both evals are skipped', () => {
  const moves = play(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'd3']);
  const positions = reviewPositions(START, moves);
  const evals = [...EVALS.slice(0, 7), { lines: [line('e8e7', { cp: 300 })] }];
  const j = judgeMoves(positions, moves, evals);
  const d3 = j[6];
  assert.equal(d3.label, 'mistake');
  assert.deepEqual(d3.notes, ['Missed mate in 1']);
  assert.equal(d3.best.san, 'Qxf7#');

  const partial = judgeMoves(positions, moves, [EVALS[0], EVALS[1], null, null, null, null, null, null]);
  assert.ok(partial[0] && partial.slice(1).every((m) => m === null));
});

test('summarise counts per side', () => {
  const s = summarise(judgeMoves(POSITIONS, MOVES, EVALS));
  assert.equal(s.w.moves, 4);
  assert.equal(s.b.moves, 3);
  assert.equal(s.b.blunder, 1);
  assert.equal(s.w.only, 1);
  assert.equal(s.w.inaccuracy, 1);
  assert.ok(s.w.accuracy > s.b.accuracy);
  assert.equal(summarise([null]).w.accuracy, null);
});

test('time estimates and wording', () => {
  assert.equal(estimateSeconds(81, 1000), 88);
  assert.equal(estimateSeconds(0, 1000), 0);
  assert.equal(describeDuration(3), 'a few seconds');
  assert.equal(describeDuration(42), 'about 40 s');
  assert.equal(describeDuration(250), 'about 4 min');
});

test('reviewStillApplies only while the reviewed moves are unchanged', () => {
  const review = { startFen: START, ucis: ['e2e4', 'e7e5'] };
  assert.ok(reviewStillApplies(review, START, ['e2e4', 'e7e5']));
  assert.ok(reviewStillApplies(review, START, ['e2e4', 'e7e5', 'g1f3']), 'extra moves after are fine');
  assert.ok(!reviewStillApplies(review, START, ['e2e4', 'c7c5']));
  assert.ok(!reviewStillApplies(review, START, ['e2e4']));
  assert.ok(!reviewStillApplies(review, 'other', ['e2e4', 'e7e5']));
});

test('normaliseEval drops the null half of saved scores', () => {
  const saved = { depth: 18, lines: [{ uci: 'e2e4', score: { cp: -27, mate: null }, pv: ['e2e4'] }, { uci: 'd2d4', score: { cp: null, mate: 3 }, pv: ['d2d4'] }] };
  const ev = normaliseEval(saved);
  assert.deepEqual(ev.lines.map((l) => l.score), [{ cp: -27 }, { mate: 3 }]);
  assert.equal(normaliseEval(null), null);
});

test('inaccuracy starts at a 4.5-point drop: half a pawn from a level position', () => {
  const moves = play(['e4', 'e5']);
  const positions = reviewPositions(START, moves);
  // Black's best keeps 50%; the move played leaves White ahead by `cp`.
  const at = (cp) => judgeMoves(positions, moves, [
    { lines: [line('e2e4', { cp: 0 })] },
    { lines: [line('c7c5', { cp: 0 })] },
    { lines: [line('g1f3', { cp })] },
  ])[1];
  assert.equal(at(40).label, null); // +0.40: a drop of ~3.7
  assert.equal(at(50).label, 'inaccuracy'); // +0.50: ~4.6
  assert.equal(at(210).label, 'inaccuracy'); // +2.10: ~18.4
  assert.equal(at(280).label, 'mistake'); // +2.80: ~23.7
});
