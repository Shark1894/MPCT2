// Wild tab: tournament games (Lichess broadcasts, The Week in Chess) that reach positions
// you watch. The helpers at the top are pure (unit tested); WildView builds the DOM.

import { api } from './api.js';
import { formatMoves } from './insights.js';
import { confirmDialog, formDialog, plural, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const POLL_MS = 3000;

// ---- pure helpers ---------------------------------------------------------------------

/** "Carlsen, Magnus (2830)". */
export function playerText(name, elo) {
  return `${name || '?'}${elo ? ` (${elo})` : ''}`;
}

export function resultText(result) {
  return result === '1/2-1/2' ? '½–½' : result.replace('-', '–');
}

/** "move 6" style text for the ply where a watched position was reached: "3…Bf5" → "move 3". */
export function moveNumber(ply) {
  return Math.ceil(ply / 2);
}

/** A watch's display name: its label, or the last move of its path ("3...Bf5"). */
export function watchName(w) {
  if (w.label) return w.label;
  if (!w.path.length) return 'Start';
  return formatMoves(w.path.slice(-1), w.path.length);
}

/** How long ago, roughly: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(iso, now = Date.now()) {
  if (!iso) return 'never';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** The Wild tab's rating filter (shared with the board's Watch button): a number, or null for any. */
export function minElo() {
  return Number(store.get('wildMinElo', 0)) || null;
}

/** One line describing the fetcher: running step, or when it last checked and what it has. */
export function statusText(st, now = Date.now()) {
  if (!st.enabled) return 'Fetching tournament games is turned off on this server (WILD_FETCH=false).';
  if (st.running) return `Checking for new games… ${st.step}`;
  const parts = [];
  parts.push(st.last_fetch_at ? `Last checked ${ago(st.last_fetch_at, now)}` : 'Not checked yet: the first check starts a minute after the app starts');
  if (st.games) parts.push(`${st.games.toLocaleString('en-GB')} games stored${st.oldest_played_on ? ` since ${st.oldest_played_on}` : ''}`);
  if (st.twic_issue) parts.push(st.twic_first && st.twic_first !== st.twic_issue ? `TWIC ${st.twic_first}–${st.twic_issue}` : `TWIC ${st.twic_issue}`);
  return parts.join(' · ') + '.';
}

// ---- view ---------------------------------------------------------------------------------

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class WildView {
  /**
   * @param {object} deps
   * @param {import('./repertoire.js').RepertoirePanel} deps.repertoire
   * @param {(gameId: number, ply: number) => void} deps.onOpen   open a game on the board at a move
   * @param {(sans: string[]) => void} deps.onShowPosition       put a watched position on the board
   */
  constructor({ repertoire, onOpen, onShowPosition }) {
    Object.assign(this, { repertoire, onOpen, onShowPosition });
    this.watches = [];
    this.games = [];
    this.total = 0;
    this.status = null;
    this.timer = null;
    this.visible = false;
    this.el = {
      statusText: $('wild-status-text'),
      check: $('wild-check'),
      errors: $('wild-errors'),
      rep: $('wild-rep'),
      watches: $('wild-watches'),
      watchesEmpty: $('wild-watches-empty'),
      filter: $('wild-filter'),
      minElo: $('wild-min-elo'),
      search: $('wild-search'),
      count: $('wild-count'),
      list: $('wild-games'),
      empty: $('wild-empty'),
      more: $('wild-more'),
      tabCount: $('wild-new'),
    };
    const e = this.el;
    e.check.addEventListener('click', () => this.checkNow());
    e.filter.addEventListener('change', () => this.loadGames());
    e.minElo.value = minElo() ? String(minElo()) : '';
    e.minElo.addEventListener('change', async () => {
      store.set('wildMinElo', Number(e.minElo.value) || 0);
      await this.loadWatches();
      await this.loadGames();
      this.repertoire.loadTags?.(); // the board's Watch count follows the filter
    });
    let searchTimer = null;
    e.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.loadGames(), 250);
    });
    e.more.addEventListener('click', () => this.loadGames(true));
  }

  get repId() {
    return this.repertoire.repId;
  }

  /** Called when the tab is shown. */
  async refresh() {
    this.visible = true;
    const rep = this.repertoire.repertoires?.find?.((r) => r.id === this.repId);
    this.el.rep.textContent = rep ? `· ${rep.name}` : '';
    store.set('wildSeen', new Date().toISOString());
    this._setTabCount(0);
    await Promise.all([this.loadStatus(), this.loadWatches()]);
    await this.loadGames();
  }

  hide() {
    this.visible = false;
    clearTimeout(this.timer);
  }

  /** On page load: count new spotted games since the tab was last opened. */
  async checkNew() {
    if (!this.repId) return;
    const since = store.get('wildSeen');
    if (!since) return;
    try {
      const st = await api.wildStatus(this.repId, since, minElo());
      if (!this.visible) this._setTabCount(st.new_games);
    } catch {
      /* not important */
    }
  }

  _setTabCount(n) {
    this.el.tabCount.hidden = !n;
    this.el.tabCount.textContent = n ? String(n) : '';
    this.el.tabCount.title = n ? `${plural(n, 'new game')} since you last looked` : '';
  }

  // ---- status -------------------------------------------------------------------------

  async loadStatus() {
    try {
      this.status = await api.wildStatus(this.repId);
    } catch (err) {
      this.el.statusText.textContent = `Couldn’t load the status: ${err.message}`;
      return;
    }
    this._renderStatus();
  }

  _renderStatus() {
    const st = this.status;
    const e = this.el;
    e.statusText.textContent = statusText(st);
    e.check.disabled = st.running || !st.enabled;
    e.check.textContent = st.running ? 'Checking…' : 'Check now';
    e.errors.hidden = st.running || !st.errors.length;
    e.errors.textContent = st.errors.length ? `Last check had problems: ${st.errors.slice(-3).join(' · ')}` : '';
    clearTimeout(this.timer);
    if (st.running && this.visible) {
      this.timer = setTimeout(async () => {
        const wasRunning = this.status?.running;
        await this.loadStatus();
        if (wasRunning && !this.status.running) {
          toast(this.status.added ? `${plural(this.status.added, 'new game')} fetched.` : 'No new games.');
          await this.loadWatches();
          await this.loadGames();
        }
      }, POLL_MS);
    }
  }

  async checkNow() {
    try {
      this.status = await api.wildRefresh(this.repId);
      this.status.running = true; // the run starts in the background
      this.status.step = 'Starting';
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    this._renderStatus();
  }

  // ---- watches ----------------------------------------------------------------------------

  async loadWatches() {
    const e = this.el;
    if (!this.repId) {
      this.watches = [];
    } else {
      try {
        this.watches = await api.watches(this.repId, minElo());
      } catch (err) {
        toast(err.message, 'error');
        this.watches = [];
      }
    }
    e.watches.innerHTML = '';
    e.watchesEmpty.hidden = this.watches.length > 0;
    for (const w of this.watches) e.watches.appendChild(this._watchRow(w));
    const current = e.filter.value;
    e.filter.innerHTML = '';
    e.filter.appendChild(new Option('All watched positions', ''));
    for (const w of this.watches) e.filter.appendChild(new Option(`${w.opening_name}: ${watchName(w)}`, w.id));
    e.filter.value = this.watches.some((w) => String(w.id) === current) ? current : '';
    e.filter.hidden = this.watches.length < 2;
  }

  _watchRow(w) {
    const li = el('li', 'wild-watch');
    const main = el('div', 'wild-watch-main');
    const name = el('div', 'wild-watch-name');
    name.append(el('span', `ov-colour ${w.color}`), el('strong', '', watchName(w)), el('span', 'meta', ` · ${w.opening_name}`));
    const path = el('div', 'meta wild-watch-path', formatMoves(w.path));
    main.append(name, path);
    const count = el(
      'div',
      'wild-watch-count',
      w.games ? `${plural(w.games, 'game')}${w.latest_played_on ? ` · latest ${w.latest_played_on}` : ''}` : minElo() ? `No games with a player ${minElo()}+` : 'No games yet',
    );
    const actions = el('div', 'wild-watch-actions');
    const games = el('button', 'small primary', 'Games');
    games.type = 'button';
    games.disabled = !w.games;
    games.addEventListener('click', () => {
      this.el.filter.value = String(w.id);
      this.loadGames();
      this.el.list.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const show = el('button', 'small', 'Show');
    show.type = 'button';
    show.title = 'Show this position on the board';
    show.addEventListener('click', () => this.onShowPosition(w.path));
    const rename = el('button', 'small', 'Rename');
    rename.type = 'button';
    rename.addEventListener('click', () => this.rename(w));
    const remove = el('button', 'small danger-outline', 'Unwatch');
    remove.type = 'button';
    remove.addEventListener('click', () => this.unwatch(w));
    actions.append(games, show, rename, remove);
    li.append(main, count, actions);
    return li;
  }

  async rename(w) {
    const values = await formDialog({
      title: 'Name this watched position',
      fields: [{ name: 'label', label: 'Name (empty = show the move)', value: w.label, required: false, maxLength: 60 }],
      submit: 'Save',
    });
    if (!values) return;
    try {
      await api.updateWatch(w.id, values.label ?? '');
    } catch (err) {
      toast(err.message, 'error');
    }
    await this.loadWatches();
    this._renderGames();
  }

  async unwatch(w) {
    const ok = await confirmDialog('Stop watching this position?', `${w.opening_name}: ${formatMoves(w.path)}`, 'Unwatch');
    if (!ok) return;
    try {
      await api.deleteWatch(w.id);
      this.repertoire.loadTags?.(); // the board's Watch button follows
    } catch (err) {
      toast(err.message, 'error');
    }
    await this.loadWatches();
    await this.loadGames();
  }

  // ---- games ----------------------------------------------------------------------------------

  async loadGames(more = false) {
    if (!this.repId) return;
    const watchId = this.el.filter.value ? Number(this.el.filter.value) : null;
    const q = this.el.search.value.trim();
    const offset = more ? this.games.length : 0;
    let data;
    try {
      data = await api.wildGames(this.repId, { watchId, q, limit: PAGE, offset, minElo: minElo() });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    this.games = more ? [...this.games, ...data.games] : data.games;
    this.total = data.total;
    this._renderGames();
  }

  _renderGames() {
    const e = this.el;
    e.list.innerHTML = '';
    const filtered = Boolean(e.filter.value || e.search.value.trim() || minElo());
    e.count.textContent = this.total ? `${plural(this.total, 'game')}${this.games.length < this.total ? `, showing ${this.games.length}` : ''}` : '';
    e.empty.hidden = this.games.length > 0;
    e.empty.textContent = !this.watches.length
      ? 'Watch a position to see the tournament games that reach it.'
      : filtered
        ? minElo() && !e.filter.value && !e.search.value.trim()
          ? `No games with a player rated ${minElo()}+ yet. Lower the rating filter to see more.`
          : 'No games match.'
        : 'No tournament games reach your watched positions yet. New games are checked every few hours.';
    e.more.hidden = this.games.length >= this.total;
    const byId = new Map(this.watches.map((w) => [w.id, w]));
    for (const g of this.games) e.list.appendChild(this._gameRow(g, byId));
  }

  _gameRow(g, byId) {
    const row = el('div', 'game-row wild-row');
    const date = el('div', 'game-date', g.played_on || 'No date');
    const main = el('div', 'game-main');
    main.append(el('div', 'game-players', `${playerText(g.white, g.white_elo)} – ${playerText(g.black, g.black_elo)}`));
    const m = g.matches[0];
    const w = byId.get(m.watch_id);
    const reached = w ? `${watchName(w)} at move ${moveNumber(m.ply)}` : `move ${moveNumber(m.ply)}`;
    const more = g.matches.length > 1 ? ` (+${g.matches.length - 1} more)` : '';
    main.append(
      el(
        'div',
        'game-sub',
        [g.event + (g.round ? `, round ${g.round}` : ''), `${Math.ceil(g.plies / 2)} moves`, g.source === 'twic' ? 'TWIC' : 'Lichess']
          .filter(Boolean)
          .join(' · '),
      ),
      el('div', 'game-sub wild-reached', `Reached ${reached}${more}`),
    );
    const result = el('div', 'game-result', resultText(g.result));
    const actions = el('div', 'game-actions wild-actions');
    const open = el('button', 'small primary', 'Open');
    open.type = 'button';
    open.title = 'Open on the board at the watched position';
    open.addEventListener('click', () => this.onOpen(g.id, m.ply));
    const save = el('button', 'small', 'Save to Games');
    save.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const r = await api.saveWildGame(g.id);
        save.textContent = 'Saved ✓';
        toast(r.created ? 'Saved to your Games.' : 'Already in your Games.');
      } catch (err) {
        save.disabled = false;
        toast(err.message, 'error');
      }
    });
    actions.append(open, save);
    row.append(date, main, result, actions);
    return row;
  }
}
