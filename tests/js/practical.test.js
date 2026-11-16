import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS, candidateMoves, evalChange, evalText, finalCandidate, finish, movetext, pct, scoreCandidate, signed, winPct, worthALook,
} from '../../web/js/practical-core.js';

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const cp = (n) => ({ cp: n });
const W = (n) => winPct(cp(n), 'white');

test('win% from either side, mates, the clamp and saved lines', () => {
  near(winPct(cp(0), 'white'), 50);
  near(winPct(cp(100), 'white'), 59.1, 0.1);
  near(winPct(cp(100), 'black'), 40.9, 0.1);
  assert.equal(winPct({ mate: -3 }, 'black'), 100);
  assert.equal(winPct({ mate: 2 }, 'black'), 0);
  near(winPct(cp(5000), 'white'), winPct(cp(1000), 'white'));
  near(winPct({ cp: 100, mate: null }, 'white'), 59.1, 0.1); // as saved lines come back from the server
});

test('candidates: the engine moves once each, then your repertoire move', () => {
  assert.deepEqual(candidateMoves([{ uci: 'b8c6' }, { uci: 'e7e6' }, { uci: 'b8c6' }], ['h7h6']), ['b8c6', 'e7e6', 'h7h6']);
  assert.deepEqual(candidateMoves([{ uci: 'b8c6' }], ['b8c6']), ['b8c6']);
});

// You are Black. After your move White's replies, best first by the engine (White-POV centipawns).
const sharpLines = [{ uci: 'b1c3', score: cp(-60) }, { uci: 'd2d4', score: cp(40) }, { uci: 'f1c4', score: cp(-150) }, { uci: 'h2h3', score: cp(-200) }];

test('only moves, gap and sharpness from the engine alone', () => {
  const c = scoreCandidate({ uci: 'd7d6', san: 'd6', me: 'black', theirLines: sharpLines, sans: { d2d4: 'd4' } });
  assert.deepEqual(c.replies.map((r) => r.uci), ['d2d4', 'b1c3', 'f1c4', 'h2h3']); // sorted for them, best first
  assert.equal(c.replies[0].san, 'd4');
  assert.equal(c.good, 1);
  near(c.engine, 100 - W(40));
  assert.deepEqual(c.score, { cp: 40 });
  near(c.gap, W(40) - W(-60));
  near(c.sharpness, ((W(40) - W(-60)) + (W(40) - W(-150)) + (W(40) - W(-200))) / 3);
  near(c.replies[2].mine, 100 - W(-150));
  const quiet = scoreCandidate({ uci: 'b8c6', san: 'Nc6', me: 'black', theirLines: [{ uci: 'd2d4', score: cp(30) }, { uci: 'b1c3', score: cp(28) }, { uci: 'f1b5', score: cp(25) }] });
  assert.equal(quiet.good, 3);
  assert.ok(quiet.gap < 1 && quiet.sharpness < 1);
  const lone = scoreCandidate({ uci: 'x', san: 'x', me: 'white', theirLines: [{ uci: 'e8d8', score: cp(500) }] });
  assert.ok(Number.isNaN(lone.gap) && Number.isNaN(lone.sharpness) && lone.good === 1);
});

test('an obvious recapture is flagged and kept out of the sharpest alternatives', () => {
  // ...Bxe2: White's best is to take back on e2; everything else loses a piece.
  const lines = [{ uci: 'd1e2', score: cp(30) }, { uci: 'g1e2', score: cp(20) }, { uci: 'a2a3', score: cp(-400) }];
  const bxe2 = scoreCandidate({ uci: 'g4e2', san: 'Bxe2', me: 'black', theirLines: lines, capture: true });
  assert.ok(bxe2.recapture && bxe2.sharpness > 15, `${bxe2.recapture} ${bxe2.sharpness}`);
  assert.equal(scoreCandidate({ uci: 'g4e2', san: 'Bxe2', me: 'black', theirLines: lines }).recapture, false); // not a capture
  const notBack = scoreCandidate({ uci: 'f6d5', san: 'Nxd5', me: 'black', theirLines: [{ uci: 'c2c4', score: cp(50) }, { uci: 'g1f3', score: cp(-200) }], capture: true });
  assert.equal(notBack.recapture, false); // their best doesn't take back
  assert.equal(worthALook([{ position: {}, cands: finish([bxe2]) }]).length, 0);
});

test('costs, the cap, ordering and the sharpest alternatives', () => {
  const d6 = scoreCandidate({ uci: 'd7d6', san: 'd6', me: 'black', theirLines: sharpLines });
  const nc6 = scoreCandidate({ uci: 'b8c6', san: 'Nc6', me: 'black', repertoire: true, theirLines: [{ uci: 'f1b5', score: cp(20) }, { uci: 'd2d4', score: cp(15) }] });
  const bad = scoreCandidate({ uci: 'g7g5', san: 'g5', me: 'black', theirLines: [{ uci: 'd2d4', score: cp(300) }, { uci: 'h2h4', score: cp(100) }] });
  const cands = finish([d6, nc6, bad], { ...DEFAULTS, cap: 15 });
  assert.deepEqual(cands.map((c) => c.san), ['Nc6', 'd6']); // least cost first; g5 over the cap
  near(nc6.cost, 0);
  near(d6.cost, W(40) - W(20));
  const w = worthALook([{ position: { sans: ['e4', 'e5', 'Nf3'] }, cands }]);
  assert.equal(w.length, 1);
  assert.equal(w[0].cand.san, 'd6');
  assert.equal(w[0].mine.san, 'Nc6');
  assert.equal(worthALook([{ position: {}, cands }], { ...DEFAULTS, minGap: 20 }).length, 0);
  assert.equal(worthALook([{ position: {}, cands }], { ...DEFAULTS, maxGood: 0 }).length, 0);
  assert.equal(finalCandidate({ uci: 'd8h4', san: 'Qh4#', value: 100 }).mate, true);
});

test('never less sharp than your move (unless yours is a recapture)', () => {
  const mk = (san, sharpness, extra = {}) => ({ san, sharpness, good: 1, gap: 10, cost: 2, repertoire: false, final: false, recapture: false, ...extra });
  const mine = mk('Qxd5', 8.4, { repertoire: true });
  const cands = [mine, mk('c6', 12), mk('Qd6', 7.6), mk('g6', 6.2)]; // Qd6 shows as 8, the same as yours
  assert.deepEqual(worthALook([{ position: {}, cands }]).map((p) => p.cand.san), ['c6', 'Qd6']);
  const recap = mk('Bxe2', 36, { repertoire: true, recapture: true });
  assert.deepEqual(worthALook([{ position: {}, cands: [recap, mk('h5', 7)] }]).map((p) => p.cand.san), ['h5']);
});

test('the change in eval against your move, and who it helps', () => {
  // You're Black: yours leaves −0.50, the suggestion 0.00 after their best reply: half a pawn worse for you.
  const worse = evalChange({ score: { cp: 0 } }, { score: { cp: -50 } }, 'black');
  assert.deepEqual(worse, { cp: 50, better: false, worse: true });
  assert.equal(evalText({ cp: worse.cp }), '+0.50');
  assert.deepEqual(evalChange({ score: { cp: -80, mate: null } }, { score: { cp: -50 } }, 'black'), { cp: -30, better: true, worse: false });
  assert.deepEqual(evalChange({ score: { cp: 20 } }, { score: { cp: 20 } }, 'white'), { cp: 0, better: false, worse: false });
  assert.equal(evalChange({ score: { mate: 3 } }, { score: { cp: 0 } }, 'white'), null);
  assert.equal(evalChange({ score: { cp: 0 } }, null, 'white'), null);
});

test('text helpers', () => {
  assert.equal(evalText({ cp: 35 }), '+0.35');
  assert.equal(evalText({ cp: -120, mate: null }), '−1.20');
  assert.equal(evalText({ cp: 0 }), '0.00');
  assert.equal(evalText({ mate: 3 }), '#3');
  assert.equal(evalText({ mate: -2 }), '#−2');
  assert.equal(evalText(null), '–');
  assert.equal(movetext(['e4', 'd5', 'exd5']), '1.e4 d5 2.exd5');
  assert.equal(movetext(['Nf6', 'd4'], 3), '2…Nf6 3.d4');
  assert.equal(pct(62.6), '63%');
  assert.equal(pct(NaN), '–');
  assert.equal(signed(2.6), '+3');
  assert.equal(signed(-2.4), '−2');
  assert.equal(signed(0.2), '0');
  assert.equal(signed(NaN), '–');
});
