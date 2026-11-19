import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BANDS, BRUSHES, bandFor, engineArrows } from '../../web/js/arrows-core.js';

const line = (uci, score) => ({ pv: [uci], score });
const deep = { depth: 20, limit: 20 };

test('bands by win% lost', () => {
  assert.equal(bandFor(0).key, 'best');
  assert.equal(bandFor(1.5).key, 'equal');
  assert.equal(bandFor(7).key, 'good');
  assert.equal(bandFor(7.1).key, 'dubious');
  assert.equal(bandFor(30).key, 'bad');
  for (const b of BANDS) assert.ok(BRUSHES[b.brush], `brush for ${b.key}`);
  for (const b of Object.values(BRUSHES)) assert.ok(!['#15781B', '#003088'].includes(b.color), 'not repertoire green/blue');
});

test('a terrible second line is red and labelled; best drawn last', () => {
  const lines = [line('e2e4', { cp: 30 }), line('g1f3', { cp: 20 }), line('f2f3', { cp: -250 })];
  const shapes = engineArrows(lines, 'white', deep);
  assert.deepEqual(shapes.map((s) => s.brush), ['engineBad', 'engineEqual', 'engineBest']);
  assert.equal(shapes.at(-1).orig, 'e2');
  assert.equal(shapes.at(-1).dest, 'e4');
  assert.match(shapes[0].label.text, /^−\d+$/);
  assert.equal(shapes[1].label, undefined);
});

test('losses are from the side to move (Black)', () => {
  // White-POV scores: Black's best is -50, the second gives White +150.
  const shapes = engineArrows([line('e7e5', { cp: -50 }), line('f7f6', { cp: 150 })], 'black', deep);
  assert.deepEqual(shapes.map((s) => s.brush), ['engineBad', 'engineBest']);
});

test('mates: allowing mate is bad, two mates are equal', () => {
  const allow = engineArrows([line('a2a3', { cp: 0 }), line('f2f3', { mate: -2 })], 'white', deep);
  assert.equal(allow[0].brush, 'engineBad');
  assert.equal(allow[0].label.text, '−50');
  const both = engineArrows([line('d1h5', { mate: 2 }), line('d1f3', { mate: 3 })], 'white', deep);
  assert.deepEqual(both.map((s) => s.brush), ['engineEqual', 'engineBest']);
});

test('Arrows setting: good moves / best only', () => {
  const lines = [line('e2e4', { cp: 30 }), line('d2d4', { cp: 0 }), line('b1a3', { cp: -90 }), line('f2f3', { cp: -300 })];
  assert.equal(engineArrows(lines, 'white', deep).length, 4);
  const good = engineArrows(lines, 'white', { ...deep, show: 'good' });
  assert.deepEqual(good.map((s) => s.orig), ['d2', 'e2']);
  assert.deepEqual(engineArrows(lines, 'white', { ...deep, show: 'best' }).map((s) => s.orig), ['e2']);
});

test('only the best arrow until the search is deep enough', () => {
  const lines = [line('e2e4', { cp: 30 }), line('f2f3', { cp: -300 })];
  assert.equal(engineArrows(lines, 'white', { depth: 8, limit: 20 }).length, 1);
  assert.equal(engineArrows(lines, 'white', { depth: 12, limit: 0 }).length, 2);
  assert.equal(engineArrows(lines, 'white', { depth: 8, limit: 8 }).length, 2); // limit below 12
  assert.equal(engineArrows(lines, 'white', { depth: 5, limit: 20, done: true }).length, 2);
});

test('nothing to draw', () => {
  assert.deepEqual(engineArrows([], 'white', deep), []);
  assert.deepEqual(engineArrows([{ pv: [], score: { cp: 0 } }], 'white', deep), []);
});
