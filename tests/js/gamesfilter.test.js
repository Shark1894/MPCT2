import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseFilters, resultOptions } from '../../web/js/games.js';
import { gameParams } from '../../web/js/api.js';
import { speedFor } from '../../web/js/review.js';

test('result options switch between colour results and the player’s own', () => {
  assert.deepEqual(resultOptions('').map(([v]) => v), ['', 'white', 'black', 'draw', 'unfinished']);
  assert.deepEqual(resultOptions('Jason').map(([v]) => v), ['', 'won', 'lost', 'drawn', 'unfinished']);
});

test('normaliseFilters keeps filters consistent', () => {
  assert.deepEqual(normaliseFilters(), { player: '', color: '', result: '', reviewed: '' });
  // colour and own results need a player
  assert.deepEqual(normaliseFilters({ color: 'white', result: 'won' }), { player: '', color: '', result: '', reviewed: '' });
  // a draw carries over both ways; colour results don't become the player's
  assert.equal(normaliseFilters({ player: 'J', result: 'draw' }).result, 'drawn');
  assert.equal(normaliseFilters({ result: 'drawn' }).result, 'draw');
  assert.equal(normaliseFilters({ player: 'J', result: 'white' }).result, '');
  assert.equal(normaliseFilters({ player: 'J', result: 'unfinished' }).result, 'unfinished');
  assert.deepEqual(normaliseFilters({ player: 'J', color: 'black', result: 'lost', reviewed: 'yes' }), {
    player: 'J', color: 'black', result: 'lost', reviewed: 'yes',
  });
  assert.deepEqual(normaliseFilters({ player: 'J', color: 'red', reviewed: 'maybe' }), { player: 'J', color: '', result: '', reviewed: '' });
});

test('gameParams leaves out empty values', () => {
  assert.deepEqual(gameParams('', { player: 'Jason', color: '', result: 'won', reviewed: '' }), { player: 'Jason', result: 'won' });
  assert.deepEqual(gameParams('league'), { q: 'league' });
});

test('speedFor maps a saved review time to a speed', () => {
  assert.equal(speedFor(1000), 'standard');
  assert.equal(speedFor(3000), 'deep');
  assert.equal(speedFor(300), 'quick');
  assert.equal(speedFor(1500), 'standard');
  assert.equal(speedFor(100), 'quick');
  assert.equal(speedFor(null), 'standard');
});
