import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, days, duration, pace, scopeText, sortPuzzles, timeToGo } from '../../web/js/woodpecker-core.js';

test('clock and durations', () => {
  assert.equal(clock(7.9), '0:07');
  assert.equal(clock(102), '1:42');
  assert.equal(clock(3723), '1:02:03');
  assert.equal(duration(12.4), '12s');
  assert.equal(duration(250), '4m 10s');
  assert.equal(duration(18720), '5h 12m');
  assert.equal(days(0.375), '9 hours');
  assert.equal(days(4.25), '4.3 days');
  assert.equal(days(1), '1 day');
  assert.equal(days(0.01), 'under an hour');
});

test('pace against the target', () => {
  assert.equal(pace({ total: 100, done: 10, days: 1 }), null);
  // 2 of 10 days gone: on pace you'd have done 20; done 30 = 10 ahead; 70 left over 8 days = 9 a day.
  assert.deepEqual(pace({ total: 100, done: 30, days: 2, target_days: 10 }), { expected: 20, ahead: 10, daysLeft: 8, perDay: 9 });
  const late = pace({ total: 100, done: 90, days: 12, target_days: 10 });
  assert.equal(late.expected, 100);
  assert.equal(late.ahead, -10);
  assert.equal(late.perDay, 10); // past the target: everything left, now
  assert.equal(timeToGo({ total: 100, done: 40, avg_seconds: 30 }), 1800);
  assert.equal(timeToGo({ total: 100, done: 0, avg_seconds: null }), null);
});

test('sorting puzzle times', () => {
  const P = [
    { id: 1, times: { 1: { seconds: 10, solved: true }, 2: { seconds: 4, solved: true } } },
    { id: 2, times: {} },
    { id: 3, times: { 1: { seconds: 50, solved: false }, 2: { seconds: 20, solved: false } } },
    { id: 4, times: { 1: { seconds: 30, solved: false } } },
  ];
  assert.deepEqual(sortPuzzles(P, 'order').map((p) => p.id), [1, 2, 3, 4]);
  assert.deepEqual(sortPuzzles(P, 'slowest').map((p) => p.id), [4, 3, 1, 2]); // by latest time tried
  assert.deepEqual(sortPuzzles(P, 'missed').map((p) => p.id), [3, 4, 1, 2]);
});

test('cycle scope text', () => {
  const ch = [{ id: 1, title: 'Easy' }, { id: 2, title: 'Intermediate' }, { id: 3, title: 'Advanced' }];
  assert.equal(scopeText({ chapter_ids: null }, ch), 'All chapters');
  assert.equal(scopeText({ chapter_ids: [1] }, ch), 'Easy');
  assert.equal(scopeText({ chapter_ids: [1, 2] }, ch), '2 chapters: Easy, Intermediate');
});
