import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pgnChunks } from '../../web/js/games.js';

const game = (n) => `[Event "Game ${n}"]\n[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Nf3 Nc6 *`;

test('small text is sent as it is', () => {
  const text = [1, 2, 3].map(game).join('\n\n');
  assert.deepEqual(pgnChunks(text), [text]);
});

test('large text is split between games, never inside one', () => {
  const text = Array.from({ length: 10 }, (_, i) => game(i)).join('\n\n');
  const chunks = pgnChunks(text, 120);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.startsWith('[Event "Game '));
    assert.ok(c.trimEnd().endsWith('*'));
  }
  const events = chunks.join('\n\n').match(/\[Event "Game \d+"\]/g);
  assert.equal(events.length, 10);
});

test('a single game bigger than the limit stays whole', () => {
  const big = game(1) + ' {' + 'x'.repeat(500) + '}';
  assert.deepEqual(pgnChunks(`${big}\n\n${game(2)}`, 100), [big, game(2)]);
});
