import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../../web/vendor/chess.js/chess.js';
import { candidates, heardCommand, heardYesNo, interpret, interpretTyped, parseSpoken, sanToSpeech } from '../../web/js/speech-core.js';

const legal = (fen) => new Chess(fen).moves({ verbose: true }).map((m) => ({ ...m, uci: m.from + m.to + (m.promotion ?? '') }));
const after = (...sans) => {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
};
const uciOf = (alts, fen, expected = null) => {
  const r = interpret(Array.isArray(alts) ? alts : [alts], legal(fen), expected);
  return r.move?.uci ?? r.kind;
};

test('moves read aloud', () => {
  assert.equal(sanToSpeech('Nf3'), 'knight F3');
  assert.equal(sanToSpeech('e4'), 'E4');
  assert.equal(sanToSpeech('exd5'), 'E takes D5');
  assert.equal(sanToSpeech('Nbd7'), 'knight B takes D7'.replace(' takes', ''));
  assert.equal(sanToSpeech('O-O'), 'castles kingside');
  assert.equal(sanToSpeech('O-O-O+'), 'castles queenside, check');
  assert.equal(sanToSpeech('Qxe7#'), 'queen takes E7, checkmate');
  assert.equal(sanToSpeech('e8=Q+'), 'E8 promotes to queen, check');
  assert.equal(sanToSpeech('R1e2'), 'rook 1 E2');
});

test('parse what was heard', () => {
  assert.deepEqual(parseSpoken('Knight F3'), { castle: null, piece: 'N', fromFile: null, fromRank: null, capture: false, to: 'f3', promo: null });
  assert.equal(parseSpoken('e takes d5').fromFile, 'e');
  assert.equal(parseSpoken('e takes d5').capture, true);
  assert.equal(parseSpoken('night to f three').to, 'f3');
  assert.equal(parseSpoken('bishop be 5').to, 'b5');
  assert.equal(parseSpoken('e for').to, 'e4');
  assert.equal(parseSpoken('nf3').piece, 'N');
  assert.deepEqual(parseSpoken('castles kingside'), { castle: 'K' });
  assert.deepEqual(parseSpoken('long castle'), { castle: 'Q' });
  assert.equal(parseSpoken('hello there'), null);
});

test('heard moves match legal moves', () => {
  const start = after();
  assert.equal(uciOf('E4', start), 'e2e4');
  assert.equal(uciOf('knight f3', start), 'g1f3');
  assert.equal(uciOf('night F3', start), 'g1f3');
  assert.equal(uciOf('pawn to e four', start), 'e2e4');
  // f3 alone: the pawn move, unless the knight move is the one expected
  assert.equal(uciOf('f3', start), 'f2f3');
  assert.equal(uciOf('f3', start, 'g1f3'), 'g1f3');
  const caro = after('e4', 'c6', 'd4', 'd5', 'exd5');
  assert.equal(uciOf('c takes d5', caro), 'c6d5');
  assert.equal(uciOf('queen takes d5', caro), 'd8d5');
  const castle = 'r3k2r/pppqppbp/2np1np1/8/8/2NP1NP1/PPPQPPBP/R3K2R w KQkq - 0 1';
  assert.equal(uciOf('castles', castle), 'e1g1');
  assert.equal(uciOf('castle queenside', castle), 'e1c1');
  // two knights can reach d2? no: Nf3-d2 and Nc3... only one; two rooks: R a1-d1 vs e1? king
  const twoKnights = '4k3/8/8/8/8/2N3N1/8/4K3 w - - 0 1';
  assert.equal(uciOf('knight e4', twoKnights), 'unclear'); // either knight: ask again
  assert.equal(uciOf('knight c e4', twoKnights), 'c3e4');
});

test('any guess that is the expected move wins; else confirm a single legal move', () => {
  const start = after('e4', 'c6');
  const r = interpret(['be 4', 'd4', 'B4'], legal(start), 'd2d4');
  assert.equal(r.kind, 'expected');
  assert.equal(r.move.uci, 'd2d4');
  const o = interpret(['knight c3'], legal(start), 'd2d4');
  assert.equal(o.kind, 'other');
  assert.equal(o.move.san, 'Nc3');
  assert.equal(interpret(['banana'], legal(start), 'd2d4').kind, 'unclear');
});

test('promotion', () => {
  const fen = '8/4P3/8/8/8/8/k7/4K3 w - - 0 1';
  assert.equal(uciOf('e8 queen', fen), 'e7e8q');
  assert.equal(uciOf('e8', fen), 'e7e8q');
  assert.equal(uciOf('e8 promotes to knight', fen), 'e7e8n');
});

test('commands and yes/no', () => {
  assert.equal(heardCommand('Repeat'), 'repeat');
  assert.equal(heardCommand('that was a mishearing'), 'mishearing');
  assert.equal(heardCommand('stop'), 'stop');
  assert.equal(heardCommand('knight f3'), null);
  assert.equal(interpret(['repeat', 'E4'], legal(after()), 'e2e4').kind, 'command');
  assert.equal(heardYesNo('Yes'), 'yes');
  assert.equal(heardYesNo('yeah that is right'), 'yes');
  assert.equal(heardYesNo('no'), 'no');
  assert.equal(heardYesNo('knight'), null);
});

test('typed moves', () => {
  const start = after();
  assert.equal(interpretTyped('Nf3', legal(start), 'g1f3').kind, 'expected');
  assert.equal(interpretTyped('e4', legal(start), 'g1f3').move.uci, 'e2e4');
  assert.equal(interpretTyped('knight c3', legal(start), 'g1f3').move.uci, 'b1c3');
  assert.equal(interpretTyped('g1f3', legal(start), 'g1f3').kind, 'expected');
});

test('candidates is empty for nothing heard', () => {
  assert.deepEqual(candidates(null, legal(after())), []);
});
