// Stats tab: where your time goes. A period's total and its split by category (openings,
// tactics, endgames, strategy, games, analysis), the last 30 days as stacked bars, and a
// breakdown by activity with its main openings, courses or drills.

import { api } from './api.js';
import { drillById } from './endgame-core.js';
import { button, el } from './dom.js';
import { CATEGORIES, ACTIVITIES, PERIODS, axisTop, daily, duration, share, summarize } from './stats-core.js';
import { store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const DAYS = 30;

function swatch(category) {
  const s = el('span', 'st-swatch');
  s.style.background = CAT[category]?.color ?? 'var(--text-dim)';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

const detailName = (activity, detail) => (activity === 'endgame-drill' ? drillById(detail)?.name ?? detail : detail);

function shortDate(iso, opts = { day: 'numeric', month: 'short' }) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

export class StatsView {
  /** @param {{flush: () => Promise<void>}} deps  sends the time being counted, so it shows */
  constructor(deps) {
    this.flush = deps.flush;
    this.el = $('stats-view');
    this.data = null;
  }

  async refresh() {
    await this.flush?.();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
      this.data = await api.timeSpent(tz);
    } catch (err) {
      toast(err.message, 'error');
      this.data = null;
    }
    this.draw();
  }

  hide() {}

  draw() {
    const box = this.el;
    box.replaceChildren();
    const period = store.get('statsPeriod', 'week');
    const head = el('div', 'st-head');
    const title = el('div', 'st-title');
    title.append(el('h2', 'dash-h st-h', 'Time spent'), el('p', 'meta st-sub', 'Counted while the app is open and you’ve touched it in the last 2 minutes.'));
    const chips = el('div', 'tr-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Period');
    for (const p of PERIODS) {
      const b = button(p.label, 'tr-chip-btn', () => {
        store.set('statsPeriod', p.id);
        this.draw();
      });
      b.dataset.period = p.id;
      b.setAttribute('aria-pressed', String(p.id === period));
      chips.appendChild(b);
    }
    head.append(title, chips);
    box.appendChild(head);

    const d = this.data;
    if (!d) {
      box.appendChild(el('p', 'meta', 'Stats are unavailable right now.'));
      return;
    }
    const sum = summarize(d.rows, d.today, period);
    box.appendChild(this._split(sum, period));
    box.appendChild(this._daily(d));
    box.appendChild(this._breakdown(sum));
    const note = el('p', 'meta st-note');
    note.textContent = d.tracking_since
      ? `Tracking since ${new Date(d.tracking_since).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}. Before that, only rated puzzles, Woodpecker puzzles and endgame drills kept their times (each capped at 10 minutes).`
      : 'Tracking starts now. Until then, only rated puzzles, Woodpecker puzzles and endgame drills have times (each capped at 10 minutes).';
    box.appendChild(note);
  }

  /** The period's total and its split by category: one bar plus a legend with times and shares. */
  _split(sum, period) {
    const card = el('section', 'dash-card st-split');
    card.setAttribute('aria-labelledby', 'st-split-h');
    const label = PERIODS.find((p) => p.id === period)?.label ?? '';
    const h = el('h3', 'dash-h', 'By category');
    h.id = 'st-split-h';
    h.appendChild(el('span', 'meta', period === 'all' ? 'all time' : period === 'today' ? 'today' : `last ${label}`));
    card.appendChild(h);
    const total = el('div', 'st-total');
    total.append(el('span', 'st-total-n', duration(sum.total)), el('span', 'meta', sum.total ? 'in total' : 'nothing yet in this period'));
    card.appendChild(total);

    const bar = el('div', 'st-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute(
      'aria-label',
      CATEGORIES.filter((c) => sum.byCategory[c.id])
        .map((c) => `${c.label} ${duration(sum.byCategory[c.id])} (${share(sum.byCategory[c.id], sum.total)})`)
        .join(', ') || 'No time recorded',
    );
    for (const c of CATEGORIES) {
      const v = sum.byCategory[c.id];
      if (!v) continue;
      const seg = el('span', 'st-bar-seg');
      seg.style.flexGrow = String(v);
      seg.style.background = c.color;
      seg.title = `${c.label}: ${duration(v)} (${share(v, sum.total)})`;
      bar.appendChild(seg);
    }
    if (!sum.total) bar.classList.add('empty');
    card.appendChild(bar);

    const legend = el('ul', 'st-legend');
    for (const c of CATEGORIES) {
      const v = sum.byCategory[c.id];
      const li = el('li', v ? '' : 'none');
      li.dataset.category = c.id;
      li.append(swatch(c.id), el('span', 'st-legend-name', c.label), el('span', 'st-legend-time', duration(v)), el('span', 'meta st-legend-share', share(v, sum.total)));
      legend.appendChild(li);
    }
    card.appendChild(legend);
    return card;
  }

  /** The last 30 days as stacked bars (categories in legend order), with a tooltip and a table. */
  _daily(d) {
    const days = daily(d.rows, d.today, DAYS);
    const card = el('section', 'dash-card st-daily');
    card.setAttribute('aria-labelledby', 'st-daily-h');
    const h = el('h3', 'dash-h', 'Last 30 days');
    h.id = 'st-daily-h';
    card.appendChild(h);
    const max = Math.max(...days.map((x) => x.total));
    if (!max) {
      card.appendChild(el('p', 'meta', 'Nothing in the last 30 days yet.'));
      return card;
    }
    const { top, step } = axisTop(max);
    const chart = el('div', 'st-chart');
    const plot = el('div', 'st-plot');
    for (let v = 0; v <= top; v += step) {
      const g = el('div', 'st-grid');
      g.style.bottom = `${(100 * v) / top}%`;
      g.appendChild(el('span', 'st-grid-label', v ? duration(v) : '0'));
      plot.appendChild(g);
    }
    const cols = el('div', 'st-cols');
    const tip = el('div', 'st-tip');
    tip.hidden = true;
    const show = (col, x) => {
      tip.replaceChildren(el('strong', '', shortDate(x.date, { weekday: 'short', day: 'numeric', month: 'short' })), el('span', 'st-tip-total', duration(x.total)));
      for (const c of CATEGORIES) {
        if (!x.values[c.id]) continue;
        const row = el('span', 'st-tip-row');
        row.append(swatch(c.id), el('span', '', c.label), el('span', 'st-tip-v', duration(x.values[c.id])));
        tip.appendChild(row);
      }
      tip.hidden = false;
      const r = col.getBoundingClientRect();
      const p = chart.getBoundingClientRect();
      const left = r.left - p.left + r.width / 2;
      tip.style.left = `${Math.min(Math.max(left, 80), p.width - 80)}px`;
    };
    const hideTip = () => (tip.hidden = true);
    days.forEach((x, i) => {
      const col = el('div', 'st-col');
      col.dataset.date = x.date;
      if (x.date === d.today) col.classList.add('today');
      if (x.total) {
        col.tabIndex = 0;
        col.setAttribute('aria-label', `${shortDate(x.date)}: ${duration(x.total)}`);
        const stack = el('div', 'st-stack');
        stack.style.height = `${(100 * x.total) / top}%`;
        for (const c of CATEGORIES) {
          const v = x.values[c.id];
          if (!v) continue;
          const seg = el('span', 'st-seg');
          seg.style.flexGrow = String(v);
          seg.style.background = c.color;
          stack.appendChild(seg);
        }
        col.appendChild(stack);
        col.addEventListener('pointerenter', () => show(col, x));
        col.addEventListener('focus', () => show(col, x));
        col.addEventListener('pointerleave', hideTip);
        col.addEventListener('blur', hideTip);
      }
      cols.appendChild(col);
      if (i % 7 === days.length % 7 || i === days.length - 1) col.dataset.label = i === days.length - 1 ? 'Today' : shortDate(x.date);
    });
    plot.appendChild(cols);
    chart.append(plot, tip);
    card.appendChild(chart);

    const legend = el('ul', 'st-legend st-legend-inline');
    for (const c of CATEGORIES) {
      if (!days.some((x) => x.values[c.id])) continue;
      const li = el('li');
      li.append(swatch(c.id), el('span', '', c.label));
      legend.appendChild(li);
    }
    card.appendChild(legend);

    const det = el('details', 'st-table');
    det.appendChild(el('summary', '', 'Show as a table'));
    const table = el('table', 'st-tbl');
    const thead = el('tr');
    thead.append(el('th', '', 'Day'), ...CATEGORIES.map((c) => el('th', 'num', c.label)), el('th', 'num', 'Total'));
    table.appendChild(thead);
    for (const x of days.filter((y) => y.total).reverse()) {
      const tr = el('tr');
      tr.append(el('td', '', shortDate(x.date)), ...CATEGORIES.map((c) => el('td', 'num', x.values[c.id] ? duration(x.values[c.id]) : '')), el('td', 'num', duration(x.total)));
      table.appendChild(tr);
    }
    det.appendChild(table);
    card.appendChild(det);
    return card;
  }

  /** Each activity in the period, largest first, with its main openings / courses / drills. */
  _breakdown(sum) {
    const card = el('section', 'dash-card st-break');
    card.setAttribute('aria-labelledby', 'st-break-h');
    const h = el('h3', 'dash-h', 'By activity');
    h.id = 'st-break-h';
    card.appendChild(h);
    if (!sum.breakdown.length) {
      card.appendChild(el('p', 'meta', 'Nothing in this period yet.'));
      return card;
    }
    const list = el('ul', 'st-acts');
    const top = sum.breakdown[0].seconds;
    for (const b of sum.breakdown) {
      const li = el('li', 'st-act');
      li.dataset.activity = b.activity;
      const name = el('div', 'st-act-name');
      name.append(swatch(b.category), el('span', '', ACTIVITIES[b.activity] ?? b.activity), el('span', 'meta', CAT[b.category]?.label ?? b.category));
      const time = el('div', 'st-act-time');
      time.append(el('span', '', duration(b.seconds)), el('span', 'meta', share(b.seconds, sum.total)));
      const meter = el('div', 'st-act-meter');
      const fill = el('span');
      fill.style.width = `${(100 * b.seconds) / top}%`;
      meter.appendChild(fill);
      li.append(name, time, meter);
      if (b.details.length) {
        const shown = b.details.slice(0, 4).map((x) => `${detailName(b.activity, x.detail)} ${duration(x.seconds)}`);
        if (b.details.length > 4) shown.push(`+${b.details.length - 4} more`);
        li.appendChild(el('div', 'meta st-act-details', shown.join(' · ')));
      }
      list.appendChild(li);
    }
    card.appendChild(list);
    return card;
  }
}
