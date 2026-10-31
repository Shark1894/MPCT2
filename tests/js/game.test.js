import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, START_FEN } from '../../web/js/game.js';

const playUci = (game, ...ucis) => {
  for (const u of ucis) {
    const r = game.play(u.slice(0, 2), u.slice(2, 4), u[4]);
    assert.ok(r, `expected ${u} to be legal`);
  }
};

test('start position has 20 legal moves and correct dests', () => {
  const g = new Game();
  const dests = g.dests();
  const total = [...dests.values()].reduce((n, l) => n + l.length, 0);
  assert.equal(total, 20);
  assert.deepEqual(dests.get('e2').sort(), ['e3', 'e4']);
  assert.equal(g.turn(), 'white');
  assert.equal(g.status().text, 'White to move');
});

test('illegal move is rejected and changes nothing', () => {
  const g = new Game();
  assert.equal(g.play('e2', 'e5'), null);
  assert.equal(g.play('e7', 'e5'), null); // wrong side
  assert.equal(g.fen(), START_FEN);
  assert.equal(g.moves.length, 0);
});

test('moves record SAN, UCI and resulting FEN', () => {
  const g = new Game();
  const r = g.play('g1', 'f3');
  assert.equal(r.san, 'Nf3');
  assert.equal(r.uci, 'g1f3');
  assert.equal(r.fen, g.fen());
  assert.deepEqual(g.lastMove(), ['g1', 'f3']);
});

test('navigation clamps and restores positions', () => {
  const g = new Game();
  playUci(g, 'e2e4', 'e7e5', 'g1f3');
  const end = g.fen();
  g.toStart();
  assert.equal(g.fen(), START_FEN);
  assert.equal(g.lastMove(), undefined);
  g.back();
  assert.equal(g.ply, 0);
  g.forward();
  assert.equal(g.moves[0].fen, g.fen());
  g.toEnd();
  assert.equal(g.fen(), end);
  g.forward();
  assert.equal(g.ply, 3);
  g.goTo(2);
  assert.equal(g.turn(), 'white');
});

test('playing a different move after stepping back replaces the continuation', () => {
  const g = new Game();
  playUci(g, 'e2e4', 'e7e5', 'g1f3', 'b8c6');
  g.goTo(1);
  playUci(g, 'c7c5');
  assert.deepEqual(g.moves.map((m) => m.san), ['e4', 'c5']);
  assert.equal(g.ply, 2);
});

test('replaying the same move after stepping back keeps the continuation', () => {
  const g = new Game();
  playUci(g, 'e2e4', 'e7e5', 'g1f3');
  g.goTo(1);
  playUci(g, 'e7e5');
  assert.deepEqual(g.moves.map((m) => m.san), ['e4', 'e5', 'Nf3']);
  assert.equal(g.ply, 2);
});

test('castling both sides', () => {
  const g = new Game('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
  assert.ok(g.dests().get('e1').includes('g1'));
  assert.equal(g.play('e1', 'g1').san, 'O-O');
  assert.equal(g.play('e8', 'c8').san, 'O-O-O');
});

test('en passant', () => {
  const g = new Game();
  playUci(g, 'e2e4', 'a7a6', 'e4e5', 'd7d5');
  const r = g.play('e5', 'd6');
  assert.equal(r.san, 'exd6');
  assert.match(g.fen(), /^rnbqkbnr\/1pp1pppp\/p2P4\//);
});

test('promotion needs a piece choice, and under-promotion works', () => {
  const g = new Game('8/4P1k1/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(g.isPromotion('e7', 'e8'), true);
  assert.equal(g.isPromotion('e1', 'e2'), false);
  assert.equal(g.play('e7', 'e8'), null); // no piece chosen
  const r = g.play('e7', 'e8', 'n');
  assert.equal(r.san, 'e8=N+');
  assert.equal(r.uci, 'e7e8n');
});

test('checkmate status (fool\'s mate)', () => {
  const g = new Game();
  playUci(g, 'f2f3', 'e7e5', 'g2g4', 'd8h4');
  assert.deepEqual(g.status(), { over: true, text: 'Checkmate: Black wins' });
  assert.equal(g.isOver(), true);
  assert.equal(g.dests().size, 0);
});

test('check is reported', () => {
  const g = new Game();
  playUci(g, 'e2e4', 'f7f6', 'd1h5');
  assert.equal(g.inCheck(), true);
  assert.equal(g.status().text, 'Black to move: check');
});

test('stalemate status', () => {
  const g = new Game('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.deepEqual(g.status(), { over: true, text: 'Draw by stalemate' });
});

test('threefold repetition is detected across navigation', () => {
  const g = new Game();
  playUci(g, 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8');
  assert.equal(g.status().text, 'Draw by threefold repetition');
  g.back();
  g.forward(); // history rebuilt from the start, still detected
  assert.equal(g.status().text, 'Draw by threefold repetition');
});

test('invalid FEN throws and leaves the game unchanged', () => {
  const g = new Game();
  playUci(g, 'e2e4');
  assert.throws(() => g.load('not a fen'));
  assert.equal(g.moves.length, 1);
});

test('move rows number correctly when starting with black to move', () => {
  const g = new Game('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  playUci(g, 'e7e5', 'g1f3', 'b8c6');
  assert.deepEqual(g.moveRows(), [
    { number: 1, white: null, black: { ply: 1, san: 'e5' } },
    { number: 2, white: { ply: 2, san: 'Nf3' }, black: { ply: 3, san: 'Nc6' } },
  ]);
});

test('playSan', () => {
  const g = new Game();
  assert.equal(g.playSan('Nf3').uci, 'g1f3');
  assert.equal(g.playSan('Qh5'), null);
});
