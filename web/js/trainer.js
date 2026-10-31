// Training session: walks through lines move by move. Pure logic, no DOM, so it can
// be unit tested in Node. The page plays the opponent's moves and the user's correct
// moves on the board; this class decides what's expected, counts mistakes, gives
// hints and builds the review sent to the server when a line is finished.
//
//   1 wrong move on a ply  -> just try again
//   2 wrong                -> hint: highlight the piece to move
//   3 or more wrong        -> hint: show the whole move
//
// Any mistake makes the line count as failed. Retrying a failed line is a real
// review: get it right and it counts as correct. Retrying a line you got right
// is practice: recorded, but it doesn't change the schedule.

export const HINT_PIECE_AFTER = 2;
export const HINT_MOVE_AFTER = 3;
// Comments stay visible while a line is still being learned (as in the desktop app).
export const SHOW_COMMENTS_BELOW_STREAK = 2;

export class TrainingSession {
  /**
   * @param {{ opening: {id, name, color}, lines: {id, streak, next_review_on, moves: {ply, uci, san}[]}[] }} data
   */
  constructor(data) {
    this.opening = data.opening;
    this.color = data.opening.color;
    this.lines = data.lines;
    this.index = 0; // which line
    this.results = []; // { lineId, correct, mistakes, retried } latest real (non-practice) result per line
    this.failedLines = new Set(); // lines with a mistake this session: keep their comments visible
    this.startLine(false);
  }

  get total() {
    return this.lines.length;
  }

  get line() {
    return this.lines[this.index] ?? null;
  }

  get finished() {
    return this.index >= this.lines.length;
  }

  startLine(practice, retry = false) {
    this.practice = practice;
    this.retry = retry; // a real review of a line failed just before
    this.ply = 0; // moves played so far in this line
    this.attempts = []; // { ply, uci } for every user move tried
    this.wrongHere = 0; // wrong tries on the current move
    this.mistakes = 0;
  }

  /** The move the line expects next, or null when the line is complete. */
  expected() {
    return this.line?.moves[this.ply] ?? null;
  }

  lineComplete() {
    return !this.finished && this.ply >= this.line.moves.length;
  }

  isUserTurn() {
    const m = this.expected();
    return Boolean(m) && (m.ply % 2 === 1) === (this.color === 'white');
  }

  /**
   * Whether comments are shown for the current line, and why:
   *   'learning' (streak below SHOW_COMMENTS_BELOW_STREAK), 'mistake' (a mistake on this line
   *   this session), or 'known' (hidden: the line has been played correctly often enough).
   */
  commentState() {
    if (this.mistakes > 0 || this.failedLines.has(this.line?.id)) return { show: true, reason: 'mistake' };
    const streak = this.line?.streak ?? 0;
    if (streak < SHOW_COMMENTS_BELOW_STREAK) return { show: true, reason: 'learning', streak };
    return { show: false, reason: 'known', streak };
  }

  showComments() {
    return this.commentState().show;
  }

  /** Advance past the opponent's move; returns it so the page can play it. */
  opponentMove() {
    if (this.isUserTurn()) throw new Error('It is the user’s turn');
    const m = this.expected();
    this.ply += 1;
    this.wrongHere = 0;
    return m;
  }

  /**
   * The user tried a move (UCI, including promotion letter).
   * @returns {{ correct: boolean, move?: object, hint: null | {type: 'piece', from} | {type: 'move', from, to} }}
   */
  tryMove(uci) {
    const m = this.expected();
    if (!m || !this.isUserTurn()) throw new Error('Not the user’s turn');
    this.attempts.push({ ply: m.ply, uci });
    if (uci === m.uci) {
      this.ply += 1;
      this.wrongHere = 0;
      return { correct: true, move: m, hint: null };
    }
    this.wrongHere += 1;
    this.mistakes += 1;
    this.failedLines.add(this.line.id);
    return { correct: false, hint: this.hint() };
  }

  /** The hint earned so far on the current move. */
  hint() {
    const m = this.expected();
    if (!m || !this.isUserTurn()) return null;
    const from = m.uci.slice(0, 2);
    if (this.wrongHere >= HINT_MOVE_AFTER) return { type: 'move', from, to: m.uci.slice(2, 4) };
    if (this.wrongHere >= HINT_PIECE_AFTER) return { type: 'piece', from };
    return null;
  }

  /** What to POST to /api/lines/{id}/reviews once the line is complete. */
  review() {
    return { lineId: this.line.id, practice: this.practice, attempts: this.attempts };
  }

  /** Record the outcome of the line just finished. A retry replaces the failed result. */
  recordResult() {
    this.lastCorrect = this.mistakes === 0;
    if (this.practice) return;
    const result = { lineId: this.line.id, correct: this.lastCorrect, mistakes: this.mistakes, retried: this.retry };
    const i = this.results.findIndex((r) => r.lineId === result.lineId);
    if (i >= 0) this.results[i] = result;
    else this.results.push(result);
  }

  /** Play the line again: a real review after a failure, practice after a clean run. */
  retryLine() {
    const failed = this.lastCorrect === false;
    this.startLine(!failed, failed);
  }

  nextLine() {
    this.lastCorrect = undefined;
    this.index += 1;
    this.startLine(false);
  }

  summary() {
    const correct = this.results.filter((r) => r.correct).length;
    const fixed = this.results.filter((r) => r.correct && r.retried).length;
    return { reviewed: this.results.length, correct, fixed, failed: this.results.length - correct, total: this.total };
  }
}
