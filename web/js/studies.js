// Endgame studies (Training tab): composed studies imported from PGN files, browsed by material,
// win or draw, progress and favourites. A study is solved on the board like a course exercise
// (you play the side to move; the other side's moves are played for you). Favourites work like
// bookmarked lines: one tap on the star, with an optional note.

import { api } from './api.js';
import { pickFile } from './courseimport.js';
import { button, el, miniBoard } from './dom.js';
import { confirmDialog, formDialog, plural, store, toast } from './ui.js';

const PAGE = 50;
/** 1 study, 2 studies (prefix: 'new ' -> 1 new study). */
export const nStudies = (n, prefix = '') => `${Number(n).toLocaleString('en-GB')} ${prefix}${n === 1 ? 'study' : 'studies'}`;
const STATUSES = [
  ['', 'Any progress'],
  ['unsolved', 'Not solved yet'],
  ['new', 'New'],
  ['missed', 'Missed'],
  ['solved', 'Solved'],
];
const STIPULATIONS = [
  ['', 'Win or draw'],
  ['win', 'Win'],
  ['draw', 'Draw'],
];
const DEFAULT_FILTERS = { group: '', stipulation: '', status: '', favourites: false, q: '' };
const SAMPLE_URL = 'https://gadycosteff.com/cql/sample-pgn.html';

/** "White to play and win" from a study's side and stipulation. */
export function taskText(color, stipulation) {
  const side = color === 'black' ? 'Black' : 'White';
  return stipulation ? `${side} to play and ${stipulation}` : `${side} to play`;
}

/** The filters as saved, with anything unknown dropped. */
export function loadFilters(saved) {
  const f = { ...DEFAULT_FILTERS };
  for (const k of Object.keys(f)) if (saved && typeof saved[k] === typeof f[k]) f[k] = saved[k];
  return f;
}

export class StudiesPage {
  /**
   * @param {object} deps
   * @param {(list: {id: number}[], label: string, opts: object) => void} deps.onStart  solve these studies
   * @param {() => Promise<void>} deps.onChanged                                       studies were added or removed
   */
  constructor({ onStart, onChanged }) {
    Object.assign(this, { onStart, onChanged });
    this.filters = loadFilters(store.get('studyFilters'));
  }

  _save() {
    store.set('studyFilters', this.filters);
  }

  /** The whole page into `box` (summary: from GET /studies/summary). */
  async render(box, summary) {
    this.box = box;
    this.summary = summary;
    box.replaceChildren(this._hero(), ...(summary?.total ? [this._filtersBar(), this._listCard(), this._collections()] : [this._empty()]));
    if (summary?.total) await this._load(true);
  }

  _hero() {
    const s = this.summary ?? { total: 0, solved: 0, favourites: 0 };
    const hero = el('section', 'tr-hero cv-head-card st-hero');
    const glyphs = el('div', 'eg-hero-glyphs');
    glyphs.setAttribute('aria-hidden', 'true');
    glyphs.append('♔♙', el('span', 'tr-vs', 'v'), el('span', 'tr-lone', '♜'));
    const text = el('div', 'tr-hero-text');
    text.append(
      el('span', 'tr-eyebrow', 'Endgame studies'),
      el('h1', 'dash-h', 'Endgame studies'),
      el('p', 'tr-hero-line', 'Composed positions with one way to win or draw. You play the side to move; the composer’s solution is the answer, and its notes appear as you go.'),
    );
    if (s.total) {
      const facts = el('p', 'st-facts');
      facts.id = 'st-facts';
      facts.textContent = `${nStudies(s.total)} · ${s.solved} solved · ${s.missed} missed · ★ ${s.favourites}`;
      text.appendChild(facts);
    }
    const cta = el('div', 'eg-cta st-cta');
    if (s.total) {
      const start = button('Start', 'primary tr-cta big', () => this.start(false), 'Studies matching the filters: new first, then missed');
      start.id = 'st-start';
      const random = button('Random study', 'tr-cta', () => this.start(true), 'One at random from those matching the filters');
      random.id = 'st-random';
      cta.append(start, random);
    }
    const imp = button('Import PGN', s.total ? 'tr-ghost' : 'primary tr-cta big', () => this.importFile(), 'Add a PGN file of studies');
    imp.id = 'st-import';
    cta.appendChild(imp);
    hero.append(glyphs, text, cta);
    return hero;
  }

  _empty() {
    const card = el('section', 'tr-card st-empty');
    card.id = 'st-empty';
    card.append(
      el('h2', 'tr-card-title', 'No studies yet'),
      el('p', 'tr-muted', 'Import a PGN file of endgame studies: each game a set-up position (FEN) with the solution as its main line. They’re sorted by material (pawn, minor piece, rook, queen endings) and you can filter by win or draw, progress and favourites.'),
    );
    const p = el('p', 'tr-muted');
    const a = el('a', '', 'about 200 studies from the HHdb database');
    a.href = SAMPLE_URL;
    a.target = '_blank';
    a.rel = 'noopener';
    p.append('A free sample to start with: ', a, ' (sample.pgn on the CQL site).');
    card.appendChild(p);
    return card;
  }

  // ---- filters ---------------------------------------------------------------------------------

  _filtersBar() {
    const f = this.filters;
    const bar = el('section', 'tr-card st-filters');
    const chips = el('div', 'tr-chips st-groups');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Material');
    const groups = [{ group: '', title: 'All', total: this.summary.total }, ...this.summary.groups];
    for (const g of groups) {
      const b = button(`${g.title} ${g.total}`, 'tr-chip-btn', () => this._set({ group: g.group }));
      b.dataset.group = g.group;
      b.setAttribute('aria-pressed', String(f.group === g.group));
      chips.appendChild(b);
    }
    const row = el('div', 'st-filter-row');
    const select = (name, options, value, label) => {
      const s = el('select');
      s.name = name;
      s.setAttribute('aria-label', label);
      for (const [v, t] of options) {
        const o = el('option', '', t);
        o.value = v;
        s.appendChild(o);
      }
      s.value = value;
      s.addEventListener('change', () => this._set({ [name]: s.value }));
      return s;
    };
    const fav = button(`★ Favourites ${this.summary.favourites}`, 'tr-chip-btn st-fav-filter', () => this._set({ favourites: !f.favourites }));
    fav.id = 'st-fav-filter';
    fav.setAttribute('aria-pressed', String(f.favourites));
    const search = el('input', 'st-search');
    search.type = 'search';
    search.name = 'q';
    search.placeholder = 'Composer, source or material (R+P v B)';
    search.setAttribute('aria-label', 'Search studies');
    search.value = f.q;
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => this._set({ q: search.value.trim() }, false), 300);
    });
    row.append(select('stipulation', STIPULATIONS, f.stipulation, 'Win or draw'), select('status', STATUSES, f.status, 'Progress'), fav, search);
    bar.append(chips, row);
    this.el = { ...this.el, chips, fav };
    return bar;
  }

  /** Change filters and reload the list (redraw: also the chips and selects). */
  _set(changes, redraw = true) {
    Object.assign(this.filters, changes);
    this._save();
    if (redraw) {
      for (const b of this.el.chips.children) b.setAttribute('aria-pressed', String(b.dataset.group === this.filters.group));
      this.el.fav.setAttribute('aria-pressed', String(this.filters.favourites));
    }
    this._load(true);
  }

  // ---- the list --------------------------------------------------------------------------------

  _listCard() {
    const card = el('section', 'tr-card st-list-card');
    const head = el('div', 'tr-card-head');
    const count = el('span', 'tr-muted st-count');
    count.id = 'st-count';
    head.append(el('h2', 'tr-card-title', 'Studies'), count);
    const list = el('ul', 'st-list');
    list.id = 'st-list';
    const more = button('Show more', 'tr-ghost st-more', () => this._load(false));
    more.id = 'st-more';
    more.hidden = true;
    card.append(head, list, more);
    this.el = { ...this.el, count, list, more };
    return card;
  }

  async _load(fresh) {
    const { list, count, more } = this.el ?? {};
    if (!list) return;
    const ask = ++this.loading;
    const offset = fresh ? 0 : list.children.length;
    let page;
    try {
      page = await api.studies(this.filters, offset, PAGE);
    } catch (err) {
      toast(`Couldn't load the studies: ${err.message}`, 'error');
      return;
    }
    if (ask !== this.loading) return; // a newer filter won
    if (fresh) list.replaceChildren();
    for (const st of page.items) list.appendChild(this._row(st));
    const shown = list.children.length;
    count.textContent = page.total === shown ? nStudies(page.total) : `${shown} of ${page.total.toLocaleString('en-GB')}`;
    more.hidden = shown >= page.total;
    if (!page.total) list.appendChild(el('li', 'tr-muted st-none', this.filters.favourites ? 'No favourites match: tap ☆ on a study to keep it here.' : 'No studies match these filters.'));
  }

  _row(st) {
    const li = el('li', `st-row status-${st.status}`);
    li.dataset.id = st.id;
    const open = button('', 'st-open', () => this.onStart([{ id: st.id }], st.title, { studies: true, course: { name: 'Endgame studies', kind: 'endgames' } }));
    open.title = 'Solve this study';
    open.appendChild(miniBoard(st.start_fen, st.title, st.color === 'black'));
    const text = el('div', 'st-text');
    const title = button(st.title || 'Study', 'st-title', () => open.click());
    const meta = el('span', 'st-meta', [taskText(st.color, st.stipulation), plural(Math.ceil(st.moves / 2), 'move'), st.source].filter(Boolean).join(' · '));
    text.append(title, meta);
    if (st.favourite) {
      const note = button(st.favourite_note || 'Add a note', `line-note st-note${st.favourite_note ? '' : ' empty'}`, () => this.editNote(st, li));
      note.title = 'Edit the note';
      text.appendChild(note);
    }
    const side = el('div', 'st-side');
    side.append(el('span', `st-status ${st.status}`, { new: 'New', solved: '✓ Solved', missed: '✗ Missed' }[st.status]));
    const star = button(st.favourite ? '★' : '☆', 'small star', () => this.toggleFavourite(st, li));
    star.setAttribute('aria-pressed', String(st.favourite));
    star.setAttribute('aria-label', st.favourite ? 'Remove from favourites' : 'Add to favourites');
    star.title = star.getAttribute('aria-label');
    side.appendChild(star);
    li.append(open, text, side);
    return li;
  }

  async toggleFavourite(st, li) {
    try {
      if (st.favourite) {
        if (st.favourite_note && !(await confirmDialog('Remove from favourites?', `Its note is deleted too:\n“${st.favourite_note}”`, 'Remove'))) return;
        Object.assign(st, await api.unfavouriteStudy(st.id));
      } else {
        Object.assign(st, await api.favouriteStudy(st.id));
      }
    } catch (err) {
      toast(`Not changed: ${err.message}`, 'error');
      return;
    }
    this.summary.favourites += st.favourite ? 1 : -1;
    this.el.fav.textContent = `★ Favourites ${this.summary.favourites}`;
    if (!st.favourite && this.filters.favourites) li.remove();
    else li.replaceWith(this._row(st));
  }

  async editNote(st, li) {
    const values = await formDialog({
      title: 'Favourite note',
      message: st.title,
      fields: [{ name: 'note', label: 'Note (what to look at, why it’s here)', value: st.favourite_note, maxLength: 500 }],
      submit: 'Save',
    });
    if (!values) return;
    try {
      Object.assign(st, await api.favouriteStudy(st.id, values.note));
    } catch (err) {
      toast(`Not saved: ${err.message}`, 'error');
      return;
    }
    li.replaceWith(this._row(st));
  }

  /** Solve the studies matching the filters: new first, then missed (or one at random). */
  async start(random) {
    let ids;
    try {
      ids = await api.studyQueue(this.filters, { random, limit: random ? 1 : 50 });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (!ids.length) {
      toast('No studies match these filters.');
      return;
    }
    const label = this.filters.favourites ? 'Favourite studies' : 'Endgame studies';
    this.onStart(ids.map((id) => ({ id })), random ? 'Random study' : label, { studies: true, course: { name: 'Endgame studies', kind: 'endgames' } });
  }

  // ---- collections and import ------------------------------------------------------------------

  _collections() {
    const card = el('section', 'tr-card st-collections');
    card.appendChild(el('h2', 'tr-card-title', 'Collections'));
    const ul = el('ul', 'st-coll-list');
    for (const c of this.summary.collections) {
      const li = el('li');
      li.append(el('span', '', `${c.name} · ${nStudies(c.count)}`), button('Delete', 'small danger-outline', () => this.deleteCollection(c)));
      ul.appendChild(li);
    }
    card.appendChild(ul);
    return card;
  }

  async deleteCollection(c) {
    const ok = await confirmDialog(`Delete “${c.name}”?`, `${nStudies(c.count)} go, with their progress, favourites and notes. Importing the file again brings the studies back (as new).`);
    if (!ok) return;
    try {
      await api.deleteStudyCollection(c.name);
    } catch (err) {
      toast(`Not deleted: ${err.message}`, 'error');
      return;
    }
    toast(`Deleted “${c.name}”.`);
    await this.onChanged();
  }

  /** Choose a PGN file, see what's in it, pick the material groups, import. */
  async importFile() {
    const file = await pickFile('.pgn,application/x-chess-pgn,application/vnd.chess-pgn');
    if (!file) return;
    const pgn = await file.text();
    let p;
    try {
      p = await api.previewStudies(pgn);
    } catch (err) {
      toast(`Couldn't read ${file.name}: ${err.message}`, 'error');
      return;
    }
    const skipped = p.skipped.length
      ? `\n\n${plural(p.skipped.length, 'game')} can't be used: ${p.skipped.slice(0, 3).join('; ')}${p.skipped.length > 3 ? '…' : ''}`
      : '';
    const values = await formDialog({
      title: 'Import endgame studies',
      message:
        `${file.name}: ${nStudies(p.studies)}. Tick the kinds of ending to import. ` +
        'Studies you already have are updated and keep their progress and favourites.' + skipped,
      fields: [
        { name: 'collection', label: 'Collection name', value: file.name.replace(/\.pgn$/i, '').slice(0, 100), maxLength: 100 },
        ...p.groups.map((g) => ({ name: `g_${g.group}`, label: `${g.title} (${nStudies(g.count)})`, type: 'checkbox', value: true })),
      ],
      submit: 'Import',
    });
    if (!values) return;
    const groups = p.groups.filter((g) => values[`g_${g.group}`]).map((g) => g.group);
    if (!groups.length) {
      toast('Nothing chosen: tick at least one kind of ending.', 'error');
      return;
    }
    toast(`Importing ${nStudies(p.groups.filter((g) => groups.includes(g.group)).reduce((n, g) => n + g.count, 0))}…`);
    let r;
    try {
      r = await api.importStudies({ pgn, collection: values.collection, groups });
    } catch (err) {
      toast(`Not imported: ${err.message}`, 'error');
      return;
    }
    await this.onChanged();
    const parts = [`“${r.collection}”: ${nStudies(r.added, 'new ')}`, r.updated ? `${r.updated} updated` : '', r.unchanged ? `${r.unchanged} already there` : ''].filter(Boolean);
    await formDialog({ title: 'Studies imported', message: parts.join('\n'), submit: 'OK' });
  }
}

StudiesPage.prototype.loading = 0;
