import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PairDrill, describePair, describeSide } from '../../web/js/pairdrill.js';

const side = (san, uci) => ({ expected_san: san, expected_uci: uci, fen: '', moves: [] });
const SLAV = {
  a: side('cxd5', 'c4d5'),
  b: side('Ne5', 'f3e5'),
  distance: 2,
  differences: [
    { square: 'g4', a: null, b: 'black bishop' },
    { square: 'f5', a: 'black bishop', b: null },
  ],
};
const QG = {
  a: side('e3', 'e2e3'),
  b: side('Qa4+', 'd1a4'),
  distance: 2,
  differences: [
    { square: 'b4', a: null, b: 'black bishop' },
    { square: 'e7', a: 'black bishop', b: null },
  ],
};

// random() < 0.5 asks a first; the sequence is consumed one value per pair.
const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test('asks both positions of a pair, in the drawn order', () => {
  const d = new PairDrill([SLAV], { random: seq(0.9) });
  assert.equal(d.sideKey, 'b');
  assert.equal(d.expected(), 'f3e5');
  assert.deepEqual(d.tryMove('f3e5'), { correct: true, hint: null });
  d.nextSide();
  assert.equal(d.sideKey, 'a');
  assert.equal(d.otherSide.expected_san, 'Ne5');
  d.tryMove('c4d5');
  d.nextSide();
  assert.equal(d.pairComplete, true);
  d.nextPair();
  assert.equal(d.finished, true);
  assert.deepEqual(d.summary(), { drilled: 1, clean: 1, withMistakes: 0, total: 1 });
});

test('playing the other position’s move is flagged as the mix-up', () => {
  const d = new PairDrill([SLAV], { random: seq(0.1) });
  assert.deepEqual(d.tryMove('f3e5'), { correct: false, hint: null, other: true });
  assert.deepEqual(d.tryMove('e2e3'), { correct: false, hint: { type: 'piece', from: 'c4' }, other: false });
  assert.deepEqual(d.tryMove('e2e3').hint, { type: 'move', from: 'c4', to: 'd5' });
  assert.equal(d.tryMove('c4d5').correct, true);
  d.nextSide();
  assert.equal(d.hint(), null); // hints reset for the second position
  d.tryMove('f3e5');
  d.nextSide();
  assert.deepEqual(d.results, [{ index: 0, mistakes: 3 }]);
});

test('can’t answer twice or skip ahead', () => {
  const d = new PairDrill([SLAV], { random: seq(0.1) });
  assert.throws(() => d.nextSide());
  d.tryMove('c4d5');
  assert.throws(() => d.tryMove('c4d5'));
});

test('again repeats the pair the other way round and replaces its result', () => {
  const d = new PairDrill([SLAV, QG], { random: seq(0.1, 0.9) });
  d.tryMove('f3e5'); // wrong
  d.tryMove('c4d5');
  d.nextSide();
  d.tryMove('f3e5');
  d.nextSide();
  assert.deepEqual(d.summary(), { drilled: 1, clean: 0, withMistakes: 1, total: 2 });
  d.again();
  assert.equal(d.sideKey, 'b');
  d.tryMove('f3e5');
  d.nextSide();
  d.tryMove('c4d5');
  d.nextSide();
  assert.deepEqual(d.summary(), { drilled: 1, clean: 1, withMistakes: 0, total: 2 });
  d.nextPair();
  assert.equal(d.pair, QG);
  assert.equal(d.sideKey, 'b'); // second random value
});

test('describes what differs, side by side', () => {
  assert.equal(describeSide(SLAV.differences, 'a'), 'black bishop on f5');
  assert.deepEqual(describePair(SLAV), ['Black bishop on f5: cxd5.', 'Black bishop on g4: Ne5.']);
  const missing = [{ square: 'c5', a: null, b: 'black pawn' }];
  assert.equal(describeSide(missing, 'a'), 'no black pawn on c5');
  assert.equal(describeSide(missing, 'b'), 'black pawn on c5');
});

test('pieces still on their starting square are left out of the description', () => {
  const nf6 = [
    { square: 'c8', a: null, b: 'black bishop' },
    { square: 'f5', a: 'black bishop', b: null },
    { square: 'f6', a: null, b: 'black knight' },
    { square: 'g8', a: 'black knight', b: null },
  ];
  assert.equal(describeSide(nf6, 'a'), 'black bishop on f5');
  assert.equal(describeSide(nf6, 'b'), 'black knight on f6');
  const castled = [{ square: 'e1', a: 'white king', b: null }]; // only a home piece: still named
  assert.equal(describeSide(castled, 'a'), 'white king on e1');
});
