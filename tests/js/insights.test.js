import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoves, weakness, viewLines, weakestLines, activityLevel, activityWeeks, streakBreakdown, branchRows, repertoireTotals } from '../../web/js/insights.js';

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

test('streakBreakdown: new row, one row per streak, 6+ lumped together', () => {
  const lines = [
    line(1, [], { reviews: 0 }),
    line(2, [], { recent: [true, false], streak: 0 }),
    line(3, [], { recent: [true], streak: 1 }),
    line(4, [], { recent: [true], streak: 1 }),
    line(5, [], { recent: [true], streak: 3 }),
    line(6, [], { recent: [true], streak: 6 }),
    line(7, [], { recent: [true], streak: 9 }),
  ];
  const rows = streakBreakdown(lines);
  assert.deepEqual(rows.map((r) => r.key), ['new', '0', '1', '2', '3', '4', '5', '6']);
  assert.deepEqual(rows.map((r) => r.lines.map((l) => l.id)), [[1], [2], [3, 4], [], [5], [], [], [6, 7]]);
  assert.deepEqual(rows.map((r) => r.stage), ['new', 'learning', 'learning', 'known', 'known', 'known', 'mastered', 'mastered']);
  assert.equal(rows[2].gap, 'next in 1 day');
  assert.equal(rows[4].gap, 'next in 7 days');
  assert.equal(rows[7].gap, 'every 60 days');
  assert.equal(rows[1].gap, 'last had a mistake');
  assert.equal(rows[7].label, '6+× correct');
});

test('branchRows: branches nested under their parents, "No branch" last', () => {
  const m = { new: 0, learning: 0, known: 0, mastered: 0 };
  const rows = branchRows([
    { id: null, name: 'No branch', parent_id: null, lines: 2, due: 0, mastery: m },
    { id: 1, name: 'Main', parent_id: null, lines: 5, due: 1, mastery: m },
    { id: 3, name: 'Wuss', parent_id: 1, lines: 2, due: 0, mastery: m },
    { id: 2, name: 'Other', parent_id: null, lines: 1, due: 0, mastery: m },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.branch.name, r.depth]),
    [['Main', 0], ['Wuss', 1], ['Other', 0], ['No branch', 0]],
  );
});

test('repertoireTotals: sums openings, accuracy weighted by reviews', () => {
  const t = repertoireTotals([
    { lines: 10, due: 2, reviews: 10, accuracy: 0.5, mastery: { new: 1, learning: 2, known: 3, mastered: 4 } },
    { lines: 4, due: 0, reviews: 30, accuracy: 0.9, mastery: { new: 4, learning: 0, known: 0, mastered: 0 } },
    { lines: 0, due: 0, reviews: 0, accuracy: null, mastery: { new: 0, learning: 0, known: 0, mastered: 0 } },
  ]);
  assert.deepEqual(t, { lines: 14, due: 2, reviews: 40, accuracy: 32 / 40, mastery: { new: 5, learning: 2, known: 3, mastered: 4 } });
});
