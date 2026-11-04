import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMistakes, gamePositions, positionsNeeded } from '../../web/js/gamescan.js';
import { judgeMoves } from '../../web/js/review-core.js';

// Scholar's mate trap: Black blunders 3...Nf6?? (ply 6).
const UCIS = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
const line = (uci, cp, pv = [uci]) => ({ uci, score: { cp }, pv });
const mate = (uci, m, pv = [uci]) => ({ uci, score: { mate: m }, pv });

function evalsFor(positions) {
  // White-POV scores: level until 3.Qh5; Black's best is ...g6, ...Nf6 allows mate.
  const ev = positions.map(() => ({ lines: [line('a2a3', 20), line('h2h3', 10)] }));
  ev[5] = { lines: [line('g7g6', 20, ['g7g6', 'h5f3']), line('d8e7', 900)] }; // before ...Nf6: g6 holds, Qe7 loses big (to make the gap)
  ev[6] = { lines: [mate('h5f7', 1)] }; // after ...Nf6: White mates
  ev[7] = { terminal: 'checkmate', white: 100, lines: [] };
  return ev;
}

test('positions and moves of a game', () => {
  const { positions, moves } = gamePositions('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', UCIS);
  assert.equal(positions.length, 8);
  assert.equal(moves[5].san, 'Nf6');
  assert.equal(moves[6].san, 'Qxf7#');
});

test('only positions around your moves are analysed', () => {
  const { positions } = gamePositions('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', UCIS);
  assert.deepEqual(positionsNeeded(positions, 'black'), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(positionsNeeded(positions, 'white'), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('your blunder with one clear best move becomes a candidate', () => {
  const { positions, moves } = gamePositions('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', UCIS);
  const evals = evalsFor(positions);
  const judged = judgeMoves(positions, moves, evals);
  const found = findMistakes(judged, evals, 'black');
  assert.equal(found.length, 1);
  assert.equal(found[0].ply, 6);
  assert.equal(found[0].best_uci, 'g7g6');
  assert.deepEqual(found[0].best_pv, ['g7g6', 'h5f3']);
  assert.ok(found[0].before > 45 && found[0].after === 0);
  assert.deepEqual(findMistakes(judged, evals, 'white'), []); // White's moves were fine
});

test('no puzzle when two moves are about as good', () => {
  const { positions, moves } = gamePositions('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', UCIS);
  const evals = evalsFor(positions);
  evals[5] = { lines: [line('g7g6', 20), line('d8e7', 40)] };
  assert.deepEqual(findMistakes(judgeMoves(positions, moves, evals), evals, 'black'), []);
});
