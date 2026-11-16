import { test } from 'node:test';
import assert from 'node:assert/strict';

import { studyParams } from '../../web/js/api.js';
import { loadFilters, nStudies, taskText } from '../../web/js/studies.js';

test('task text from side and stipulation', () => {
  assert.equal(taskText('white', 'win'), 'White to play and win');
  assert.equal(taskText('black', 'draw'), 'Black to play and draw');
  assert.equal(taskText('white', ''), 'White to play');
});

test('study counts', () => {
  assert.equal(nStudies(1), '1 study');
  assert.equal(nStudies(0), '0 studies');
  assert.equal(nStudies(103517, 'new '), '103,517 new studies');
});

test('saved filters: unknown keys and wrong types dropped', () => {
  assert.deepEqual(loadFilters(null), { group: '', stipulation: '', status: '', favourites: false, q: '' });
  assert.deepEqual(loadFilters({ group: 'rook', favourites: 'yes', junk: 1, q: 'Troitzky' }), { group: 'rook', stipulation: '', status: '', favourites: false, q: 'Troitzky' });
});

test('query parameters leave out empty filters', () => {
  assert.deepEqual(studyParams({ group: 'pawn', stipulation: '', status: null, favourites: false, q: 'x' }), { group: 'pawn', q: 'x' });
  assert.deepEqual(studyParams({ favourites: true }), { favourites: true });
});
