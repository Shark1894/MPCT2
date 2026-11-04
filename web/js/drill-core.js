// Position drill rules, free of the page: a run through a list of positions from the
// server (GET /api/drill), each answered once, with the trainer's hints, and optionally
// the rest of a line played from there. Practice only: results never change a schedule.

/** Hints like the trainer's: the piece after 2 wrong tries, the whole move after 3. */
export function hintAfter(wrongTries, uci) {
  if (wrongTries >= 3) return { type: 'move', from: uci.slice(0, 2), to: uci.slice(2, 4) };
  if (wrongTries >= 2) return { type: 'piece', from: uci.slice(0, 2) };
  return null;
}

const userPlaysPly = (ply, color) => (ply % 2 === 1) === (color === 'white');

/** "5...dxe4" / "12.Nf3" for the move at a ply. */
export function moveLabel(ply, san) {
  const n = Math.floor((ply - 1) / 2) + 1;
  return ply % 2 === 1 ? `${n}.${san}` : `${n}...${san}`;
}

export class DrillRun {
  /** @param {object[]} positions  as GET /api/drill returns them */
  constructor(positions) {
    this.positions = positions;
    this.index = 0;
    this.results = positions.map(() => null);
    this._startPosition();
  }

  get total() {
    return this.positions.length;
  }

  get current() {
    return this.positions[this.index] ?? null;
  }

  get done() {
    return this.index >= this.positions.length;
  }

  get color() {
    return this.current?.opening.color;
  }

  _startPosition() {
    this.phase = this.done ? 'done' : 'answer'; // answer → answered → (line → answered)
    this.wrong = [];
    this.revealed = false;
    this.played = null;
    this.lineAt = 0; // index into current.rest while playing the line on
    this.lineWrong = 0;
  }

  /** The repertoire moves accepted here (usually one). */
  expectedUcis() {
    return this.current.expected.map((e) => e.uci);
  }

  /** The user's answer for the position. */
  tryMove(uci) {
    if (this.phase !== 'answer') return { correct: false, ignored: true };
    if (this.expectedUcis().includes(uci)) {
      this.played = uci;
      this._finish(this.wrong.length === 0);
      return { correct: true, firstTry: this.wrong.length === 0 };
    }
    this.wrong.push(uci);
    return { correct: false, hint: hintAfter(this.wrong.length, this.current.expected[0].uci) };
  }

  /** Give up: the answer is shown and the position counts as missed. */
  reveal() {
    if (this.phase !== 'answer') return null;
    this.revealed = true;
    this.played = this.current.expected[0].uci;
    this._finish(false);
    return this.current.expected[0];
  }

  _finish(correct) {
    this.phase = 'answered';
    this.results[this.index] = { correct, wrong: this.wrong.slice(), revealed: this.revealed, played: this.played };
  }

  /** What to send to POST /api/drill/results for the current position. */
  resultPayload() {
    const p = this.current;
    const r = this.results[this.index];
    return { opening_id: p.opening.id, position_id: p.position_id, expected_uci: r.played, correct: r.correct, wrong: r.wrong.slice(0, 20) };
  }

  // ---- playing on through the rest of the line ------------------------------------

  /** The line can be played on if it continues past this move and the answer was its move. */
  canPlayLine() {
    const rest = this.current?.rest ?? [];
    return this.phase === 'answered' && this.lineAt === 0 && rest.length > 1 && rest[0].uci === this.played;
  }

  startLine() {
    if (!this.canPlayLine()) return false;
    this.phase = 'line';
    this.lineAt = 1;
    this.lineWrong = 0;
    return true;
  }

  lineMove() {
    return this.current.rest[this.lineAt] ?? null;
  }

  lineComplete() {
    return this.phase === 'line' && this.lineAt >= this.current.rest.length;
  }

  isUserTurnInLine() {
    const m = this.lineMove();
    return this.phase === 'line' && Boolean(m) && userPlaysPly(m.ply, this.color);
  }

  /** The opponent's reply in the line (advances). */
  opponentMove() {
    const m = this.lineMove();
    this.lineAt += 1;
    this.lineWrong = 0;
    return m;
  }

  /** The user's move while playing the line on (not recorded). */
  tryLineMove(uci) {
    const m = this.lineMove();
    if (!this.isUserTurnInLine()) return { correct: false, ignored: true };
    if (uci === m.uci) {
      this.lineAt += 1;
      this.lineWrong = 0;
      return { correct: true };
    }
    this.lineWrong += 1;
    return { correct: false, hint: hintAfter(this.lineWrong, m.uci) };
  }

  endLine() {
    this.phase = 'answered';
  }

  // ---- moving through the run -------------------------------------------------------

  next() {
    this.index += 1;
    this._startPosition();
  }

  summary() {
    const answered = this.results.filter(Boolean);
    const missed = this.positions.map((p, i) => ({ position: p, result: this.results[i] })).filter((x) => x.result && !x.result.correct);
    return { answered: answered.length, correct: answered.filter((r) => r.correct).length, missed };
  }
}
