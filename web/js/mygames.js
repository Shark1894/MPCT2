// "Your games" panel on the board: from the board position, what was played next in your own
// games (over the board; a switch adds your online games), with the results and your score,
// and the games that reached it. Tap a move to play it; tap a game to open it at that position.
//
// Looked up only while the panel is open, after the position has settled. Answers are kept for
// the session and forgotten when you come back to the board (games may have changed meanwhile).

import { api } from './api.js';
import { compactCount, fitBarLabels, shares } from './masters.js';
import { store } from './ui.js';

const key = (fen) => fen.split(' ').slice(0, 4).join(' ');
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

/** "You +2 =1 −0" from your results ('' when neither side was you in any of the games). */
export function scoreText({ won, drawn, lost }) {
  return won + drawn + lost ? `You +${won} =${drawn} −${lost}` : '';
}

/** "Jason Sharkey – Ally · 1-0 · 2026-01-10 · played c5" for a game row. */
export function gameLine(g) {
  return {
    players: `${g.white || '?'} – ${g.black || '?'}`,
    meta: [g.result.replace('1/2-1/2', '½-½'), g.played_on, g.category === 'online' ? 'online' : '', g.san ? `played ${g.san}` : 'game ended here']
      .filter(Boolean)
      .join(' · '),
  };
}

export class MyGamesPanel {
  /**
   * @param {object} deps
   * @param {(uci: string) => void} deps.onPlay
   * @param {(id: number, ply: number) => void} deps.onOpenGame
   */
  constructor({ onPlay, onOpenGame }) {
    Object.assign(this, { onPlay, onOpenGame });
    const $ = (id) => document.getElementById(id);
    this.el = {
      box: $('mine-box'),
      total: $('mine-total'),
      online: $('mine-online'),
      status: $('mine-status'),
      score: $('mine-score'),
      moves: $('mine-moves'),
      gamesHead: $('mine-games-head'),
      games: $('mine-games'),
    };
    this.cache = new Map(); // groups|key -> data
    this.fen = null;
    this.hidden = false;
    this.timer = null;
    this.seq = 0;
    this.el.box.open = Boolean(store.get('mineOpen', false));
    this.el.online.checked = Boolean(store.get('mineOnline', false));
    this.el.box.addEventListener('toggle', () => {
      store.set('mineOpen', this.el.box.open);
      if (this.el.box.open) this._load(true);
    });
    this.el.online.addEventListener('change', () => {
      store.set('mineOnline', this.el.online.checked);
      this._load(true);
    });
  }

  get groups() {
    return this.el.online.checked ? ['otb', 'online'] : ['otb'];
  }

  /** Forget looked-up positions (your games may have changed). */
  clear() {
    this.cache.clear();
  }

  /** Call on every render. Hidden while training, drilling, solving or playing. */
  update(fen, hidden) {
    const changed = fen !== this.fen || hidden !== this.hidden;
    this.fen = fen;
    this.hidden = hidden;
    this.el.box.hidden = hidden;
    if (!changed || hidden || !this.el.box.open) return;
    this._load(false);
  }

  _id(fen) {
    return `${this.groups.join(',')}|${key(fen)}`;
  }

  _load(now) {
    if (this.hidden || !this.el.box.open || !this.fen) return;
    const id = this._id(this.fen);
    clearTimeout(this.timer);
    if (this.cache.has(id)) {
      this._render(this.cache.get(id));
      return;
    }
    this.timer = setTimeout(() => this._fetch(this.fen), now ? 0 : 250);
  }

  async _fetch(fen) {
    const id = this._id(fen);
    const seq = ++this.seq;
    let data;
    try {
      data = await api.gamesExplorer(fen, this.groups);
    } catch (err) {
      if (seq !== this.seq) return;
      this._clear();
      this._status(err.message, true);
      return;
    }
    this.cache.set(id, data);
    if (seq === this.seq && this._id(this.fen) === id) this._render(data);
  }

  _status(text, error = false) {
    this.el.status.textContent = text;
    this.el.status.hidden = !text;
    this.el.status.classList.toggle('error', error);
  }

  _clear() {
    this.el.total.textContent = '';
    this.el.score.textContent = '';
    this.el.score.hidden = true;
    this.el.moves.innerHTML = '';
    this.el.games.innerHTML = '';
    this.el.gamesHead.hidden = true;
  }

  _render(data) {
    this._clear();
    this._status('');
    const which = data.groups.includes('online') ? 'your OTB or online games' : 'your OTB games';
    if (!data.total) {
      this._status(`Not reached in ${which}.`);
      return;
    }
    this.el.total.textContent = `${data.total} game${data.total === 1 ? '' : 's'}`;
    const score = scoreText(data);
    this.el.score.hidden = !score;
    this.el.score.textContent = score ? `${score} from here` : '';
    for (const m of data.moves) this.el.moves.appendChild(this._moveRow(m, data.total));
    requestAnimationFrame(() => fitBarLabels(this.el.moves));
    this.el.gamesHead.hidden = data.games.length === 0;
    this.el.gamesHead.textContent = data.games.length < data.total ? `Latest ${data.games.length} games` : 'Games';
    for (const g of data.games) this.el.games.appendChild(this._gameRow(g));
  }

  _moveRow(m, total) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mx-move';
    btn.title = `Play ${m.san}`;
    const s = shares(m);
    btn.innerHTML =
      '<span class="mx-san"></span><span class="mx-count"></span><span class="mx-bar" aria-hidden="true"><i class="w"></i><i class="d"></i><i class="b"></i></span><span class="mx-elo"></span>';
    btn.querySelector('.mx-san').textContent = m.san;
    btn.querySelector('.mx-count').textContent = `${compactCount(m.games)} · ${pct(m.games, total)}%`;
    const [w, d, b] = btn.querySelectorAll('.mx-bar i');
    w.style.width = `${s.white}%`;
    d.style.width = `${s.draws}%`;
    b.style.width = `${s.black}%`;
    w.textContent = s.white ? `${s.white}%` : '';
    d.textContent = s.draws ? `${s.draws}%` : '';
    b.textContent = s.black ? `${s.black}%` : '';
    btn.querySelector('.mx-bar').title = `White wins ${s.white}% · draws ${s.draws}% · Black wins ${s.black}%`;
    const score = scoreText(m);
    btn.querySelector('.mx-elo').textContent = score.replace('You ', '');
    btn.querySelector('.mx-elo').title = score;
    btn.setAttribute(
      'aria-label',
      `${m.san}: ${m.games} game${m.games === 1 ? '' : 's'}, ${pct(m.games, total)}%. White wins ${s.white}%, draws ${s.draws}%, Black wins ${s.black}%.` +
        (score ? ` ${score}.` : ''),
    );
    btn.addEventListener('click', () => this.onPlay(m.uci));
    return btn;
  }

  _gameRow(g) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mx-game';
    btn.title = 'Open this game at this position';
    btn.innerHTML = '<span class="mx-players"></span><span class="mx-meta"></span>';
    const line = gameLine(g);
    btn.querySelector('.mx-players').textContent = line.players;
    btn.querySelector('.mx-meta').textContent = line.meta;
    btn.addEventListener('click', () => this.onOpenGame(g.id, g.ply));
    li.appendChild(btn);
    return li;
  }
}
