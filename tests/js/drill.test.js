import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DrillRun, hintAfter, moveLabel } from '../../web/js/drill-core.js';

const pos = (over = {}) => ({
  opening: { id: 1, name: 'Caro', color: 'black' },
  position_id: 10,
  fen: 'x',
  ply: 4,
  expected: [{ uci: 'd7d5', san: 'd5' }],
  line_id: 3,
  path: ['e4', 'c6', 'd4'],
  rest: [
    { ply: 4, uci: 'd7d5', san: 'd5' },
    { ply: 5, uci: 'e4e5', san: 'e5' },
    { ply: 6, uci: 'c8f5', san: 'Bf5' },
  ],
  ...over,
});

test('hints and move labels', () => {
  assert.equal(hintAfter(1, 'd7d5'), null);
  assert.deepEqual(hintAfter(2, 'd7d5'), { type: 'piece', from: 'd7' });
  assert.deepEqual(hintAfter(3, 'd7d5'), { type: 'move', from: 'd7', to: 'd5' });
  assert.equal(moveLabel(4, 'd5'), '2...d5');
  assert.equal(moveLabel(5, 'e5'), '3.e5');
});

test('right first time', () => {
  const r = new DrillRun([pos(), pos({ position_id: 11 })]);
  assert.equal(r.phase, 'answer');
  assert.deepEqual(r.tryMove('d7d5'), { correct: true, firstTry: true });
  assert.equal(r.phase, 'answered');
  assert.deepEqual(r.resultPayload(), { opening_id: 1, position_id: 10, expected_uci: 'd7d5', correct: true, wrong: [] });
  assert.equal(r.tryMove('d7d5').ignored, true); // already answered
  r.next();
  assert.equal(r.current.position_id, 11);
  assert.equal(r.phase, 'answer');
});

test('wrong tries give hints and count as missed', () => {
  const r = new DrillRun([pos()]);
  assert.deepEqual(r.tryMove('e7e6'), { correct: false, hint: null });
  assert.equal(r.tryMove('g7g6').hint.type, 'piece');
  assert.equal(r.tryMove('a7a6').hint.type, 'move');
  assert.deepEqual(r.tryMove('d7d5'), { correct: true, firstTry: false });
  assert.deepEqual(r.resultPayload().wrong, ['e7e6', 'g7g6', 'a7a6']);
  assert.equal(r.resultPayload().correct, false);
  r.next();
  assert.equal(r.done, true);
  const s = r.summary();
  assert.equal(s.answered, 1);
  assert.equal(s.correct, 0);
  assert.equal(s.missed.length, 1);
});

test('reveal counts as missed; any of several repertoire moves is accepted', () => {
  const r = new DrillRun([pos(), pos({ expected: [{ uci: 'd7d5', san: 'd5' }, { uci: 'd7d6', san: 'd6' }] })]);
  assert.equal(r.reveal().san, 'd5');
  assert.equal(r.resultPayload().correct, false);
  assert.equal(r.canPlayLine(), true);
  r.next();
  assert.equal(r.tryMove('d7d6').correct, true);
  assert.equal(r.resultPayload().expected_uci, 'd7d6');
  assert.equal(r.canPlayLine(), false); // the line given goes 2...d5
});

test('playing the rest of the line', () => {
  const r = new DrillRun([pos()]);
  r.tryMove('d7d5');
  assert.equal(r.startLine(), true);
  assert.equal(r.isUserTurnInLine(), false);
  assert.equal(r.opponentMove().san, 'e5');
  assert.equal(r.isUserTurnInLine(), true);
  assert.equal(r.tryLineMove('e7e6').correct, false);
  assert.equal(r.tryLineMove('g7g6').hint.type, 'piece');
  assert.equal(r.tryLineMove('c8f5').correct, true);
  assert.equal(r.lineComplete(), true);
  r.endLine();
  assert.equal(r.canPlayLine(), false); // once per position
  assert.equal(r.resultPayload().correct, true); // line mistakes aren't recorded
});

test('no line to play when the answer ends it', () => {
  const r = new DrillRun([pos({ rest: [{ ply: 4, uci: 'd7d5', san: 'd5' }] })]);
  r.tryMove('d7d5');
  assert.equal(r.canPlayLine(), false);
  assert.equal(r.startLine(), false);
});
