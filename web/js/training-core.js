// The Training tab's look, without the DOM (unit tested): mini boards from a FEN, drill mastery
// levels and result strips, the puzzle rating trend, and what to suggest next.

const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

/** The 64 squares of a FEN (rank 8 first, a to h): {light, glyph, white} (glyph '' if empty). */
export function boardSquares(fen, flipped = false) {
  const rows = (fen || '8/8/8/8/8/8/8/8').split(' ')[0].split('/');
  const squares = [];
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) squares.push({ light: (r + f++) % 2 === 0, glyph: '', white: false });
      } else {
        squares.push({ light: (r + f++) % 2 === 0, glyph: GLYPH[ch.toLowerCase()] ?? '', white: ch === ch.toUpperCase() });
      }
    }
  });
  return flipped ? squares.reverse() : squares;
}

export const LEVELS = ['New', 'Learning', 'Solid', 'Mastered'];

/**
 * A drill's level from its stats (recent attempts newest first): Mastered = the last 5 all
 * passed; Solid = 3 or more of the last 5; Learning = passed at least once; New = not yet.
 */
export function drillLevel(st) {
  const recent = st?.recent ?? [];
  const last5 = recent.slice(0, 5);
  const passed = last5.filter((a) => a.success).length;
  if (last5.length === 5 && passed === 5) return 'Mastered';
  if (passed >= 3) return 'Solid';
  if ((st?.successes ?? 0) > 0) return 'Learning';
  return 'New';
}

/** The last `n` results, oldest first, padded with 'none': 'pass' | 'fail' | 'none'. */
export function runStrip(recent = [], n = 8) {
  const out = recent.slice(0, n).reverse().map((a) => (a.success ? 'pass' : 'fail'));
  while (out.length < n) out.push('none');
  return out;
}

/** Rating change over the last `days` days from the daily history, or null. */
export function ratingChange(history = [], rating, now = new Date(), days = 7) {
  if (!history.length) return null;
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const before = history.filter((h) => h.date < cutoff).at(-1);
  if (before) return rating - before.rating;
  const recent = history.filter((h) => h.date >= cutoff);
  return recent.length > 1 ? rating - recent[0].rating : null;
}

/** SVG polyline points for the last `count` ratings, fitted to w x h (with a little padding). */
export function sparkPoints(history = [], w = 300, h = 70, count = 30) {
  const pts = history.slice(-count).map((p) => p.rating);
  if (pts.length < 2) return '';
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const pad = 6;
  return pts
    .map((v, i) => `${Math.round((i / (pts.length - 1)) * w)},${Math.round(pad + (1 - (v - lo) / span) * (h - 2 * pad))}`)
    .join(' ');
}

/** stroke-dasharray for a progress ring of radius r at fraction p (0-1). */
export function ringDash(r, p) {
  const c = 2 * Math.PI * r;
  return `${(c * Math.max(0, Math.min(1, p))).toFixed(1)} ${c.toFixed(1)}`;
}

/** The drill to suggest: one tried but not mastered (lowest level first), else the first new one. */
export function suggestDrill(drills, stats) {
  const rank = (d) => LEVELS.indexOf(drillLevel(stats?.[d.id]));
  const tried = drills.filter((d) => (stats?.[d.id]?.attempts ?? 0) > 0 && drillLevel(stats[d.id]) !== 'Mastered');
  if (tried.length) return [...tried].sort((a, b) => rank(a) - rank(b))[0];
  return drills.find((d) => !(stats?.[d.id]?.attempts > 0)) ?? null;
}
