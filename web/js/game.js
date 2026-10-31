// Game state for the analysis board: a start position plus a list of moves and a
// cursor (ply) into it. Pure logic, no DOM, so it can be unit tested in Node.
//
// Behaviour carried over from the PyQt WidgetBoard:
//   - stepping back and playing a different move replaces the moves after it
//   - stepping back and replaying the *same* move keeps the rest of the line

import { Chess, DEFAULT_POSITION, validateFen } from '../vendor/chess.js/chess.js';

export const START_FEN = DEFAULT_POSITION;

export class Game {
  constructor(fen = START_FEN) {
    this.load(fen);
  }

  /** Start from a FEN. Throws Error(message) if the FEN is invalid; state is unchanged then. */
  load(fen = START_FEN) {
    const clean = fen.trim().replace(/\s+/g, ' ');
    const check = validateFen(clean);
    if (!check.ok) throw new Error(check.error);
    this.startFen = clean;
    this.moves = []; // { san, uci, from, to, promotion, fen }
    this.ply = 0; // number of moves played from the start to reach the shown position
    this._chess = new Chess(clean);
  }

  // ---- current position -------------------------------------------------

  fen() {
    return this._chess.fen();
  }

  /** 'white' | 'black' — the side to move in the shown position. */
  turn() {
    return this._chess.turn() === 'w' ? 'white' : 'black';
  }

  inCheck() {
    return this._chess.isCheck();
  }

  isOver() {
    return this._chess.isGameOver();
  }

  /** [from, to] of the move that led to the shown position, or undefined at the start. */
  lastMove() {
    const m = this.moves[this.ply - 1];
    return m ? [m.from, m.to] : undefined;
  }

  /** Legal destinations in chessground's format: Map<fromSquare, toSquare[]>. */
  dests() {
    const dests = new Map();
    for (const m of this._chess.moves({ verbose: true })) {
      const list = dests.get(m.from) ?? [];
      if (!list.includes(m.to)) list.push(m.to);
      dests.set(m.from, list);
    }
    return dests;
  }

  /** True if moving from -> to is a legal pawn promotion (so a piece must be chosen). */
  isPromotion(from, to) {
    return this._chess.moves({ square: from, verbose: true }).some((m) => m.to === to && m.promotion);
  }

  /** Human-readable status of the shown position. */
  status() {
    const c = this._chess;
    const mover = this.turn() === 'white' ? 'White' : 'Black';
    if (c.isCheckmate()) return { over: true, text: `Checkmate: ${mover === 'White' ? 'Black' : 'White'} wins` };
    if (c.isStalemate()) return { over: true, text: 'Draw by stalemate' };
    if (c.isInsufficientMaterial()) return { over: true, text: 'Draw: insufficient material' };
    if (c.isThreefoldRepetition()) return { over: true, text: 'Draw by threefold repetition' };
    if (c.isDrawByFiftyMoves()) return { over: true, text: 'Draw by the fifty-move rule' };
    return { over: false, text: `${mover} to move${c.isCheck() ? ': check' : ''}` };
  }

  // ---- making moves -----------------------------------------------------

  /**
   * Play a move from the shown position. promotion: 'q' | 'r' | 'b' | 'n' (needed for promotions).
   * Returns the move record, or null if the move is illegal (state unchanged).
   */
  play(from, to, promotion) {
    if (this.isPromotion(from, to) && !promotion) return null;
    let move;
    try {
      move = this._chess.move({ from, to, promotion });
    } catch {
      return null;
    }
    const record = {
      san: move.san,
      uci: move.lan,
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      fen: this._chess.fen(),
    };
    const next = this.moves[this.ply];
    if (!(next && next.uci === record.uci)) {
      this.moves.length = this.ply; // branch: drop the old continuation
      this.moves.push(record);
    }
    this.ply += 1;
    return this.moves[this.ply - 1];
  }

  /** Play a move given in SAN (e.g. 'Nf3'). Returns the record or null if illegal. */
  playSan(san) {
    const legal = this._chess.moves({ verbose: true }).find((m) => m.san === san);
    return legal ? this.play(legal.from, legal.to, legal.promotion) : null;
  }

  /** Drop the moves after the shown position. */
  truncate() {
    this.moves.length = this.ply;
  }

  // ---- navigation -------------------------------------------------------

  goTo(ply) {
    const target = Math.max(0, Math.min(ply, this.moves.length));
    // Rebuild from the start so chess.js keeps the history it needs for repetition draws.
    const chess = new Chess(this.startFen);
    for (const m of this.moves.slice(0, target)) chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    this._chess = chess;
    this.ply = target;
  }

  back() {
    this.goTo(this.ply - 1);
  }

  forward() {
    this.goTo(this.ply + 1);
  }

  toStart() {
    this.goTo(0);
  }

  toEnd() {
    this.goTo(this.moves.length);
  }

  // ---- move list --------------------------------------------------------

  /**
   * Moves grouped into numbered rows for display:
   * [{ number, white: {ply, san} | null, black: {ply, san} | null }]
   * `ply` is the cursor value that shows the position after that move.
   */
  moveRows() {
    const [, side, , , , fullmove] = this.startFen.split(' ');
    let number = Number(fullmove) || 1;
    const rows = [];
    let row = null;
    let colour = side === 'b' ? 'black' : 'white';
    this.moves.forEach((m, i) => {
      if (!row) row = { number, white: null, black: null };
      row[colour] = { ply: i + 1, san: m.san };
      if (colour === 'black') {
        rows.push(row);
        row = null;
        number += 1;
      }
      colour = colour === 'white' ? 'black' : 'white';
    });
    if (row) rows.push(row);
    return rows;
  }
}
