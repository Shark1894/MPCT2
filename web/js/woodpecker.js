// The Woodpecker page in the Training tab: the current cycle (progress, time, pace against the
// target), starting the next cycle, every cycle side by side, and each puzzle's time per cycle.

import { api } from './api.js';
import { clock, days, duration, pace, scopeText, sortPuzzles, timeToGo } from './woodpecker-core.js';
import { confirmDialog, formDialog, plural, store, toast } from './ui.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const button = (label, cls, onClick, title) => {
  const b = el('button', cls, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
};
const dateText = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const pct = (n) => (n == null ? '—' : `${Math.round(n)}%`);
const PAGE = 100; // puzzle-times rows shown before "Show all"

export class WoodpeckerPage {
  /**
   * @param {object} deps
   * @param {(cycle: object, todo: number[], course: object) => void} deps.onSolve   go through the cycle's puzzles
   * @param {(exerciseId: number) => void} deps.onPractise                          one puzzle, not recorded
   * @param {() => void} deps.onChanged                                              reload the tab
   */
  constructor({ onSolve, onPractise, onChanged }) {
    Object.assign(this, { onSolve, onPractise, onChanged });
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
    box.replaceChildren(this._current(o), this._history(o), this._times(o));
  }

  // ---- the current cycle -----------------------------------------------------------------------

  _current(o) {
    const card = el('section', 'dash-card wp-current');
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
      card.appendChild(button(`Start cycle ${next}`, 'primary', () => this._start(o)));
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
    actions.appendChild(button(c.done ? `Continue cycle ${c.number}` : `Start solving`, 'primary', () => this.onSolve(c, o.todo, this.course)));
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
    const card = el('section', 'dash-card wp-history');
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
    const card = el('details', 'dash-card wp-times');
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
