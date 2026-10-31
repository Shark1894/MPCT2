import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatScore, parseInfo, pvToSan, whiteShare } from '../../web/js/engine.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('parseInfo reads depth, multipv, score and pv', () => {
  const line = 'info depth 18 seldepth 24 multipv 2 score cp 31 nodes 123456 nps 900000 hashfull 50 tbhits 0 time 137 pv e2e4 e7e5 g1f3';
  assert.deepEqual(parseInfo(line, true), {
    depth: 18,
    multipv: 2,
    score: { cp: 31 },
    pv: ['e2e4', 'e7e5', 'g1f3'],
    nodes: 123456,
    nps: 900000,
  });
});

test('parseInfo converts scores to White’s point of view', () => {
  assert.deepEqual(parseInfo('info depth 10 score cp 50 pv e7e5', false).score, { cp: -50 });
  assert.deepEqual(parseInfo('info depth 10 score mate 3 pv d8h4', false).score, { mate: -3 });
  assert.deepEqual(parseInfo('info depth 10 score mate -2 pv e1e2', true).score, { mate: -2 });
});

test('parseInfo ignores lines without pv/score and flags bounds', () => {
  assert.equal(parseInfo('info string NNUE evaluation using nn-xyz.nnue', true), null);
  assert.equal(parseInfo('info depth 5 currmove e2e4 currmovenumber 1', true), null);
  assert.equal(parseInfo('bestmove e2e4 ponder e7e5', true), null);
  assert.equal(parseInfo('info depth 12 score cp 20 lowerbound nodes 5 pv e2e4', true).bound, 'lowerbound');
});

test('formatScore', () => {
  assert.equal(formatScore({ cp: 35 }), '+0.35');
  assert.equal(formatScore({ cp: -120 }), '-1.20');
  assert.equal(formatScore({ cp: 0 }), '0.00');
  assert.equal(formatScore({ mate: 3 }), '#3');
  assert.equal(formatScore({ mate: -2 }), '#-2');
});

test('whiteShare maps evaluations onto the bar', () => {
  assert.equal(whiteShare({ cp: 0 }), 50);
  assert.ok(whiteShare({ cp: 100 }) > 55 && whiteShare({ cp: 100 }) < 70);
  assert.ok(whiteShare({ cp: -300 }) < 30);
  assert.equal(whiteShare({ cp: 5000 }), 98);
  assert.equal(whiteShare({ mate: 2 }), 100);
  assert.equal(whiteShare({ mate: -1 }), 0);
  assert.equal(whiteShare(null), 50);
});

test('pvToSan numbers moves from the position', () => {
  assert.deepEqual(
    pvToSan(START, ['e2e4', 'e7e5', 'g1f3']).map((m) => m.text),
    ['1.e4', 'e5', '2.Nf3'],
  );
  const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  assert.deepEqual(
    pvToSan(blackToMove, ['c7c5', 'g1f3']).map((m) => m.text),
    ['1...c5', '2.Nf3'],
  );
});

test('pvToSan stops at an illegal move and respects the limit', () => {
  assert.deepEqual(pvToSan(START, ['e2e4', 'e2e4']).map((m) => m.san), ['e4']);
  assert.equal(pvToSan(START, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3'], 3).length, 3);
});
