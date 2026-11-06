// Create an opening from a Chessable course export (.json): the file is read here in the browser,
// you choose the chapters, and only the chosen lines (moves and the author's notes) are sent to
// the server, which makes the opening, its lines, comments and one branch tag per chapter.

import { api } from './api.js';
import { formDialog, plural, store, toast } from './ui.js';

// Chapters left unticked at first: not repertoire lines to train.
const NOT_TRAINED = /intro|quick ?starter|model games|illustrative games|test yourself|exercises/i;

/** The course in a Chessable export: name, colour, chapters (course order) with their lines. */
export function readCourse(json) {
  const book = json?.bookData;
  if (!book || typeof book !== 'object') throw new Error('Not a Chessable course export (no bookData)');
  const entries = Object.values(book).filter((v) => v && typeof v === 'object' && v.game && Array.isArray(v.game.data));
  if (!entries.length) throw new Error('No course lines in this file');
  const listed = Array.isArray(book.course?.data) ? book.course.data : [];
  const chapters = new Map(
    [...listed].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((c) => [c.id, { id: c.id, title: String(c.title ?? '').trim(), lines: [], reference: 0, info: 0, listed: true }]),
  );
  for (const { game } of entries) {
    if (game.isDel) continue;
    // A chapter the course's contents don't list (e.g. left over from an older edition of the course).
    if (!chapters.has(game.lid)) chapters.set(game.lid, { id: game.lid, title: String(game.lineName ?? `Chapter ${game.lid}`).trim(), lines: [], reference: 0, info: 0, listed: !listed.length });
    const ch = chapters.get(game.lid);
    if (game.isInfo) ch.info += 1;
    else if (game.isRef) ch.reference += 1;
    ch.lines.push(game);
  }
  const first = entries[0].game;
  const colors = new Set(entries.map((e) => e.game.color));
  return {
    name: String(book.course?.name ?? first.name ?? 'Chessable course').trim(),
    color: colors.size === 1 ? first.color : null,
    chapters: [...chapters.values()].filter((c) => c.lines.length),
  };
}

/** What to do with the author's notes where a position already has a comment of yours. */
export const NOTE_MODES = [
  ['append', 'Import: add under my existing comments'],
  ['keep', 'Import: only where I have no comment'],
  ['replace', 'Import: replace my existing comments'],
  ['none', 'Don’t import'],
];
/** Whether a chapter is ticked to start with. */
export const trainedChapter = (title) => !NOT_TRAINED.test(title);

/** Only what the server reads from a line (the export carries much more). */
export function slimLine(game) {
  const keep = ['oid', 'lid', 'bid', 'title', 'color', 'initial', 'isInfo', 'isRef', 'isAlt', 'isDel', 'name', 'lineName'];
  return {
    game: {
      ...Object.fromEntries(keep.map((k) => [k, game[k]])),
      data: game.data.map((m) => ({ san: m.san, before: m.before ?? '', after: m.after ?? '' })),
    },
  };
}

/** The lines to send: chosen chapters, information pages left out, reference lines only if asked. */
export function chosenLines(course, chapterIds, withReference) {
  const ids = new Set(chapterIds);
  return course.chapters
    .filter((c) => ids.has(c.id))
    .flatMap((c) => c.lines)
    .filter((g) => !g.isInfo && (withReference || !g.isRef))
    .map(slimLine);
}

/** Pick a .json file with the browser's file chooser (resolves null if none is chosen). */
function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => resolve(input.files[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/**
 * The whole flow: choose the file, the chapters and options, import, report.
 * Resolves to the new (or added-to) opening's id, or null.
 */
export async function importCourse(repertoireId) {
  const file = await pickFile();
  if (!file) return null;
  let course;
  try {
    course = readCourse(JSON.parse(await file.text()));
  } catch (err) {
    toast(`Couldn't read ${file.name}: ${err.message}`, 'error');
    return null;
  }
  if (!course.color) {
    toast('This course has lines for both colours; MPCT openings are for one side.', 'error');
    return null;
  }
  const trainable = (c) => c.lines.length - c.info - c.reference;
  const references = course.chapters.reduce((n, c) => n + c.reference, 0);
  const fields = [
    { name: 'name', label: 'Opening name', value: course.name.slice(0, 100), maxLength: 100 },
    ...course.chapters.map((c) => ({
      name: `ch_${c.id}`,
      label: `${c.title} (${plural(trainable(c), 'line')})${c.listed ? '' : ' · not in the course contents'}`,
      type: 'checkbox',
      value: c.listed && trainedChapter(c.title) && trainable(c) > 0,
    })),
    {
      name: 'notes',
      label: 'Author’s notes',
      type: 'select',
      options: NOTE_MODES,
      value: NOTE_MODES.some(([v]) => v === store.get('courseImport.notes')) ? store.get('courseImport.notes') : 'append',
    },
    { name: 'tags', label: 'Tag each chapter (train or filter by chapter)', type: 'checkbox', value: true },
  ];
  if (references) fields.push({ name: 'reference', label: `Include ${plural(references, 'reference line')} (not trained on Chessable)`, type: 'checkbox', value: false });
  const values = await formDialog({
    title: 'Import a Chessable course',
    message:
      `${course.name}: ${plural(course.chapters.length, 'chapter')}, played as ${course.color === 'white' ? 'White' : 'Black'}. ` +
      'Tick the chapters to import. Chapters marked “not in the course contents” are in the file but not in the course’s current ' +
      'chapter list (often from an older edition). Every new line is due today; giving the same name again adds to that opening.',
    fields,
    submit: 'Import',
  });
  if (!values) return null;
  store.set('courseImport.notes', values.notes);
  const comments = values.notes !== 'none';
  const ids = course.chapters.filter((c) => values[`ch_${c.id}`]).map((c) => c.id);
  const lines = chosenLines(course, ids, Boolean(values.reference));
  if (!lines.length) {
    toast('No lines chosen: tick at least one chapter.', 'error');
    return null;
  }
  toast(`Importing ${plural(lines.length, 'line')}… (this can take a minute)`);
  let r;
  try {
    r = await api.importCourse(repertoireId, {
      name: values.name,
      lines,
      chapters: course.chapters.map((c) => ({ id: c.id, title: c.title })),
      comments,
      comment_mode: comments ? values.notes : 'append',
      tags: values.tags,
    });
  } catch (err) {
    toast(`Not imported: ${err.message}`, 'error');
    return null;
  }
  const parts = [
    `${r.created_opening ? 'Created' : 'Added to'} “${r.opening}”: ${plural(r.lines_created, 'new line')}`,
    r.lines_extended ? `${plural(r.lines_extended, 'line')} extended` : '',
    r.lines_covered ? `${r.lines_covered} already covered by other lines` : '',
    comments ? `${plural(r.comments_added, 'note')} added to comments` + (r.comments_existing ? ` (${r.comments_existing} already there)` : '') : '',
    r.comments_replaced ? `${plural(r.comments_replaced, 'comment')} replaced by the course’s notes` : '',
    r.comments_kept ? `${plural(r.comments_kept, 'position')} with your own comment left as it was` : '',
    r.comments_too_long ? `${plural(r.comments_too_long, 'note')} left out (the comment would be too long)` : '',
    values.tags ? `${plural(r.tags.length, 'chapter tag')}` : '',
  ].filter(Boolean);
  const notes = [...r.tags_skipped.map((t) => `Not tagged: ${t}`), ...r.skipped.map((t) => `Skipped: ${t}`)];
  await formDialog({
    title: 'Course imported',
    message: parts.join('\n') + (notes.length ? `\n\n${notes.join('\n')}` : ''),
    submit: 'OK',
  });
  return r.opening_id;
}
