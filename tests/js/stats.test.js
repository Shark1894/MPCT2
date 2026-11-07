import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_MS, TimeTracker } from '../../web/js/activity-core.js';
import { addDays, axisTop, daily, duration, periodStart, share, summarize } from '../../web/js/stats-core.js';

const OPEN = { category: 'openings', activity: 'opening-training', detail: 'Italian' };
const PUZ = { category: 'tactics', activity: 'puzzles-rated' };

function tracker() {
  let n = 0;
  return new TimeTracker({ uuid: () => `key-${++n}`, day: (t) => Math.floor(t / 86400000) });
}

/** Tick once a second from `from` to `to` (ms), touching the page at the given times. */
function run(t, from, to, activity, { visible = true, touches = [] } = {}) {
  const ended = [];
  for (let ms = from; ms <= to; ms += 1000) {
    if (touches.includes(ms)) t.input(ms);
    ended.push(...t.tick(ms, visible, activity));
  }
  return ended;
}

test('counts while visible and touched within two minutes', () => {
  const t = tracker();
  run(t, 1000, 61000, OPEN, { touches: [1000] });
  assert.equal(t.current.seconds, 60);
  run(t, 62000, 1000 + IDLE_MS + 30000, OPEN); // nothing touched: counts up to two minutes after the touch
  assert.equal(t.current.seconds, IDLE_MS / 1000);
  assert.deepEqual(t.pending(), { key: 'key-1', ...OPEN, started_at: new Date(1000).toISOString(), seconds: 120 });
  assert.equal(t.pending(), null); // nothing new since
});

test('hidden pages and long gaps are not counted', () => {
  const t = tracker();
  run(t, 0, 10000, OPEN, { touches: [0] });
  run(t, 11000, 20000, OPEN, { visible: false });
  t.input(30000);
  t.tick(30000, true, OPEN); // 10 s since the last tick: only 5 s counted
  assert.equal(t.current.seconds, 15);
  t.tick(31000, true, null); // the training hub: not counted, but doesn't end the stretch
  t.tick(32000, true, OPEN);
  assert.equal(t.current.seconds, 16);
});

test('a new stretch when the activity changes, after idling, and at midnight', () => {
  const t = tracker();
  run(t, 0, 30000, OPEN, { touches: [0] });
  const ended = t.tick(31000, true, PUZ);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].key, 'key-1');
  assert.equal(ended[0].seconds, 30);
  assert.equal(t.current.key, 'key-2');
  run(t, 32000, 40000, PUZ);
  // away for ten minutes, then back: a new stretch of the same thing
  t.input(700000);
  const back = t.tick(700000, true, PUZ);
  assert.equal(back[0].key, 'key-2');
  assert.equal(t.current.key, 'key-3');
  // past midnight (day = whole days of ms here)
  run(t, 86398000, 86399000, PUZ, { touches: [86398000] });
  assert.equal(t.tick(86400000, true, PUZ)[0].key, 'key-4');
  assert.equal(t.current.key, 'key-5');
});

const ROWS = [
  { date: '2026-10-01', category: 'openings', activity: 'opening-training', detail: 'Italian', seconds: 600, sessions: 2 },
  { date: '2026-11-01', category: 'tactics', activity: 'woodpecker', detail: 'Woodpecker', seconds: 1200, sessions: 1 },
  { date: '2026-11-06', category: 'openings', activity: 'opening-training', detail: 'Caro-Kann', seconds: 300, sessions: 1 },
  { date: '2026-11-07', category: 'openings', activity: 'opening-training', detail: 'Italian', seconds: 120, sessions: 1 },
  { date: '2026-11-07', category: 'endgames', activity: 'endgame-drill', detail: 'kbn', seconds: 60, sessions: 3 },
];
const TODAY = '2026-11-07';

test('periods, totals and breakdowns', () => {
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(periodStart(TODAY, 'week'), '2026-11-01');
  assert.equal(periodStart(TODAY, 'all'), null);
  const today = summarize(ROWS, TODAY, 'today');
  assert.equal(today.total, 180);
  assert.deepEqual([today.byCategory.openings, today.byCategory.endgames, today.byCategory.tactics], [120, 60, 0]);
  const week = summarize(ROWS, TODAY, 'week');
  assert.equal(week.total, 1680);
  assert.deepEqual(week.breakdown.map((b) => [b.activity, b.seconds, b.sessions]), [
    ['woodpecker', 1200, 1], ['opening-training', 420, 2], ['endgame-drill', 60, 3]]);
  assert.deepEqual(week.breakdown[1].details, [{ detail: 'Caro-Kann', seconds: 300 }, { detail: 'Italian', seconds: 120 }]);
  assert.equal(summarize(ROWS, TODAY, 'all').total, 2280);
});

test('daily totals fill empty days', () => {
  const d = daily(ROWS, TODAY, 7);
  assert.equal(d.length, 7);
  assert.equal(d[0].date, '2026-11-01');
  assert.equal(d[6].date, TODAY);
  assert.equal(d[0].values.tactics, 1200);
  assert.equal(d[3].total, 0);
  assert.deepEqual([d[6].values.openings, d[6].values.endgames, d[6].total], [120, 60, 180]);
});

test('formatting', () => {
  assert.deepEqual([0, 42, 840, 3725, 36000].map(duration), ['0m', '42s', '14m', '1h 02m', '10h 00m']);
  assert.deepEqual([share(0, 10), share(1, 1000), share(1, 3)], ['', '<1%', '33%']);
  assert.deepEqual(axisTop(500), { top: 600, step: 600 });
  assert.deepEqual(axisTop(5000), { top: 5400, step: 1800 });
  assert.deepEqual(axisTop(100000), { top: 100800, step: 25200 });
});
