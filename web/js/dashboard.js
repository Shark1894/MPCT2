// Dashboard view: one opening's stats and lines with their review history, plus
// per-line and per-opening actions. Follows the repertoire panel's selected opening.

import { api } from './api.js';
import { confirmDialog, describeDue, daysFromToday, fillOpeningSelect, plural, store, toast } from './ui.js';
import {
  enableTips,
  masteryBar,
  renderActivity,
  renderForecast,
  renderOverview,
  renderProblems,
  viewLines,
  weakestLines,
} from './insights.js';

const $ = (id) => document.getElementById(id);

/** SAN list -> "1.e4 c6 2.d4 d5" (lines always start from the initial position). */
export function formatLine(sans) {
  const out = [];
  sans.forEach((san, i) => out.push(i % 2 === 0 ? `${i / 2 + 1}.${san}` : san));
  return out.join(' ');
}

export class DashboardView {
  /**
   * @param {object} deps
   * @param {import('./repertoire.js').RepertoirePanel} deps.repertoire
   * @param {(opening, mode: 'due'|'all', lineId?: number|number[], tag?, label?: string) => void} deps.onTrain
   * @param {(sans: string[]) => void} deps.onShowLine
   */
  constructor({ repertoire, onTrain, onShowLine }) {
    Object.assign(this, { repertoire, onTrain, onShowLine });
    this.data = null;
    this.view = { sort: 'due', filter: 'all', search: '', ...store.get('dashView', {}) };
    this.el = {
      opening: $('dash-opening'),
      tag: $('dash-tag'),
      color: $('dash-color'),
      trainDue: $('dash-train-due'),
      trainAll: $('dash-train-all'),
      resetAll: $('dash-reset-all'),
      deleteAll: $('dash-delete-all'),
      deleteOpening: $('dash-delete-opening'),
      stats: {
        lines: $('stat-lines'),
        due: $('stat-due'),
        next: $('stat-next'),
        reviews: $('stat-reviews'),
        accuracy: $('stat-accuracy'),
      },
      lines: $('dash-lines'),
      empty: $('dash-empty'),
      menu: $('dash-menu'),
      trainWeak: $('dash-train-weak'),
      mastery: $('dash-mastery'),
      fcChart: $('fc-chart'),
      fcNote: $('fc-note'),
      ppList: $('pp-list'),
      ppEmpty: $('pp-empty'),
      ovList: $('ov-list'),
      ovRep: $('ov-rep'),
      actGrid: $('act-grid'),
      actSummary: $('act-summary'),
      sort: $('dash-sort'),
      filter: $('dash-filter'),
      search: $('dash-search'),
      showing: $('dash-showing'),
    };
    const e = this.el;
    e.opening.addEventListener('change', async () => {
      this.repertoire.selectOpening(Number(e.opening.value), true);
      await this.refresh();
    });
    e.tag.addEventListener('change', () => this.repertoire.setTagFilter(e.tag.value ? Number(e.tag.value) : null));
    const tag = () => this.repertoire.currentTag();
    e.trainDue.addEventListener('click', () => this._opening() && this.onTrain(this._opening(), 'due', null, tag()));
    e.trainAll.addEventListener('click', () => this._opening() && this.onTrain(this._opening(), 'all', null, tag()));
    e.trainWeak.addEventListener('click', () => {
      const weak = weakestLines(this.data?.lines ?? []);
      if (weak.length) this.onTrain(this._opening(), 'all', weak.map((l) => l.id), null, 'weakest lines');
    });
    e.sort.value = this.view.sort;
    e.filter.value = this.view.filter;
    e.search.value = this.view.search;
    const changeView = () => {
      this.view = { sort: e.sort.value, filter: e.filter.value, search: e.search.value };
      store.set('dashView', this.view);
      if (this.data) this._renderLines();
    };
    e.sort.addEventListener('change', changeView);
    e.filter.addEventListener('change', changeView);
    e.search.addEventListener('input', changeView);
    enableTips(document.getElementById('dashboard'));
    e.resetAll.addEventListener('click', () => this._closeMenu() || this.resetAll());
    e.deleteAll.addEventListener('click', () => this._closeMenu() || this.deleteAll());
    e.deleteOpening.addEventListener('click', () => this._closeMenu() || this.deleteOpening());
  }

  _opening() {
    return this.repertoire._opening();
  }

  _closeMenu() {
    this.el.menu.open = false;
  }

  async refresh() {
    this._refreshBand(); // overview + activity load alongside the opening
    const openings = this.repertoire.openings;
    const sel = this.el.opening;
    fillOpeningSelect(sel, openings);
    const opening = this._opening();
    const hasOpening = Boolean(opening);
    for (const b of [sel, this.el.trainAll, this.el.resetAll, this.el.deleteAll, this.el.deleteOpening]) b.disabled = !hasOpening;
    if (!hasOpening) {
      this.data = null;
      this._renderEmpty(
        this.repertoire.repId
          ? 'No openings yet. Create one from the Board view with the + next to Opening.'
          : 'No repertoire yet. Create one from the Board view.',
      );
      return;
    }
    sel.value = String(opening.id);

    const tags = this.repertoire.tags;
    const tagSel = this.el.tag;
    tagSel.innerHTML = '';
    tagSel.appendChild(new Option('All lines', ''));
    for (const t of tags) tagSel.appendChild(new Option(t.name, t.id));
    const tagId = this.repertoire.tagId;
    tagSel.value = tagId ? String(tagId) : '';
    tagSel.hidden = tags.length === 0;

    let data;
    try {
      data = await api.dashboard(opening.id, tagId);
    } catch (err) {
      this._renderEmpty(`Couldn't load the dashboard: ${err.message}`);
      return;
    }
    if (this._opening()?.id !== data.opening.id || this.repertoire.tagId !== data.tag_id) return; // changed meanwhile
    this.data = data;
    this._render();
  }

  async _refreshBand() {
    const repId = this.repertoire.repId;
    const rep = this.repertoire.repertoires?.find?.((r) => r.id === repId);
    this.el.ovRep.textContent = rep ? `· ${rep.name}` : '';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const [ov, act] = await Promise.all([
      repId ? api.overview(repId).catch(() => null) : null,
      api.activity(tz).catch(() => null),
    ]);
    if (repId !== this.repertoire.repId) return;
    this.overview = ov?.openings ?? [];
    this._renderOverview();
    if (act) {
      renderActivity(this.el.actGrid, this.el.actSummary, act);
      const scroller = this.el.actGrid.parentElement;
      scroller.scrollLeft = scroller.scrollWidth; // most recent weeks in view on narrow screens
    }
  }

  _renderOverview() {
    renderOverview(this.el.ovList, this.overview ?? [], this._opening()?.id, async (id) => {
      this.repertoire.selectOpening(id, true);
      await this.refresh();
    });
  }

  _renderEmpty(text) {
    this.el.color.textContent = '';
    this.el.trainDue.textContent = 'Train due';
    this.el.trainDue.disabled = true;
    for (const v of Object.values(this.el.stats)) v.textContent = '—';
    this.el.trainWeak.disabled = true;
    this.el.mastery.innerHTML = '';
    this.el.fcChart.innerHTML = '';
    this.el.fcNote.textContent = '';
    this.el.ppList.innerHTML = '';
    this.el.ppEmpty.hidden = true;
    this.el.showing.textContent = '';
    this.el.lines.innerHTML = '';
    this.el.empty.textContent = text;
    this.el.empty.hidden = false;
  }

  _render() {
    const { opening, stats, lines } = this.data;
    const e = this.el;
    e.color.textContent = `You play ${opening.color === 'white' ? 'White' : 'Black'}`;
    e.trainDue.textContent = `Train due (${stats.due})`;
    e.trainDue.disabled = stats.due === 0;
    e.trainAll.disabled = stats.lines === 0;
    e.stats.lines.textContent = stats.lines;
    e.stats.due.textContent = stats.due;
    e.stats.next.textContent = stats.next_review_on ? describeDue(stats.next_review_on) : '—';
    e.stats.reviews.textContent = stats.reviews;
    e.stats.accuracy.textContent = stats.accuracy === null ? '—' : `${Math.round(stats.accuracy * 100)}%`;

    const weak = weakestLines(lines);
    e.trainWeak.textContent = `Train weakest (${weak.length})`;
    e.trainWeak.disabled = weak.length === 0;
    e.mastery.innerHTML = '';
    e.mastery.appendChild(masteryBar(stats.mastery));
    renderForecast(e.fcChart, e.fcNote, this.data.forecast);
    renderProblems(e.ppList, e.ppEmpty, this.data.problems, {
      hasHistory: stats.reviews > 0,
      onShow: (sans) => this.onShowLine(sans),
      onTrain: (p) => this.onTrain(this._opening(), 'all', p.line_ids, null, `${p.expected} problem`),
    });
    this._renderOverview();
    this._renderLines();
  }

  _renderLines() {
    const e = this.el;
    const all = this.data.lines;
    const shown = viewLines(all, this.view);
    e.lines.innerHTML = '';
    e.showing.textContent = all.length ? `Showing ${shown.length} of ${plural(all.length, 'line')}` : '';
    e.empty.hidden = shown.length > 0;
    e.empty.textContent = !all.length
      ? this.data.tag_id
        ? 'No lines pass through this branch’s position.'
        : 'No lines yet. Add some from the Board view with Add line.'
      : 'No lines match. Change Show or clear the move search.';
    for (const line of shown) e.lines.appendChild(this._lineRow(line));
  }

  _lineRow(line) {
    const row = document.createElement('div');
    row.className = 'dash-line';
    row.dataset.lineId = line.id;

    const moves = document.createElement('div');
    moves.className = 'dash-moves';
    moves.textContent = formatLine(line.moves);
    const names = new Map(this.repertoire.tags.map((t) => [t.id, t.name]));
    const chips = (line.tags ?? []).filter((id) => names.has(id));
    if (chips.length) {
      const tagRow = document.createElement('div');
      for (const id of chips) {
        const chip = document.createElement('span');
        chip.className = 'line-tag';
        chip.textContent = names.get(id);
        tagRow.appendChild(chip);
      }
      moves.appendChild(tagRow);
    }

    const due = document.createElement('div');
    due.className = 'dash-due';
    due.textContent = describeDue(line.next_review_on);
    if (daysFromToday(line.next_review_on) <= 0) due.classList.add('is-due');

    const streak = document.createElement('div');
    streak.className = 'dash-streak';
    streak.textContent = `Streak ${line.streak}`;
    streak.title = `${line.correct} of ${plural(line.reviews, 'review')} without mistakes`;

    const recent = document.createElement('div');
    recent.className = 'dash-recent';
    recent.setAttribute('aria-label', `Last results: ${line.recent.map((r) => (r ? 'correct' : 'mistake')).join(', ') || 'none'}`);
    for (let i = 0; i < 5 - line.recent.length; i++) recent.appendChild(this._dot('empty'));
    for (const ok of line.recent) recent.appendChild(this._dot(ok ? 'good' : 'bad'));

    const actions = document.createElement('div');
    actions.className = 'dash-actions-row';
    actions.append(
      this._button('Train', () => this.onTrain(this._opening(), 'all', line.id, null), 'primary'),
      this._button('Show', () => this.onShowLine(line.moves)),
      this._button('Reset', () => this.resetLine(line)),
      this._button('Delete', () => this.deleteLine(line), 'danger-outline'),
    );

    row.append(moves, due, streak, recent, actions);
    return row;
  }

  _dot(kind) {
    const d = document.createElement('span');
    d.className = `dot ${kind}`;
    d.textContent = kind === 'good' ? '✓' : kind === 'bad' ? '✗' : '';
    return d;
  }

  _button(label, onClick, cls = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `small ${cls}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- actions ------------------------------------------------------------

  async _after(message) {
    toast(message);
    await this.repertoire.reloadOpenings().catch(() => {});
    await this.refresh();
  }

  async resetLine(line) {
    const ok = await confirmDialog(
      'Reset this line?',
      `${formatLine(line.moves)}\n\nIts review history is cleared and it becomes due today.`,
      'Reset',
    );
    if (!ok) return;
    try {
      await api.resetLine(line.id);
      await this._after('Line reset');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async deleteLine(line) {
    const ok = await confirmDialog('Delete this line?', `${formatLine(line.moves)}\n\nIt can't be undone.`);
    if (!ok) return;
    try {
      await api.deleteLine(line.id);
      await this._after('Line deleted');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async resetAll() {
    const o = this._opening();
    if (!o) return;
    const ok = await confirmDialog(
      `Reset all lines in ${o.name}?`,
      `The review history of ${plural(o.lines, 'line')} is cleared and they all become due today.`,
      'Reset all',
    );
    if (!ok) return;
    try {
      const res = await api.resetOpening(o.id);
      await this._after(`Reset ${plural(res.lines, 'line')}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async deleteAll() {
    const o = this._opening();
    if (!o) return;
    const ok = await confirmDialog(
      `Delete all lines in ${o.name}?`,
      `${plural(o.lines, 'line')} and their review history will be deleted. The opening itself is kept. It can't be undone.`,
      'Delete all',
    );
    if (!ok) return;
    try {
      const res = await api.deleteAllLines(o.id);
      await this._after(`Deleted ${plural(res.lines, 'line')}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async deleteOpening() {
    await this.repertoire.deleteOpening(); // asks for confirmation itself
    await this.refresh();
  }
}
