import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, levelById, engineOptions, resultFor, takebackPly, competitionFor } from '../../web/js/play.js';
import { Game } from '../../web/js/game.js';

test('levels: skill levels below 1400, Elo limiter above, full strength last', () => {
  assert.deepEqual(engineOptions(levelById(1)), { skill: 0, elo: null, movetime: 100, depth: 1 });
  assert.deepEqual(engineOptions(levelById(5)), { skill: null, elo: 1600, movetime: 700, depth: null });
  const max = LEVELS.at(-1);
  assert.equal(max.label, 'Full strength');
  assert.deepEqual(engineOptions(max), { skill: null, elo: null, movetime: 1500, depth: null });
  for (const l of LEVELS) if (l.elo) assert.ok(l.elo >= 1320 && l.elo <= 3190, 'within Stockfish UCI_Elo range');
  assert.equal(levelById(99).id, 4, 'unknown level falls back to 1400');
});

test('result: checkmate scored for the winner, from your side', () => {
  const g = new Game();
  for (const s of ['f3', 'e5', 'g4', 'Qh4#']) g.playSan(s);
  assert.deepEqual(resultFor(g.status(), g.turn(), 'black'), { score: '0-1', text: 'You won by checkmate' });
  assert.deepEqual(resultFor(g.status(), g.turn(), 'white'), { score: '0-1', text: 'Stockfish won by checkmate' });
});

test('result: draws and unfinished games', () => {
  const g = new Game('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.deepEqual(resultFor(g.status(), g.turn(), 'white'), { score: '1/2-1/2', text: 'Draw by stalemate' });
  assert.equal(resultFor(new Game().status(), 'white', 'white'), null);
});

test('takeback: your move and the reply, never before the start', () => {
  // You are White: e4 e5 played, White to move -> back to ply 0.
  assert.equal(takebackPly(2, 0, 'white', 'white'), 0);
  // Engine still thinking after your move (Black to move) -> just your move.
  assert.equal(takebackPly(3, 0, 'black', 'white'), 2);
  // Started from a position at ply 6.
  assert.equal(takebackPly(7, 6, 'black', 'white'), 6);
  assert.equal(takebackPly(6, 6, 'white', 'white'), 6);
  // You are Black, engine opened, you haven't moved: nothing to take back.
  assert.equal(takebackPly(1, 0, 'black', 'black'), 0);
});

test('truncate drops the moves after the shown position', () => {
  const g = new Game();
  for (const s of ['e4', 'e5', 'Nf3']) g.playSan(s);
  g.goTo(1);
  g.truncate();
  assert.deepEqual(g.moves.map((m) => m.san), ['e4']);
  assert.equal(g.ply, 1);
});

test('competitionFor names the opening of a continued training line', () => {
  assert.equal(competitionFor(null), 'Practice vs engine');
  assert.equal(competitionFor('Scandinavian'), 'Practice vs engine (Scandinavian)');
});
