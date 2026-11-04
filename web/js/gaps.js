// Repertoire gaps card on the Dashboard: masters replies the selected opening doesn't cover,
// most often met first. "Check with Lichess masters" looks the opening's positions up on the
// server (in the background, cached); the list fills in from whatever has been looked up.

import { api } from './api.js';
import { formatMoves } from './insights.js';
import { plural, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 1500;
const PAGE = 15;
export const MIN_SHARES = [2, 5, 10];

// ---- pure helpers ---------------------------------------------------------------------

/** How often you'd face a reply, from its share of all masters games (percent). */
export function meetText(meet) {
  if (meet === null || meet === undefined) return 'how often you’d reach this isn’t known yet';
  if (meet >= 1) return `you’d meet it in about ${Math.round(meet)} of every 100 games`;
  if (meet <= 0) return 'you’d rarely meet it';
  return `you’d meet it in about 1 game in ${Math.round(100 / meet).toLocaleString('en-GB')}`;
}

/** Status line for the card. */
export function statusText({ positions, checked }, st) {
  if (!positions) return 'Add lines with replies for your opponent to check them against masters games.';
  if (st?.running) return `Checking: ${st.done} of ${st.total} positions looked up…`;
  if (checked === 0) {
    return `Not checked yet: ${plural(positions, 'position')} to look up in the Lichess masters database (about ${Math.max(1, Math.round((positions * 1.2) / 60))} min).`;
  }
  if (checked < positions) return `${checked} of ${plural(positions, 'position')} checked. Check again to look up the rest.`;
  return `All ${plural(positions, 'position')} checked against masters games.`;
}

// ---- the card ---------------------------------------------------------------------------

export class GapsCard {
  /**
   * @param {object} deps
   * @param {(sans: string[]) => void} deps.onShow  put these moves (from the start) on the board
   */
  constructor({ onShow }) {
    this.onShow = onShow;
    this.opening = null;
    this.data = null;
    this.shown = PAGE;
    this.timer = null;
    this.el = {
      min: $('gaps-min'),
      check: $('gaps-check'),
      stop: $('gaps-stop'),
      status: $('gaps-status'),
      progress: $('gaps-progress'),
      bar: $('gaps-bar'),
      error: $('gaps-error'),
      list: $('gaps-list'),
      empty: $('gaps-empty'),
      more: $('gaps-more'),
    };
    for (const n of MIN_SHARES) this.el.min.appendChild(new Option(`${n}% of games or more`, n));
    this.el.min.value = String(store.get('gapsMinShare', 5));
    this.el.min.addEventListener('change', () => {
      store.set('gapsMinShare', Number(this.el.min.value));
      this.shown = PAGE;
      this.load();
    });
    this.el.check.addEventListener('click', () => this.check());
    this.el.stop.addEventListener('click', () => api.explorerStop().catch(() => {}));
    this.el.more.addEventListener('click', () => {
      this.shown += PAGE;
      this._renderList();
    });
  }

  /** The dashboard's opening changed (or was refreshed). */
  async setOpening(opening) {
    if (this.opening?.id !== opening?.id) this.shown = PAGE;
    this.opening = opening;
    await this.load();
  }

  async load() {
    const o = this.opening;
    if (!o) return;
    let data, st;
    try {
      [data, st] = await Promise.all([api.gaps(o.id, Number(this.el.min.value)), api.explorerStatus()]);
    } catch (err) {
      this.el.status.textContent = `Couldn't load gaps: ${err.message}`;
      return;
    }
    if (this.opening?.id !== o.id) return; // changed meanwhile
    this.data = data;
    this.st = st;
    this._render();
    if (st.running && !this.timer) this._poll();
  }

  async check() {
    const o = this.opening;
    if (!o) return;
    try {
      this.st = await api.gapsCheck(o.id);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    this._render();
    this._poll();
  }

  _poll() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      let st;
      try {
        st = await api.explorerStatus();
      } catch {
        return;
      }
      this.st = st;
      if (st.running) {
        this._renderStatus();
        this._poll();
      } else {
        await this.load(); // finished: the list fills in
        if (st.error) toast(st.error, 'error');
      }
    }, POLL_MS);
  }

  _render() {
    this._renderStatus();
    this._renderList();
  }

  _renderStatus() {
    const e = this.el;
    const d = this.data;
    const st = this.st ?? {};
    const mine = st.running && st.opening_id === this.opening?.id;
    const other = st.running && !mine;
    e.status.textContent = other ? 'Another opening is being checked; try again when it finishes.' : statusText(d, mine ? st : null);
    e.progress.hidden = !mine;
    if (mine) e.bar.style.width = `${st.total ? (100 * st.done) / st.total : 0}%`;
    e.check.hidden = mine;
    e.stop.hidden = !mine;
    e.check.disabled = !st.token || !d?.positions || other;
    e.check.textContent = d?.checked && d.checked >= d.positions ? 'Check again' : 'Check with Lichess masters';
    e.check.title = st.token
      ? 'Look the positions up in the Lichess masters database (answers are cached)'
      : 'Needs a Lichess API token on the server (LICHESS_TOKEN in .env)';
    e.error.hidden = st.token && !(st.error && !st.running && st.opening_id === this.opening?.id);
    e.error.textContent = !st.token
      ? 'The Lichess explorer needs a free personal API token: create one at lichess.org/account/oauth/token (no scopes needed), add LICHESS_TOKEN=… to the server’s .env and restart the app.'
      : (st.error ?? '');
  }

  _renderList() {
    const e = this.el;
    const d = this.data;
    e.list.innerHTML = '';
    const gaps = d?.gaps ?? [];
    e.empty.hidden = gaps.length > 0 || !d?.checked;
    e.empty.textContent = `No gaps: every masters reply played in at least ${this.el.min.value}% of games is covered in the positions checked.`;
    for (const g of gaps.slice(0, this.shown)) e.list.appendChild(this._row(g));
    e.more.hidden = gaps.length <= this.shown;
    e.more.textContent = `Show more (${gaps.length - this.shown} more)`;
  }

  _row(g) {
    const li = document.createElement('li');
    li.className = 'pp-item gap-item';
    const path = document.createElement('div');
    path.className = 'pp-path';
    const before = document.createElement('span');
    before.className = 'pp-before';
    before.textContent = g.path.length ? `${formatMoves(g.path)} ` : '';
    const move = document.createElement('strong');
    move.className = 'pp-move';
    move.textContent = formatMoves([g.san], g.ply);
    path.append(before, move);
    const facts = document.createElement('div');
    facts.className = 'pp-wrong';
    facts.textContent = `${g.share}% of masters games here (${g.games.toLocaleString('en-GB')} of ${g.position_games.toLocaleString('en-GB')}); ${meetText(g.meet)}.`;
    const meta = document.createElement('div');
    meta.className = 'meta pp-meta';
    meta.textContent = `Your repertoire: ${g.covered.join(', ')}`;
    const actions = document.createElement('div');
    actions.className = 'pp-actions';
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'small';
    show.textContent = 'Show';
    show.title = 'Put this position and the reply on the board, so you can add a line from there';
    show.addEventListener('click', () => this.onShow([...g.path, g.san]));
    actions.append(show);
    li.append(path, facts, meta, actions);
    return li;
  }
}
