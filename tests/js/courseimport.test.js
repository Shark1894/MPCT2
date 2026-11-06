import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosenLines, readCourse, slimLine, trainedChapter } from '../../web/js/courseimport.js';

const line = (oid, lid, extra = {}) => ({
  game: { oid, lid, bid: 9, title: `L${oid}`, color: 'white', initial: 'x', isInfo: 0, isRef: 0, isAlt: 0, isDel: false,
    name: 'Course', lineName: `Ch ${lid}`, data: [{ san: 'd4', before: null, after: '{"data":[]}', alts: '["e4"]', class: 'w' }], commentsByFEN: null, ...extra },
  lastStudied: null,
});

const EXPORT = {
  bookData: {
    course: { name: 'Test Course', data: [{ id: 2, order: 1, title: 'Main lines ' }, { id: 1, order: 0, title: 'Introduction' }, { id: 3, order: 2, title: 'Model Games' }] },
    book_bought: { name: 'x' },
    chapterStats: {},
    11: line(11, 1, { isInfo: 1 }),
    21: line(21, 2),
    22: line(22, 2, { isRef: 1 }),
    23: line(23, 2, { isDel: true }),
    31: line(31, 3),
    41: line(41, 4, { lineName: 'Old chapter' }),
  },
  hash: '1',
};

test('readCourse: chapters in course order with their lines', () => {
  const c = readCourse(EXPORT);
  assert.equal(c.name, 'Test Course');
  assert.equal(c.color, 'white');
  assert.deepEqual(c.chapters.map((ch) => [ch.id, ch.title, ch.lines.length, ch.reference, ch.info, ch.listed]), [
    [1, 'Introduction', 1, 0, 1, true],
    [2, 'Main lines', 2, 1, 0, true],
    [3, 'Model Games', 1, 0, 0, true],
    [4, 'Old chapter', 1, 0, 0, false],
  ]);
  assert.throws(() => readCourse({}), /bookData/);
});

test('chapters ticked to start with', () => {
  assert.equal(trainedChapter('1. Catalan, Main Line'), true);
  assert.equal(trainedChapter('Quickstarter Guide'), false);
  assert.equal(trainedChapter('Introduction '), false);
  assert.equal(trainedChapter('Model Games'), false);
});

test('chosenLines leaves out info pages, and reference lines unless asked', () => {
  const c = readCourse(EXPORT);
  assert.deepEqual(chosenLines(c, [1, 2], false).map((l) => l.game.oid), [21]);
  assert.deepEqual(chosenLines(c, [2], true).map((l) => l.game.oid), [21, 22]);
});

test('slimLine keeps only what the server reads', () => {
  const s = slimLine(EXPORT.bookData[21].game);
  assert.deepEqual(Object.keys(s.game).sort(), ['bid', 'color', 'data', 'initial', 'isAlt', 'isDel', 'isInfo', 'isRef', 'lid', 'lineName', 'name', 'oid', 'title'].sort());
  assert.deepEqual(s.game.data, [{ san: 'd4', before: '', after: '{"data":[]}' }]);
});
