// The Stats tab's numbers, without the browser: periods, daily totals and breakdowns from the
// server's rows ({date, category, activity, detail, seconds, sessions}, dates as YYYY-MM-DD).

/** In stacking and legend order; colours checked for dark mode (distinct with colour blindness too). */
export const CATEGORIES = [
  { id: 'openings', label: 'Openings', color: '#3987e5' },
  { id: 'tactics', label: 'Tactics', color: '#d95926' },
  { id: 'endgames', label: 'Endgames', color: '#199e70' },
  { id: 'strategy', label: 'Strategy', color: '#c98500' },
  { id: 'games', label: 'Games', color: '#d55181' },
  { id: 'analysis', label: 'Analysis', color: '#008300' },
];

export const ACTIVITIES = {
  'opening-training': 'Opening training',
  'position-drill': 'Position drills',
  repertoire: 'Repertoire & board',
  dashboard: 'Dashboard',
  wild: 'Wild',
  'puzzles-rated': 'Rated puzzles',
  'puzzles-mine': 'Puzzles from your games',
  woodpecker: 'Woodpecker',
  course: 'Courses',
  'endgame-drill': 'Endgame drills',
  play: 'Playing the engine',
  'engine-review': 'Engine reviews',
  'game-study': 'Studying games',
  'games-list': 'Games list',
  analysis: 'Free analysis',
};

export const PERIODS = [
  { id: 'today', label: 'Today', days: 1 },
  { id: 'week', label: '7 days', days: 7 },
  { id: 'month', label: '30 days', days: 30 },
  { id: 'all', label: 'All time', days: null },
];

/** YYYY-MM-DD plus n days. */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** First day of a period ending today (null: all time). */
export function periodStart(today, period) {
  const p = PERIODS.find((x) => x.id === period);
  return p?.days ? addDays(today, 1 - p.days) : null;
}

const inPeriod = (row, from, today) => (!from || row.date >= from) && row.date <= today;

/**
 * Totals for a period: total seconds, seconds per category, and a breakdown per activity
 * (largest first) with its details (an opening, a course, a drill), largest first.
 */
export function summarize(rows, today, period) {
  const from = periodStart(today, period);
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  const acts = new Map();
  let total = 0;
  for (const r of rows) {
    if (!inPeriod(r, from, today)) continue;
    total += r.seconds;
    byCategory[r.category] = (byCategory[r.category] ?? 0) + r.seconds;
    const k = `${r.category}|${r.activity}`;
    if (!acts.has(k)) acts.set(k, { category: r.category, activity: r.activity, seconds: 0, sessions: 0, details: new Map() });
    const a = acts.get(k);
    a.seconds += r.seconds;
    a.sessions += r.sessions;
    if (r.detail) a.details.set(r.detail, (a.details.get(r.detail) ?? 0) + r.seconds);
  }
  const breakdown = [...acts.values()]
    .map((a) => ({
      ...a,
      details: [...a.details].map(([detail, seconds]) => ({ detail, seconds })).sort((x, y) => y.seconds - x.seconds),
    }))
    .sort((x, y) => y.seconds - x.seconds);
  return { total, byCategory, breakdown };
}

/** One entry per day for the last `days` days (oldest first): {date, total, values: {category: seconds}}. */
export function daily(rows, today, days = 30) {
  const from = addDays(today, 1 - days);
  const out = [];
  const index = new Map();
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const d = { date, total: 0, values: Object.fromEntries(CATEGORIES.map((c) => [c.id, 0])) };
    index.set(date, d);
    out.push(d);
  }
  for (const r of rows) {
    const d = index.get(r.date);
    if (!d) continue;
    d.values[r.category] = (d.values[r.category] ?? 0) + r.seconds;
    d.total += r.seconds;
  }
  return out;
}

/** 3725 → "1h 02m", 840 → "14m", 42 → "42s", 0 → "0m". */
export function duration(seconds) {
  const s = Math.round(seconds);
  if (s <= 0) return '0m';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Share of a total as a whole percentage ("<1%" for a sliver, "" for nothing). */
export function share(part, total) {
  if (!total || !part) return '';
  const p = (100 * part) / total;
  return p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/** Nice round top for an axis of hours/minutes: a value ≥ max in seconds, with its tick step. */
export function axisTop(maxSeconds) {
  const steps = [600, 900, 1800, 3600, 5400, 7200, 10800, 14400, 21600];
  for (const step of steps) if (maxSeconds <= step * 4) return { top: Math.max(step, Math.ceil(maxSeconds / step) * step), step };
  const step = 3600 * Math.ceil(maxSeconds / 4 / 3600);
  return { top: step * 4, step };
}
