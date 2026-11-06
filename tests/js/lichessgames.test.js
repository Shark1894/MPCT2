import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailsLine, outcome, playersLine, whenText } from '../../web/js/lichessgames.js';

test('outcome is from your side', () => {
  assert.equal(outcome('1-0', 'white'), 'won');
  assert.equal(outcome('1-0', 'black'), 'lost');
  assert.equal(outcome('0-1', 'black'), 'won');
  assert.equal(outcome('1/2-1/2', 'white'), 'drawn');
  assert.equal(outcome('*', 'white'), null);
  assert.equal(outcome('1-0', null), null);
});

test('players and details lines', () => {
  const g = { white: 'JasonS', white_rating: 1850, black: 'Stockfish level 3', black_rating: null, speed: 'Rapid', clock: '10+0', rated: true, opening: 'Caro-Kann Defense', plies: 67 };
  assert.equal(playersLine(g), 'JasonS (1850) v Stockfish level 3');
  assert.equal(detailsLine(g), 'Rapid 10+0 · rated · Caro-Kann Defense · 34 moves');
  assert.equal(detailsLine({ ...g, rated: false, opening: null, plies: 0, clock: '' }), 'Rapid · casual');
});

test('whenText', () => {
  const now = new Date(2026, 10, 6, 17, 0);
  assert.equal(whenText(new Date(2026, 10, 6, 14, 5).toISOString(), now), 'Today 14:05');
  assert.equal(whenText(new Date(2026, 10, 5, 9, 30).toISOString(), now), 'Yesterday 09:30');
  assert.equal(whenText(new Date(2026, 10, 3, 21, 10).toISOString(), now), '3 Nov 21:10');
  assert.equal(whenText(new Date(2025, 10, 3, 21, 10).toISOString(), now), '3 Nov 2025');
  assert.equal(whenText(null, now), '');
});
