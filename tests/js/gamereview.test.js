import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMistakes, gamePositions, reviewComplete, reviewPayload } from '../../web/js/gamereview.js';
import { judgeMoves } from '../../web/js/review-core.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Scholar's mate trap: Black blunders 3...Nf6?? (ply 6).
const UCIS = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
const line = (uci, cp, pv = [uci]) => ({ uci, score: { cp }, pv });
const mate = (uci, m, pv = [uci]) => ({ uci, score: { mate: m }, pv });

function evalsFor(positions) {
  // White-POV scores: level until 3.Qh5; Black's best is ...g6, ...Nf6 allows mate.
  const ev = positions.map(() => ({ lines: [line('a2a3', 20), line('h2h3', 10)] }));
  ev[5] = { lines: [line('g7g6', 20, ['g7g6', 'h5f3']), line('d8e7', 900)] }; // g6 holds, Qe7 loses big (the gap)
  ev[6] = { lines: [mate('h5f7', 1)] }; // after ...Nf6: White mates
  ev[7] = { terminal: 'checkmate', white: 100, lines: [] };
  return ev;
}

test('positions and moves of a game', () => {
  const { positions, moves } = gamePositions(START, UCIS);
  assert.equal(positions.length, 8);
  assert.equal(moves[5].san, 'Nf6');
  assert.equal(moves[6].san, 'Qxf7#');
});

test('a blunder with one clear best move becomes a candidate, for either side', () => {
  const { positions, moves } = gamePositions(START, UCIS);
  const evals = evalsFor(positions);
  const found = findMistakes(judgeMoves(positions, moves, evals), evals);
  assert.equal(found.length, 1);
  assert.equal(found[0].ply, 6);
  assert.equal(found[0].best_uci, 'g7g6');
  assert.deepEqual(found[0].best_pv, ['g7g6', 'h5f3']);
  assert.ok(found[0].before > 45 && found[0].after === 0);
});

test('no puzzle when two moves are about as good', () => {
  const { positions, moves } = gamePositions(START, UCIS);
  const evals = evalsFor(positions);
  evals[5] = { lines: [line('g7g6', 20), line('d8e7', 40)] };
  assert.deepEqual(findMistakes(judgeMoves(positions, moves, evals), evals), []);
});

test('the review payload: complete only when every move is judged', () => {
  const { positions, moves } = gamePositions(START, UCIS);
  const evals = evalsFor(positions);
  const judged = judgeMoves(positions, moves, evals);
  assert.ok(reviewComplete(judged, 7));
  const body = reviewPayload(UCIS, 1000, judged, evals);
  assert.deepEqual(body.moves, UCIS);
  assert.equal(body.movetime_ms, 1000);
  assert.equal(body.counts.b.blunder, 1);
  assert.equal(body.candidates.length, 1);
  assert.ok(body.accuracy.w > body.accuracy.b);
  const partial = evals.slice();
  partial[3] = null;
  assert.ok(!reviewComplete(judgeMoves(positions, moves, partial), 7));
});
