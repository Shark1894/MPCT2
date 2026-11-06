import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../../web/vendor/chess.js/chess.js';
import { bestDefence, judge, movesToMate, placementFen, randomMatePosition, ruleEnd, winningMoves } from '../../web/js/endgame-core.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const squareColour = (s) => ('abcdefgh'.indexOf(s[0]) + Number(s[1])) % 2;

test('placement FEN', () => {
  assert.equal(placementFen({ e1: 'K', e8: 'k', a1: 'R' }, 'w'), '4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
});

test('random mating positions are legal, fair and varied', () => {
  const rng = seeded(7);
  for (const drill of ['kq', 'kr', 'kbb', 'kbn']) {
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const fen = randomMatePosition(drill, rng);
      seen.add(fen);
      const c = new Chess(fen);
      const you = c.turn();
      assert.equal(c.inCheck(), false, fen);
      assert.equal(c.isGameOver(), false, fen);
      const board = c.board().flat().filter(Boolean);
      const mine = board.filter((p) => p.color === you);
      const theirs = board.filter((p) => p.color !== you);
      assert.deepEqual(theirs.map((p) => p.type), ['k'], fen);
      assert.equal(mine.length, drill === 'kbb' || drill === 'kbn' ? 3 : 2, fen);
      // the lone king starts in the middle
      const lone = theirs[0].square;
      assert.ok('cdef'.includes(lone[0]) && '3456'.includes(lone[1]), `${lone} in ${fen}`);
      if (drill === 'kbb') {
        const bs = mine.filter((p) => p.type === 'b').map((p) => p.square);
        assert.notEqual(squareColour(bs[0]), squareColour(bs[1]), fen);
      }
      // nothing hangs: the lone king can't capture next move
      const passed = new Chess(fen.replace(/ [wb] /, you === 'w' ? ' b ' : ' w '));
      assert.equal(passed.moves({ verbose: true }).some((m) => m.captured), false, fen);
    }
    assert.ok(seen.size > 50, `${drill}: varied`);
  }
  assert.equal(new Chess(randomMatePosition('kq', rng, 'black')).turn(), 'b');
});

test('reading the tablebase', () => {
  assert.equal(movesToMate(55), 28);
  assert.equal(movesToMate(-54), 27);
  assert.equal(movesToMate(null), null);
  assert.equal(judge({ category: 'loss' }), 'ok');
  assert.equal(judge({ category: 'draw' }), 'thrown');
  assert.equal(judge({ category: 'blessed-loss' }), 'fifty');
  assert.equal(judge({ category: 'draw', stalemate: true }), 'stalemate');
  assert.equal(judge({ category: 'draw', insufficient_material: true }), 'material');
  assert.equal(judge({ category: 'loss', checkmate: true }), 'mate');
  const info = { moves: [{ uci: 'a', category: 'loss' }, { uci: 'b', category: 'draw' }, { uci: 'c', category: 'loss' }] };
  assert.equal(bestDefence(info), 'a');
  assert.deepEqual(winningMoves(info).map((m) => m.uci), ['a', 'c']);
});

test('rule ends', () => {
  assert.equal(ruleEnd(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')), 'stalemate');
  assert.equal(ruleEnd(new Chess('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1')), 'mate');
  assert.equal(ruleEnd(new Chess('7k/8/6K1/8/8/8/8/8 b - - 0 1')), 'material');
  assert.equal(ruleEnd(new Chess('7k/8/6K1/8/8/8/8/5Q2 b - - 100 80')), 'fifty');
  assert.equal(ruleEnd(new Chess('7k/8/6K1/8/8/8/8/5Q2 b - - 10 80')), null);
});
