// Lichess game import (Games tab): your recent Lichess games, fetched when the box opens, with
// Open (imports the game into Games once, then opens it on the board), Open latest and Import
// all new. Your Lichess username is an app setting, asked for the first time.

import { api } from './api.js';
import { formDialog, plural, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZES = [20, 50, 100];

/** Your result in a game: 'won' / 'lost' / 'drawn' / null (unfinished, or neither side is you). */
export function outcome(result, myColor) {
  if (!myColor || result === '*') return null;
  if (result === '1/2-1/2') return 'drawn';
  return (result === '1-0') === (myColor === 'white') ? 'won' : 'lost';
}

/** "JasonS (1850) v Opponent (1790)" */
export function playersLine(g) {
  const side = (name, rating) => `${name}${rating ? ` (${rating})` : ''}`;
  return `${side(g.white, g.white_rating)} v ${side(g.black, g.black_rating)}`;
}

/** "Rapid 10+0 · rated · Caro-Kann Defense · 34 moves" */
export function detailsLine(g) {
  const kind = [g.speed, g.clock].filter(Boolean).join(' ');
  return [kind, g.rated ? 'rated' : 'casual', g.opening, g.plies ? plural(Math.ceil(g.plies / 2), 'move') : '']
    .filter(Boolean)
    .join(' · ');
}

/** "Today 14:05", "Yesterday 09:30", "3 Nov 21:10", "3 Nov 2025" (in this browser's time zone). */
export function whenText(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  const opts = d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  const date = d.toLocaleDateString('en-GB', opts);
  return d.getFullYear() === now.getFullYear() ? `${date} ${time}` : date;
}

const OUTCOME_TEXT = { won: 'Won', lost: 'Lost', drawn: 'Drawn' };

export class LichessGames {
  /**
   * @param {object} deps
   * @param {(id: number) => Promise<void>} deps.onOpen  open a saved game on the board
   * @param {() => void} deps.onImported             games were added (refresh the Games list)
   */
  constructor({ onOpen, onImported }) {
    Object.assign(this, { onOpen, onImported });
    this.username = null;
    this.size = PAGE_SIZES[0];
    this.loading = false;
    this.el = {
      toggle: $('games-lichess'),
      box: $('lichess-box'),
      user: $('lichess-user'),
      change: $('lichess-change'),
      latest: $('lichess-latest'),
      importNew: $('lichess-import-new'),
      close: $('lichess-close'),
      status: $('lichess-status'),
      list: $('lichess-list'),
      more: $('lichess-more'),
    };
    this.el.toggle.addEventListener('click', () => (this.el.box.hidden ? this.show() : this.hide()));
    this.el.close.addEventListener('click', () => this.hide());
    this.el.change.addEventListener('click', () => this.askUsername().then((ok) => ok && this.load()));
    this.el.latest.addEventListener('click', () => this.openLatest());
    this.el.importNew.addEventListener('click', () => this.importNew());
    this.el.more.addEventListener('click', () => {
      this.size = PAGE_SIZES[PAGE_SIZES.indexOf(this.size) + 1] ?? this.size;
      this.load();
    });
  }

  /** Open the box again after a reload if it was open. */
  async restore() {
    if (store.get('lichessOpen', false)) await this.show();
  }

  async _settings() {
    if (this.username === null) {
      try {
        this.username = (await api.lichessSettings()).username ?? '';
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    }
    return true;
  }

  async show() {
    if (!(await this._settings())) return;
    if (!this.username && !(await this.askUsername())) return;
    this.el.box.hidden = false;
    this.el.toggle.classList.add('active');
    store.set('lichessOpen', true);
    await this.load();
  }

  hide() {
    this.el.box.hidden = true;
    this.el.toggle.classList.remove('active');
    store.set('lichessOpen', false);
  }

  /** Ask for the Lichess username; true if one is set afterwards. */
  async askUsername() {
    const values = await formDialog({
      title: 'Your Lichess username',
      message:
        'Your games are public on Lichess, so the username is all MPCT needs (no password or token). ' +
        'It is also added to your names in games, so puzzles know which side was you.',
      fields: [{ name: 'username', label: 'Username', value: this.username || '', placeholder: 'e.g. DrNykterstein', maxLength: 30 }],
      submit: 'Save',
    });
    if (!values) return Boolean(this.username);
    try {
      this.username = (await api.setLichessUsername(values.username)).username ?? '';
    } catch (err) {
      toast(err.message, 'error');
      return Boolean(this.username);
    }
    return Boolean(this.username);
  }

  _busy(on) {
    this.loading = on;
    for (const b of [this.el.latest, this.el.importNew, this.el.change, this.el.more]) b.disabled = on;
  }

  async load() {
    const e = this.el;
    e.user.textContent = this.username ? `as ${this.username}` : '';
    e.status.hidden = false;
    e.status.textContent = 'Fetching your games from Lichess…';
    e.more.hidden = true;
    this._busy(true);
    let res;
    try {
      res = await api.lichessGames(this.size);
    } catch (err) {
      e.list.innerHTML = '';
      e.status.textContent = `Couldn't fetch your Lichess games: ${err.message}`;
      return;
    } finally {
      this._busy(false);
    }
    this.games = res.games;
    e.list.innerHTML = '';
    if (!res.games.length) {
      e.status.textContent = `No finished games on Lichess for ${res.username}.`;
      return;
    }
    const fresh = res.games.filter((g) => g.importable && !g.game_id).length;
    e.status.textContent = `Your last ${plural(res.games.length, 'game')} on Lichess` + (fresh ? ` · ${fresh} not in Games yet` : ' · all in Games');
    e.importNew.hidden = !fresh;
    e.importNew.textContent = `Import ${plural(fresh, 'new game')}`;
    for (const g of res.games) e.list.appendChild(this._row(g));
    e.more.hidden = res.games.length < this.size || this.size === PAGE_SIZES.at(-1);
  }

  _row(g) {
    const row = document.createElement('div');
    row.className = 'game-row lichess-row';
    row.dataset.id = g.id;

    const date = document.createElement('div');
    date.className = 'game-date';
    date.textContent = whenText(g.played_at);

    const main = document.createElement('div');
    main.className = 'game-main';
    const players = document.createElement('div');
    players.className = 'game-players';
    players.textContent = playersLine(g);
    const sub = document.createElement('div');
    sub.className = 'game-sub';
    sub.textContent = detailsLine(g);
    main.append(players, sub);
    if (g.game_id || !g.importable) {
      const note = document.createElement('div');
      note.className = g.game_id ? 'game-reviewed yes' : 'game-reviewed';
      note.textContent = g.game_id ? '✓ In your Games' : g.not_importable;
      main.appendChild(note);
    }

    const result = document.createElement('div');
    const out = outcome(g.result, g.my_color);
    result.className = `game-result${out ? ` ${out}` : ''}`;
    result.textContent = out ? OUTCOME_TEXT[out] : g.result === '1/2-1/2' ? '½-½' : g.result;

    const actions = document.createElement('div');
    actions.className = 'game-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'small primary';
    open.textContent = 'Open';
    open.disabled = !g.importable;
    open.title = g.game_id ? 'Open your copy in Games' : 'Import into Games and open it on the board';
    open.addEventListener('click', () => this.open(g, open));
    const link = document.createElement('a');
    link.className = 'button small';
    link.href = `https://lichess.org/${g.id}${g.my_color === 'black' ? '/black' : ''}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Lichess';
    actions.append(open, link);

    row.append(date, main, result, actions);
    return row;
  }

  async open(g, button) {
    if (this.loading) return;
    button.disabled = true;
    let r;
    try {
      r = await api.importLichessGame(g.id);
    } catch (err) {
      button.disabled = false;
      toast(err.message, 'error');
      return;
    }
    g.game_id = r.game_id;
    button.disabled = false;
    if (r.created) this.onImported?.();
    await this.onOpen(r.game_id);
    if (r.created) toast('Imported from Lichess into your Games.');
  }

  /** One tap: your most recent finished Lichess game, imported and on the board. */
  async openLatest() {
    if (this.loading) return;
    this._busy(true);
    let r;
    try {
      r = await api.importLichessLatest();
    } catch (err) {
      toast(err.message, 'error');
      return;
    } finally {
      this._busy(false);
    }
    if (r.created) this.onImported?.();
    await this.onOpen(r.game_id);
    toast(r.created ? 'Your latest Lichess game, imported into your Games.' : 'Your latest Lichess game (already in your Games).');
  }

  async importNew() {
    if (this.loading) return;
    this._busy(true);
    let r;
    try {
      r = await api.importLichessNew(this.size);
    } catch (err) {
      toast(err.message, 'error');
      return;
    } finally {
      this._busy(false);
    }
    toast(`Imported ${plural(r.imported, 'game')} from Lichess.`);
    this.onImported?.();
    await this.load();
  }
}
