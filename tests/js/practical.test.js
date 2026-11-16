import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS, addDecision, level, stillSharp, worthFollowing, breakEven, breakEvenText, candidateMoves, decision, lineValue, evalChange, evalText, finalCandidate, finish, movetext, pct, scoreCandidate, signed, winPct, worthALook,
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
  assert.equal(worthALook([{ position: {}, cands: finish([bxe2]) }], { ...DEFAULTS, decisions: 1 }).length, 0);
});

test('costs, the cap, ordering and the sharpest alternatives', () => {
  const d6 = scoreCandidate({ uci: 'd7d6', san: 'd6', me: 'black', theirLines: sharpLines });
  const nc6 = scoreCandidate({ uci: 'b8c6', san: 'Nc6', me: 'black', repertoire: true, theirLines: [{ uci: 'f1b5', score: cp(20) }, { uci: 'd2d4', score: cp(15) }] });
  const bad = scoreCandidate({ uci: 'g7g5', san: 'g5', me: 'black', theirLines: [{ uci: 'd2d4', score: cp(300) }, { uci: 'h2h4', score: cp(100) }] });
  const cands = finish([d6, nc6, bad], { ...DEFAULTS, cap: 15 });
  assert.deepEqual(cands.map((c) => c.san), ['Nc6', 'd6']); // least cost first; g5 over the cap
  near(nc6.cost, 0);
  near(d6.cost, W(40) - W(20));
  const one = { ...DEFAULTS, decisions: 1 };
  const w = worthALook([{ position: { sans: ['e4', 'e5', 'Nf3'] }, cands }], one);
  assert.equal(w.length, 1);
  assert.equal(w[0].cand.san, 'd6');
  assert.equal(w[0].mine.san, 'Nc6');
  assert.equal(worthALook([{ position: {}, cands }], { ...one, minGap: 20 }).length, 0);
  assert.equal(worthALook([{ position: {}, cands }], { ...one, maxGood: 0 }).length, 0);
  assert.equal(finalCandidate({ uci: 'd8h4', san: 'Qh4#', value: 100 }).mate, true);
});

test('never less sharp than your move (unless yours is a recapture)', () => {
  const mk = (san, sharpness, extra = {}) => ({ san, sharpness, good: 1, gap: 10, cost: 2, repertoire: false, final: false, recapture: false, allRecapture: false, chain: [{ good: 1, gap: 10, recapture: false }], ...extra });
  const mine = mk('Qxd5', 8.4, { repertoire: true });
  const cands = [mine, mk('c6', 12), mk('Qd6', 7.6), mk('g6', 6.2)]; // Qd6 shows as 8, the same as yours
  assert.deepEqual(worthALook([{ position: {}, cands }], { ...DEFAULTS, decisions: 1 }).map((p) => p.cand.san), ['c6', 'Qd6']);
  const recap = mk('Bxe2', 36, { repertoire: true, recapture: true, allRecapture: true });
  assert.deepEqual(worthALook([{ position: {}, cands: [recap, mk('h5', 7)] }], { ...DEFAULTS, decisions: 1 }).map((p) => p.cand.san), ['h5']);
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

test('break-even: how often they must miss for the switch to pay', () => {
  // Jason's example, as Black: his move leaves -0.50 against all of their 3-4 replies; the
  // suggestion leaves 0.00 against their only move and -3.00 against the next best.
  const mine = scoreCandidate({ uci: 'a', san: 'a', me: 'black', theirLines: [{ uci: 'x1', score: cp(-50) }, { uci: 'x2', score: cp(-50) }, { uci: 'x3', score: cp(-55) }] });
  const sugg = scoreCandidate({ uci: 'b', san: 'b', me: 'black', theirLines: [{ uci: 'y1', score: cp(0) }, { uci: 'y2', score: cp(-300) }] });
  const A = 100 - W(-50);
  const B = 50;
  const B2 = 100 - W(-300);
  const p = breakEven(sugg, mine);
  near(p, (A - B) / ((A - B) + (B2 - A)));
  assert.ok(p > 0.15 && p < 0.25, `about 1 in 5 (${p})`);
  assert.equal(breakEvenText(p), '18%');
  // At least as good even if they find the best reply: free.
  const better = scoreCandidate({ uci: 'c', san: 'c', me: 'black', theirLines: [{ uci: 'y1', score: cp(-60) }, { uci: 'y2', score: cp(-300) }] });
  assert.equal(breakEven(better, mine), 0);
  assert.equal(breakEvenText(0), 'free');
  // Worse, and their mistake gains no more than against yours: never.
  const flat = scoreCandidate({ uci: 'd', san: 'd', me: 'black', theirLines: [{ uci: 'y1', score: cp(0) }, { uci: 'y2', score: cp(-40) }] });
  assert.equal(breakEven(flat, mine), Infinity);
  assert.equal(breakEvenText(Infinity), 'never');
  assert.equal(breakEven(sugg, null), null);
  assert.equal(breakEvenText(null), '–');
});

test('following their decisions: the chain, only moves in a row, the sharpest point', () => {
  // Decision 1: three fine replies. Decision 2: only one. Decision 3: only one again.
  const easy = [{ uci: 'a2a3', score: cp(20) }, { uci: 'b2b3', score: cp(15) }, { uci: 'c2c3', score: cp(10) }];
  const sharp2 = [{ uci: 'd2d4', score: cp(30) }, { uci: 'e2e4', score: cp(-150) }, { uci: 'f2f4', score: cp(-250) }];
  const sharp3 = [{ uci: 'g2g3', score: cp(40) }, { uci: 'h2h3', score: cp(-60) }];
  const c = scoreCandidate({ uci: 'x', san: 'Qd6', me: 'black', theirLines: easy });
  assert.deepEqual([c.goodChain, c.inRow], [[3], 0]);
  addDecision(c, decision(sharp2, 'black'), 'a3', 'Nc6');
  addDecision(c, decision(sharp3, 'black'), 'd4', 'e5');
  assert.deepEqual(c.goodChain, [3, 1, 1]);
  assert.equal(c.inRow, 0); // the first decision isn't an only move
  assert.equal(c.onlyMoves, 2);
  assert.equal(c.peakAt, 2); // the sharpest point: decision 2
  near(c.sharpness, decision(sharp2, 'black').sharpness);
  near(c.gap, W(30) - W(-150));
  near(c.firstSharpness, decision(easy, 'black').sharpness); // the first decision is kept too
  assert.deepEqual(c.line, ['Qd6', 'a3', 'Nc6', 'd4', 'e5']);
  const d = scoreCandidate({ uci: 'y', san: 'c6', me: 'black', theirLines: sharp2 });
  addDecision(d, decision(sharp3, 'black'), 'd4', 'e5');
  assert.equal(d.inRow, 2);
  // A recapture in the middle neither counts as an only move nor breaks the run.
  const e = scoreCandidate({ uci: 'z', san: 'c6', me: 'black', theirLines: sharp2 });
  addDecision(e, decision([{ uci: 'e1e2', score: cp(30) }, { uci: 'a2a4', score: cp(-500) }], 'black', { capture: true, myUci: 'b4e2' }), 'd4', 'Bxe2');
  addDecision(e, decision(sharp3, 'black'), 'Kxe2', 'e5');
  assert.deepEqual(e.goodChain, [1, 'r', 1]);
  assert.equal(e.inRow, 2);
  assert.equal(e.peakAt, 1); // the recapture's big "sharpness" is ignored
});

test('break-even over several decisions', () => {
  // Yours: easy all the way (-0.50 for White against everything). Suggestion: 0.00, but at
  // each of three decisions only one reply holds and the next best is -3.00 for White.
  const flat = [{ uci: 'a', score: cp(-50) }, { uci: 'b', score: cp(-50) }];
  const trap = [{ uci: 'a', score: cp(0) }, { uci: 'b', score: cp(-300) }];
  const mine = scoreCandidate({ uci: 'm', san: 'm', me: 'black', theirLines: flat });
  const one = scoreCandidate({ uci: 's', san: 's', me: 'black', theirLines: trap });
  const three = scoreCandidate({ uci: 's', san: 's', me: 'black', theirLines: trap });
  addDecision(three, decision(trap, 'black'), 'a', 'x');
  addDecision(three, decision(trap, 'black'), 'a', 'x');
  near(lineValue(one, 0), 50);
  near(lineValue(one, 1), 100 - W(-300));
  const p1 = breakEven(one, mine);
  const p3 = breakEven(three, mine);
  near(p1, (100 - W(-50) - 50) / ((100 - W(-50) - 50) + (100 - W(-300) - (100 - W(-50)))), 1e-6); // the one-decision formula
  assert.ok(p3 < p1, `three chances to slip lower the break-even (${p3} < ${p1})`);
  near(lineValue(three, p3), lineValue(mine, p3), 1e-6);
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

test('alternatives: the whole line followed, at most two good replies at every decision', () => {
  const dec = (good, gap = 10, recapture = false) => ({ good, gap, recapture });
  const mk = (san, chain) => ({ san, sharpness: 10, cost: 2, repertoire: false, final: false, allRecapture: false, chain });
  const cands = [
    mk('a', [dec(2), dec(1), dec(2)]), // in
    mk('b', [dec(1), dec(3), dec(1)]), // three good replies at decision 2
    mk('c', [dec(1), dec(1)]), // the line stopped after two decisions
    mk('d', [dec(1, 10, true), dec(2, 2), dec(1, 6)]), // recapture first, then a clear gap: in
    mk('e', [dec(1, 3), dec(2, 2), dec(1, 4)]), // no clear gap anywhere
  ];
  assert.deepEqual(worthALook([{ position: {}, cands }]).map((p) => p.cand.san), ['a', 'd']);
  assert.deepEqual(worthALook([{ position: {}, cands }], { ...DEFAULTS, decisions: 2 }).map((p) => p.cand.san), ['a', 'c', 'd']);
});

test('which lines are worth following further', () => {
  const dec = (good, recapture = false) => ({ good, gap: 10, recapture });
  const mk = (extra) => ({ engine: 40, repertoire: false, final: false, chain: [dec(2)], ...extra });
  assert.equal(stillSharp(dec(2)), true);
  assert.equal(stillSharp(dec(3)), false);
  assert.equal(stillSharp(dec(6, true)), true); // a recapture is obvious
  assert.equal(worthFollowing(mk(), 50), true);
  assert.equal(worthFollowing(mk({ chain: [dec(7)] }), 50), false); // too many good replies already
  assert.equal(worthFollowing(mk({ engine: 30 }), 50), false); // over the cost cap (15)
  assert.equal(worthFollowing(mk({ chain: [dec(7)], engine: 10, repertoire: true }), 50), true); // yours always
  assert.equal(worthFollowing(mk({ final: true, repertoire: true }), 50), false);
});

test('a decision is the worst case over every good-move branch', () => {
  // Their best reply leads to an only move; their other good reply leads to a position with three good replies.
  const first = [{ uci: 'a2a3', score: cp(20) }, { uci: 'b2b3', score: cp(10) }, { uci: 'c2c3', score: cp(-300) }];
  const onlyOne = [{ uci: 'd2d4', score: cp(30) }, { uci: 'e2e4', score: cp(-150) }];
  const easy = [{ uci: 'f2f4', score: cp(25) }, { uci: 'g2g3', score: cp(20) }, { uci: 'h2h3', score: cp(15) }, { uci: 'a3a4', score: cp(-400) }];
  const c = scoreCandidate({ uci: 'x', san: 'Qd6', me: 'black', theirLines: first });
  addDecision(c, decision(onlyOne, 'black'), 'a3', 'Nc6', [decision(easy, 'black')]);
  assert.deepEqual(c.goodChain, [2, 3]); // not 2 → 1: after b3 they have three good replies
  assert.equal(c.levels[1].nodes, 2);
  assert.equal(c.chain[1].good, 1); // the main line still has the only move
  near(c.levels[1].gap, decision(easy, 'black').gap); // the smaller gap
  assert.deepEqual(c.line, ['Qd6', 'a3', 'Nc6']);
  assert.equal(worthALook([{ position: {}, cands: [{ ...c, cost: 0, repertoire: false, final: false }] }], { ...DEFAULTS, decisions: 2 }).length, 0);
  // recaptures among the branches don't count; all recaptures: a recapture
  const r = { good: 5, gap: 30, sharpness: 30, recapture: true };
  assert.deepEqual([level([r, { good: 1, gap: 9, sharpness: 12, recapture: false }]).good, level([r, r]).recapture], [1, true]);
});
