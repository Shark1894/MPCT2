// Dashboard insights: learning-stage bars, the due forecast, the activity heatmap,
// problem positions, and sorting/filtering the line list. The helpers at the top
// are pure (unit tested); the render functions build DOM.

import { daysFromToday, plural } from './ui.js';

export const STAGES = [
  ['mastered', 'Mastered'],
  ['known', 'Known'],
  ['learning', 'Learning'],
  ['new', 'New'],
];
export const WEAKEST_LIMIT = 15;

// ---- pure helpers -------------------------------------------------------------

/** "1.e4 c6 2.d4" from SAN moves played from the start; `fromPly` numbers a fragment. */
export function formatMoves(sans, fromPly = 1) {
  return sans
    .map((san, i) => {
      const ply = fromPly + i;
      const n = Math.ceil(ply / 2);
      if (ply % 2 === 1) return `${n}.${san}`;
      return i === 0 ? `${n}...${san}` : san;
    })
    .join(' ');
}

/** How badly a line is going: mistakes in its last 5 reviews, the latest counting extra. */
export function weakness(line) {
  const fails = line.recent.filter((ok) => !ok).length;
  if (!fails) return 0;
  return fails * 2 + (line.recent.at(-1) === false ? 1 : 0);
}

const byDue = (a, b) => a.next_review_on.localeCompare(b.next_review_on) || a.id - b.id;
const accuracy = (l) => (l.reviews ? l.correct / l.reviews : 1);

export const SORTS = {
  due: byDue,
  weak: (a, b) => weakness(b) - weakness(a) || a.streak - b.streak || accuracy(a) - accuracy(b) || byDue(a, b),
  streak: (a, b) => a.streak - b.streak || a.reviews - b.reviews || byDue(a, b),
  moves: (a, b) => {
    const n = Math.min(a.moves.length, b.moves.length);
    for (let i = 0; i < n; i++) if (a.moves[i] !== b.moves[i]) return a.moves[i] < b.moves[i] ? -1 : 1;
    return a.moves.length - b.moves.length;
  },
};

export const FILTERS = {
  all: () => true,
  due: (l) => daysFromToday(l.next_review_on) <= 0,
  new: (l) => l.reviews === 0,
  mistakes: (l) => weakness(l) > 0,
  bookmarked: (l) => Boolean(l.bookmarked),
};

/** Lines after filter, move search and sort. Search matches the numbered move text ("Bf5", "3.e5"). */
export function viewLines(lines, { sort = 'due', filter = 'all', search = '' } = {}) {
  const q = search.trim();
  return lines
    .filter(FILTERS[filter] ?? FILTERS.all)
    .filter((l) => !q || ` ${formatMoves(l.moves)} `.includes(q))
    .sort(SORTS[sort] ?? SORTS.due);
}

/** The lines Train weakest uses: any mistake in the last 5 reviews, weakest first. */
export function weakestLines(lines, limit = WEAKEST_LIMIT) {
  return lines.filter((l) => weakness(l) > 0).sort(SORTS.weak).slice(0, limit);
}

/** Heatmap shade 0-4 for a number of reviews. */
export function activityLevel(reviews) {
  if (reviews <= 0) return 0;
  if (reviews <= 3) return 1;
  if (reviews <= 8) return 2;
  if (reviews <= 15) return 3;
  return 4;
}

/**
 * Lay days (oldest first) out as week columns starting on Monday:
 * [[day|null x7], ...]. Leading blanks pad the first week.
 */
export function activityWeeks(days) {
  if (!days.length) return [];
  const first = new Date(`${days[0].date}T12:00:00`);
  const pad = (first.getDay() + 6) % 7; // Monday = 0
  const cells = [...Array(pad).fill(null), ...days];
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7);
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
const asDate = (iso) => new Date(`${iso}T12:00:00`);

// ---- tooltip ------------------------------------------------------------------

let tipEl;
/** One floating tooltip for every element with data-tip inside `root` (hover, focus or tap). */
export function enableTips(root) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.hidden = true;
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  const show = (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t || !root.contains(t)) return;
    tipEl.textContent = t.dataset.tip;
    tipEl.hidden = false;
    const r = t.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    const above = r.top - tipEl.offsetHeight - 8;
    tipEl.style.left = `${x + scrollX}px`;
    tipEl.style.top = `${(above > 4 ? above : r.bottom + 8) + scrollY}px`;
  };
  const hide = (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest?.('[data-tip]')) tipEl.hidden = true;
  };
  root.addEventListener('mouseover', show);
  root.addEventListener('focusin', show);
  root.addEventListener('click', show);
  root.addEventListener('mouseout', hide);
  root.addEventListener('focusout', () => (tipEl.hidden = true));
  addEventListener('scroll', () => (tipEl.hidden = true), { passive: true });
}

// ---- rendering ----------------------------------------------------------------

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Stacked bar of learning stages, plus a text summary unless compact. */
export function masteryBar(m, { compact = false } = {}) {
  const total = STAGES.reduce((n, [k]) => n + m[k], 0);
  const wrap = el('div', compact ? 'mastery compact' : 'mastery');
  const bar = el('div', 'mastery-bar');
  if (!total) bar.classList.add('empty');
  for (const [key, label] of STAGES) {
    if (!m[key]) continue;
    const seg = el('span', `seg m-${key}`);
    seg.style.flexGrow = m[key];
    seg.dataset.tip = `${label}: ${plural(m[key], 'line')} (${Math.round((m[key] / total) * 100)}%)`;
    seg.tabIndex = compact ? -1 : 0;
    bar.appendChild(seg);
  }
  wrap.appendChild(bar);
  const text = STAGES.filter(([k]) => m[k])
    .map(([k, label]) => `${m[k]} ${label.toLowerCase()}`)
    .join(' · ');
  wrap.setAttribute('aria-label', total ? `Learning progress: ${text}` : 'No lines');
  if (!compact) wrap.appendChild(el('p', 'mastery-text', total ? text : 'No lines yet'));
  return wrap;
}

/** Vertical bars: lines due per day; today includes overdue lines. */
export function renderForecast(box, note, forecast) {
  box.innerHTML = '';
  const days = forecast.days;
  const max = Math.max(1, ...days.map((d) => d.due));
  const peak = days.reduce((best, d, i) => (d.due > days[best].due ? i : best), 0);
  const bars = el('div', 'fc-bars');
  days.forEach((d, i) => {
    const col = el('div', 'fc-col');
    const label = i === 0 ? `Today: ${plural(d.due, 'line')} (including overdue)` : `${dayFmt.format(asDate(d.date))}: ${plural(d.due, 'line')}`;
    col.dataset.tip = label;
    col.tabIndex = 0;
    col.setAttribute('aria-label', label);
    const value = el('span', 'fc-value', d.due && (i === 0 || i === peak) ? String(d.due) : '');
    const bar = el('span', 'fc-bar');
    bar.style.height = `${(d.due / max) * 100}%`;
    if (!d.due) bar.classList.add('zero');
    // Every day gets its weekday letter; today's is highlighted (the tooltip says "Today").
    const tick = el('span', i === 0 ? 'fc-tick today' : 'fc-tick', weekdayFmt.format(asDate(d.date)));
    const plot = el('span', 'fc-plot');
    plot.append(value, bar);
    col.append(plot, tick);
    bars.appendChild(col);
  });
  box.appendChild(bars);
  const total = days.reduce((n, d) => n + d.due, 0);
  note.textContent = `${plural(total, 'line')} in the next 14 days` + (forecast.later ? `, ${forecast.later} later.` : '.');
}

/** GitHub-style grid of training days. */
export function renderActivity(grid, summary, act) {
  grid.innerHTML = '';
  const weeks = activityWeeks(act.days);
  const months = el('div', 'act-months');
  let lastMonth = null;
  weeks.forEach((week) => {
    const first = week.find(Boolean);
    const m = first ? asDate(first.date).getMonth() : lastMonth;
    months.appendChild(el('span', '', m !== lastMonth && first ? monthFmt.format(asDate(first.date)) : ''));
    lastMonth = m;
  });
  const body = el('div', 'act-body');
  const labels = el('div', 'act-days');
  for (const name of ['Mon', '', 'Wed', '', 'Fri', '', '']) labels.appendChild(el('span', '', name));
  body.appendChild(labels);
  for (const week of weeks) {
    const col = el('div', 'act-week');
    for (const day of week) {
      const c = el('span', day ? `cell l${activityLevel(day.reviews)}` : 'cell blank');
      if (day) {
        const when = day.date === act.today ? 'Today' : dayFmt.format(asDate(day.date));
        c.dataset.tip = day.reviews
          ? `${when}: ${plural(day.reviews, 'review')}, ${day.correct} without mistakes`
          : `${when}: no training`;
        if (day.date === act.today) c.classList.add('today');
      }
      col.appendChild(c);
    }
    body.appendChild(col);
  }
  grid.append(months, body);
  const total = act.days.reduce((n, d) => n + d.reviews, 0);
  grid.setAttribute('aria-label', `${plural(total, 'review')} on ${plural(act.active_days, 'day')} in the last 26 weeks`);

  const run = act.current_run;
  let runText;
  if (!run) runText = 'No current run: train today to start one.';
  else if (act.trained_today) runText = `Current run: ${plural(run, 'day')}.`;
  else runText = `Current run: ${plural(run, 'day')}. Train today to keep it going.`;
  summary.textContent = `${runText} Longest: ${plural(act.longest_run, 'day')}. ${plural(act.active_days, 'day')} trained.`;
}

/** Problem positions: where you keep going wrong, with what you play instead. */
export function renderProblems(list, empty, problems, { onShow, onTrain, hasHistory }) {
  list.innerHTML = '';
  empty.hidden = problems.length > 0;
  empty.textContent = hasHistory
    ? 'No problem positions: no repeated mistakes in the last 90 days. A position drops off once you get it right 3 times in a row.'
    : 'Train some lines and the moves you get wrong will show up here.';
  for (const p of problems) {
    const li = el('li', 'pp-item');
    const path = el('div', 'pp-path');
    path.append(el('span', 'pp-before', p.moves.length ? `${formatMoves(p.moves)} ` : 'Start: '));
    path.append(el('strong', 'pp-move', formatMoves([p.expected], p.ply)));
    const wrong = el(
      'div',
      'pp-wrong',
      `You played ${p.wrong.map((w) => (w.count > 1 ? `${w.san} (${w.count}×)` : w.san)).join(', ')} instead of ${p.expected}.`,
    );
    const facts = [`Wrong in ${p.times_wrong} of ${plural(p.times_seen, 'review')}`];
    if (p.right_since) facts.push(`right ${p.right_since}× since`);
    const meta = el('div', 'meta pp-meta', facts.join(' · '));
    const actions = el('div', 'pp-actions');
    const show = el('button', 'small', 'Show');
    show.type = 'button';
    show.title = 'Show this position on the board';
    show.addEventListener('click', () => onShow(p.moves));
    const train = el('button', 'small primary', `Train ${plural(p.line_ids.length, 'line')}`);
    train.type = 'button';
    train.title = 'Train the lines that go through this move';
    train.addEventListener('click', () => onTrain(p));
    actions.append(show, train);
    li.append(path, wrong, meta, actions);
    list.appendChild(li);
  }
}

/** Repertoire overview: one row per opening. Clicking a row selects it. */
export function renderOverview(list, openings, selectedId, onSelect) {
  list.innerHTML = '';
  if (!openings.length) {
    list.appendChild(el('p', 'meta', 'No openings yet.'));
    return;
  }
  for (const o of openings) {
    const row = el('button', 'ov-row');
    row.type = 'button';
    row.setAttribute('aria-pressed', String(o.id === selectedId));
    const name = el('span', 'ov-name');
    name.append(el('span', `ov-colour ${o.color}`), el('span', 'ov-label', o.name));
    const due = el('span', o.due ? 'ov-due is-due' : 'ov-due', o.due ? `${o.due} due` : 'none due');
    const acc = el('span', 'ov-acc', o.accuracy === null ? '—' : `${Math.round(o.accuracy * 100)}%`);
    acc.title = 'Accuracy: reviews without mistakes';
    const lines = el('span', 'ov-lines meta', plural(o.lines, 'line'));
    row.append(name, lines, due, acc, masteryBar(o.mastery, { compact: true }));
    row.addEventListener('click', () => onSelect(o.id));
    list.appendChild(row);
  }
}
