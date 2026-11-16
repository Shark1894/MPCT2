import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS, candidateMoves, evalText, extraReplies, finish, finalCandidate, modelProbs, movetext, pct, scoreCandidate, scoreFor, winPct, worthALook,
} from '../../web/js/practical-core.js';

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const cp = (n) => ({ cp: n });
const DATA = { ...DEFAULTS, useData: true };
const stats = (w, d, b, moves = []) => ({ white: w, draws: d, black: b, moves: moves.map(([uci, san, mw, md, mb]) => ({ uci, san, white: mw, draws: md, black: mb })) });

test('win% from either side, mates and the clamp', () => {
  near(winPct(cp(0), 'white'), 50);
  near(winPct(cp(100), 'white'), 59.1, 0.1);
  near(winPct(cp(100), 'black'), 40.9, 0.1);
  assert.equal(winPct({ mate: -3 }, 'black'), 100);
  assert.equal(winPct({ mate: 2 }, 'black'), 0);
  near(winPct(cp(5000), 'white'), winPct(cp(1000), 'white'));
  near(winPct({ cp: 100, mate: null }, 'white'), 59.1, 0.1); // as saved lines come back from the server
});

test('scores and the model', () => {
  near(scoreFor(stats(50, 20, 30), 'black'), 40);
  assert.ok(Number.isNaN(scoreFor(stats(0, 0, 0), 'white')));
  const p = modelProbs({ a: 50, b: 44, c: 20 }, 6);
  near(p.a + p.b + p.c, 1);
  assert.ok(p.a > p.b && p.b > p.c);
});

test('candidates: engine first, then played moves, then the repertoire move', () => {
  const here = stats(1000, 0, 0, [['c7c6', 'c6', 40, 0, 0], ['a7a6', 'a6', 3, 0, 0], ['g7g6', 'g6', 20, 0, 0], ['b8c6', 'Nc6', 500, 0, 0]]);
  // a6: too few games; g6: under 3% of the games
  assert.deepEqual(candidateMoves([{ uci: 'b8c6' }, { uci: 'e7e6' }, { uci: 'b8c6' }], here, ['h7h6'], DATA), ['b8c6', 'e7e6', 'c7c6', 'h7h6']);
  assert.deepEqual(candidateMoves([{ uci: 'b8c6' }, { uci: 'e7e6' }], here, ['h7h6']), ['b8c6', 'e7e6', 'h7h6']); // engine only: no played moves
  const data = stats(100, 0, 0, [['d2d4', 'd4', 60, 0, 0], ['g2g3', 'g3', 19, 0, 0], ['a2a3', 'a3', 3, 0, 0], ['h2h3', 'h3', 6, 0, 0], ['b2b3', 'b3', 7, 0, 0], ['c2c3', 'c3', 5, 0, 0]]);
  assert.deepEqual(extraReplies([{ uci: 'd2d4' }], data, DATA), ['g2g3', 'b2b3', 'h2h3']); // 5%+, the 3 most played
  assert.deepEqual(extraReplies([{ uci: 'd2d4' }], data), []); // engine only
  assert.deepEqual(extraReplies([{ uci: 'd2d4' }], stats(5, 0, 0, [['a2a3', 'a3', 5, 0, 0]]), DATA), []); // few games: the engine's replies only
});

// You are Black. After your move, White's best is d4 (+0.40); Bc4 is a mistake (-1.50).
const theirLines = [{ uci: 'd2d4', score: cp(40) }, { uci: 'f1c4', score: cp(-150) }, { uci: 'b1c3', score: cp(35) }];

test('practical value from what people play', () => {
  const data = stats(100, 20, 80, [['f1c4', 'Bc4', 70, 14, 56], ['d2d4', 'd4', 30, 6, 24]]);
  const c = scoreCandidate({ uci: 'd7d6', san: 'd6', me: 'black', theirLines, data, moveStats: stats(100, 20, 80) }, DATA);
  assert.equal(c.source, 'data');
  assert.equal(c.good, 2);
  near(c.wrong, 0.7);
  near(c.engine, winPct(cp(40), 'black'));
  near(c.practical, 0.7 * winPct(cp(-150), 'black') + 0.3 * winPct(cp(40), 'black'));
  assert.equal(c.replies[0].san, 'Bc4');
  assert.equal(c.replies[0].good, false);
  near(c.actual, 45);
  assert.equal(c.actualGames, 200);
});

test('extra replies and the model with few games', () => {
  const c = scoreCandidate({ uci: 'd7d6', san: 'd6', me: 'black', theirLines, extra: { h2h4: 70 }, data: stats(3, 0, 2, []), sans: { h2h4: 'h4' } }, DATA);
  assert.equal(c.source, 'model');
  near(c.replies.reduce((a, r) => a + r.prob, 0), 1);
  assert.equal(c.replies[0].uci, 'd2d4'); // the model favours their best
  assert.equal(c.replies.find((r) => r.uci === 'h2h4').san, 'h4');
  assert.equal(c.actualGames, 0);
});

test('engine only: an only move, its gap, and how often they slip', () => {
  // One good reply (d4), the next is 9 points worse for them, then much worse ones.
  const sharp = [{ uci: 'd2d4', score: cp(40) }, { uci: 'b1c3', score: cp(-60) }, { uci: 'f1c4', score: cp(-150) }, { uci: 'h2h3', score: cp(-200) }];
  const c = scoreCandidate({ uci: 'd7d6', san: 'd6', me: 'black', theirLines: sharp, data: stats(900, 50, 50, [['f1c4', 'Bc4', 900, 50, 50]]) });
  assert.equal(c.source, 'model'); // lots of games, but data is off by default
  assert.equal(c.good, 1);
  near(c.gap, winPct(cp(40), 'white') - winPct(cp(-60), 'white'));
  assert.ok(c.wrong > 0.3 && c.wrong < 0.8, `wrong ${c.wrong}`);
  assert.ok(c.trap > 0, 'mistakes are worth something to you');
  near(c.trap, c.practical - c.engine);
  const quiet = scoreCandidate({ uci: 'b8c6', san: 'Nc6', me: 'black', theirLines: [{ uci: 'd2d4', score: cp(30) }, { uci: 'b1c3', score: cp(28) }, { uci: 'f1b5', score: cp(25) }] });
  assert.equal(quiet.good, 3);
  assert.ok(quiet.wrong === 0 && quiet.trap < 1);
  const stronger = scoreCandidate({ uci: 'd7d6', san: 'd6', me: 'black', theirLines: sharp }, { ...DEFAULTS, temperature: 5 });
  assert.ok(stronger.wrong < c.wrong, 'a stronger opponent slips less');
});

test('costs, the cap, ordering and worth a look', () => {
  const data = stats(100, 20, 80, [['f1c4', 'Bc4', 70, 14, 56], ['d2d4', 'd4', 30, 6, 24]]);
  const d6 = scoreCandidate({ uci: 'd7d6', san: 'd6', me: 'black', theirLines, data }, DATA);
  const nc6 = scoreCandidate({ uci: 'b8c6', san: 'Nc6', me: 'black', repertoire: true, theirLines: [{ uci: 'f1b5', score: cp(20) }, { uci: 'd2d4', score: cp(15) }], data: stats(50, 0, 50, [['f1b5', 'Bb5', 50, 0, 50]]) }, DATA);
  const bad = scoreCandidate({ uci: 'g7g5', san: 'g5', me: 'black', theirLines: [{ uci: 'd2d4', score: cp(300) }] });
  const cands = finish([nc6, d6, bad], { ...DEFAULTS, cap: 15 });
  assert.deepEqual(cands.map((c) => c.san), ['d6', 'Nc6']); // g5 over the cap
  near(nc6.cost, 0);
  assert.ok(d6.cost > 0);
  const w = worthALook([{ position: { sans: ['e4', 'e5', 'Nf3'] }, cands }]);
  assert.equal(w.length, 1); // d6: two good replies, they slip 70% (with the data); Nc6 is yours
  assert.equal(w[0].cand.san, 'd6');
  assert.equal(w[0].mine.san, 'Nc6');
  assert.equal(worthALook([{ position: {}, cands }], { ...DATA, minWrong: 0.9 }).length, 0);
  assert.equal(worthALook([{ position: {}, cands }], { ...DATA, maxGood: 1 }).length, 0);
  assert.equal(finalCandidate({ uci: 'd8h4', san: 'Qh4#', value: 100 }).practical, 100);
});

test('evals as players write them, and the eval kept with each move', () => {
  assert.equal(evalText({ cp: 35 }), '+0.35');
  assert.equal(evalText({ cp: -120, mate: null }), '−1.20');
  assert.equal(evalText({ cp: 0 }), '0.00');
  assert.equal(evalText({ mate: 3 }), '#3');
  assert.equal(evalText({ mate: -2 }), '#−2');
  assert.equal(evalText(null), '–');
  const c = scoreCandidate({ uci: 'd7d6', san: 'd6', me: 'black', theirLines });
  assert.deepEqual(c.score, { cp: 40 }); // after their best reply, d4
});

test('movetext and pct', () => {
  assert.equal(movetext(['e4', 'd5', 'exd5']), '1.e4 d5 2.exd5');
  assert.equal(movetext(['Nf6', 'd4'], 3), '2…Nf6 3.d4');
  assert.equal(pct(62.6), '63%');
  assert.equal(pct(NaN), '–');
});
