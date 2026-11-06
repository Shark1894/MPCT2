// The rules of one course exercise (Training tab), with no board or DOM, so it can be tested.
//
// From the start position the moves in `ucis` are played in turn. You play `color`'s moves; the
// other side's are played for you. A wrong move: try again; a second wrong move at the same point
// shows the right one (the exercise counts as missed either way). The author's notes are by ply
// (0 = the start position, n = after move n) and are shown once that move has been played.
// kind 'line' is tested; 'reference' and 'info' are read: every move is stepped through.

export const MAX_TRIES = 2;

/** The side to move in a FEN: 'white' or 'black'. */
export const sideToMove = (fen) => (fen.split(' ')[1] === 'b' ? 'black' : 'white');

export class ExerciseRun {
  /** @param {{start_fen: string, color: string, ucis: string[], sans?: string[], comments?: object, kind?: string}} ex */
  constructor(ex) {
    this.ex = ex;
    this.ucis = ex.ucis ?? [];
    this.sans = ex.sans ?? [];
    this.color = ex.color;
    this.tested = (ex.kind ?? 'line') === 'line' && this.ucis.length > 0;
    this.first = sideToMove(ex.start_fen);
    this.index = 0; // moves played so far
    this.tries = 0; // wrong moves at the current move
    this.failed = false; // any wrong move or shown move
    this.done = this.ucis.length === 0 && !this.tested;
    this.comments = Object.fromEntries(Object.entries(ex.comments ?? {}).map(([k, v]) => [Number(k), v]));
  }

  /** Who plays move number `index` (0-based). */
  moverAt(index) {
    return index % 2 === 0 ? this.first : this.first === 'white' ? 'black' : 'white';
  }

  get finished() {
    return this.index >= this.ucis.length;
  }

  /** Your turn: a tested exercise, not finished, and the next move is your side's. */
  get yourTurn() {
    return this.tested && !this.finished && this.moverAt(this.index) === this.color;
  }

  expected() {
    return this.ucis[this.index] ?? null;
  }

  /** The note for the position after `ply` moves (0 = start), or ''. */
  note(ply) {
    return this.comments[ply] ?? '';
  }

  /** Label for move `ply` (1-based) in the usual notation, e.g. '12.Nf3' or '12...Nf6'. */
  moveLabel(ply, fullMove = Number(this.ex.start_fen.split(' ')[5]) || 1) {
    const i = ply - 1;
    const offset = this.first === 'black' ? 1 : 0; // a start with Black to move shifts the count
    const n = fullMove + Math.floor((i + offset) / 2);
    const white = this.moverAt(i) === 'white';
    return `${n}${white ? '.' : '...'}${this.sans[i] ?? this.ucis[i]}`;
  }

  /**
   * The moves to play for you now (the opponent's, or every move when reading), one at a time:
   * returns the next one and advances, or null when it's your turn or the end.
   */
  nextAuto() {
    if (this.finished) return null;
    if (this.tested && this.moverAt(this.index) === this.color) return null;
    return this._advance();
  }

  _advance() {
    const uci = this.ucis[this.index];
    this.index += 1;
    this.tries = 0;
    if (this.finished) this.done = true;
    return uci;
  }

  /**
   * Your move. `mates`: it gives checkmate (accepted when the expected move is the last one and
   * mates too: `expectedMates`). Returns {correct, uci?} or {correct: false, show: uci} on the
   * second miss (play `show` for the user).
   */
  tryMove(uci, { mates = false, expectedMates = false } = {}) {
    if (!this.yourTurn) return { correct: false };
    const want = this.expected();
    const sameMove = uci === want || (want?.length === 5 && uci.slice(0, 4) === want.slice(0, 4) && !uci[4]);
    const lastAndMate = mates && expectedMates && this.index === this.ucis.length - 1;
    if (sameMove || lastAndMate) {
      this._advance();
      return { correct: true, uci: sameMove ? want : uci };
    }
    this.failed = true;
    this.tries += 1;
    if (this.tries >= MAX_TRIES) return { correct: false, show: this.showMove() };
    return { correct: false };
  }

  /** Give up on this move: it's played for you (counts as missed). Returns its UCI. */
  showMove() {
    if (this.finished) return null;
    this.failed = true;
    return this._advance();
  }

  /** The result once done: solved unless a move was missed or shown (reading always counts as done). */
  get solved() {
    return this.done && (!this.tested || !this.failed);
  }
}
