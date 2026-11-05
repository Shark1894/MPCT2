import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactCount, shares, shortName } from '../../web/js/masters.js';

test('shortName keeps the surname', () => {
  assert.equal(shortName('Carlsen, Magnus'), 'Carlsen');
  assert.equal(shortName('DrNykterstein'), 'DrNykterstein');
  assert.equal(shortName(''), '?');
});

test('compactCount', () => {
  assert.equal(compactCount(512), '512');
  assert.equal(compactCount(1000), '1k');
  assert.equal(compactCount(1234), '1.2k');
  assert.equal(compactCount(34567), '35k');
});

test('shares add up to 100', () => {
  assert.deepEqual(shares({ white: 1, draws: 1, black: 1 }), { white: 33, draws: 34, black: 33 });
  assert.deepEqual(shares({ white: 0, draws: 0, black: 0 }), { white: 0, draws: 0, black: 0 });
  assert.deepEqual(shares({ white: 50, draws: 30, black: 20 }), { white: 50, draws: 30, black: 20 });
});
