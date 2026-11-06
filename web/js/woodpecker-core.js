// Woodpecker Method helpers with no DOM (unit tested): time formats, pace against the cycle's
// target, and sorting the puzzle-times table.

/** A clock reading: 0:07, 1:42, 1:02:03. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A duration in words: 12s, 4m 10s, 5h 12m. */
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Days as text: 0.4 days → "9 hours", 4.25 → "4.3 days", 1 → "1 day". */
export function days(d) {
  if (d < 1 / 24) return 'under an hour';
  if (d < 1) {
    const h = Math.max(1, Math.round(d * 24));
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const r = Math.round(d * 10) / 10;
  return `${r} day${r === 1 ? '' : 's'}`;
}

/**
 * How the cycle is going against its target: on target pace you'd have done total × days/target
 * puzzles by now. Returns null without a target; else {expected, ahead (puzzles, + = ahead),
 * daysLeft, perDay (puzzles a day needed for the rest)}.
 */
export function pace(cycle) {
  if (!cycle?.target_days) return null;
  const expected = Math.min(cycle.total, Math.round((cycle.total * cycle.days) / cycle.target_days));
  const daysLeft = Math.max(0, cycle.target_days - cycle.days);
  const left = cycle.total - cycle.done;
  return {
    expected,
    ahead: cycle.done - expected,
    daysLeft,
    perDay: left <= 0 ? 0 : daysLeft > 0 ? Math.ceil(left / Math.max(daysLeft, 1)) : left,
  };
}

/** Time still needed at the cycle's average so far (seconds), or null. */
export function timeToGo(cycle) {
  if (!cycle?.avg_seconds) return null;
  return (cycle.total - cycle.done) * cycle.avg_seconds;
}

/**
 * Sort the puzzle-times rows: 'order' (course order), 'slowest' (slowest in the latest cycle they
 * were tried in, first), 'missed' (most cycles missed, then slowest). Rows not tried yet go last.
 */
export function sortPuzzles(puzzles, mode) {
  const rows = puzzles.map((p, i) => {
    const entries = Object.entries(p.times).map(([n, t]) => [Number(n), t]).sort((a, b) => a[0] - b[0]);
    const last = entries.at(-1)?.[1];
    return { p, i, last: last?.seconds ?? -1, missed: entries.filter(([, t]) => !t.solved).length, tried: entries.length > 0 };
  });
  if (mode === 'slowest') rows.sort((a, b) => b.tried - a.tried || b.last - a.last || a.i - b.i);
  else if (mode === 'missed') rows.sort((a, b) => b.missed - a.missed || b.last - a.last || a.i - b.i);
  return rows.map((r) => r.p);
}

/** Chapter scope of a cycle as text: "All chapters" or "2 chapters: Easy, Intermediate". */
export function scopeText(cycle, chapters) {
  if (!cycle.chapter_ids?.length) return 'All chapters';
  const names = chapters.filter((c) => cycle.chapter_ids.includes(c.id)).map((c) => c.title);
  return names.length === 1 ? names[0] : `${names.length} chapters: ${names.join(', ')}`;
}
