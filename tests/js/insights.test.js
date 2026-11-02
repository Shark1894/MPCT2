import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoves, weakness, viewLines, weakestLines, activityLevel, activityWeeks } from '../../web/js/insights.js';

const iso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
};
const line = (id, moves, { recent = [], streak = 0, due = 0, reviews = recent.length, correct } = {}) => ({
  id,
  moves,
  recent,
  streak,
  reviews,
  correct: correct ?? recent.filter(Boolean).length,
  next_review_on: iso(due),
});

test('formatMoves numbers moves, including fragments starting with Black', () => {
  assert.equal(formatMoves(['e4', 'c6', 'd4']), '1.e4 c6 2.d4');
  assert.equal(formatMoves(['c6'], 2), '1...c6');
  assert.equal(formatMoves(['Bf5'], 6), '3...Bf5');
  assert.equal(formatMoves(['e5'], 5), '3.e5');
});

test('weakness: recent mistakes, the latest counting extra', () => {
  assert.equal(weakness(line(1, [], { recent: [true, true] })), 0);
  assert.equal(weakness(line(1, [], { recent: [false, true] })), 2);
  assert.equal(weakness(line(1, [], { recent: [true, false] })), 3);
  assert.equal(weakness(line(1, [], { recent: [false, false, true, false] })), 7);
});

test('viewLines filters, searches move text and sorts', () => {
  const lines = [
    line(1, ['e4', 'c6', 'd4', 'd5', 'e5', 'Bf5'], { recent: [true, true], streak: 2, due: 3 }),
    line(2, ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4'], { recent: [false], due: 0 }),
    line(3, ['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5'], { due: -2 }),
  ];
  assert.deepEqual(viewLines(lines).map((l) => l.id), [3, 2, 1], 'default: next review');
  assert.deepEqual(viewLines(lines, { sort: 'weak' }).map((l) => l.id), [2, 3, 1]);
  assert.deepEqual(viewLines(lines, { sort: 'moves' }).map((l) => l.id), [2, 1, 3]);
  assert.deepEqual(viewLines(lines, { filter: 'due' }).map((l) => l.id), [3, 2]);
  assert.deepEqual(viewLines(lines, { filter: 'new' }).map((l) => l.id), [3]);
  assert.deepEqual(viewLines(lines, { filter: 'mistakes' }).map((l) => l.id), [2]);
  assert.deepEqual(viewLines(lines, { search: 'Bf5' }).map((l) => l.id), [1]);
  assert.deepEqual(viewLines(lines, { search: '3.e5' }).map((l) => l.id), [1]);
  assert.deepEqual(viewLines(lines, { search: 'e5' }).map((l) => l.id), [1], 'e5 does not match exd5');
});

test('viewLines bookmarked filter', () => {
  const lines = [
    { ...line(1, ['e4', 'c6'], { due: 1 }), bookmarked: true, bookmark_note: 'sharp' },
    line(2, ['e4', 'e5']),
    { ...line(3, ['d4', 'd5'], { due: -1 }), bookmarked: true, bookmark_note: null },
  ];
  assert.deepEqual(viewLines(lines, { filter: 'bookmarked' }).map((l) => l.id), [3, 1]);
  assert.deepEqual(viewLines(lines, { filter: 'bookmarked', search: 'd4' }).map((l) => l.id), [3]);
});

test('weakestLines: only lines with recent mistakes, weakest first, capped', () => {
  const lines = [
    line(1, ['e4'], { recent: [true, false] }),
    line(2, ['d4'], { recent: [false, false] }),
    line(3, ['c4'], { recent: [true] }),
  ];
  assert.deepEqual(weakestLines(lines).map((l) => l.id), [2, 1]);
  assert.deepEqual(weakestLines(lines, 1).map((l) => l.id), [2]);
});

test('activity levels and week layout from Monday', () => {
  assert.deepEqual([0, 1, 3, 4, 8, 9, 16].map(activityLevel), [0, 1, 1, 2, 2, 3, 4]);
  // 2026-10-28 is a Wednesday: two blanks before it
  const days = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map((date) => ({ date, reviews: 1 }));
  const weeks = activityWeeks(days);
  assert.equal(weeks.length, 2);
  assert.deepEqual(weeks[0].map((d) => d?.date ?? null), [null, null, '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(weeks[1].map((d) => d?.date ?? null), ['2026-11-02', null, null, null, null, null, null]);
});
