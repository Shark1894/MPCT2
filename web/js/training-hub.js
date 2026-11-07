// The Training tab: one hub with three families that look different on purpose.
//   Puzzles (amber): your rating and its trend, rated puzzles, your own mistakes, recent boards.
//   Courses (blue, Woodpecker purple): a shelf of imported courses, each a cover with a ring.
//   Endgame drills (teal): generated positions, never the same twice, with mastery levels.
// "Up next" suggests one thing from each. Each course, drill and the full puzzle pages open as
// their own page with a breadcrumb back to the hub.

import { api } from './api.js';
import { pickFile, readCourse, slimLine } from './courseimport.js';
import { KINDS, guessKind, queueFor } from './courses.js';
import { DRILLS, GROUPS as DRILL_GROUPS, drillById, goalText } from './endgame-core.js';
import { EndgamePage } from './endgames.js';
import { WoodpeckerPage } from './woodpecker.js';
import { pace } from './woodpecker-core.js';
import { breadcrumb, button, diceIcon, el, miniBoard, rings, sparkline } from './dom.js';
import { drillLevel, ratingChange, runStrip, sparkPoints, suggestDrill } from './training-core.js';
import { confirmDialog, daysFromToday, formDialog, plural, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const kindName = (k) => (KINDS.find(([v]) => v === k) ?? [k, k])[1];
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
const FILTERS = [['', 'All'], ...KINDS];

export class TrainingView {
  /**
   * @param {object} deps
   * @param {(list: {id: number}[], label: string, opts?: object) => void} deps.onStart   course exercises on the board
   * @param {(drillId: string, fen?: string) => void} deps.onEndgame                      an endgame drill
   * @param {(theme: string|null) => void} deps.onPuzzleStart                            rated puzzles
   * @param {(list: object[]) => void} deps.onOwnPuzzles                                  puzzles from your games
   * @param {(id: string) => void} deps.onPuzzleOpen                                      one rated puzzle again
   * @param {{refresh: () => Promise<void>, hide: () => void}} deps.puzzles               the full puzzle pages
   */
  constructor(deps) {
    Object.assign(this, deps);
    // Every start says which course it's from (for the Stats tab): the one last opened or started.
    const start = deps.onStart;
    this.onStart = (list, label, opts = {}) => start(list, label, { course: this.activeCourse ?? null, ...opts });
    this.el = { page: $('tr-page'), puzzles: $('puzzles-view') };
    this.page = store.get('trainingPage', { view: 'hub' });
    this.details = new Map();
    this.woodpecker = new WoodpeckerPage({
      onSolve: (cycle, todo, course) =>
        this.onStart(
          todo.map((id) => ({ id })),
          `Cycle ${cycle.number}`,
          { woodpecker: { cycleId: cycle.id, number: cycle.number, done: cycle.done, total: cycle.total, course: course.name } },
        ),
      onPractise: (id) => this.onStart([{ id }], 'Practice'),
      onChanged: () => this.refresh(),
      onEdit: (c) => this._edit(c),
    });
    this.endgame = new EndgamePage({ onStart: (id, fen) => this.onEndgame(id, fen) });
  }

  // ---- data and navigation ----------------------------------------------------------------------

  async refresh() {
    this.visible = true;
    const [courses, pz, mine, eg, status] = await Promise.allSettled([
      api.courses(),
      api.puzzleSummary(),
      api.gamePuzzles(false),
      api.endgameStats(),
      api.puzzleStatus(),
    ]);
    this.courses = courses.status === 'fulfilled' ? courses.value : [];
    this.loadError = courses.status === 'rejected' ? courses.reason.message : null;
    this.pz = pz.status === 'fulfilled' ? pz.value : null;
    this.mine = mine.status === 'fulfilled' ? mine.value : [];
    this.egStats = eg.status === 'fulfilled' ? eg.value : {};
    this.pzStatus = status.status === 'fulfilled' ? status.value : null;
    this.details.clear(); // statuses change as you work through a course
    if (this.page.view === 'course' && !this.courses.some((c) => c.id === this.page.id)) this.page = { view: 'hub' };
    if (this.page.view === 'drill' && !drillById(this.page.id)) this.page = { view: 'hub' };
    await this.draw();
  }

  hide() {
    this.visible = false;
    this.puzzles.hide();
  }

  /** Open a page: {view: 'hub'} | {view: 'course', id} | {view: 'drill', id} | {view: 'puzzles', which}. */
  async go(page, anchor = null) {
    this.page = page;
    store.set('trainingPage', page);
    await this.draw();
    if (anchor) document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo(0, 0);
  }

  /** Old entry points: the Puzzles tab (saved view) and the sidebar's puzzle pages. */
  showPuzzles(which = 'rated') {
    this.page = { view: 'puzzles', which };
    store.set('trainingPage', this.page);
  }

  async draw() {
    const p = this.page;
    const box = this.el.page;
    const onPuzzles = p.view === 'puzzles';
    this.el.puzzles.hidden = !onPuzzles;
    if (!onPuzzles) this.puzzles.hide();
    if (p.view === 'course') return this._coursePage(box, this.courses.find((c) => c.id === p.id));
    if (p.view === 'drill') {
      const drill = drillById(p.id);
      const body = el('div', 'tr-detail fam-eg');
      box.replaceChildren(this._crumbs([['Endgame drills', 'tr-endgames'], [drill.name]]), body);
      this.endgame.render(body, p.id, this.egStats);
      return;
    }
    if (onPuzzles) {
      box.replaceChildren(this._crumbs([['Puzzles', 'tr-puzzles'], [p.which === 'mine' ? 'From your games' : 'Rated puzzles']]));
      this.el.puzzles.dataset.show = p.which === 'mine' ? 'mine' : 'rated';
      if (this.visible) await this.puzzles.refresh();
      return;
    }
    box.replaceChildren(this._hub());
  }

  /** Training › section › page: items = [[label, hub anchor], ..., [this page]]. */
  _crumbs(items) {
    return breadcrumb([
      ['Training', () => this.go({ view: 'hub' })],
      ...items.map(([label, anchor], i) => [label, i < items.length - 1 ? () => this.go({ view: 'hub' }, anchor) : null]),
    ]);
  }

  // ---- the hub ---------------------------------------------------------------------------------

  _hub() {
    const hub = el('div', 'tr-hub');
    const head = el('div', 'tr-head');
    const title = el('div', 'tr-title');
    title.append(el('h1', '', 'Training'), el('p', '', 'Puzzles to sharpen, courses to work through, endgames to drill until they’re automatic.'));
    const nav = el('nav', 'tr-sections');
    nav.setAttribute('aria-label', 'Training sections');
    for (const [label, anchor, fam] of [['Overview', null, ''], ['Puzzles', 'tr-puzzles', 'fam-pz'], ['Courses', 'tr-courses', 'fam-co'], ['Endgame drills', 'tr-endgames', 'fam-eg']]) {
      const b = button(label, `tr-section-link ${fam}`, () => (anchor ? document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' }) : window.scrollTo({ top: 0, behavior: 'smooth' })));
      if (!anchor) b.setAttribute('aria-current', 'page');
      nav.appendChild(b);
    }
    head.append(title, nav);
    hub.append(head, this._upNext(), this._puzzlesSection(), this._coursesSection(), this._drillsSection());
    return hub;
  }

  _upNext() {
    const sec = el('section', 'tr-next');
    sec.setAttribute('aria-labelledby', 'tr-next-h');
    const h = el('h2', 'tr-eyebrow', 'Up next');
    h.id = 'tr-next-h';
    const grid = el('div', 'tr-next-grid');
    const card = (fam, visual, eyebrow, title, sub, label, onClick, data = {}) => {
      const c = el('div', `tr-next-card ${fam}`);
      Object.assign(c.dataset, data);
      const text = el('div', 'tr-next-text');
      text.append(el('span', 'tr-next-eyebrow', eyebrow), el('span', 'tr-next-title', title), el('span', 'tr-next-sub', sub));
      c.append(visual, text, button(label, 'tr-cta', onClick));
      grid.appendChild(c);
    };
    const badge = (text, cls = '') => el('div', `tr-next-badge ${cls}`, text);

    // 1. a course: the Woodpecker cycle first, else a course with exercises to do
    const wp = this.courses.find((c) => c.kind === 'woodpecker');
    const course = this.courses.find((c) => c.kind !== 'woodpecker' && c.new + c.missed > 0);
    if (wp?.cycle && !wp.cycle.finished_at) {
      const cy = wp.cycle;
      const p = pace(cy);
      card(
        'fam-wp',
        rings(56, [{ p: cy.total ? cy.done / cy.total : 0, cls: 'wp' }], { width: 6 }),
        `Woodpecker · cycle ${cy.number}`,
        `${cy.done} of ${cy.total} puzzles`,
        p ? `${Math.abs(p.ahead)} ${p.ahead >= 0 ? 'ahead of' : 'behind'} pace · ${p.perDay} a day to finish` : wp.name,
        'Continue',
        () => this._continueCycle(wp),
        { kind: 'woodpecker' },
      );
    } else if (wp) {
      const next = (wp.cycle?.number ?? 0) + 1;
      card('fam-wp', rings(56, [{ p: wp.cycle ? 1 : 0, cls: 'wp dim' }], { width: 6 }), 'Woodpecker', wp.name, wp.cycle ? `Cycle ${wp.cycle.number} done: time for cycle ${next}` : 'Start your first cycle', `Start cycle ${next}`, () => this.go({ view: 'course', id: wp.id }), { kind: 'woodpecker' });
    } else if (course) {
      card('fam-co', rings(56, [{ p: course.total ? course.solved / course.total : 0, cls: 'co' }], { width: 6 }), kindName(course.kind), course.name, `${course.new} to do · ${course.missed} missed`, 'Continue', () => this._startCourse(course, 'continue'), { kind: 'course' });
    }

    // 2. puzzles: your own mistakes when due, else rated puzzles
    const due = this.mine.filter((p) => daysFromToday(p.next_review_on) <= 0);
    if (due.length) {
      card('fam-pz', badge(String(due.length)), 'Puzzles · from your games', `${plural(due.length, 'mistake')} of yours due`, 'Practised like your repertoire lines', 'Practise', () => this.onOwnPuzzles(due), { kind: 'puzzles' });
    } else if (this.pzStatus?.puzzles) {
      card('fam-pz', badge(this.pz ? String(this.pz.rating) : '—', 'small'), 'Puzzles', 'Rated puzzles', this.pz?.today?.attempts ? `${this.pz.today.attempts} today` : 'Keep your rating moving', 'Start', () => this.onPuzzleStart(store.get('puzzleTheme', '') || null), { kind: 'puzzles' });
    } else {
      card('fam-pz', badge('↓', 'small'), 'Puzzles', 'Download the puzzle database', 'Six million rated puzzles from Lichess', 'Open', () => this.go({ view: 'puzzles', which: 'rated' }), { kind: 'puzzles' });
    }

    // 3. a drill
    const d = suggestDrill(DRILLS, this.egStats);
    if (d) {
      const st = this.egStats?.[d.id];
      const lvl = drillLevel(st);
      card('fam-eg', badge(d.glyphs, 'glyphs'), 'Endgame drill', d.name, st?.attempts ? `${lvl === 'New' ? 'Not passed yet' : lvl} · ${st.attempts} ${st.attempts === 1 ? 'try' : 'tries'}` : 'Not tried yet', 'New position', () => this.onEndgame(d.id), { kind: 'drill' });
    }
    sec.append(h, grid);
    return sec;
  }

  async _continueCycle(c) {
    this.activeCourse = c;
    let o;
    try {
      o = await api.woodpecker(c.id);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (!o.current || !o.todo.length) return this.go({ view: 'course', id: c.id });
    this.onStart(
      o.todo.map((id) => ({ id })),
      `Cycle ${o.current.number}`,
      { woodpecker: { cycleId: o.current.id, number: o.current.number, done: o.current.done, total: o.current.total, course: c.name } },
    );
  }

  // ---- puzzles -----------------------------------------------------------------------------------

  _sectionHead(id, title, tagline, extra = []) {
    const head = el('div', 'tr-sec-head');
    const left = el('div', 'tr-sec-title');
    const h = el('h2', '', title);
    h.id = `${id}-h`;
    left.append(h, el('span', 'tr-tagline', tagline));
    head.append(left);
    if (extra.length) {
      const right = el('div', 'tr-sec-tools');
      right.append(...extra);
      head.appendChild(right);
    }
    return head;
  }

  _puzzlesSection() {
    const sec = el('section', 'tr-sec fam-pz');
    sec.id = 'tr-puzzles';
    sec.setAttribute('aria-labelledby', 'tr-puzzles-h');
    sec.appendChild(
      this._sectionHead('tr-puzzles', 'Puzzles', 'Quick hits, scored. Find the move.', [
        button('All puzzle stats', 'tr-link', () => this.go({ view: 'puzzles', which: 'rated' })),
      ]),
    );
    const grid = el('div', 'tr-pz-grid');
    const pz = this.pz;

    // the rating
    const rating = el('div', 'tr-card tr-rating');
    rating.appendChild(el('span', 'tr-eyebrow', 'Puzzle rating'));
    const big = el('div', 'tr-rating-row');
    big.appendChild(el('span', 'tr-rating-value', pz ? `${pz.rating}${pz.provisional ? '?' : ''}` : '—'));
    const change = pz ? ratingChange(pz.history, pz.rating) : null;
    if (change != null) big.appendChild(el('span', `tr-rating-change ${change >= 0 ? 'up' : 'down'}`, `${signed(change)} this week`));
    rating.appendChild(big);
    const pts = pz ? sparkPoints(pz.history, 300, 70) : '';
    if (pts) {
      const first = pz.history.slice(-30)[0];
      rating.appendChild(sparkline(pts, 300, 70, `Rating over the last ${Math.min(30, pz.history.length)} days played, from ${first.rating} to ${pz.rating}`));
    } else rating.appendChild(el('p', 'tr-muted', 'Solve a few rated puzzles and your trend shows here.'));
    const facts = el('div', 'tr-facts');
    if (pz) {
      const first = pz.rated ? Math.round((100 * pz.rated_solved) / pz.rated) : null;
      facts.append(fact(pz.solved, 'solved'));
      if (first != null) facts.append(fact(`${first}%`, 'first try'));
      facts.append(fact(pz.today?.attempts ?? 0, 'today'));
    }
    rating.appendChild(facts);
    grid.appendChild(rating);

    // rated + your games
    const col = el('div', 'tr-col');
    const rated = el('div', 'tr-card');
    const rh = el('div', 'tr-card-head');
    rh.appendChild(el('span', 'tr-card-title', 'Rated puzzles'));
    if (this.pzStatus?.puzzles) rh.appendChild(el('span', 'tr-chip', `Lichess · ${countText(this.pzStatus.puzzles)}`));
    rated.appendChild(rh);
    if (this.pzStatus?.puzzles) {
      const row = el('div', 'tr-row');
      const label = el('label', 'tr-field', 'Theme');
      const select = el('select');
      select.id = 'tr-theme';
      select.appendChild(new Option('Any theme', ''));
      for (const t of this.themes ?? []) select.appendChild(new Option(t.name, t.theme));
      select.value = store.get('puzzleTheme', '');
      select.addEventListener('change', () => store.set('puzzleTheme', select.value));
      label.appendChild(select);
      row.append(label, button('Start', 'tr-cta', () => this.onPuzzleStart(select.value || null)));
      rated.appendChild(row);
      this._loadThemes(select);
      const weak = (pz?.themes ?? []).slice(0, 2);
      if (weak.length) {
        const p = el('p', 'tr-muted', 'Weakest: ');
        weak.forEach((t, i) => {
          if (i) p.append(' · ');
          p.appendChild(el('span', 'tr-strong', `${t.name} ${Math.round((100 * t.solved) / t.attempts)}%`));
        });
        rated.appendChild(p);
      }
    } else {
      rated.appendChild(el('p', 'tr-muted', 'The Lichess puzzle database isn’t downloaded yet (about 260 MB, a few minutes).'));
      rated.appendChild(button('Download puzzles', 'tr-ghost', () => this.go({ view: 'puzzles', which: 'rated' })));
    }
    const mine = el('div', 'tr-card tr-mine');
    const due = this.mine.filter((p) => daysFromToday(p.next_review_on) <= 0);
    const mt = el('div', 'tr-stack');
    mt.append(el('span', 'tr-card-title', 'From your games'), el('span', 'tr-muted', this.mine.length ? `${plural(this.mine.length, 'puzzle')} · ${due.length} due today` : 'Your mistakes, once your games are reviewed'));
    const mineActions = el('div', 'tr-row');
    const practise = button(due.length ? `Practise due (${due.length})` : 'Nothing due', 'tr-ghost', () => this.onOwnPuzzles(due));
    practise.disabled = !due.length;
    mineActions.append(practise, button('Manage', 'tr-link', () => this.go({ view: 'puzzles', which: 'mine' })));
    mine.append(mt, mineActions);
    col.append(rated, mine);
    grid.appendChild(col);

    // recent boards
    const recent = el('div', 'tr-card');
    recent.appendChild(el('span', 'tr-card-title', 'Recent'));
    const shown = (pz?.recent ?? []).filter((r) => r.fen).slice(0, 4);
    if (shown.length) {
      const boards = el('div', 'tr-recent');
      for (const r of shown) {
        const b = button('', 'tr-recent-item', () => this.onPuzzleOpen(r.puzzle_id), 'Try this puzzle again (not rated)');
        const wrap = el('div', 'tr-board-wrap');
        const theme = r.themes[0] ?? 'Puzzle';
        wrap.appendChild(miniBoard(r.fen, `${theme}, rated ${r.puzzle_rating}: ${r.solved ? 'solved' : 'missed'}`, r.fen.split(' ')[1] === 'b'));
        wrap.appendChild(el('span', `tr-badge ${r.solved ? 'ok' : 'bad'}`, `${r.solved ? '✓' : '✗'}${r.rated ? ` ${signed(r.change)}` : ''}`));
        b.append(wrap, el('span', 'tr-muted', `${theme} · ${r.puzzle_rating}`));
        boards.appendChild(b);
      }
      recent.appendChild(boards);
    } else recent.appendChild(el('p', 'tr-muted', 'Your latest puzzles show here as boards.'));
    grid.appendChild(recent);
    sec.appendChild(grid);
    return sec;
  }

  async _loadThemes(select) {
    if (this.themes) return;
    try {
      this.themes = await api.puzzleThemes();
    } catch {
      return;
    }
    for (const t of this.themes) select.appendChild(new Option(t.name, t.theme));
    select.value = store.get('puzzleTheme', '');
  }

  // ---- courses -----------------------------------------------------------------------------------

  _coursesSection() {
    const sec = el('section', 'tr-sec fam-co');
    sec.id = 'tr-courses';
    sec.setAttribute('aria-labelledby', 'tr-courses-h');
    const filter = store.get('courseFilter', '');
    const chips = el('div', 'tr-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Filter courses');
    for (const [k, label] of FILTERS) {
      const n = k ? this.courses.filter((c) => c.kind === k).length : this.courses.length;
      if (k && !n) continue;
      const b = button(label, 'tr-chip-btn', () => {
        store.set('courseFilter', k);
        this.draw().then(() => document.getElementById('tr-courses')?.scrollIntoView({ block: 'start' }));
      });
      b.dataset.filter = k;
      b.setAttribute('aria-pressed', String(k === filter));
      chips.appendChild(b);
    }
    const imp = button('Import course', 'tr-cta small', () => this.importCourse(), 'Import a Chessable course (one combined .json file)');
    imp.id = 'cv-import';
    sec.appendChild(this._sectionHead('tr-courses', 'Courses', 'Your library, worked through in order.', [chips, imp]));
    const shelf = el('div', 'tr-shelf');
    const shown = this.courses.filter((c) => !filter || c.kind === filter);
    for (const c of shown) shelf.appendChild(this._cover(c));
    const add = button('', 'tr-cover tr-cover-add', () => this.importCourse());
    add.append(el('span', 'tr-plus', '+'), el('span', '', 'Import a Chessable course'));
    shelf.appendChild(add);
    sec.appendChild(shelf);
    const empty = el('p', 'tr-muted', this.loadError ? `Couldn't load your courses: ${this.loadError}` : 'Import adds your Chessable courses here: tactics, strategy, endgame courses or the Woodpecker Method.');
    empty.id = 'cv-empty';
    empty.hidden = this.courses.length > 0 && !this.loadError;
    sec.appendChild(empty);
    return sec;
  }

  _cover(c) {
    const b = button('', `tr-cover kind-${c.kind}`, () => this.go({ view: 'course', id: c.id }));
    b.dataset.course = c.id;
    b.setAttribute('aria-label', `${c.name}, ${kindName(c.kind)}`);
    b.appendChild(el('span', 'tr-spine'));
    const body = el('span', 'tr-cover-body');
    body.append(el('span', 'tr-cover-kind', kindName(c.kind)), el('span', 'tr-cover-name', c.name), el('span', 'tr-cover-by', `${plural(c.total, 'exercise')}`), el('span', 'tr-grow'));
    const foot = el('span', 'tr-cover-foot');
    let ringList;
    let big;
    let small;
    if (c.kind === 'woodpecker') {
      const cy = c.cycle;
      const p = cy ? cy.done / Math.max(cy.total, 1) : 0;
      ringList = [{ p, cls: 'wp' }, { p: cy ? Math.min(1, (cy.number - (cy.finished_at ? 0 : 1)) / 6) : 0, cls: 'wp dim', width: 4 }];
      big = cy ? `Cycle ${cy.number}` : 'No cycle yet';
      small = cy ? (cy.finished_at ? 'done · start the next' : `${Math.round(100 * p)}% · ${cy.done}/${cy.total}`) : 'start cycle 1';
    } else {
      ringList = [{ p: c.total ? c.solved / c.total : 0, cls: 'co' }];
      big = c.total ? `${Math.round((100 * c.solved) / c.total)}%` : '—';
      small = `${c.solved} solved · ${c.missed} missed`;
    }
    const txt = el('span', 'tr-stack');
    txt.append(el('span', 'tr-cover-big', big), el('span', 'tr-cover-small', small));
    foot.append(rings(52, ringList, { width: 6, gap: 9 }), txt);
    body.appendChild(foot);
    b.appendChild(body);
    return b;
  }

  // ---- endgame drills ---------------------------------------------------------------------------------

  _drillsSection() {
    const sec = el('section', 'tr-sec fam-eg tr-range');
    sec.id = 'tr-endgames';
    sec.setAttribute('aria-labelledby', 'tr-endgames-h');
    const head = this._sectionHead('tr-endgames', 'Endgame drills', 'Against perfect defence from the tablebase. No chapters, no end: practise until it’s automatic.');
    const random = el('span', 'tr-random');
    random.append(diceIcon(14), ' a new random position every time');
    head.querySelector('.tr-sec-title h2').after(random);
    sec.appendChild(head);
    for (const [group, title] of DRILL_GROUPS) {
      const drills = DRILLS.filter((d) => d.group === group);
      if (!drills.length) continue;
      const h = el('h3', 'tr-drill-group', title);
      const grid = el('div', 'tr-drills');
      for (const d of drills) grid.appendChild(this._drillTile(d));
      sec.append(h, grid);
    }
    return sec;
  }

  _drillTile(d) {
    const st = this.egStats?.[d.id];
    const lvl = drillLevel(st);
    const b = button('', `tr-drill level-${lvl.toLowerCase()}`, () => this.go({ view: 'drill', id: d.id }));
    b.dataset.drill = d.id;
    b.setAttribute('aria-label', `${d.name} (${d.pieces}): ${lvl}`);
    const top = el('span', 'tr-drill-top');
    const glyphs = el('span', 'tr-glyphs');
    glyphs.append(d.glyphs, el('span', 'tr-vs', 'v'), el('span', 'tr-lone', d.vs ?? '♚'));
    top.append(glyphs, el('span', `tr-level ${lvl.toLowerCase()}`, lvl));
    const name = el('span', 'tr-stack');
    name.append(el('span', 'tr-drill-name', d.name), el('span', `tr-drill-goal ${d.goal === 'draw' ? 'defend' : ''}`, goalText(d)));
    const strip = el('span', 'tr-strip');
    strip.setAttribute('aria-hidden', 'true');
    for (const r of runStrip(st?.recent ?? [], 8)) strip.appendChild(el('span', `tr-tick ${r}`));
    const stat = st?.attempts
      ? `${st.successes}/${st.attempts}` + (st.avg_moves != null ? ` · avg ${st.avg_moves} moves${st.avg_optimal ? ` (perfect ${st.avg_optimal})` : ''}` : '')
      : 'Not tried yet';
    const progress = el('span', 'tr-drill-stat', stat);
    progress.classList.add('cv-item-progress'); // (kept for tests and old links)
    b.append(top, name, strip, progress);
    return b;
  }

  // ---- a course's page ---------------------------------------------------------------------------------

  async _coursePage(box, c) {
    this.activeCourse = c;
    if (!c) return this.go({ view: 'hub' });
    const crumbs = this._crumbs([['Courses', 'tr-courses'], [c.name]]);
    if (c.kind === 'woodpecker') {
      const body = el('div', 'tr-detail fam-wp');
      box.replaceChildren(crumbs, body);
      await this.woodpecker.render(body, c);
      return;
    }
    const page = el('div', 'tr-detail fam-co');
    const hero = el('section', 'tr-hero cv-head-card');
    const cover = this._cover(c);
    cover.classList.add('tr-cover-hero');
    cover.disabled = true;
    const text = el('div', 'tr-hero-text');
    const title = el('div', 'cv-title');
    title.append(el('h1', 'dash-h', c.name), el('span', `tr-chip kind-${c.kind}`, kindName(c.kind)));
    text.append(title, el('p', 'meta cv-counts', `${plural(c.total, 'exercise')} · ${c.solved} solved · ${c.missed} missed · ${c.new + c.missed ? `${c.new} to do` : 'all done'}`));
    const actions = el('div', 'cv-actions');
    actions.appendChild(button(c.solved === 0 && c.missed === 0 ? 'Start' : c.new ? 'Continue' : c.missed ? 'Retry missed' : 'Go again', 'primary tr-cta', () => this._startCourse(c, c.new || c.missed ? 'continue' : 'all')));
    if (c.missed && c.new) actions.appendChild(button(`Retry missed (${c.missed})`, 'tr-ghost', () => this._startCourse(c, 'missed')));
    actions.appendChild(button('Edit', 'small', () => this._edit(c), 'Rename, change the kind, reset progress or delete'));
    text.appendChild(actions);
    hero.append(cover, text);
    const chapters = el('section', 'tr-card cv-chapters');
    chapters.appendChild(el('h2', 'tr-card-title', 'Chapters'));
    const list = el('div', 'cv-chapter-list');
    list.appendChild(el('p', 'meta', 'Loading…'));
    chapters.appendChild(list);
    page.append(hero, chapters);
    box.replaceChildren(crumbs, page);
    if (!this.details.has(c.id)) await this._load(c.id);
    const full = this.details.get(c.id);
    if (this.page.id !== c.id) return;
    list.replaceChildren(...(full ? full.chapters.map((ch) => this._chapterRow(c, ch)) : []));
  }

  async _load(id) {
    try {
      this.details.set(id, await api.course(id));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  _chapterRow(course, ch) {
    const row = el('details', 'cv-chapter');
    row.open = (store.get('chaptersOpen', []) ?? []).includes(ch.id);
    row.addEventListener('toggle', () => {
      const open = new Set(store.get('chaptersOpen', []));
      if (row.open) open.add(ch.id);
      else open.delete(ch.id);
      store.set('chaptersOpen', [...open]);
    });
    const sum = el('summary', 'cv-chapter-head');
    sum.appendChild(el('span', 'cv-chapter-title', ch.title));
    const bar = el('span', 'tr-minibar');
    bar.setAttribute('aria-hidden', 'true');
    const w = (n) => `${ch.total ? (100 * n) / ch.total : 0}%`;
    const s1 = el('span', 'ok');
    s1.style.width = w(ch.solved);
    const s2 = el('span', 'bad');
    s2.style.width = w(ch.missed);
    bar.append(s1, s2);
    sum.appendChild(bar);
    sum.appendChild(el('span', 'meta cv-chapter-counts', `${ch.solved}/${ch.total}${ch.missed ? ` · ${ch.missed} missed` : ''}`));
    const start = button(ch.new || ch.missed ? 'Start' : 'Again', 'small', (e) => {
      e.preventDefault(); // not the details toggle
      this.onStart(queueFor([ch], ch.new || ch.missed ? 'continue' : 'all'), ch.title);
    });
    sum.appendChild(start);
    row.appendChild(sum);
    const ul = el('ul', 'cv-exercises');
    ch.exercises.forEach((e, i) => {
      const li = el('li', `cv-ex cv-${e.status}`);
      const b = button(e.title || `Exercise ${i + 1}`, 'link', () => this.onStart(ch.exercises.slice(i), ch.title), e.kind === 'line' ? 'Open this exercise' : 'Read this page');
      li.append(el('span', 'cv-dot', ''), b);
      if (e.kind !== 'line') li.appendChild(el('span', 'meta', e.kind === 'info' ? 'read' : 'reference'));
      ul.appendChild(li);
    });
    row.appendChild(ul);
    return row;
  }

  async _startCourse(c, which) {
    this.activeCourse = c;
    if (!this.details.has(c.id)) await this._load(c.id);
    const full = this.details.get(c.id);
    if (!full) return;
    this.onStart(queueFor(full.chapters, which), which === 'missed' ? `${c.name} · missed` : c.name);
  }

  async _edit(c) {
    const values = await formDialog({
      title: 'Edit course',
      fields: [
        { name: 'name', label: 'Name', value: c.name, maxLength: 100 },
        { name: 'kind', label: 'Kind', type: 'select', options: KINDS, value: c.kind },
        { name: 'reset', label: 'Reset progress (every exercise back to new; Woodpecker cycles are kept)', type: 'checkbox', value: false },
        { name: 'delete', label: 'Delete this course', type: 'checkbox', value: false },
      ],
    });
    if (!values) return;
    try {
      if (values.delete) {
        if (!(await confirmDialog('Delete course', `Delete “${c.name}” and your progress in it?`))) return;
        await api.deleteCourse(c.id);
        toast(`Deleted “${c.name}”.`);
        this.page = { view: 'hub' };
        store.set('trainingPage', this.page);
      } else {
        if (values.name !== c.name || values.kind !== c.kind) await api.updateCourse(c.id, { name: values.name, kind: values.kind });
        if (values.reset) {
          const r = await api.resetCourse(c.id);
          toast(`Progress reset (${plural(r.reset, 'exercise')}).`);
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    await this.refresh();
  }

  /** Choose a combined Chessable course file, the chapters, name and kind; import. */
  async importCourse() {
    const file = await pickFile();
    if (!file) return;
    let course;
    try {
      course = readCourse(JSON.parse(await file.text()));
    } catch (err) {
      toast(`Couldn't read ${file.name}: ${err.message}`, 'error');
      return;
    }
    const values = await formDialog({
      title: 'Import a course for Training',
      message:
        `${course.name}: ${plural(course.chapters.length, 'chapter')}. Tick the chapters to import. ` +
        'Importing the same course again updates it and keeps your progress.',
      fields: [
        { name: 'name', label: 'Course name', value: course.name.slice(0, 100), maxLength: 100 },
        { name: 'kind', label: 'Kind', type: 'select', options: KINDS, value: guessKind(course.name) },
        ...course.chapters.map((c) => ({
          name: `ch_${c.id}`,
          label: `${c.title} (${plural(c.lines.length, 'exercise')})${c.listed ? '' : ' · not in the course contents'}`,
          type: 'checkbox',
          value: c.listed,
        })),
      ],
      submit: 'Import',
    });
    if (!values) return;
    const chosen = course.chapters.filter((c) => values[`ch_${c.id}`]);
    const lines = chosen.flatMap((c) => c.lines).map(slimLine);
    if (!lines.length) {
      toast('No exercises chosen: tick at least one chapter.', 'error');
      return;
    }
    toast(`Importing ${plural(lines.length, 'exercise')}…`);
    let r;
    try {
      r = await api.importTrainingCourse({
        name: values.name,
        kind: values.kind,
        lines,
        chapters: course.chapters.map((c) => ({ id: c.id, title: c.title })),
      });
    } catch (err) {
      toast(`Not imported: ${err.message}`, 'error');
      return;
    }
    const parts = [
      `${r.created_course ? 'Created' : 'Updated'} “${r.course}”: ${plural(r.added, 'new exercise')}`,
      r.updated ? `${plural(r.updated, 'exercise')} updated` : '',
      r.unchanged ? `${r.unchanged} unchanged` : '',
      r.reset ? `${plural(r.reset, 'exercise')} changed, so they're new again` : '',
    ].filter(Boolean);
    const skipped = r.skipped.map((t) => `Skipped: ${t}`);
    this.page = { view: 'course', id: r.course_id };
    store.set('trainingPage', this.page);
    await this.refresh();
    await formDialog({
      title: 'Course imported',
      message: parts.join('\n') + (skipped.length ? `\n\n${skipped.join('\n')}` : ''),
      submit: 'OK',
    });
  }
}

/** 6061234 -> "6.1M", 43000 -> "43k", 3 -> "3". */
function countText(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString('en-GB');
}

function fact(value, label) {
  const s = el('span', 'tr-fact');
  s.append(el('strong', '', String(value)), ` ${label}`);
  return s;
}
