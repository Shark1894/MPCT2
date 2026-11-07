// Endgame drills without the DOM (unit tested): the drills, random starting positions for the
// mates, and reading the tablebase's answers (is the win still there, the best defence, how many
// moves perfect play needs).

import { Chess } from '../vendor/chess.js/chess.js';

// group: where the drill sits on the hub. goal: mate | promote | capture (win their last piece or
// pawn, or mate) | draw (a defend drill: hold for `hold` of your moves). server: positions come
// from the server (template variations checked in the tablebase); the mates are made here.
// guide: how to play it; key: the classic position to show, with its caption.
export const GROUPS = [
  ['mates', 'Basic mates'],
  ['pawns', 'Pawn endings'],
  ['rooks', 'Rook endings'],
  ['pieces', 'Queen and minor pieces'],
];

export const DRILLS = [
  {
    id: 'kq',
    group: 'mates',
    glyphs: '♔♕',
    vs: '♚',
    name: 'Queen mate',
    pieces: 'K+Q v K',
    steps: ['Box it in: keep the queen a knight’s move from the king and shrink its box.', 'Bring your king up: the queen alone can’t mate.', 'Mate on the edge, and check every move for stalemate.'],
    goal: 'mate',
    tip: 'Use the queen to shrink the king’s box a knight’s move away, bring your king up, then mate on the edge. Watch for stalemate.',
  },
  {
    id: 'kr',
    group: 'mates',
    glyphs: '♔♖',
    vs: '♚',
    name: 'Rook mate',
    pieces: 'K+R v K',
    steps: ['Cut the king off along a rank or file with the rook.', 'Walk your king up so the kings face each other.', 'Check to push it back a rank; a waiting rook move keeps the opposition.'],
    goal: 'mate',
    tip: 'Cut the king off with the rook, walk your king up in opposition, check to push it back a rank; a waiting rook move keeps the opposition.',
  },
  {
    id: 'kbb',
    group: 'mates',
    glyphs: '♔♗♗',
    vs: '♚',
    name: 'Two bishops',
    pieces: 'K+B+B v K',
    steps: ['Put the bishops side by side: together they make a wall.', 'Bring the king up to take squares the bishops can’t.', 'Herd it to any corner: the mate comes there.'],
    goal: 'mate',
    tip: 'Side by side, the bishops make a wall the king can’t cross. Herd it to a corner with your king close; mate comes in the corner.',
  },
  {
    id: 'kbn',
    group: 'mates',
    glyphs: '♔♗♘',
    vs: '♚',
    name: 'Bishop and knight',
    pieces: 'K+B+N v K',
    steps: ['Edge first: all three pieces push the king to an edge (about 15 moves).', 'The W manoeuvre: herd it along the edge towards a corner of the bishop’s colour.', 'Mate in the right corner: watch the count, by move 35 you should be close.'],
    goal: 'mate',
    tip: 'Mate only works in a corner of the bishop’s colour. Drive the king to the edge, then along it with the W manoeuvre of the knight. 50 moves is tight.',
  },
  {
    id: 'kp',
    group: 'pawns',
    glyphs: '♔♙',
    vs: '♚',
    name: 'King and pawn',
    pieces: 'K+P v K',
    server: true,
    steps: ['King in front of the pawn: aim for the key squares two ranks ahead of it.', 'Take the opposition when the kings face each other; a tempo move can win it.', 'Push only when the pawn’s path is safe. Done when it queens.'],
    goal: 'promote',
    tip: 'Positions with one or two winning moves. Think opposition and key squares: get your king in front of the pawn first. Done when the pawn queens safely.',
  },
  {
    id: 'reti',
    group: 'pawns',
    glyphs: '♔♙',
    vs: '♚♟',
    name: 'Réti manoeuvre',
    pieces: 'K+P v K+P',
    server: true,
    hold: 12,
    goal: 'draw',
    steps: [
      'Two goals at once: walk your king diagonally, so each step both chases their pawn and comes nearer your own.',
      'Count, don’t race: on a diagonal a king covers the same distance as along a rank, with two jobs in one.',
      'If they take your pawn, you catch theirs; if they run, your pawn queens too. A draw either way.',
    ],
    guide: [
      'Your king looks hopelessly far from their passed pawn, and their king is about to eat yours. Counting squares in a straight line says you lose.',
      'The trick is the diagonal. A king moving diagonally reaches the pawn’s square in the same number of moves as moving along the rank, but each step also brings it nearer the corner where your own pawn needs support. Their king can’t stop both threats in time.',
      'Positions here are Richard Réti’s 1921 study and its mirror images. Pass by drawing: hold for 12 moves or reach a dead draw.',
    ],
    key: { fen: '7K/8/k1P5/7p/8/8/8/8 w - - 0 1', caption: 'Réti, 1921: White to play and draw (1.Kg7!)' },
    tip: 'Walk the king along the diagonal: it chases their pawn and supports yours at the same time.',
  },
  {
    id: 'wrongb',
    group: 'pawns',
    glyphs: '♔',
    vs: '♚♝♟',
    name: 'Wrong rook pawn',
    pieces: 'K v K+B+P',
    server: true,
    hold: 12,
    goal: 'draw',
    steps: [
      'Run for the corner in front of the pawn: that’s the only square that matters.',
      'Once there, shuffle between the corner and the square beside it.',
      'Their bishop can’t drive you out: it doesn’t control the corner’s colour. Watch out only for being shut out on the way.',
    ],
    guide: [
      'A rook pawn and a bishop that doesn’t control the queening square can’t win if the defending king reaches the corner. The bishop can never check the king out of a square of the other colour, and the pawn alone can’t push it out without stalemate.',
      'So everything is a race to that corner. Head straight for it, ignore the pawn, and once you’re there move between the corner and the next square. Stalemate is your friend.',
      'Pass by holding for 12 moves (or a draw by the rules). Lose by letting their king or bishop shut you out of the corner.',
    ],
    key: { fen: '8/6k1/8/3K3P/8/3B4/8/8 b - - 0 1', caption: 'h-pawn, light bishop, h8 dark: Black runs to h8 and draws' },
    tip: 'Get to the corner in front of the pawn and stay there: the wrong bishop can’t drive you out.',
  },
  {
    id: 'lucena',
    group: 'rooks',
    glyphs: '♔♖♙',
    vs: '♚♜',
    name: 'Lucena position',
    pieces: 'K+R+P v K+R',
    server: true,
    goal: 'promote',
    steps: [
      'Bring your rook to the fourth rank (counting from your side): this is the bridge.',
      'Step your king out from in front of the pawn and walk it towards their rook’s checks.',
      'When the checks come close, block with the rook on the fourth rank. The pawn queens.',
    ],
    guide: [
      'Your pawn is on the 7th, your king is on its queening square and their king is cut off from the pawn by your rook. The trouble is getting your king out: their rook checks it from the side or behind.',
      'Building a bridge (Lucena, 1497): first put your rook on the fourth rank. Then come out with the king, towards the side their rook is checking from. When they keep checking, your king steps forward until the rook can interpose on the fourth rank, and the checks stop.',
      'Pass when the pawn queens with the win still there. Variations: any file from b to g, either side cut off, either colour.',
    ],
    key: { fen: '3K4/3P1k2/8/8/8/8/2r5/4R3 w - - 0 1', caption: 'White to play: 1.Re4! builds the bridge' },
    tip: 'Rook to the fourth rank first, then king out towards their rook; block the last check with the rook.',
  },
  {
    id: 'philidor',
    group: 'rooks',
    glyphs: '♔♖',
    vs: '♚♜♟',
    name: 'Philidor position',
    pieces: 'K+R v K+R+P',
    server: true,
    hold: 15,
    goal: 'draw',
    steps: [
      'Keep your king on the queening square (or right beside it).',
      'Keep your rook on your third rank, so their king can’t reach your third rank in front of you.',
      'The moment their pawn steps onto your third rank, drop the rook to the back and check from behind: their king has no shelter.',
    ],
    guide: [
      'The most important drawing technique in rook endings (Philidor, 1777). You’re a pawn down with your king in front of the pawn.',
      'Hold the third rank with the rook: as long as it stays there, their king can’t advance in front of the pawn. If they push the pawn to your third rank to get past, it takes away the king’s cover: your rook goes to the back rank and checks from behind for ever.',
      'Pass by holding for 15 moves or reaching a draw by the rules. Stockfish attacks and the tablebase checks every move of yours.',
    ],
    key: { fen: '4k3/R7/7r/3KP3/8/8/8/8 b - - 0 1', caption: 'Black holds: rook on the sixth (his third) rank until the pawn moves' },
    tip: 'Rook on your third rank until the pawn advances, then checks from behind.',
  },
  {
    id: 'vancura',
    group: 'rooks',
    glyphs: '♔♖',
    vs: '♚♜♟',
    name: 'Vančura position',
    pieces: 'K+R v K+R+P',
    server: true,
    hold: 15,
    goal: 'draw',
    steps: [
      'Attack the rook pawn from the side, along your third rank.',
      'Keep your king near the other corner; their rook is stuck guarding the pawn.',
      'If their king comes to help, check it from behind and go straight back to the side attack.',
    ],
    guide: [
      'A lesser-known save for a rook pawn on the 6th with the attacking rook in front of it (Vančura, 1924). The usual defence, rook behind the pawn, loses here.',
      'Put your rook on the side of the pawn, on the same rank, attacking it. Their rook is tied to defending the pawn, and if their king walks over to support it, your rook checks from behind and returns to the side.',
      'Pass by holding for 15 moves or a draw by the rules.',
    ],
    key: { fen: 'R7/6k1/P4r2/8/8/8/8/4K3 b - - 0 1', caption: 'Black’s rook hits the a-pawn from the side: a draw' },
    tip: 'Attack the rook pawn from the side on the same rank; checks from behind if their king comes over.',
  },
  {
    id: 'qvp',
    group: 'pieces',
    glyphs: '♔♕',
    vs: '♚♟',
    name: 'Queen v pawn on the 7th',
    pieces: 'K+Q v K+P',
    server: true,
    goal: 'capture',
    steps: [
      'Check and pin to bring the queen close to the pawn.',
      'Force their king in front of its pawn: then it blocks the pawn for a move.',
      'Use that move to bring your king one step closer. Repeat, then win the pawn.',
    ],
    guide: [
      'A pawn one step from queening with its king beside it. Against a centre or knight pawn the queen wins; rook and bishop pawns often draw because of stalemate tricks, so they’re left out here.',
      'Approach with checks and pins until the queen guards the queening square. Each time their king has to go in front of its pawn, the pawn is blocked and you have one free move: bring your king a step nearer. When it arrives, the pawn falls.',
      'Pass by winning the pawn (or mating) with the win kept.',
    ],
    key: { fen: 'K7/6Q1/8/8/8/8/3pk3/8 w - - 0 1', caption: 'White checks until Black’s king blocks the pawn, then brings the king' },
    tip: 'Checks until their king stands in front of the pawn, then a king step; repeat.',
  },
  {
    id: 'qvr',
    group: 'pieces',
    glyphs: '♔♕',
    vs: '♚♜',
    name: 'Queen v rook',
    pieces: 'K+Q v K+R',
    server: true,
    goal: 'capture',
    steps: [
      'Push their king to the edge with your king and queen together.',
      'Aim for the position where they must move (zugzwang): the rook has to leave its king.',
      'Then fork the king and rook, or mate. Watch for rook checks that would win your queen or give stalemate.',
    ],
    guide: [
      'The queen wins, but it takes technique and the 50-move rule is close. The rook stays beside its king, where it’s hardest to win.',
      'Use your king and queen together to drive their king to an edge. Then reach a position where they have to move and any rook move separates it from the king. From there the rook is lost to a fork, or they’re mated.',
      'Pass by winning the rook (or mating) with the win kept.',
    ],
    key: { fen: 'k7/1r6/2K5/8/8/8/8/7Q w - - 0 1', caption: 'The hardest defence: the rook right beside its king' },
    tip: 'Edge first, then aim for zugzwang so the rook must leave its king; fork it.',
  },
  {
    id: 'rvb',
    group: 'pieces',
    glyphs: '♔♗',
    vs: '♚♜',
    name: 'Rook v bishop',
    pieces: 'K+B v K+R',
    server: true,
    hold: 20,
    goal: 'draw',
    steps: [
      'Head for the right corner: the one NOT of your bishop’s colour.',
      'In that corner the bishop can always block on the square next to your king.',
      'Avoid the wrong corner and pins on the bishop; keep the bishop away from their king.',
    ],
    guide: [
      'A rook usually can’t beat a bishop, if the defender knows where to go. In the corner of the colour your bishop doesn’t move on, rook checks can always be blocked by the bishop, and stalemate tricks help too.',
      'In the wrong corner (your bishop’s colour) you get mated. In the middle you can lose the bishop to a skewer or a pin. So go straight to the right corner, keep the bishop close to your king, and don’t let it be pinned.',
      'Pass by holding for 20 moves or a draw by the rules.',
    ],
    key: { fen: '6bk/8/5K2/8/8/8/8/5R2 b - - 0 1', caption: 'h8 is dark and the bishop is light: the right corner' },
    tip: 'Go to the corner not of your bishop’s colour and keep the bishop next to your king.',
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
  captured: 'Material won, still winning',
  held: 'Draw held',
  lost: 'That lost the draw',
  fifty: 'Not mated within 50 moves',
  stalemate: 'Stalemate',
  material: 'Not enough left to mate',
  repetition: 'Draw by repetition',
  thrown: 'The win slipped: a draw now',
  'gave-up': 'Given up',
};

export const isSuccess = (result) => ['mate', 'promoted', 'captured', 'held'].includes(result);

/** What passing means, for tiles and the drill page. */
export function goalText(d) {
  if (d.goal === 'mate') return 'Mate within 50 moves';
  if (d.goal === 'promote') return 'Queen with the win kept';
  if (d.goal === 'capture') return 'Win the material, keep the win';
  return `Defend: hold for ${d.hold} moves`;
}

/** A defend drill's verdict on your move, from the answer after it (the attacker to move). */
export function judgeDefence(info) {
  if (info.checkmate) return 'lost';
  if (info.category === 'win') return 'lost';
  return 'ok'; // draw, or even better (a cursed win for them is a draw by the 50-move rule)
}

/** Your drawing moves in a position (you to move), best first. */
export function drawingMoves(info) {
  return (info.moves ?? []).filter((m) => m.category !== 'win'); // their category after it: anything but a win for them
}
