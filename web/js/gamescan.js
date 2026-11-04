// Finding puzzles in your own games: the browser's Stockfish looks at every position of each
// game (reusing analysis already saved, e.g. by the engine review), the review's judgement
// says how much each of your moves lost, and your mistakes with one clearly best move are
// sent to the server, which keeps them as puzzles. findMistakes is pure (unit tested).

import { api } from './api.js';
import { Chess } from '../vendor/chess.js/chess.js';
import { Engine } from './engine.js';
import { ONLY_MOVE_GAP, THRESHOLDS, judgeMoves, normaliseEval, terminalEval, winChance } from './review-core.js';

export const SCAN_MS = 1000; // thinking time per position (the review's Standard)
const ENGINE_NAME = 'Stockfish 19 Lite';
const SAVE_BATCH = 10;

/**
 * Your mistakes worth a puzzle, from judgeMoves output: your moves (color 'white'|'black')
 * that lost at least a mistake's worth of winning chances, where the engine's best move was
 * clearly better than its second choice (so the puzzle has one answer). Not move 1 (a puzzle
 * starts from the opponent's previous move).
 * @returns {{ply, best_uci, best_pv, before, after}[]}
 */
export function findMistakes(judged, evals, color) {
  const side = color === 'white' ? 'w' : 'b';
  const mine = (w) => (side === 'w' ? w : 100 - w);
  const out = [];
  for (const j of judged) {
    if (!j || j.side !== side || j.ply < 2 || !j.best || j.loss < THRESHOLDS.mistake) continue;
    const lines = evals[j.ply - 1]?.lines ?? [];
    if (lines.length < 2) continue; // a forced move isn't a puzzle
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

/** Indexes of the positions to analyse: before and after each of your moves. */
export function positionsNeeded(positions, color) {
  const side = color === 'white' ? 'w' : 'b';
  const need = new Set();
  positions.forEach((fen, i) => {
    if (i < positions.length - 1 && fen.split(' ')[1] === side) {
      need.add(i);
      need.add(i + 1);
    }
  });
  return [...need].sort((a, b) => a - b);
}

/**
 * Scans games one after another. Callbacks: onProgress({ game, gameIndex, games, done, total }),
 * onGameDone(result). cancel() stops after the current position.
 */
export class GameScanner {
  constructor({ onProgress, onGameDone, ms = SCAN_MS }) {
    Object.assign(this, { onProgress, onGameDone, ms });
    this.cancelled = false;
    this.engine = null;
  }

  cancel() {
    this.cancelled = true;
    this.engine?.stop();
  }

  async scan(games) {
    this.engine = new Engine({ onUpdate: () => {}, onStatus: () => {} });
    let found = 0;
    try {
      for (const [gi, g] of games.entries()) {
        if (this.cancelled) break;
        const { positions, moves } = gamePositions(g.start_fen, g.moves);
        const need = positionsNeeded(positions, g.color);
        const evals = positions.map((fen) => terminalEval(fen));
        const lookup = need.filter((i) => !evals[i]);
        if (lookup.length) {
          const saved = (await api.evalsLookup(lookup.map((i) => positions[i]), this.ms)).evals.map(normaliseEval);
          lookup.forEach((i, k) => (evals[i] = saved[k] ?? null));
        }
        const todo = need.filter((i) => !evals[i]);
        const pending = [];
        for (const [k, i] of todo.entries()) {
          if (this.cancelled) break;
          this.onProgress?.({ game: g, gameIndex: gi, games: games.length, done: k, total: todo.length });
          const r = await this.engine.evaluate(positions[i], { multipv: 2, movetime: this.ms });
          if (!r || this.cancelled) break;
          evals[i] = { depth: r.depth, movetime_ms: this.ms, lines: r.lines.map((l) => ({ uci: l.pv[0], score: l.score, pv: l.pv.slice(0, 12) })) };
          pending.push({ fen: positions[i], movetime_ms: this.ms, depth: r.depth, engine: ENGINE_NAME, lines: evals[i].lines });
          if (pending.length >= SAVE_BATCH) await api.saveEvals(pending.splice(0)).catch(() => {});
        }
        if (pending.length) await api.saveEvals(pending.splice(0)).catch(() => {});
        if (this.cancelled) break;
        const candidates = findMistakes(judgeMoves(positions, moves, evals), evals, g.color);
        const result = await api.saveGameScan(g.id, g.moves_hash, this.ms, candidates);
        found += result.found;
        this.onGameDone?.({ game: g, ...result });
      }
    } finally {
      this.engine.terminate();
      this.engine = null;
    }
    return { found, cancelled: this.cancelled };
  }
}
