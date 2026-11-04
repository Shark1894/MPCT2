import { test } from 'node:test';
import assert from 'node:assert/strict';

// sounds.js imports ui.js, which touches localStorage only when used; give Node a stand-in.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { soundFor, movedOneForward } = await import('../../web/js/sounds.js');

test('which sound a move makes', () => {
  assert.equal(soundFor('e4'), 'move');
  assert.equal(soundFor('Nf3'), 'move');
  assert.equal(soundFor('exd5'), 'capture');
  assert.equal(soundFor('Bxf7+'), 'check');
  assert.equal(soundFor('Qh7#'), 'check');
  assert.equal(soundFor('O-O'), 'castle');
  assert.equal(soundFor('O-O-O+'), 'check');
  assert.equal(soundFor('e8=Q'), 'promote');
  assert.equal(soundFor('dxe8=N'), 'promote');
  assert.equal(soundFor(''), null);
});

test('only one move forward in the same game makes a sound', () => {
  const s = 'start';
  assert.equal(movedOneForward({ startFen: s, ply: 3 }, { startFen: s, ply: 4 }), true);
  assert.equal(movedOneForward({ startFen: s, ply: 4 }, { startFen: s, ply: 3 }), false); // back
  assert.equal(movedOneForward({ startFen: s, ply: 0 }, { startFen: s, ply: 5 }), false); // jump
  assert.equal(movedOneForward({ startFen: s, ply: 3 }, { startFen: 'other', ply: 4 }), false); // new game
  assert.equal(movedOneForward(null, { startFen: s, ply: 1 }), false);
});
