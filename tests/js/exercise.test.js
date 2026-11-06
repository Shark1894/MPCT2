import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExerciseRun, sideToMove } from '../../web/js/exercise.js';

// Black to move first; you play White: h6 (auto), Ra8+ (you), Kh7 (auto), Rh8?? no: ends after Kh7.
const MATE = {
  start_fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1',
  color: 'white',
  kind: 'line',
  ucis: ['h7h6', 'a1a8', 'g8h7'],
  sans: ['h6', 'Ra8+', 'Kh7'],
  comments: { 0: 'Intro.', 2: 'Check!' },
};

test('the opponent moves first when it is their turn, then it is yours', () => {
  const r = new ExerciseRun(MATE);
  assert.equal(sideToMove(MATE.start_fen), 'black');
  assert.equal(r.yourTurn, false);
  assert.equal(r.nextAuto(), 'h7h6');
  assert.equal(r.nextAuto(), null);
  assert.equal(r.yourTurn, true);
  assert.equal(r.expected(), 'a1a8');
});

test('solving cleanly, then the last reply ends it', () => {
  const r = new ExerciseRun(MATE);
  r.nextAuto();
  assert.deepEqual(r.tryMove('a1a8'), { correct: true, uci: 'a1a8' });
  assert.equal(r.note(2), 'Check!');
  assert.equal(r.nextAuto(), 'g8h7');
  assert.equal(r.done, true);
  assert.equal(r.solved, true);
  assert.equal(r.nextAuto(), null);
});

test('a wrong move: try again; a second wrong move shows the answer', () => {
  const r = new ExerciseRun(MATE);
  r.nextAuto();
  assert.deepEqual(r.tryMove('a1a7'), { correct: false });
  assert.equal(r.failed, true);
  assert.deepEqual(r.tryMove('a1b1'), { correct: false, show: 'a1a8' });
  assert.equal(r.index, 2);
  assert.equal(r.nextAuto(), 'g8h7');
  assert.equal(r.done && !r.solved, true);
});

test('one miss, then the right move: still missed', () => {
  const r = new ExerciseRun(MATE);
  r.nextAuto();
  r.tryMove('a1a7');
  assert.equal(r.tryMove('a1a8').correct, true);
  r.nextAuto();
  assert.equal(r.solved, false);
});

test('tries are counted per move', () => {
  const two = { ...MATE, start_fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', ucis: ['a1a7', 'h7h6', 'a7a8'], sans: ['Ra7', 'h6', 'Ra8+'] };
  const r = new ExerciseRun(two);
  r.tryMove('a1a6');
  assert.equal(r.tryMove('a1a7').correct, true);
  r.nextAuto();
  assert.deepEqual(r.tryMove('a7b7'), { correct: false }); // first miss at this move, not the second
});

test('another mate on the last move is accepted', () => {
  const r = new ExerciseRun({ ...MATE, start_fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', ucis: ['a1a8'], sans: ['Ra8#'] });
  assert.deepEqual(r.tryMove('a1e1', { mates: true, expectedMates: true }), { correct: true, uci: 'a1e1' });
  assert.equal(r.solved, true);
});

test('a promotion without a piece chosen matches the expected promotion', () => {
  const r = new ExerciseRun({ start_fen: '8/P6k/8/8/8/8/8/K7 w - - 0 1', color: 'white', ucis: ['a7a8q'], sans: ['a8=Q'] });
  assert.equal(r.tryMove('a7a8').correct, true);
});

test('reference lines and info pages are read: every move steps, always done', () => {
  const ref = new ExerciseRun({ ...MATE, kind: 'reference' });
  assert.equal(ref.yourTurn, false);
  assert.deepEqual([ref.nextAuto(), ref.nextAuto(), ref.nextAuto(), ref.nextAuto()], ['h7h6', 'a1a8', 'g8h7', null]);
  assert.equal(ref.solved, true);
  const info = new ExerciseRun({ start_fen: '8/8/8/8/8/8/8/K6k w - - 0 1', color: 'white', kind: 'info', ucis: [] });
  assert.equal(info.done && info.solved, true);
});

test('move labels follow the start position', () => {
  const r = new ExerciseRun({ ...MATE, start_fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 23' });
  assert.equal(r.moveLabel(1), '23...h6');
  assert.equal(r.moveLabel(2), '24.Ra8+');
  assert.equal(r.moveLabel(3), '24...Kh7');
});
