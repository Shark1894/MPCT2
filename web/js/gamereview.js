// Engine reviews of saved games: what's sent to the server when a game's review is complete
// (each side's accuracy, the counts of inaccuracies/mistakes/blunders and the candidate
// puzzles), and a batch reviewer that reviews several games one after another with the
// browser's Stockfish, reusing analysis already saved. The pure parts are unit tested.

import { api } from './api.js';
import { Chess } from '../vendor/chess.js/chess.js';
import { Engine } from './engine.js';
import { ONLY_MOVE_GAP, THRESHOLDS, judgeMoves, normaliseEval, summarise, terminalEval, winChance } from './review-core.js';

export const BATCH_MS = 1000; // thinking time per position (the review's Standard)
const ENGINE_NAME = 'Stockfish 19 Lite';
const SAVE_BATCH = 10;

/**
 * Mistakes worth a puzzle, from judgeMoves output, for either side: moves that lost at least
 * a mistake's worth of winning chances, where the engine's best move was clearly better than
 * its second choice (so the puzzle has one answer). Not move 1 (a puzzle starts from the
 * opponent's previous move). The server keeps the ones on your side.
 * @returns {{ply, best_uci, best_pv, before, after}[]}
 */
export function findMistakes(judged, evals) {
  const out = [];
  for (const j of judged) {
    if (!j || j.ply < 2 || !j.best || j.loss < THRESHOLDS.mistake) continue;
    const lines = evals[j.ply - 1]?.lines ?? [];
    if (lines.length < 2) continue; // a forced move isn't a puzzle
    const mine = (w) => (j.side === 'w' ? w : 100 - w);
    const gap = mine(winChance(lines[0].score)) - mine(winChance(lines[1].score));
    if (gap < ONLY_MOVE_GAP) continue;
    out.push({
      ply: j.ply,
      best_uci: j.best.uci,
      best_pv: (j.best.pv ?? []).slice(0, 10),
      before: Math.round(j.before * 10) / 10,
      after: Math.round(j.after * 10) / 10,
    });
  }
  return out;
}

/** Whether every move of the game has been judged (the review is complete). */
export function reviewComplete(judged, nMoves) {
  return judged.length === nMoves && nMoves > 0 && judged.every(Boolean);
}

/** The body of POST /api/game-reviews/{id} for a complete review. */
export function reviewPayload(ucis, ms, judged, evals) {
  const s = summarise(judged);
  const counts = (side) => ({ inaccuracy: s[side].inaccuracy, mistake: s[side].mistake, blunder: s[side].blunder });
  const round = (x) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    moves: ucis,
    movetime_ms: ms,
    accuracy: { w: round(s.w.accuracy), b: round(s.b.accuracy) },
    counts: { w: counts('w'), b: counts('b') },
    candidates: findMistakes(judged, evals),
  };
}

/** Positions and moves of a game: positions[i] is before moves[i]. */
export function gamePositions(startFen, ucis) {
  const chess = new Chess(startFen);
  const positions = [chess.fen()];
  const moves = [];
  for (const uci of ucis) {
    const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    moves.push({ uci: m.lan, san: m.san });
    positions.push(chess.fen());
  }
  return { positions, moves };
}

/**
 * Reviews games one after another. Callbacks: onProgress({ game, gameIndex, games, done, total }),
 * onGameDone({ game, ...server result }). cancel() stops after the current position.
 */
export class GameReviewer {
  constructor({ onProgress, onGameDone, ms = BATCH_MS }) {
    Object.assign(this, { onProgress, onGameDone, ms });
    this.cancelled = false;
    this.engine = null;
  }

  cancel() {
    this.cancelled = true;
    this.engine?.stop();
  }

  async review(games) {
    this.engine = new Engine({ onUpdate: () => {}, onStatus: () => {} });
    let reviewed = 0;
    let puzzles = 0;
    try {
      for (const [gi, g] of games.entries()) {
        if (this.cancelled) break;
        const { positions, moves } = gamePositions(g.start_fen, g.moves);
        const evals = positions.map((fen) => terminalEval(fen));
        const lookup = positions.map((_, i) => i).filter((i) => !evals[i]);
        if (lookup.length) {
          const saved = (await api.evalsLookup(lookup.map((i) => positions[i]), this.ms)).evals.map(normaliseEval);
          lookup.forEach((i, k) => (evals[i] = saved[k] ?? null));
        }
        const todo = positions.map((_, i) => i).filter((i) => !evals[i]);
        const pending = [];
        this.onProgress?.({ game: g, gameIndex: gi, games: games.length, done: 0, total: todo.length });
        for (const [k, i] of todo.entries()) {
          if (this.cancelled) break;
          const r = await this.engine.evaluate(positions[i], { multipv: 2, movetime: this.ms });
          if (!r || this.cancelled) break;
          evals[i] = { depth: r.depth, movetime_ms: this.ms, lines: r.lines.map((l) => ({ uci: l.pv[0], score: l.score, pv: l.pv.slice(0, 12) })) };
          pending.push({ fen: positions[i], movetime_ms: this.ms, depth: r.depth, engine: ENGINE_NAME, lines: evals[i].lines });
          if (pending.length >= SAVE_BATCH) await api.saveEvals(pending.splice(0)).catch(() => {});
          this.onProgress?.({ game: g, gameIndex: gi, games: games.length, done: k + 1, total: todo.length });
        }
        if (pending.length) await api.saveEvals(pending.splice(0)).catch(() => {});
        if (this.cancelled) break;
        const judged = judgeMoves(positions, moves, evals);
        if (!reviewComplete(judged, moves.length)) continue;
        const result = await api.saveGameReview(g.id, reviewPayload(g.moves, this.ms, judged, evals));
        reviewed += 1;
        puzzles += result.new;
        this.onGameDone?.({ game: g, ...result });
      }
    } finally {
      this.engine.terminate();
      this.engine = null;
    }
    return { reviewed, newPuzzles: puzzles, cancelled: this.cancelled };
  }
}
