import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardSquares, drillLevel, ratingChange, ringDash, runStrip, sparkPoints, suggestDrill } from '../../web/js/training-core.js';

test('board squares from a FEN', () => {
  const sq = boardSquares('7k/8/8/8/8/8/8/K6R w - - 0 1');
  assert.equal(sq.length, 64);
  assert.deepEqual(sq[7], { light: false, glyph: '♚', white: false }); // h8 is dark
  assert.deepEqual(sq[56], { light: false, glyph: '♚', white: true }); // a1, White's king
  assert.equal(sq[63].glyph, '♜');
  assert.equal(sq[0].light, true); // a8 is light
  assert.equal(boardSquares('7k/8/8/8/8/8/8/K6R w - - 0 1', true)[0].glyph, '♜'); // flipped: h1 first
});

const A = (success) => ({ success });

test('drill levels', () => {
  assert.equal(drillLevel(undefined), 'New');
  assert.equal(drillLevel({ successes: 0, recent: [A(false), A(false)] }), 'New');
  assert.equal(drillLevel({ successes: 1, recent: [A(true), A(false)] }), 'Learning');
  assert.equal(drillLevel({ successes: 3, recent: [A(true), A(false), A(true), A(false), A(true)] }), 'Solid');
  assert.equal(drillLevel({ successes: 9, recent: [A(true), A(true), A(true), A(true), A(true), A(false)] }), 'Mastered');
  assert.equal(drillLevel({ successes: 4, recent: [A(true), A(true), A(true), A(true)] }), 'Solid'); // needs 5 for Mastered
});

test('result strip, oldest first', () => {
  assert.deepEqual(runStrip([A(true), A(false), A(true)], 5), ['pass', 'fail', 'pass', 'none', 'none']);
  assert.deepEqual(runStrip([], 2), ['none', 'none']);
});

test('rating change and sparkline', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  const h = [
    { date: '2026-10-20', rating: 1500 },
    { date: '2026-10-29', rating: 1560 },
    { date: '2026-11-02', rating: 1590 },
    { date: '2026-11-06', rating: 1612 },
  ];
  assert.equal(ratingChange(h, 1612, now), 52); // since 29 Oct (the last day before the week)
  assert.equal(ratingChange([{ date: '2026-11-05', rating: 1500 }, { date: '2026-11-06', rating: 1520 }], 1530, now), 30);
  assert.equal(ratingChange([], 1500, now), null);
  const pts = sparkPoints(h, 300, 70).split(' ');
  assert.equal(pts.length, 4);
  assert.equal(pts[0], '0,64'); // lowest at the bottom
  assert.equal(pts[3], '300,6'); // highest at the top
  assert.equal(sparkPoints([{ rating: 1 }]), '');
});

test('rings and the suggested drill', () => {
  assert.equal(ringDash(10, 0.5), '31.4 62.8');
  assert.equal(ringDash(10, 2), '62.8 62.8');
  const drills = [{ id: 'kq' }, { id: 'kr' }, { id: 'kbn' }];
  const mastered = { successes: 5, attempts: 5, recent: [A(true), A(true), A(true), A(true), A(true)] };
  assert.equal(suggestDrill(drills, {}).id, 'kq');
  assert.equal(suggestDrill(drills, { kq: mastered, kbn: { successes: 0, attempts: 2, recent: [A(false), A(false)] } }).id, 'kbn');
  assert.equal(suggestDrill(drills, { kq: mastered }).id, 'kr');
});
