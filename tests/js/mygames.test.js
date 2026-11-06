import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameLine, scoreText } from '../../web/js/mygames.js';

test('scoreText', () => {
  assert.equal(scoreText({ won: 2, drawn: 1, lost: 0 }), 'You +2 =1 −0');
  assert.equal(scoreText({ won: 0, drawn: 0, lost: 0 }), '');
});

test('gameLine', () => {
  const g = { white: 'Jason Sharkey', black: 'Ally', result: '1/2-1/2', played_on: '2026-01-10', category: 'otb', san: 'c5' };
  assert.deepEqual(gameLine(g), { players: 'Jason Sharkey – Ally', meta: '½-½ · 2026-01-10 · played c5' });
  assert.equal(gameLine({ ...g, category: 'online', san: null, played_on: null }).meta, '½-½ · online · game ended here');
});
