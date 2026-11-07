// The Woodpecker page in the Training tab: the current cycle (progress, time, pace against the
// target), starting the next cycle, every cycle side by side, and each puzzle's time per cycle.

import { api } from './api.js';
import { clock, days, duration, pace, scopeText, sortPuzzles, timeToGo } from './woodpecker-core.js';
import { confirmDialog, formDialog, plural, store, toast } from './ui.js';
import { button, el, rings } from './dom.js';

const MAX_RINGS = 6; // cycles drawn as rings in the hero (the book's plan is about six)
const dateText = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const pct = (n) => (n == null ? '—' : `${Math.round(n)}%`);
const PAGE = 100; // puzzle-times rows shown before "Show all"

export class WoodpeckerPage {
  /**
   * @param {object} deps
   * @param {(cycle: object, todo: number[], course: object) => void} deps.onSolve   go through the cycle's puzzles
   * @param {(exerciseId: number) => void} deps.onPractise                          one puzzle, not recorded
   * @param {() => void} deps.onChanged                                              reload the tab
   * @param {(course: object) => void} deps.onEdit                                   rename / move / delete
   */
  constructor({ onSolve, onPractise, onChanged, onEdit }) {
    Object.assign(this, { onSolve, onPractise, onChanged, onEdit });
  }

  /** Fill `box` for the course (summary from the course list). */
  async render(box, course) {
    let o;
    try {
      o = await api.woodpecker(course.id);
    } catch (err) {
      box.replaceChildren(el('p', 'meta', `Couldn't load the cycles: ${err.message}`));
      return;
    }
    this.o = o;
    this.course = course;
    const row = el('div', 'tr-row-cards top');
    row.append(this._staircase(o), this._chapters(o));
    box.replaceChildren(this._hero(o, course), this._current(o), row, this._map(o), this._history(o), this._times(o));
  }

  // ---- the hero: the book and its cycle rings ------------------------------------------------------

  _hero(o, course) {
    const hero = el('section', 'tr-hero wp-hero cv-head-card');
    const cover = el('div', 'tr-cover tr-cover-hero kind-woodpecker');
    cover.setAttribute('aria-hidden', 'true');
    cover.appendChild(el('span', 'tr-spine'));
    const cb = el('span', 'tr-cover-body');
    cb.append(el('span', 'tr-cover-kind', 'Woodpecker'), el('span', 'tr-cover-name', course.name), el('span', 'tr-cover-by', plural(o.puzzles, 'puzzle')));
    cover.appendChild(cb);
    const text = el('div', 'tr-hero-text');
    const c = o.current;
    const last = o.cycles.at(-1);
    const eyebrow = c ? `Cycle ${c.number} · ${plural(o.puzzles, 'puzzle')}` : `${plural(o.puzzles, 'puzzle')} · ${o.cycles.length ? `${plural(o.cycles.length, 'cycle')} done` : 'no cycle yet'}`;
    const headline = o.cycles.length > (c ? 1 : 0) ? 'Same puzzles. Half the days.' : 'Solve the set. Then again, faster.';
    let line;
    if (c && o.cycles.length > 1) {
      const prev = o.cycles[o.cycles.length - 2];
      line = `Cycle ${prev.number} took ${days(prev.days)}. Cycle ${c.number}${c.target_days ? `’s target is ${plural(c.target_days, 'day')}` : ' has no target'}: you’re ${days(c.days)} in, with ${c.done} of ${c.total} done.`;
    } else if (c) {
      line = `Cycle ${c.number}${c.target_days ? `, aiming for ${plural(c.target_days, 'day')}` : ''}: ${c.done} of ${c.total} done after ${days(c.days)}.`;
    } else if (last) {
      line = `Cycle ${last.number} took ${days(last.days)}. Next: the same puzzles in ${o.suggested_target_days ? plural(o.suggested_target_days, 'day') : 'half the time'}.`;
    } else {
      line = 'Every puzzle timed, only your first go counts. Then the whole set again in half the days, and again, until it takes a day or two.';
    }
    const title = el('div', 'cv-title');
    title.append(el('h1', 'dash-h', course.name), el('span', 'tr-chip kind-woodpecker', 'Woodpecker'));
    text.append(el('span', 'tr-eyebrow', eyebrow), title, el('p', 'tr-hero-line', `${headline} ${line}`));
    const actions = el('div', 'cv-actions');
    actions.appendChild(button('Edit', 'small', () => this.onEdit?.(course), 'Rename, move to another group or delete'));
    text.appendChild(actions);
    const list = [];
    for (let i = 0; i < Math.min(MAX_RINGS, Math.max(1, o.cycles.length + (c ? 0 : 1))); i++) {
      const cy = o.cycles[i];
      list.push({ p: cy ? (cy.finished_at ? 1 : cy.done / Math.max(cy.total, 1)) : 0, cls: cy?.finished_at ? 'wp dim' : 'wp' });
    }
    const pctNow = c ? `${Math.round((100 * c.done) / Math.max(c.total, 1))}%` : o.cycles.length ? '✓' : '0';
    const ringBox = el('div', 'wp-rings');
    ringBox.setAttribute('role', 'img');
    ringBox.setAttribute('aria-label', o.cycles.map((cy) => `cycle ${cy.number} ${cy.finished_at ? 'done' : `${Math.round((100 * cy.done) / Math.max(cy.total, 1))}%`}`).join(', ') || 'No cycles yet');
    ringBox.appendChild(rings(210, list.slice(0, MAX_RINGS), { width: 9, gap: 15, text: pctNow, sub: c ? `cycle ${c.number}` : o.cycles.length ? `${o.cycles.length} done` : 'start' }));
    hero.append(cover, text, ringBox);
    return hero;
  }

  // ---- days per cycle against the target: the halving staircase ------------------------------------------

  _staircase(o) {
    const card = el('section', 'tr-card wp-stairs');
    card.appendChild(el('h2', 'tr-card-title', 'The halving staircase'));
    card.appendChild(el('span', 'tr-muted', 'Days per cycle; the outline is the target'));
    const bars = [];
    o.cycles.forEach((c) => bars.push({ name: `C${c.number}`, days: c.days, target: c.target_days, state: c.finished_at ? 'done' : 'now' }));
    let next = o.current ? (o.current.target_days ?? null) : (o.suggested_target_days ?? (o.cycles.length ? null : 28));
    for (let n = o.cycles.length + 1; bars.length < 6 && next; n++) {
      if (!o.current || n > o.current.number) {
        bars.push({ name: `C${n}`, days: 0, target: next, state: 'next' });
      }
      next = next > 1 ? Math.ceil(next / 2) : null;
    }
    const max = Math.max(1, ...bars.map((b) => Math.max(b.days, b.target ?? 0)));
    const chart = el('div', 'wp-bars');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', bars.map((b) => `${b.name}: ${b.days ? days(b.days) : 'to come'}${b.target ? `, target ${b.target}` : ''}`).join('; '));
    for (const b of bars) {
      const col = el('div', 'wp-bar-col');
      col.appendChild(el('span', `wp-bar-label ${b.state}`, b.days ? `${Math.round(b.days * 10) / 10}d` : `${b.target}d`));
      const stack = el('div', 'wp-bar-stack');
      if (b.target) {
        const t = el('div', 'wp-bar-target');
        t.style.height = `${(100 * b.target) / max}%`;
        stack.appendChild(t);
      }
      if (b.days) {
        const f = el('div', `wp-bar-fill ${b.state}`);
        f.style.height = `${Math.max(2, (100 * b.days) / max)}%`;
        stack.appendChild(f);
      }
      col.append(stack, el('span', 'wp-bar-name', b.name));
      chart.appendChild(col);
    }
    if (!bars.length) card.appendChild(el('p', 'tr-muted', 'Your cycles show here once you start one.'));
    else card.appendChild(chart);
    return card;
  }

  // ---- this cycle by chapter ---------------------------------------------------------------------

  _chapters(o) {
    const card = el('section', 'tr-card wp-chapters');
    const shown = o.current ?? o.cycles.at(-1);
    card.appendChild(el('h2', 'tr-card-title', shown ? `Cycle ${shown.number} by chapter` : 'Chapters'));
    for (const ch of o.chapters.filter((c) => c.puzzles)) {
      const row = el('div', `wp-ch ${ch.in_cycle || !shown ? '' : 'out'}`);
      const top = el('div', 'wp-ch-top');
      const acc = ch.done ? ` · ${Math.round((100 * ch.solved) / ch.done)}%` : '';
      top.append(el('span', 'wp-ch-name', ch.title), el('span', 'tr-muted', shown && !ch.in_cycle ? 'not in this cycle' : `${ch.done} / ${ch.puzzles}${acc}`));
      const bar = el('div', 'tr-minibar wide');
      bar.setAttribute('aria-hidden', 'true');
      const a = el('span', 'ok wp');
      a.style.width = `${(100 * ch.solved) / ch.puzzles}%`;
      const b = el('span', 'bad');
      b.style.width = `${(100 * (ch.done - ch.solved)) / ch.puzzles}%`;
      bar.append(a, b);
      row.append(top, bar);
      card.appendChild(row);
    }
    return card;
  }

  // ---- the puzzle map: one square per puzzle, coloured by its time this cycle --------------------------

  _map(o) {
    const card = el('section', 'tr-card wp-map');
    const shown = o.current ?? o.cycles.at(-1);
    const head = el('div', 'tr-card-head');
    head.appendChild(el('h2', 'tr-card-title', shown ? `Puzzle map · cycle ${shown.number}` : 'Puzzle map'));
    const legend = el('div', 'wp-legend');
    for (const [cls, label] of [['fast', 'under 15s'], ['mid', '15–60s'], ['slow', 'over 60s'], ['miss', 'missed'], ['todo', 'not yet']]) {
      const item = el('span', 'wp-legend-item');
      item.append(el('span', `wp-cell ${cls}`), label);
      legend.appendChild(item);
    }
    head.appendChild(legend);
    card.appendChild(head);
    const box = el('div', 'wp-map-box');
    box.appendChild(el('p', 'tr-muted', 'Loading…'));
    card.appendChild(box);
    card.appendChild(el('span', 'tr-muted', 'Click a square to practise that puzzle (not recorded in a cycle).'));
    this._fillMap(box, o, shown);
    return card;
  }

  async _fillMap(box, o, shown) {
    let data;
    try {
      data = await api.woodpeckerTimes(o.course_id);
    } catch (err) {
      box.replaceChildren(el('p', 'tr-muted', err.message));
      return;
    }
    this.timesData = data;
    const groups = new Map();
    for (const p of data.puzzles) {
      if (!groups.has(p.chapter)) groups.set(p.chapter, []);
      groups.get(p.chapter).push(p);
    }
    const parts = [];
    for (const [chapter, puzzles] of groups) {
      parts.push(el('span', 'wp-map-chapter', `${chapter} (${puzzles.length})`));
      const grid = el('div', 'wp-grid');
      for (const p of puzzles) {
        const t = shown ? p.times[shown.number] : null;
        const cls = !t ? 'todo' : !t.solved ? 'miss' : t.seconds < 15 ? 'fast' : t.seconds <= 60 ? 'mid' : 'slow';
        const label = `${p.title}: ${!t ? 'not tried this cycle' : `${t.solved ? 'solved' : 'missed'} in ${clock(t.seconds)}`}`;
        grid.appendChild(button('', `wp-cell ${cls}`, () => this.onPractise(p.id), label));
      }
      parts.push(grid);
    }
    box.replaceChildren(...(parts.length ? parts : [el('p', 'tr-muted', 'No puzzles.')]));
  }

  // ---- the current cycle -----------------------------------------------------------------------

  _current(o) {
    const card = el('section', 'tr-card wp-current');
    const c = o.current;
    if (!o.puzzles) {
      card.appendChild(el('p', 'meta', 'This course has no puzzles to solve (only pages to read).'));
      return card;
    }
    if (!c) {
      const next = o.cycles.length + 1;
      card.appendChild(el('h3', 'wp-h', o.cycles.length ? `Cycle ${o.cycles.length} done. Ready for cycle ${next}` : 'The Woodpecker Method'));
      card.appendChild(
        el(
          'p',
          'meta wp-intro',
          o.cycles.length
            ? `Solve the same puzzles again, faster: aim for ${o.suggested_target_days ? plural(o.suggested_target_days, 'day') : 'half the time'} (half of cycle ${o.cycles.length}). Take a rest day first if you can.`
            : `Solve all ${o.puzzles} puzzles in course order, each one timed; only your first go in a cycle counts. Then do the whole set again in half the days, and again, until it takes a day or two. The first cycle is the long one: give it a few weeks.`,
        ),
      );
      card.appendChild(button(`Start cycle ${next}`, 'primary tr-cta', () => this._start(o)));
      return card;
    }
    const head = el('div', 'wp-cur-head');
    head.appendChild(el('h3', 'wp-h', `Cycle ${c.number}`));
    head.appendChild(el('span', 'meta', `${scopeText(c, o.chapters)} · started ${dateText(c.started_at)}`));
    card.appendChild(head);

    const bar = el('div', 'cv-bar wp-bar');
    const w = (n) => `${c.total ? (100 * n) / c.total : 0}%`;
    const solved = el('span', 'cv-bar-solved');
    solved.style.width = w(c.solved);
    const missed = el('span', 'cv-bar-missed');
    missed.style.width = w(c.done - c.solved);
    bar.append(solved, missed);
    const p = pace(c);
    if (p && p.expected > 0 && p.expected < c.total) {
      const mark = el('span', 'wp-pace-mark');
      mark.style.left = w(p.expected);
      mark.title = `Target pace: ${p.expected} by now`;
      bar.appendChild(mark);
    }
    card.appendChild(bar);

    const stats = el('div', 'wp-stats');
    const stat = (label, value, sub = '') => {
      const s = el('div', 'wp-stat');
      s.append(el('span', 'stat-label', label), el('span', 'wp-stat-value', value));
      if (sub) s.appendChild(el('span', 'meta', sub));
      stats.appendChild(s);
    };
    stat('Done', `${c.done} / ${c.total}`, `${c.total - c.done} to go`);
    stat('Accuracy', pct(c.accuracy), c.done ? `${c.solved} solved, ${c.done - c.solved} missed` : '');
    stat('Time', duration(c.seconds), c.avg_seconds ? `${c.avg_seconds}s a puzzle` : '');
    const togo = timeToGo(c);
    stat('Days', days(c.days), c.target_days ? `target ${plural(c.target_days, 'day')}` : 'no target');
    if (p) {
      const value = p.ahead >= 0 ? `+${p.ahead}` : `−${-p.ahead}`;
      const where = p.ahead >= 0 ? 'ahead of target pace' : 'behind target pace';
      stat('Pace', value, p.daysLeft > 0 ? `${where}; ${p.perDay} a day to finish on time` : `${where}; target passed`);
    }
    if (togo) stat('Left', `≈ ${duration(togo)}`, 'at your average');
    card.appendChild(stats);

    const actions = el('div', 'cv-actions');
    actions.appendChild(button(c.done ? `Continue cycle ${c.number}` : `Start solving`, 'primary tr-cta', () => this.onSolve(c, o.todo, this.course)));
    actions.appendChild(button('Abandon cycle', 'small', () => this._abandon(c), 'Delete this cycle and its times'));
    card.appendChild(actions);
    return card;
  }

  async _start(o) {
    const number = o.cycles.length + 1;
    const last = o.cycles.at(-1);
    const fields = [
      {
        name: 'target',
        label: 'Target (days; empty for none)',
        value: String(o.suggested_target_days ?? (o.cycles.length ? '' : 28)),
        required: false,
        placeholder: 'e.g. 14',
      },
    ];
    if (o.chapters.filter((c) => c.puzzles).length > 1) {
      for (const ch of o.chapters.filter((c) => c.puzzles)) {
        fields.push({
          name: `ch_${ch.id}`,
          label: `${ch.title} (${plural(ch.puzzles, 'puzzle')})`,
          type: 'checkbox',
          value: last?.chapter_ids ? last.chapter_ids.includes(ch.id) : true,
        });
      }
    }
    const values = await formDialog({
      title: `Start cycle ${number}`,
      message:
        (o.suggested_target_days ? `Suggested target: ${plural(o.suggested_target_days, 'day')}, half of cycle ${number - 1}. ` : '') +
        (fields.length > 1 ? 'Choose the chapters for this cycle (e.g. only the easy puzzles to begin with).' : ''),
      fields,
      submit: 'Start',
    });
    if (!values) return;
    const target = values.target.trim() ? Number(values.target) : null;
    if (target !== null && (!Number.isInteger(target) || target < 1)) {
      toast('The target is a whole number of days.', 'error');
      return;
    }
    const chosen = o.chapters.filter((c) => c.puzzles && values[`ch_${c.id}`]).map((c) => c.id);
    const all = o.chapters.filter((c) => c.puzzles).length;
    try {
      await api.startWoodpeckerCycle(this.course.id, { target_days: target, chapter_ids: fields.length > 1 && chosen.length < all ? chosen : null });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    this.onChanged();
  }

  async _abandon(c) {
    if (!(await confirmDialog('Abandon cycle', `Delete cycle ${c.number} and the ${plural(c.done, 'time')} recorded in it?`, 'Abandon'))) return;
    try {
      await api.abandonWoodpeckerCycle(c.id);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    this.onChanged();
  }

  // ---- every cycle ---------------------------------------------------------------------------------

  _history(o) {
    const card = el('section', 'tr-card wp-history');
    card.appendChild(el('h3', 'wp-h', 'Cycles'));
    if (!o.cycles.length) {
      card.appendChild(el('p', 'meta', 'Your cycles will be compared here: days, accuracy and time per puzzle.'));
      return card;
    }
    const table = el('table', 'wp-table');
    const head = el('tr');
    for (const h of ['Cycle', 'Puzzles', 'Started', 'Days', 'Done', 'Accuracy', 'Time', 'Per puzzle']) head.appendChild(el('th', '', h));
    table.appendChild(el('thead')).appendChild(head);
    const body = table.appendChild(el('tbody'));
    let prevAvg = null;
    for (const c of o.cycles) {
      const tr = el('tr', c.finished_at ? '' : 'wp-open');
      const daysCell = `${days(c.days)}${c.target_days ? ` / ${c.target_days}` : ''}`;
      const faster = prevAvg && c.avg_seconds ? Math.round((100 * (prevAvg - c.avg_seconds)) / prevAvg) : null;
      const cells = [
        `${c.number}${c.finished_at ? '' : ' (now)'}`,
        scopeText(c, o.chapters),
        dateText(c.started_at),
        daysCell,
        `${c.done}/${c.total}`,
        pct(c.accuracy),
        duration(c.seconds),
        c.avg_seconds ? `${c.avg_seconds}s${faster ? ` (${faster > 0 ? '−' : '+'}${Math.abs(faster)}%)` : ''}` : '—',
      ];
      for (const v of cells) tr.appendChild(el('td', '', v));
      if (c.target_days && c.finished_at) tr.children[3].classList.add(c.days <= c.target_days ? 'good' : 'bad');
      body.appendChild(tr);
      if (c.avg_seconds) prevAvg = c.avg_seconds;
    }
    const wrap = el('div', 'wp-table-wrap');
    wrap.appendChild(table);
    card.appendChild(wrap);
    return card;
  }

  // ---- each puzzle's times ------------------------------------------------------------------------

  _times(o) {
    const card = el('details', 'tr-card wp-times');
    card.appendChild(el('summary', 'wp-h', 'Puzzle times'));
    const tools = el('div', 'wp-times-tools');
    const sort = el('select');
    for (const [v, label] of [['slowest', 'Slowest first'], ['missed', 'Most missed first'], ['order', 'Course order']]) sort.appendChild(new Option(label, v));
    sort.value = store.get('wpSort', 'slowest');
    const label = el('label', 'cv-filter-label', 'Sort ');
    label.appendChild(sort);
    tools.appendChild(label);
    const box = el('div', 'wp-table-wrap');
    card.append(tools, box);
    let data = null;
    let all = false;
    const draw = () => {
      if (!data) return;
      const rows = sortPuzzles(data.puzzles, sort.value);
      const shown = all ? rows : rows.slice(0, PAGE);
      const table = el('table', 'wp-table wp-times-table');
      const head = el('tr');
      head.append(el('th', '', 'Puzzle'), el('th', '', 'Chapter'));
      for (const n of data.cycles) head.appendChild(el('th', 'num', `C${n}`));
      head.appendChild(el('th', ''));
      table.appendChild(el('thead')).appendChild(head);
      const body = table.appendChild(el('tbody'));
      for (const p of shown) {
        const tr = el('tr');
        tr.append(el('td', 'wp-name', p.title), el('td', 'meta', p.chapter));
        for (const n of data.cycles) {
          const t = p.times[n];
          const td = el('td', `num ${t ? (t.solved ? 'good' : 'bad') : ''}`, t ? `${t.solved ? '' : '✗ '}${clock(t.seconds)}` : '');
          if (t && !t.solved) td.title = 'Missed';
          tr.appendChild(td);
        }
        const td = el('td');
        td.appendChild(button('Practise', 'small', () => this.onPractise(p.id), 'Solve it now (practice: not recorded in a cycle)'));
        tr.appendChild(td);
        body.appendChild(tr);
      }
      box.replaceChildren(table);
      if (!all && rows.length > PAGE) {
        box.appendChild(
          button(`Show all ${rows.length}`, 'small wp-more', () => {
            all = true;
            draw();
          }),
        );
      }
    };
    sort.addEventListener('change', () => {
      store.set('wpSort', sort.value);
      draw();
    });
    card.addEventListener('toggle', async () => {
      store.set('wpTimesOpen', card.open);
      if (!card.open || data) return;
      box.replaceChildren(el('p', 'meta', 'Loading…'));
      try {
        data = await api.woodpeckerTimes(o.course_id);
      } catch (err) {
        box.replaceChildren(el('p', 'meta', err.message));
        return;
      }
      draw();
    });
    card.open = store.get('wpTimesOpen', false);
    return card;
  }
}
