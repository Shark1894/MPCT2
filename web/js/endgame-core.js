// Endgame drills without the DOM (unit tested): the drills, random starting positions for the
// mates, and reading the tablebase's answers (is the win still there, the best defence, how many
// moves perfect play needs).

import { Chess } from '../vendor/chess.js/chess.js';

export const DRILLS = [
  {
    id: 'kq',
    glyphs: '♔♕',
    name: 'Queen mate',
    pieces: 'K+Q v K',
    steps: ['Box it in: keep the queen a knight’s move from the king and shrink its box.', 'Bring your king up: the queen alone can’t mate.', 'Mate on the edge, and check every move for stalemate.'],
    goal: 'mate',
    tip: 'Use the queen to shrink the king’s box a knight’s move away, bring your king up, then mate on the edge. Watch for stalemate.',
  },
  {
    id: 'kr',
    glyphs: '♔♖',
    name: 'Rook mate',
    pieces: 'K+R v K',
    steps: ['Cut the king off along a rank or file with the rook.', 'Walk your king up so the kings face each other.', 'Check to push it back a rank; a waiting rook move keeps the opposition.'],
    goal: 'mate',
    tip: 'Cut the king off with the rook, walk your king up in opposition, check to push it back a rank; a waiting rook move keeps the opposition.',
  },
  {
    id: 'kbb',
    glyphs: '♔♗♗',
    name: 'Two bishops',
    pieces: 'K+B+B v K',
    steps: ['Put the bishops side by side: together they make a wall.', 'Bring the king up to take squares the bishops can’t.', 'Herd it to any corner: the mate comes there.'],
    goal: 'mate',
    tip: 'Side by side, the bishops make a wall the king can’t cross. Herd it to a corner with your king close; mate comes in the corner.',
  },
  {
    id: 'kbn',
    glyphs: '♔♗♘',
    name: 'Bishop and knight',
    pieces: 'K+B+N v K',
    steps: ['Edge first: all three pieces push the king to an edge (about 15 moves).', 'The W manoeuvre: herd it along the edge towards a corner of the bishop’s colour.', 'Mate in the right corner: watch the count, by move 35 you should be close.'],
    goal: 'mate',
    tip: 'Mate only works in a corner of the bishop’s colour. Drive the king to the edge, then along it with the W manoeuvre of the knight. 50 moves is tight.',
  },
  {
    id: 'kp',
    glyphs: '♔♙',
    name: 'King and pawn',
    pieces: 'K+P v K',
    steps: ['King in front of the pawn: aim for the key squares two ranks ahead of it.', 'Take the opposition when the kings face each other; a tempo move can win it.', 'Push only when the pawn’s path is safe. Done when it queens.'],
    goal: 'promote',
    tip: 'Positions with one or two winning moves. Think opposition and key squares: get your king in front of the pawn first. Done when the pawn queens safely.',
  },
];

export const drillById = (id) => DRILLS.find((d) => d.id === id);

const FILES = 'abcdefgh';
const sq = (f, r) => `${FILES[f]}${r + 1}`;
const fileOf = (s) => FILES.indexOf(s[0]);
const rankOf = (s) => Number(s[1]) - 1;
const dist = (a, b) => Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
const light = (s) => (fileOf(s) + rankOf(s)) % 2 === 1;

const PIECES = { kq: ['q'], kr: ['r'], kbb: ['b', 'b'], kbn: ['b', 'n'] };

/** A FEN from {square: 'K'|'k'|...} with `turn` ('w'/'b') to move. */
export function placementFen(pieces, turn) {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pieces[sq(f, r)];
      if (p) {
        if (empty) row += empty;
        row += p;
        empty = 0;
      } else empty += 1;
    }
    rows.push(row + (empty || ''));
  }
  return `${rows.join('/')} ${turn} - - 0 1`;
}

/**
 * A random starting position for a mating drill: you (white or black) to move, the lone king
 * in the middle (c3-f6), nothing of yours capturable at once, kings apart, the bishops on
 * opposite colours. rng() returns [0, 1).
 */
export function randomMatePosition(drill, rng = Math.random, color = null) {
  const extra = PIECES[drill];
  if (!extra) throw new Error(`Not a mating drill: ${drill}`);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const all = [];
  for (let f = 0; f < 8; f++) for (let r = 0; r < 8; r++) all.push(sq(f, r));
  const centre = all.filter((s) => fileOf(s) >= 2 && fileOf(s) <= 5 && rankOf(s) >= 2 && rankOf(s) <= 5);
  const side = color ?? (rng() < 0.5 ? 'white' : 'black');
  for (let attempt = 0; attempt < 500; attempt++) {
    const lone = pick(centre);
    const free = all.filter((s) => s !== lone);
    const king = pick(free.filter((s) => dist(s, lone) > 1));
    const placed = { [lone]: 'k', [king]: 'K' };
    let ok = true;
    let firstBishop = null;
    for (const p of extra) {
      const options = free.filter(
        (s) => !placed[s] && dist(s, lone) > 1 && (p !== 'b' || firstBishop === null || light(s) !== light(firstBishop)),
      );
      if (!options.length) {
        ok = false;
        break;
      }
      const s = pick(options);
      placed[s] = p.toUpperCase();
      if (p === 'b') firstBishop = s;
    }
    if (!ok) continue;
    // Built for White; for Black swap the colours (and mirror the ranks so it looks natural).
    const pieces = {};
    for (const [s, p] of Object.entries(placed)) {
      if (side === 'white') pieces[s] = p;
      else pieces[sq(fileOf(s), 7 - rankOf(s))] = p === p.toUpperCase() ? p.toLowerCase() : p.toUpperCase();
    }
    const fen = placementFen(pieces, side === 'white' ? 'w' : 'b');
    let c;
    try {
      c = new Chess(fen);
    } catch {
      continue;
    }
    if (c.inCheck() || c.isGameOver()) continue;
    // Nothing of yours may hang: after a pass, the lone king can't take anything.
    const passed = new Chess(fen.replace(/ [wb] /, side === 'white' ? ' b ' : ' w '));
    if (passed.inCheck() || passed.moves({ verbose: true }).some((m) => m.captured)) continue;
    return fen;
  }
  throw new Error('No position found');
}

/** Your moves to mate with perfect play, from the tablebase's depth to mate (plies, you to move). */
export function movesToMate(dtm) {
  if (dtm == null) return null;
  return Math.ceil(Math.abs(dtm) / 2);
}

/**
 * Your move, judged from the tablebase's answer for the position after it (the defender to
 * move): 'ok', 'mate', 'stalemate', 'material' (nothing left to win with), 'fifty' (no longer a
 * win within the 50-move rule) or 'thrown' (a draw now).
 */
export function judge(info) {
  if (info.checkmate) return 'mate';
  if (info.stalemate) return 'stalemate';
  if (info.insufficient_material) return 'material';
  if (info.category === 'loss') return 'ok';
  if (info.category === 'blessed-loss' || info.category === 'maybe-loss') return 'fifty';
  return 'thrown';
}

/** The defence: the tablebase lists moves best first for the side to move. */
export function bestDefence(info) {
  return info.moves?.[0]?.uci ?? null;
}

/** Your winning moves in a position (you to move), best first. */
export function winningMoves(info) {
  return (info.moves ?? []).filter((m) => m.category === 'loss');
}

/** The end of the game by the rules alone (no tablebase): a result or null. */
export function ruleEnd(chess) {
  if (chess.isCheckmate()) return 'mate';
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'material';
  if (chess.isThreefoldRepetition()) return 'repetition';
  if (Number(chess.fen().split(' ')[4]) >= 100) return 'fifty';
  return null;
}

export const RESULT_TEXT = {
  mate: 'Checkmate',
  promoted: 'Pawn queened, still winning',
  fifty: 'Not mated within 50 moves',
  stalemate: 'Stalemate',
  material: 'Not enough left to mate',
  repetition: 'Draw by repetition',
  thrown: 'The win slipped: a draw now',
  'gave-up': 'Given up',
};

export const isSuccess = (result) => result === 'mate' || result === 'promoted';
