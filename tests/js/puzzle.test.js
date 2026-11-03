import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PuzzleRun, historyPath } from '../../web/js/puzzle.js';

// Black to move in the FEN: White... no: the FEN side moves first (the opponent), then the user.
const P = { id: '00008', fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24', moves: ['f2g3', 'e6e7', 'b2b1', 'b3c1', 'b1c1', 'h6c1'], rating: 1500 };

const clock = () => {
  let t = 0;
  const now = () => t;
  now.add = (s) => (t += s * 1000);
  return now;
};

test('the user plays the side that moves after the set-up move', () => {
  const r = new PuzzleRun(P);
  assert.equal(r.color, 'white');
  assert.equal(new PuzzleRun({ ...P, fen: P.fen.replace(' b ', ' w ') }).color, 'black');
});

test('solving cleanly: replies come back, solved when the last move is played', () => {
  const now = clock();
  const r = new PuzzleRun(P, { now });
  assert.equal(r.setupMove(), 'f2g3');
  assert.equal(r.expected(), 'e6e7');
  assert.deepEqual(r.tryMove('e6e7'), { correct: true, reply: 'b2b1', finished: false });
  assert.deepEqual(r.tryMove('b3c1'), { correct: true, reply: 'b1c1', finished: false });
  now.add(17);
  assert.deepEqual(r.tryMove('h6c1'), { correct: true, finished: true });
  assert.equal(r.solved, true);
  assert.deepEqual(r.result(), { solved: true, seconds: 17 });
  assert.equal(r.result(), null); // reported once
});

test('the first wrong move fails it (reported straight away), but you can still finish', () => {
  const r = new PuzzleRun(P);
  r.setupMove();
  assert.deepEqual(r.tryMove('h6h7'), { correct: false, finished: false, firstMistake: true });
  assert.deepEqual(r.result(), { solved: false, seconds: 0 });
  assert.deepEqual(r.tryMove('h6g6'), { correct: false, finished: false, firstMistake: false });
  assert.equal(r.hintSquare(), 'e6');
  r.tryMove('e6e7');
  r.tryMove('b3c1');
  assert.equal(r.tryMove('h6c1').finished, true);
  assert.equal(r.solved, false);
  assert.equal(r.result(), null); // the failure was already reported
});

test('any checkmate is accepted', () => {
  const r = new PuzzleRun(P);
  r.setupMove();
  r.tryMove('e6e7');
  assert.deepEqual(r.tryMove('g3g8', true), { correct: true, finished: true });
  assert.equal(r.solved, true);
});

test('showing the solution plays the rest and counts as a failure', () => {
  const r = new PuzzleRun(P);
  r.setupMove();
  r.tryMove('e6e7');
  assert.deepEqual(r.reveal(), { rest: ['b3c1', 'b1c1', 'h6c1'], firstMistake: true });
  assert.equal(r.done, true);
  assert.deepEqual(r.result(), { solved: false, seconds: 0 });
  assert.throws(() => r.tryMove('h6c1'));
});

test('history path', () => {
  assert.deepEqual(historyPath([], 100, 50), { path: '', min: null, max: null, points: [] });
  const h = historyPath(
    [
      { date: '2026-11-01', rating: 1500 },
      { date: '2026-11-02', rating: 1600 },
      { date: '2026-11-03', rating: 1550 },
    ],
    200,
    56,
  );
  assert.equal(h.min, 1500);
  assert.equal(h.max, 1600);
  assert.equal(h.path, 'M0.0,50.0 L100.0,6.0 L200.0,28.0');
  const one = historyPath([{ date: '2026-11-03', rating: 1500 }], 200, 56);
  assert.equal(one.points[0].x, 100);
  assert.equal(one.min, 1475); // flat line gets a 50-point range
});
