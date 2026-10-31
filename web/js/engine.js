// Stockfish 19 Lite in a Web Worker, spoken to over UCI.
//
// The multi-threaded build needs a cross-origin isolated page (the server sends the
// COOP/COEP headers); otherwise the single-threaded build is used. Nothing runs on
// the server.

import { Chess } from '../vendor/chess.js/chess.js';

const ENGINE_URLS = {
  threaded: new URL('../vendor/stockfish/stockfish-19-lite.js', import.meta.url),
  single: new URL('../vendor/stockfish/stockfish-19-lite-single.js', import.meta.url),
};

// ---- pure helpers (unit tested) ---------------------------------------------

/**
 * Parse a UCI "info" line. Returns null for lines without a score and PV.
 * Scores are converted to White's point of view.
 */
export function parseInfo(line, whiteToMove) {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;
  const tokens = line.split(' ');
  const out = { depth: 0, multipv: 1, score: null, pv: [] };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth') out.depth = Number(tokens[++i]);
    else if (t === 'multipv') out.multipv = Number(tokens[++i]);
    else if (t === 'nodes') out.nodes = Number(tokens[++i]);
    else if (t === 'nps') out.nps = Number(tokens[++i]);
    else if (t === 'score') {
      const kind = tokens[++i];
      const value = Number(tokens[++i]);
      const sign = whiteToMove ? 1 : -1;
      out.score = kind === 'mate' ? { mate: value * sign } : { cp: value * sign };
      if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') out.bound = tokens[++i];
    } else if (t === 'pv') {
      out.pv = tokens.slice(i + 1);
      break;
    }
  }
  if (!out.score || out.pv.length === 0) return null;
  return out;
}

/** "+0.35", "-1.20", "#3" (White mates in 3), "#-2" (Black mates in 2). */
export function formatScore(score) {
  if (!score) return '';
  if (score.mate !== undefined) return score.mate === 0 ? '#' : `#${score.mate}`;
  const pawns = score.cp / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

/** Share of the eval bar that is White's, 0..100. */
export function whiteShare(score) {
  if (!score) return 50;
  if (score.mate !== undefined) return score.mate > 0 ? 100 : score.mate < 0 ? 0 : 50;
  const winChance = 2 / (1 + Math.exp(-0.00368208 * score.cp)) - 1; // Lichess's cp -> win% curve
  return Math.max(2, Math.min(98, 50 + 50 * winChance));
}

/**
 * UCI principal variation -> numbered SAN moves from a position:
 * [{ text: '12.Nf3', san: 'Nf3', index: 0 }, { text: 'Nc6', ... }]
 */
export function pvToSan(fen, pv, maxMoves = 12) {
  const chess = new Chess(fen);
  const out = [];
  let moveNumber = Number(fen.split(' ')[5]) || 1;
  for (const [index, uci] of pv.slice(0, maxMoves).entries()) {
    const white = chess.turn() === 'w';
    let move;
    try {
      move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      break;
    }
    const prefix = white ? `${moveNumber}.` : index === 0 ? `${moveNumber}...` : '';
    out.push({ text: `${prefix}${move.san}`, san: move.san, uci, index });
    if (!white) moveNumber += 1;
  }
  return out;
}

// ---- engine -------------------------------------------------------------------

export class Engine {
  /**
   * @param {(update: {fen, depth, lines: object[]}) => void} onUpdate  called as analysis deepens
   * @param {(status: string) => void} onStatus
   */
  constructor({ onUpdate, onStatus }) {
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.worker = null;
    this.ready = null; // Promise resolved once the engine has answered readyok
    this.threaded = false;
    this.threads = 1;
    this.multipv = 3;
    this.depth = 20;
    this.current = null; // { fen, whiteToMove, lines: Map<multipv, info>, depth }
    this.stopsPending = 0; // 'stop's sent whose bestmove hasn't come back yet
    this._waiters = [];
    this._best = null; // resolver for a pending bestMove() search
  }

  /** Load the engine (once). */
  start() {
    if (this.ready) return this.ready;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; // phones/tablets
    this.threaded = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
    const cores = navigator.hardwareConcurrency || 2;
    this.threads = this.threaded ? Math.max(1, Math.min(cores - 1, coarse ? 2 : 4)) : 1;
    const hash = coarse ? 16 : 64;

    this.onStatus('Loading engine…');
    this.worker = new Worker(this.threaded ? ENGINE_URLS.threaded : ENGINE_URLS.single);
    this.worker.onmessage = (e) => this._line(String(e.data));
    this.worker.onerror = (e) => this.onStatus(`Engine failed to load: ${e.message || 'error'}`);

    this.ready = (async () => {
      this._send('uci');
      await this._waitFor('uciok');
      if (this.threaded) this._send(`setoption name Threads value ${this.threads}`);
      this._send(`setoption name Hash value ${hash}`);
      this._send('isready');
      await this._waitFor('readyok');
      this.onStatus('');
    })();
    return this.ready;
  }

  /** Analyse a position (FEN), replacing any analysis in progress. */
  async analyse(fen, { multipv = this.multipv, depth = this.depth } = {}) {
    await this.start();
    this.multipv = multipv;
    this.depth = depth;
    this._stopSearch();
    this.current = { fen, whiteToMove: fen.split(' ')[1] === 'w', lines: new Map(), depth: 0, done: false };
    this._send(`setoption name MultiPV value ${multipv}`);
    this._send(`position fen ${fen}`);
    this._send(depth ? `go depth ${depth}` : 'go infinite');
  }

  /**
   * Choose a move to play. The position is sent as start FEN + moves so the engine
   * sees repetitions. Strength: `skill` (0-20, Stockfish's Skill Level) or `elo`
   * (UCI_LimitStrength, 1320-3190); neither = full strength.
   * Resolves to a UCI move, or null if cancelled.
   */
  async bestMove({ startFen, moves = [], skill = null, elo = null, movetime = 1000, depth = null }) {
    await this.start();
    this.cancelBestMove();
    this._stopSearch();
    this.current = null;
    const limit = elo !== null && skill === null;
    this._send(`setoption name MultiPV value 1`);
    this._send(`setoption name Skill Level value ${skill ?? 20}`);
    this._send(`setoption name UCI_LimitStrength value ${limit}`);
    if (limit) this._send(`setoption name UCI_Elo value ${elo}`);
    this._send(`position fen ${startFen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
    this._send(`go ${depth ? `depth ${depth} ` : ''}movetime ${movetime}`);
    return new Promise((resolve) => {
      this._best = resolve;
    });
  }

  /** Abandon a bestMove() search; its promise resolves to null. */
  cancelBestMove() {
    if (!this._best) return;
    const resolve = this._best;
    this._best = null;
    this.stopsPending += 1;
    this._send('stop');
    resolve(null);
  }

  /** Stop searching (keeps the engine loaded). */
  stop() {
    this._stopSearch();
    this.current = null;
  }

  terminate() {
    this.cancelBestMove();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.current = null;
  }

  _stopSearch() {
    if (this.current && !this.current.done) {
      this.stopsPending += 1;
      this._send('stop');
    }
  }

  _send(cmd) {
    this.worker?.postMessage(cmd);
  }

  _waitFor(token) {
    return new Promise((resolve) => this._waiters.push({ token, resolve }));
  }

  _line(line) {
    for (const w of [...this._waiters]) {
      if (line.startsWith(w.token)) {
        this._waiters.splice(this._waiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
    if (line.startsWith('bestmove')) {
      if (this.stopsPending > 0) {
        this.stopsPending -= 1; // end of a search we abandoned
        return;
      }
      if (this._best) {
        const resolve = this._best;
        this._best = null;
        const move = line.split(' ')[1];
        resolve(move && move !== '(none)' ? move : null);
        return;
      }
      if (this.current) {
        this.current.done = true;
        this._emit(true);
      }
      return;
    }
    if (this.stopsPending > 0 || !this.current) return; // output from an abandoned search
    const info = parseInfo(line, this.current.whiteToMove);
    if (!info || info.bound) return; // ignore partial (bound) scores
    this.current.lines.set(info.multipv, info);
    this.current.depth = Math.max(this.current.depth, info.depth);
    this._emit(false);
  }

  _emit(done) {
    const c = this.current;
    const lines = [...c.lines.values()]
      .filter((l) => l.multipv <= this.multipv)
      .sort((a, b) => a.multipv - b.multipv)
      .map((l) => ({ ...l, moves: pvToSan(c.fen, l.pv) }));
    this.onUpdate({ fen: c.fen, depth: c.depth, lines, done });
  }
}
