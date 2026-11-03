import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, moveNumber, playerText, resultText, statusText, watchName } from '../../web/js/wild.js';

const NOW = Date.parse('2026-11-03T18:00:00Z');

test('players, results and move numbers', () => {
  assert.equal(playerText('Carlsen, Magnus', 2830), 'Carlsen, Magnus (2830)');
  assert.equal(playerText('', null), '?');
  assert.equal(resultText('1/2-1/2'), '½–½');
  assert.equal(resultText('1-0'), '1–0');
  assert.equal(moveNumber(6), 3);
  assert.equal(moveNumber(5), 3);
});

test('a watch is named by its label or its last move', () => {
  assert.equal(watchName({ label: 'Slav Bf5', path: ['d4'] }), 'Slav Bf5');
  assert.equal(watchName({ label: '', path: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Bf5'] }), '3...Bf5');
  assert.equal(watchName({ label: '', path: ['d4', 'd5', 'c4'] }), '2.c4');
});

test('how long ago', () => {
  assert.equal(ago(null, NOW), 'never');
  assert.equal(ago('2026-11-03T17:59:30Z', NOW), 'just now');
  assert.equal(ago('2026-11-03T17:15:00Z', NOW), '45 min ago');
  assert.equal(ago('2026-11-03T12:00:00Z', NOW), '6 h ago');
  assert.equal(ago('2026-10-30T18:00:00Z', NOW), '4 days ago');
});

test('status line', () => {
  const base = { enabled: true, running: false, step: '', games: 0, twic_issue: null, last_fetch_at: null };
  assert.match(statusText(base, NOW), /^Not checked yet/);
  assert.equal(
    statusText({ ...base, last_fetch_at: '2026-11-03T15:00:00Z', games: 81234, twic_issue: 1669 }, NOW),
    'Last checked 3 h ago · 81,234 games stored · TWIC up to 1669.',
  );
  assert.equal(statusText({ ...base, running: true, step: 'The Week in Chess 1660' }, NOW), 'Checking for new games… The Week in Chess 1660');
  assert.match(statusText({ ...base, enabled: false }, NOW), /turned off/);
});
