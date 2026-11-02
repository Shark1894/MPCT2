// Move-by-move review: the pure part (unit tested). Turns one saved engine evaluation
// per position into a judgement of every move, the same way for both sides.
//
// Everything is measured in winning chances (0-100), not centipawns: losing a pawn
// matters a lot in a level position and hardly at all when already a rook up.
// Thresholds follow Lichess: a drop of 10 = inaccuracy, 20 = mistake, 30 = blunder.

import { Chess } from '../vendor/chess.js/chess.js';

export const SPEEDS = {
  quick: { label: 'Quick', ms: 300 },
  standard: { label: 'Standard', ms: 1000 },
  deep: { label: 'Deep', ms: 3000 },
};
export const OVERHEAD_MS = 80; // per position, on top of the thinking time (rough)

export const THRESHOLDS = { inaccuracy: 10, mistake: 20, blunder: 30 };
export const ONLY_MOVE_GAP = 20; // best move this much better than the second best
export const LABELS = {
  blunder: { symbol: '??', text: 'Blunder' },
  mistake: { symbol: '?', text: 'Mistake' },
  inaccuracy: { symbol: '?!', text: 'Inaccuracy' },
  only: { symbol: '!', text: 'Only move' },
};

/** White's winning chances 0..100 for a White-POV score ({cp} or {mate}). Lichess's curve. */
export function winChance(score) {
  if (!score) return 50;
  if (score.mate !== undefined && score.mate !== null) return score.mate > 0 ? 100 : score.mate < 0 ? 0 : 50;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * score.cp)) - 1);
}

/** Lichess's per-move accuracy from the drop in winning chances (0..100). */
export function moveAccuracy(loss) {
  return Math.max(0, Math.min(100, 103.1668100711649 * Math.exp(-0.04354415386753951 * loss) - 3.166924740191411));
}

/** The positions to analyse: the start and the position after each move up to `ply`. */
export function reviewPositions(startFen, moves, ply = moves.length) {
  return [startFen, ...moves.slice(0, ply).map((m) => m.fen)];
}

/**
 * A finished game position needs no engine: checkmate (the side to move lost) or a draw.
 * Returns an eval-shaped object, or null if the game isn't over here.
 */
export function terminalEval(fen) {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return { terminal: 'checkmate', white: chess.turn() === 'w' ? 0 : 100, lines: [] };
  if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.moves().length === 0) {
    return { terminal: 'draw', white: 50, lines: [] };
  }
  return null;
}

/** A saved eval from the server: scores come back as { cp, mate } with one of them null. */
export function normaliseEval(ev) {
  if (!ev) return null;
  const score = (s) => (s?.mate !== null && s?.mate !== undefined ? { mate: s.mate } : { cp: s?.cp ?? 0 });
  return { ...ev, lines: (ev.lines ?? []).map((l) => ({ ...l, score: score(l.score) })) };
}

/** White's winning chances in an analysed position, or null if it hasn't been analysed. */
export function positionWhite(ev) {
  if (!ev) return null;
  if (ev.terminal) return ev.white;
  return ev.lines?.length ? winChance(ev.lines[0].score) : null;
}

const sanOf = (fen, uci) => {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return uci;
  }
};

/** Mate in N for the given side ('w'|'b') from a White-POV score, else null. */
function mateFor(score, side) {
  if (!score || score.mate === undefined || score.mate === null || score.mate === 0) return null;
  const n = side === 'w' ? score.mate : -score.mate;
  return n > 0 ? n : null;
}

/**
 * Judge every move whose before and after positions are both analysed.
 * positions: FENs (start first); moves: [{ san, uci }] (moves[i] leads from positions[i] to positions[i+1]);
 * evals: one per position ({ lines } from the engine, a terminalEval, or null).
 * Returns one entry per move (null where it can't be judged yet).
 */
export function judgeMoves(positions, moves, evals) {
  return moves.map((move, i) => {
    const before = evals[i];
    const after = evals[i + 1];
    const wBefore = positionWhite(before);
    const wAfter = positionWhite(after);
    if (wBefore === null || wAfter === null) return null;

    const side = positions[i].split(' ')[1]; // who played this move
    const mine = (w) => (side === 'w' ? w : 100 - w);
    const best = before.lines?.[0] ?? null;
    const second = before.lines?.[1] ?? null;
    const isBest = Boolean(best && best.uci === move.uci);
    const moverBefore = mine(wBefore);
    const moverAfter = isBest ? moverBefore : mine(wAfter);
    const loss = Math.max(0, moverBefore - moverAfter);

    let label = null;
    if (loss >= THRESHOLDS.blunder) label = 'blunder';
    else if (loss >= THRESHOLDS.mistake) label = 'mistake';
    else if (loss >= THRESHOLDS.inaccuracy) label = 'inaccuracy';
    const only = isBest && Boolean(second) && mine(winChance(best.score)) - mine(winChance(second.score)) >= ONLY_MOVE_GAP;
    if (only) label = 'only';

    const notes = [];
    const missedMate = best ? mateFor(best.score, side) : null;
    const afterScore = after.lines?.[0]?.score ?? null;
    const stillMate = after.terminal === 'checkmate' || (afterScore && mateFor(afterScore, side));
    if (missedMate && !isBest && !stillMate) notes.push(`Missed mate in ${missedMate}`);
    const opponent = side === 'w' ? 'b' : 'w';
    const allowsMate = afterScore ? mateFor(afterScore, opponent) : null;
    const hadMateAgainst = best ? mateFor(best.score, opponent) : null;
    if (allowsMate && !hadMateAgainst) notes.push(`Allows mate in ${allowsMate}`);
    if (!missedMate && moverBefore >= 80 && moverAfter <= 55) notes.push('Lets a winning position slip');

    return {
      ply: i + 1,
      side,
      san: move.san,
      uci: move.uci,
      before: moverBefore, // mover's winning chances with best play
      after: moverAfter, // mover's winning chances after the move played
      loss,
      label,
      isBest,
      notes,
      accuracy: moveAccuracy(loss),
      best: best && !isBest ? { uci: best.uci, san: sanOf(positions[i], best.uci), score: best.score, pv: best.pv } : null,
    };
  });
}

/** Per-side totals: label counts, average accuracy, moves judged. */
export function summarise(judged) {
  const blank = () => ({ moves: 0, inaccuracy: 0, mistake: 0, blunder: 0, only: 0, best: 0, accuracy: null });
  const out = { w: blank(), b: blank() };
  const acc = { w: [], b: [] };
  for (const j of judged) {
    if (!j) continue;
    const s = out[j.side];
    s.moves += 1;
    if (j.label) s[j.label] += 1;
    if (j.isBest) s.best += 1;
    acc[j.side].push(j.accuracy);
  }
  for (const side of ['w', 'b']) {
    if (acc[side].length) out[side].accuracy = acc[side].reduce((a, b) => a + b, 0) / acc[side].length;
  }
  return out;
}

/** Seconds a review will take: positions still to analyse x (thinking time + overhead). */
export function estimateSeconds(toAnalyse, ms) {
  return Math.ceil((toAnalyse * (ms + OVERHEAD_MS)) / 1000);
}

/** "about 40 s", "about 3 min", "a few seconds". */
export function describeDuration(seconds) {
  if (seconds <= 5) return 'a few seconds';
  if (seconds < 90) return `about ${Math.round(seconds / 5) * 5} s`;
  return `about ${Math.round(seconds / 60)} min`;
}

/** Whether a game's moves still start with the reviewed ones (so the review applies). */
export function reviewStillApplies(review, startFen, ucis) {
  if (!review || review.startFen !== startFen) return false;
  return review.ucis.every((u, i) => ucis[i] === u);
}
