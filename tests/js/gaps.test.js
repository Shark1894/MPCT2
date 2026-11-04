import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetText, statusText } from '../../web/js/gaps.js';

test('meetText', () => {
  assert.equal(meetText(5), 'you’d meet it in about 5 of every 100 games');
  assert.equal(meetText(0.5), 'you’d meet it in about 1 game in 200');
  assert.equal(meetText(0.04), 'you’d meet it in about 1 game in 2,500');
  assert.equal(meetText(null), 'how often you’d reach this isn’t known yet');
});

test('statusText', () => {
  assert.match(statusText({ positions: 0, checked: 0 }), /Add lines/);
  assert.match(statusText({ positions: 50, checked: 0 }), /^Not checked yet: 50 positions .* \(about 1 min\)\.$/);
  assert.equal(statusText({ positions: 50, checked: 20 }), '20 of 50 positions checked. Check again to look up the rest.');
  assert.equal(statusText({ positions: 50, checked: 50 }), 'All 50 positions checked against masters games.');
  assert.equal(statusText({ positions: 50, checked: 0 }, { running: true, done: 3, total: 50 }), 'Checking: 3 of 50 positions looked up…');
});
