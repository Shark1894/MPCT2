import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrainingSession } from '../../web/js/trainer.js';

const mv = (...ucis) => ucis.map((uci, i) => ({ ply: i + 1, uci, san: uci }));
const CARO = mv('e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5');
const RUY = mv('e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5');

const session = (color, ...lines) =>
  new TrainingSession({
    opening: { id: 1, name: 'Test', color },
    lines: lines.map((moves, i) => ({ id: i + 1, streak: 0, next_review_on: '2026-01-01', moves })),
  });

test('black: opponent moves first, then the user', () => {
  const s = session('black', CARO);
  assert.equal(s.isUserTurn(), false);
  assert.equal(s.opponentMove().uci, 'e2e4');
  assert.equal(s.isUserTurn(), true);
  assert.deepEqual(s.tryMove('c7c6'), { correct: true, move: CARO[1], hint: null });
  assert.equal(s.opponentMove().uci, 'd2d4');
  s.tryMove('d7d5');
  s.opponentMove();
  assert.equal(s.lineComplete(), true);
  assert.deepEqual(s.review(), {
    lineId: 1,
    practice: false,
    attempts: [
      { ply: 2, uci: 'c7c6' },
      { ply: 4, uci: 'd7d5' },
    ],
  });
});

test('white: user moves first; line ends on the user move', () => {
  const s = session('white', RUY);
  assert.equal(s.isUserTurn(), true);
  s.tryMove('e2e4');
  s.opponentMove();
  s.tryMove('g1f3');
  s.opponentMove();
  s.tryMove('f1b5');
  assert.equal(s.lineComplete(), true);
  assert.equal(s.expected(), null);
});

test('hints: nothing after 1 wrong, piece after 2, full move after 3', () => {
  const s = session('white', RUY);
  assert.deepEqual(s.tryMove('d2d4'), { correct: false, hint: null });
  assert.deepEqual(s.tryMove('c2c4'), { correct: false, hint: { type: 'piece', from: 'e2' } });
  assert.deepEqual(s.tryMove('g1f3'), { correct: false, hint: { type: 'move', from: 'e2', to: 'e4' } });
  assert.deepEqual(s.tryMove('a2a3'), { correct: false, hint: { type: 'move', from: 'e2', to: 'e4' } });
  assert.equal(s.tryMove('e2e4').correct, true);
  // wrong count resets for the next move
  s.opponentMove();
  assert.deepEqual(s.tryMove('d2d4'), { correct: false, hint: null });
  assert.equal(s.mistakes, 5);
});

test('promotion moves compare including the piece', () => {
  const s = new TrainingSession({
    opening: { id: 1, name: 'P', color: 'white' },
    lines: [{ id: 9, streak: 0, moves: [{ ply: 1, uci: 'e7e8q', san: 'e8=Q' }] }],
  });
  assert.equal(s.tryMove('e7e8n').correct, false);
  assert.equal(s.tryMove('e7e8q').correct, true);
});

test('opponent/user turn guards', () => {
  const s = session('white', RUY);
  assert.throws(() => s.opponentMove());
  s.tryMove('e2e4');
  assert.throws(() => s.tryMove('e7e5'));
});

const playRuy = (s) => {
  s.tryMove('e2e4');
  s.opponentMove();
  s.tryMove('g1f3');
  s.opponentMove();
  s.tryMove('f1b5');
};

test('retry after a failure is a real review that replaces the failed result', () => {
  const s = session('white', RUY, mv('d2d4', 'd7d5'));
  s.tryMove('d2d4'); // wrong
  playRuy(s);
  s.recordResult();
  assert.equal(s.review().practice, false);
  assert.deepEqual(s.summary(), { reviewed: 1, correct: 0, fixed: 0, failed: 1, total: 2 });

  s.retryLine();
  assert.equal(s.practice, false);
  assert.equal(s.retry, true);
  assert.equal(s.ply, 0);
  assert.equal(s.mistakes, 0);
  playRuy(s);
  assert.equal(s.review().practice, false, 'sent as a normal review: correct moves the streak on');
  s.recordResult();
  assert.deepEqual(s.summary(), { reviewed: 1, correct: 1, fixed: 1, failed: 0, total: 2 });

  // Retrying again after getting it right is practice: no streak farming.
  s.retryLine();
  assert.equal(s.practice, true);
  s.tryMove('d2d4'); // even a mistake in practice...
  playRuy(s);
  s.recordResult();
  assert.deepEqual(s.summary(), { reviewed: 1, correct: 1, fixed: 1, failed: 0, total: 2 }, '...changes nothing');

  s.nextLine();
  assert.equal(s.line.id, 2);
  assert.equal(s.practice, false);
  assert.equal(s.retry, false);
  s.tryMove('d2d4');
  s.opponentMove();
  s.recordResult();
  assert.deepEqual(s.summary(), { reviewed: 2, correct: 2, fixed: 1, failed: 0, total: 2 });
});

test('a failed retry stays failed; a clean first run retried is practice', () => {
  const s = session('white', RUY);
  s.tryMove('d2d4');
  playRuy(s);
  s.recordResult();
  s.retryLine();
  s.tryMove('d2d4'); // wrong again
  playRuy(s);
  s.recordResult();
  assert.deepEqual(s.summary(), { reviewed: 1, correct: 0, fixed: 0, failed: 1, total: 1 });
  s.retryLine(); // still failed: another real review
  assert.equal(s.practice, false);

  const clean = session('white', RUY);
  playRuy(clean);
  clean.recordResult();
  clean.retryLine();
  assert.equal(clean.practice, true);
});

test('comments shown while learning or after a mistake', () => {
  const learning = session('white', RUY);
  assert.equal(learning.showComments(), true);
  const known = new TrainingSession({
    opening: { id: 1, name: 'K', color: 'white' },
    lines: [{ id: 1, streak: 3, moves: RUY }],
  });
  assert.equal(known.showComments(), false);
  known.tryMove('d2d4');
  assert.equal(known.showComments(), true);
});

test('empty session is finished immediately', () => {
  const s = new TrainingSession({ opening: { id: 1, name: 'E', color: 'white' }, lines: [] });
  assert.equal(s.finished, true);
  assert.equal(s.line, null);
  assert.equal(s.expected(), null);
});

test('comment state says why comments are shown or hidden', () => {
  const s = new TrainingSession({
    opening: { id: 1, name: 'K', color: 'white' },
    lines: [
      { id: 1, streak: 0, moves: RUY },
      { id: 2, streak: 2, moves: RUY },
      { id: 3, streak: 5, moves: RUY },
    ],
  });
  assert.deepEqual(s.commentState(), { show: true, reason: 'learning', streak: 0 });
  s.nextLine();
  assert.deepEqual(s.commentState(), { show: false, reason: 'known', streak: 2 });
  s.nextLine();
  assert.deepEqual(s.commentState(), { show: false, reason: 'known', streak: 5 });
});

test('a line failed this session keeps its comments on retry', () => {
  const known = new TrainingSession({
    opening: { id: 1, name: 'K', color: 'white' },
    lines: [{ id: 7, streak: 4, moves: RUY }],
  });
  assert.equal(known.showComments(), false);
  known.tryMove('d2d4'); // mistake
  assert.deepEqual(known.commentState(), { show: true, reason: 'mistake' });
  known.recordResult();
  known.retryLine(); // mistakes reset to 0 for the retry...
  assert.equal(known.mistakes, 0);
  assert.deepEqual(known.commentState(), { show: true, reason: 'mistake' }); // ...but comments stay visible
});

test('a misheard mistake can be taken back (hands-free)', () => {
  const s = session('black', CARO);
  s.opponentMove();
  assert.equal(s.canUndoMistake(), false);
  s.tryMove('e7e5');
  s.tryMove('d7d5');
  assert.equal(s.hint().type, 'piece');
  assert.equal(s.undoMistake(), true);
  assert.equal(s.mistakes, 1);
  assert.equal(s.hint(), null); // the piece hint needed two wrong tries
  assert.equal(s.undoMistake(), true);
  assert.equal(s.mistakes, 0);
  assert.equal(s.undoMistake(), false);
  assert.equal(s.showComments(), true); // streak 0: still learning
  s.tryMove('c7c6');
  s.opponentMove();
  s.tryMove('d7d5');
  s.opponentMove();
  assert.deepEqual(s.review().attempts, [
    { ply: 2, uci: 'c7c6' },
    { ply: 4, uci: 'd7d5' },
  ]);
  s.recordResult();
  assert.deepEqual(s.summary(), { reviewed: 1, correct: 1, fixed: 0, failed: 0, total: 1 });
  assert.equal(s.failedLines.has(1), false);
});

test('undo only reaches the move still to play', () => {
  const s = session('black', CARO);
  s.opponentMove();
  s.tryMove('e7e5');
  s.tryMove('c7c6');
  assert.equal(s.canUndoMistake(), false); // that mistake was on a move already played
  assert.equal(s.mistakes, 1);
});
