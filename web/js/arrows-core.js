// Engine arrows: how each of the engine's lines is drawn on the board, by how much
// winning chance (Lichess win%, as on the Practical tab) it gives away against the
// best line. Pure, so it's unit tested.
//
// Green (repertoire) and blue (repertoire transpositions) are left to the explorer,
// so the engine uses purple for its best and good moves, then orange, then red.

import { winPct } from './practical-core.js';

/** Bands by win% lost against the best line (upper bound inclusive). `good` matches Practical. */
export const BANDS = [
  { key: 'best', max: 0, brush: 'engineBest' },
  { key: 'equal', max: 2, brush: 'engineEqual' },
  { key: 'good', max: 7, brush: 'engineGood' },
  { key: 'dubious', max: 15, brush: 'engineDubious' },
  { key: 'bad', max: Infinity, brush: 'engineBad' },
];

/** Chessground brushes for the bands (width shrinks as the move gets worse). */
export const BRUSHES = {
  engineBest: { key: 'eb', color: '#6a1b9a', opacity: 0.9, lineWidth: 13 },
  engineEqual: { key: 'ee', color: '#6a1b9a', opacity: 0.7, lineWidth: 11 },
  engineGood: { key: 'eg', color: '#9575cd', opacity: 0.6, lineWidth: 8 },
  engineDubious: { key: 'ed', color: '#e07b00', opacity: 0.8, lineWidth: 6 },
  engineBad: { key: 'ex', color: '#c62828', opacity: 0.85, lineWidth: 4 },
};

/** The Arrows setting: which lines get an arrow. */
export const SHOW = [
  ['all', 'All lines'],
  ['good', 'Good moves'],
  ['best', 'Best only'],
];

/** Below this depth only the best move gets an arrow (early evals jump about). */
export const MIN_DEPTH = 12;

export function bandFor(loss) {
  return BANDS.find((b) => loss <= b.max + 1e-9);
}

/**
 * Arrows for the engine's lines ({pv, score} with White-POV scores, best first).
 * @param {object[]} lines
 * @param {'white'|'black'} turn   side to move
 * @param {object} opts
 * @param {'all'|'good'|'best'} [opts.show]
 * @param {number} [opts.depth]     depth reached
 * @param {number} [opts.limit]     depth limit (0 = none)
 * @param {boolean} [opts.done]     search finished
 * @returns chessground shapes, worst first so the best is drawn on top
 */
export function engineArrows(lines, turn, { show = 'all', depth = 0, limit = 0, done = false } = {}) {
  const usable = lines.filter((l) => l.pv?.length && l.score);
  if (!usable.length) return [];
  const settled = done || depth >= (limit ? Math.min(MIN_DEPTH, limit) : MIN_DEPTH);
  const top = winPct(usable[0].score, turn);
  const shapes = [];
  usable.forEach((l, i) => {
    const loss = i === 0 ? 0 : Math.max(0, top - winPct(l.score, turn));
    const band = bandFor(loss);
    if (i > 0) {
      if (!settled || show === 'best') return;
      if (show === 'good' && loss > BANDS[2].max) return;
    }
    // A line exactly as good as the best (e.g. two mates) is drawn as 'equal', never as a second best.
    const shape = { orig: l.pv[0].slice(0, 2), dest: l.pv[0].slice(2, 4), brush: i === 0 ? 'engineBest' : band.key === 'best' ? 'engineEqual' : band.brush };
    shapes.push({ shape, loss, i });
  });
  return shapes.sort((a, b) => b.loss - a.loss || b.i - a.i).map((s) => s.shape);
}
