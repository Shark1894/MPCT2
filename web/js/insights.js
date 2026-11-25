// Dashboard insights: learning-stage bars, the due forecast, the activity heatmap,
// the openings overview, and sorting/filtering the line list. The helpers at the top
// are pure (unit tested); the render functions build DOM.

import { daysFromToday, describeDue, plural, tagTree } from './ui.js';

export const STAGES = [
  ['mastered', 'Mastered'],
  ['known', 'Known'],
  ['learning', 'Learning'],
  ['new', 'New'],
];
export const WEAKEST_LIMIT = 15;
// Days until the next review after N correct in a row (mirrors app/core/scheduling.py).
export const INTERVALS = [0, 1, 3, 7, 14, 30, 60];

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

/**
 * Lines grouped by how many times in a row they've been right: a 'new' row (never
 * reviewed), then one row per streak 0..5 and a last '6+' row (the gap stops growing
 * there). Each row: { key, streak, label, gap, stage, lines }.
 */
export function streakBreakdown(lines) {
  const top = INTERVALS.length - 1;
  const stageOf = (n) => (n >= 5 ? 'mastered' : n >= 2 ? 'known' : 'learning');
  const gapText = (days) => `next in ${plural(days, 'day')}`;
  const rows = [{ key: 'new', streak: null, label: 'New', gap: 'never reviewed', stage: 'new', lines: [] }];
  for (let n = 0; n <= top; n++) {
    rows.push({
      key: String(n),
      streak: n,
      label: n === top ? `${n}+× correct` : `${n}× correct`,
      gap: n === 0 ? 'last had a mistake' : n === top ? `every ${INTERVALS[n]} days` : gapText(INTERVALS[n]),
      stage: stageOf(n),
      lines: [],
    });
  }
  for (const l of lines) {
    const row = l.reviews === 0 ? rows[0] : rows[1 + Math.min(Math.max(l.streak, 0), top)];
    row.lines.push(l);
  }
  return rows;
}

/**
 * Branch rows (from the server's `branches`) nested under their parents: [{ branch, depth }].
 * The "No branch" row (id null) goes last.
 */
export function branchRows(branches) {
  const tagged = branches.filter((b) => b.id !== null);
  const rows = tagTree(tagged).map(({ tag, depth }) => ({ branch: tag, depth }));
  for (const b of branches) if (b.id === null) rows.push({ branch: b, depth: 0 });
  return rows;
}

/** Totals over every opening in the overview, for the whole-repertoire row. */
export function repertoireTotals(openings) {
  const m = { new: 0, learning: 0, known: 0, mastered: 0 };
  let lines = 0, due = 0, reviews = 0, correct = 0;
  for (const o of openings) {
    for (const k of Object.keys(m)) m[k] += o.mastery[k];
    lines += o.lines;
    due += o.due;
    reviews += o.reviews;
    correct += Math.round((o.accuracy ?? 0) * o.reviews);
  }
  return { lines, due, reviews, accuracy: reviews ? correct / reviews : null, mastery: m };
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

/**
 * Horizontal bar per streak count; `onTrain(lines, label)` trains one row's lines. Tapping a row's
 * name lists its lines (soonest review first); `open` is a Set of row keys kept open across redraws,
 * `tagNames` a Map of branch names for the chips, `onShowLine(sans)` puts a line on the board.
 */
export function renderStreaks(box, lines, onTrain, { open = new Set(), tagNames = new Map(), onShowLine } = {}) {
  box.innerHTML = '';
  const rows = streakBreakdown(lines);
  const max = Math.max(1, ...rows.map((r) => r.lines.length));
  for (const r of rows) {
    const n = r.lines.length;
    const row = el('div', n ? 'sb-row' : 'sb-row zero');
    row.dataset.key = r.key;
    const name = el(n ? 'button' : 'div', 'sb-label');
    if (n) name.type = 'button';
    name.append(el('span', 'sb-name', r.label), el('span', 'sb-gap', r.gap));
    const track = el('div', 'sb-track');
    const bar = el('span', `sb-bar m-${r.stage}`);
    bar.style.width = n ? `max(4px, ${(n / max) * 100}%)` : '0';
    track.appendChild(bar);
    const count = el('div', 'sb-count', String(n));
    count.setAttribute('aria-label', plural(n, 'line'));
    const train = el('button', 'small sb-train', 'Train');
    train.type = 'button';
    train.disabled = !n;
    const what = r.key === 'new' ? 'new lines' : `lines at ${r.label}`;
    train.title = `Revise the ${plural(n, 'line')} here (lines not due yet don't move up a stage)`;
    train.addEventListener('click', () => onTrain(r.lines, what));
    row.append(name, track, count, train);
    box.appendChild(row);
    if (!n) continue;

    const list = el('ul', 'sb-lines');
    list.id = `sb-lines-${r.key}`;
    const sorted = [...r.lines].sort((a, b) => a.next_review_on.localeCompare(b.next_review_on) || a.id - b.id);
    for (const l of sorted) {
      const item = el('li');
      const btn = el('button', 'sb-line');
      btn.type = 'button';
      btn.title = 'Show this line on the board';
      const moves = el('span', 'sb-line-moves', formatMoves(l.moves));
      const chips = el('span', 'sb-line-tags');
      for (const id of l.tags ?? []) if (tagNames.has(id)) chips.appendChild(el('span', 'line-tag', tagNames.get(id)));
      const due = daysFromToday(l.next_review_on) <= 0;
      btn.append(moves, chips, el('span', due ? 'sb-line-due is-due' : 'sb-line-due', describeDue(l.next_review_on)));
      btn.addEventListener('click', () => onShowLine?.(l.moves));
      item.appendChild(btn);
      list.appendChild(item);
    }
    const setOpen = (on) => {
      list.hidden = !on;
      name.setAttribute('aria-expanded', String(on));
      row.classList.toggle('open', on);
      if (on) open.add(r.key);
      else open.delete(r.key);
    };
    name.setAttribute('aria-controls', list.id);
    name.title = 'Show the lines here';
    setOpen(open.has(r.key));
    name.addEventListener('click', () => setOpen(list.hidden));
    box.appendChild(list);
  }
}

/**
 * One stacked learning-stage bar per branch, nested under its parent, bar length by line count.
 * `onPick(branch)` (optional) runs when a branch is tapped; the "No branch" row isn't tappable.
 */
export function renderBranches(box, branches, { onPick, selectedId = null } = {}) {
  box.innerHTML = '';
  const rows = branchRows(branches);
  if (!rows.length) {
    box.appendChild(el('p', 'meta', 'No branch tags in this opening yet. Tag a position on the Board to group its lines.'));
    return;
  }
  const max = Math.max(1, ...rows.map(({ branch }) => branch.lines));
  for (const { branch: b, depth } of rows) {
    const clickable = onPick && b.id !== null;
    const row = el(clickable ? 'button' : 'div', b.id === null ? 'br-row other' : 'br-row');
    if (clickable) {
      row.type = 'button';
      row.title = `Show only ${b.name}`;
      row.setAttribute('aria-pressed', String(b.id === selectedId));
      row.addEventListener('click', () => onPick(b));
    }
    const name = el('span', 'br-name', b.name);
    name.style.paddingLeft = `${depth * 14}px`;
    if (depth) name.classList.add('sub');
    const track = el('span', 'br-track');
    const bar = masteryBar(b.mastery, { compact: true });
    bar.style.width = `max(12px, ${(b.lines / max) * 100}%)`;
    track.appendChild(bar);
    const count = el('span', 'br-count', String(b.lines));
    count.title = plural(b.lines, 'line');
    const due = el('span', b.due ? 'br-due is-due' : 'br-due', b.due ? `${b.due} due` : '');
    row.append(name, track, count, due);
    box.appendChild(row);
  }
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

/** Repertoire overview: one row per opening. Clicking a row selects it. */
export function renderOverview(list, openings, selectedId, onSelect, { open = new Set(), onPickBranch } = {}) {
  list.innerHTML = '';
  if (!openings.length) {
    list.appendChild(el('p', 'meta', 'No openings yet.'));
    return;
  }
  const cells = (row, o, label) => {
    const due = el('span', o.due ? 'ov-due is-due' : 'ov-due', o.due ? `${o.due} due` : 'none due');
    const acc = el('span', 'ov-acc', o.accuracy === null ? '—' : `${Math.round(o.accuracy * 100)}%`);
    acc.title = 'Accuracy: reviews without mistakes';
    const lines = el('span', 'ov-lines meta', plural(o.lines, 'line'));
    row.append(label, lines, due, acc, masteryBar(o.mastery, { compact: true }));
  };

  if (openings.length > 1) {
    const total = el('div', 'ov-row ov-total');
    const name = el('span', 'ov-name');
    name.append(el('span', 'ov-label', 'All openings'));
    cells(total, repertoireTotals(openings), name);
    const item = el('div', 'ov-item');
    item.append(total, el('span', 'ov-expand-spacer'));
    list.appendChild(item);
  }

  for (const o of openings) {
    const item = el('div', 'ov-item');
    const row = el('button', 'ov-row');
    row.type = 'button';
    row.setAttribute('aria-pressed', String(o.id === selectedId));
    const name = el('span', 'ov-name');
    name.append(el('span', `ov-colour ${o.color}`), el('span', 'ov-label', o.name));
    cells(row, o, name);
    row.addEventListener('click', () => onSelect(o.id));
    item.appendChild(row);

    const branches = o.branches ?? [];
    if (!branches.length) {
      item.appendChild(el('span', 'ov-expand-spacer'));
      list.appendChild(item);
      continue;
    }
    const toggle = el('button', 'ov-expand', '▸');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', `Branches of ${o.name}`);
    const box = el('div', 'ov-branches');
    box.id = `ov-branches-${o.id}`;
    toggle.setAttribute('aria-controls', box.id);
    renderBranches(box, branches, { onPick: onPickBranch && ((b) => onPickBranch(o.id, b.id)) });
    const setOpen = (on) => {
      box.hidden = !on;
      toggle.setAttribute('aria-expanded', String(on));
      toggle.textContent = on ? '▾' : '▸';
      if (on) open.add(o.id);
      else open.delete(o.id);
    };
    setOpen(open.has(o.id));
    toggle.addEventListener('click', () => setOpen(box.hidden));
    item.appendChild(toggle);
    list.append(item, box);
  }
}
