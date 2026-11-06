// Hands-free training, the pure part (no DOM, unit tested): moves to speech, and what the
// speech recogniser heard back to a move or a command.
//
// Matching never works on free text alone: what was heard is turned into the pieces of a move
// (piece, from-file, capture, destination, promotion, castling) and compared with the LEGAL
// moves in the position, so "be4" vs "d4" style mishearings rarely matter. The recogniser gives
// several guesses; if any of them is the expected move it's accepted.

const PIECE_NAMES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };

/** "Nf3" -> "knight F3", "exd5" -> "E takes D5", "O-O" -> "castles kingside", "e8=Q+" -> "E8 promotes to queen, check". */
export function sanToSpeech(san) {
  let s = san.replace(/[!?]+$/, '');
  const mate = s.endsWith('#');
  const check = s.endsWith('+');
  s = s.replace(/[+#]$/, '');
  let out;
  if (s === 'O-O') out = 'castles kingside';
  else if (s === 'O-O-O') out = 'castles queenside';
  else {
    const m = s.match(/^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([QRBN]))?$/);
    if (!m) return san;
    const [, piece, fromFile, fromRank, capture, to, promo] = m;
    const parts = [];
    if (piece) parts.push(PIECE_NAMES[piece]);
    const from = `${fromFile ?? ''}${fromRank ?? ''}`.toUpperCase();
    if (from) parts.push(from);
    if (capture) parts.push('takes');
    parts.push(to.toUpperCase());
    if (promo) parts.push(`promotes to ${PIECE_NAMES[promo]}`);
    out = parts.join(' ');
  }
  if (mate) out += ', checkmate';
  else if (check) out += ', check';
  return out;
}

/** "knight" for a hint about the piece to move. */
export function pieceName(letter) {
  return PIECE_NAMES[(letter || 'P').toUpperCase()] ?? 'piece';
}

// ---- hearing ------------------------------------------------------------------------------

const PIECE_WORDS = {
  king: 'K', kings: 'K',
  queen: 'Q', queens: 'Q', queue: 'Q',
  rook: 'R', rooks: 'R', rock: 'R', rocks: 'R', ruck: 'R', brook: 'R', look: 'R', roof: 'R',
  bishop: 'B', bishops: 'B',
  knight: 'N', knights: 'N', night: 'N', nights: 'N', nite: 'N', knife: 'N', nice: 'N',
  pawn: 'P', pawns: 'P', porn: 'P', pond: 'P', paun: 'P', prawn: 'P', palm: 'P',
};
const FILE_WORDS = {
  a: 'a', ay: 'a', eh: 'a',
  b: 'b', be: 'b', bee: 'b', bea: 'b',
  c: 'c', see: 'c', sea: 'c', cee: 'c',
  d: 'd', dee: 'd', de: 'd',
  e: 'e', ee: 'e',
  f: 'f', ef: 'f', eff: 'f',
  g: 'g', gee: 'g', jee: 'g',
  h: 'h', aitch: 'h', haitch: 'h', age: 'h', each: 'h',
};
const RANK_WORDS = {
  one: '1', won: '1',
  two: '2', to: '2', too: '2',
  three: '3', tree: '3', free: '3',
  four: '4', for: '4', fore: '4',
  five: '5', fife: '5',
  six: '6', sicks: '6', sex: '6',
  seven: '7',
  eight: '8', ate: '8',
};
const CAPTURE_WORDS = new Set(['takes', 'take', 'taking', 'captures', 'capture', 'x', 'by', 'times']);
const FILLER = new Set(['to', 'the', 'on', 'goes', 'moves', 'move', 'play', 'plays', 'i', 'and', 'check', 'mate', 'checkmate', 'please', 'uh', 'um']);

export const COMMANDS = {
  repeat: ['repeat', 'say again', 'say that again', 'again', 'what was that', 'pardon'],
  moves: ['moves', 'read the moves', 'moves so far', 'read the line', 'the line', 'where are we'],
  mishearing: ['mishearing', 'misheard', 'undo', 'that was a mishearing', 'that was misheard', 'you misheard', 'not what i said'],
  stop: ['stop', 'stop listening', 'hands free off', 'hands-free off', 'quiet'],
  next: ['next', 'next line', 'continue', 'carry on'],
};
/**
 * The words the offline recogniser (Vosk) may hear: restricting it to these makes it far more
 * accurate than open dictation. All are in Vosk's small English model ("kingside" isn't: say
 * "king side").
 */
export const VOSK_WORDS = [
  'king', 'queen', 'rook', 'bishop', 'knight', 'pawn',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'takes', 'take', 'captures', 'castles', 'castle', 'side', 'short', 'long', 'promotes', 'to', 'check',
  'yes', 'yeah', 'yep', 'no', 'nope', 'correct', 'right', 'wrong',
  'repeat', 'again', 'say', 'moves', 'that', 'was', 'misheard', 'undo', 'stop', 'next',
  '[unk]',
];

const YES = ['yes', 'yeah', 'yep', 'yup', 'correct', 'right', "that's right", 'that is right', 'confirm', 'affirmative', 'sure'];
const NO = ['no', 'nope', 'nah', 'wrong', 'incorrect', 'not right', "that's wrong", 'no it was not'];

function clean(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,!?;:"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A command word ("repeat", "stop", ...) said on its own, or null. */
export function heardCommand(text) {
  const t = clean(text);
  for (const [cmd, phrases] of Object.entries(COMMANDS)) if (phrases.includes(t)) return cmd;
  return null;
}

/** 'yes' | 'no' | null for an answer to "is that right?". */
export function heardYesNo(text) {
  const t = clean(text);
  if (YES.includes(t) || /^(yes|yeah|yep|correct)\b/.test(t)) return 'yes';
  if (NO.includes(t) || /^(no|nope|wrong)\b/.test(t)) return 'no';
  return null;
}

/**
 * The parts of a move in what was heard:
 * { castle: 'K'|'Q'|null, piece, fromFile, fromRank, capture, to, promo } or null when no square was heard.
 */
export function parseSpoken(text) {
  let t = clean(text);
  if (/\b(castle|castles|castling|short castle|long castle)\b|\bo-o(-o)?\b|\b0-0(-0)?\b/.test(t)) {
    if (/queen ?side|long|o-o-o|0-0-0/.test(t)) return { castle: 'Q' };
    return { castle: 'K' };
  }
  // split SAN-like runs: "e4" -> "e 4", "exd5" -> "e x d 5", "nf3" -> "n f 3", "qxe7" -> "q x e 7"
  t = t.replace(/\b([kqrn])(x?)([a-h])([1-8])\b/g, '$1 $2 $3 $4');
  t = t.replace(/\b([a-h]?x?[a-h])([1-8])\b/g, (m) => m.split('').join(' '));
  t = t.replace(/(\d)/g, ' $1 ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  const tokens = [];
  let promoNext = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'promotes' || w === 'promote' || w === 'promoting' || w === 'equals' || w === '=') {
      promoNext = true;
      continue;
    }
    if (PIECE_WORDS[w] || (w.length === 1 && 'kqrn'.includes(w) && tokens.length === 0)) {
      const p = PIECE_WORDS[w] ?? w.toUpperCase();
      tokens.push({ type: promoNext ? 'promo' : 'piece', value: p });
      promoNext = false;
      continue;
    }
    if (CAPTURE_WORDS.has(w)) {
      tokens.push({ type: 'x' });
      continue;
    }
    if (/^[1-8]$/.test(w)) {
      tokens.push({ type: 'rank', value: w });
      continue;
    }
    // "to"/"for" are both a rank and a filler: a rank only straight after a file
    if (RANK_WORDS[w] && tokens.at(-1)?.type === 'file') {
      tokens.push({ type: 'rank', value: RANK_WORDS[w] });
      continue;
    }
    if (FILE_WORDS[w]) {
      tokens.push({ type: 'file', value: FILE_WORDS[w] });
      continue;
    }
    if (FILLER.has(w) || RANK_WORDS[w]) continue;
  }
  // destination: the last file followed by a rank
  let destAt = -1;
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (tokens[i].type === 'file' && tokens[i + 1].type === 'rank') {
      destAt = i;
      break;
    }
  }
  if (destAt < 0) return null;
  const out = { castle: null, piece: null, fromFile: null, fromRank: null, capture: false, to: tokens[destAt].value + tokens[destAt + 1].value, promo: null };
  for (let i = 0; i < destAt; i++) {
    const tk = tokens[i];
    if (tk.type === 'piece' && !out.piece) out.piece = tk.value;
    else if (tk.type === 'file' && !out.fromFile) out.fromFile = tk.value;
    else if (tk.type === 'rank' && out.fromFile && !out.fromRank) out.fromRank = tk.value;
    else if (tk.type === 'x') out.capture = true;
  }
  for (let i = destAt + 2; i < tokens.length; i++) {
    if (tokens[i].type === 'promo' || tokens[i].type === 'piece') out.promo = out.promo ?? tokens[i].value;
  }
  return out;
}

/**
 * Legal moves matching the parsed parts.
 * @param {{uci, san, piece, from, to, promotion, flags}[]} legal  chess.js verbose moves (+ uci)
 */
export function candidates(parsed, legal) {
  if (!parsed) return [];
  if (parsed.castle) return legal.filter((m) => m.san.replace(/[+#]$/, '') === (parsed.castle === 'K' ? 'O-O' : 'O-O-O'));
  let found = legal.filter((m) => m.to === parsed.to);
  if (parsed.piece && parsed.piece !== 'P') found = found.filter((m) => m.piece.toUpperCase() === parsed.piece);
  if (parsed.piece === 'P') found = found.filter((m) => m.piece === 'p');
  if (parsed.fromFile) found = found.filter((m) => m.from[0] === parsed.fromFile);
  if (parsed.fromRank) found = found.filter((m) => m.from[1] === parsed.fromRank);
  if (found.some((m) => m.promotion)) {
    const promo = (parsed.promo ?? 'Q').toLowerCase();
    found = found.filter((m) => !m.promotion || m.promotion === promo);
  }
  return found;
}

/**
 * What a set of recogniser guesses means for the current move.
 * @param {string[]} alternatives  transcripts, best first
 * @param {object[]} legal         legal moves (see candidates)
 * @param {string|null} expectedUci
 * @returns {{kind: 'command', command} | {kind: 'expected', move, heard} | {kind: 'other', move, heard} | {kind: 'unclear', heard}}
 *   'expected': some guess is the expected move (accept); 'other': a legal move that isn't
 *   (confirm before counting it); 'unclear': no legal move heard (ask again, no penalty).
 */
export function interpret(alternatives, legal, expectedUci) {
  const heard = alternatives[0] ?? '';
  for (const alt of alternatives) {
    const cmd = heardCommand(alt);
    if (cmd) return { kind: 'command', command: cmd, heard: alt };
  }
  let other = null;
  for (const alt of alternatives) {
    const parsed = parseSpoken(alt);
    let found = candidates(parsed, legal);
    const exp = found.find((m) => m.uci === expectedUci);
    if (exp) return { kind: 'expected', move: exp, heard: alt };
    // No piece named ("f3"): a pawn move, as in written notation.
    if (found.length > 1 && parsed && !parsed.castle && !parsed.piece && found.some((m) => m.piece === 'p')) found = found.filter((m) => m.piece === 'p');
    if (!other && found.length === 1) other = { kind: 'other', move: found[0], heard: alt };
  }
  return other ?? { kind: 'unclear', heard };
}

/** Typed input: SAN ("Nf3", "exd5", "O-O") or the spoken forms ("knight f3"). */
export function interpretTyped(text, legal, expectedUci) {
  const t = text.trim();
  const plain = t.replace(/[+#!?]+$/, '');
  const bySan = legal.filter((m) => m.san.replace(/[+#]$/, '') === plain || m.uci === t.toLowerCase());
  if (bySan.length === 1) return { kind: bySan[0].uci === expectedUci ? 'expected' : 'other', move: bySan[0], heard: t };
  return interpret([t], legal, expectedUci);
}
