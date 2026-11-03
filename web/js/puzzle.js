// One puzzle being solved: pure logic, no DOM (unit tested). The page plays the moves on
// the board; this class says what's expected, judges the user's moves and reports the result.
//
// Lichess puzzle format: `fen` is the position before the opponent's move, moves[0] is that
// move (the page plays it to set up the puzzle), and the solution starts at moves[1], user
// and opponent alternating. As on Lichess, the first wrong move fails the puzzle (it's
// recorded straight away), but you can keep trying to finish it or show the solution, and a
// move that gives checkmate is always accepted.

export class PuzzleRun {
  /** @param {{ id: string, fen: string, moves: string[], rating: number }} puzzle */
  constructor(puzzle, { now = () => Date.now() } = {}) {
    this.puzzle = puzzle;
    this.moves = puzzle.moves;
    this.now = now;
    this.index = 0; // next move to play in `moves`
    this.failed = false; // a wrong move was played (rating already lost)
    this.solved = false;
    this.revealed = false; // the solution was shown
    this.startedAt = null;
    this.reported = false; // the result has been sent to the server
    // The user plays the side to move AFTER the opponent's first move.
    this.color = puzzle.fen.split(' ')[1] === 'w' ? 'black' : 'white';
  }

  /** The opponent's set-up move (played by the page before the user starts). */
  setupMove() {
    if (this.index !== 0) throw new Error('Already set up');
    this.index = 1;
    this.startedAt = this.now();
    return this.moves[0];
  }

  get done() {
    return this.solved || this.revealed || this.index >= this.moves.length;
  }

  expected() {
    return this.done ? null : this.moves[this.index];
  }

  /** Seconds since the puzzle was set up. */
  seconds() {
    return this.startedAt === null ? null : Math.round((this.now() - this.startedAt) / 1000);
  }

  /**
   * The user tried `uci`. `mates`: whether that move gives checkmate (the page checks).
   * @returns {{ correct: boolean, reply?: string, finished: boolean, firstMistake?: boolean }}
   *   reply: the opponent's answer to play next; firstMistake: report the failure now.
   */
  tryMove(uci, mates = false) {
    if (this.done || this.index === 0) throw new Error('No move expected');
    if (uci !== this.moves[this.index] && !mates) {
      const firstMistake = !this.failed;
      this.failed = true;
      return { correct: false, finished: false, firstMistake };
    }
    this.index += 1;
    if (mates || this.index >= this.moves.length) {
      this.index = this.moves.length;
      this.solved = !this.failed;
      return { correct: true, finished: true };
    }
    const reply = this.moves[this.index];
    this.index += 1;
    return { correct: true, reply, finished: this.index >= this.moves.length };
  }

  /** The rest of the solution from the current move (the page plays it), and the puzzle counts as failed. */
  reveal() {
    const rest = this.moves.slice(this.index);
    const firstMistake = !this.failed;
    this.failed = true;
    this.revealed = true;
    this.index = this.moves.length;
    return { rest, firstMistake };
  }

  /** The hint after a wrong move: the square of the piece to move. */
  hintSquare() {
    const m = this.expected();
    return m ? m.slice(0, 2) : null;
  }

  /** What to tell the server, once: solved cleanly, or failed. Null if already reported or not finished. */
  result() {
    if (this.reported) return null;
    if (this.failed) {
      this.reported = true;
      return { solved: false, seconds: this.seconds() };
    }
    if (this.solved) {
      this.reported = true;
      return { solved: true, seconds: this.seconds() };
    }
    return null;
  }
}

// ---- rating history chart ------------------------------------------------------------------

/**
 * SVG path data for a rating history line: points [{date, rating}] spread across `width`
 * by date, ratings scaled into `height` (with `pad` at top and bottom). Returns
 * { path, min, max, points: [{x, y, date, rating}] }.
 */
export function historyPath(history, width, height, pad = 6) {
  if (!history.length) return { path: '', min: null, max: null, points: [] };
  const ratings = history.map((p) => p.rating);
  let min = Math.min(...ratings);
  let max = Math.max(...ratings);
  if (max - min < 50) {
    const mid = (max + min) / 2;
    min = mid - 25;
    max = mid + 25;
  }
  const t = history.map((p) => Date.parse(p.date));
  const t0 = t[0];
  const span = Math.max(t[t.length - 1] - t0, 1);
  const points = history.map((p, i) => ({
    x: history.length === 1 ? width / 2 : ((t[i] - t0) / span) * width,
    y: pad + (1 - (p.rating - min) / (max - min)) * (height - 2 * pad),
    date: p.date,
    rating: p.rating,
  }));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return { path, min: Math.round(min), max: Math.round(max), points };
}
