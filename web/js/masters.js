// Masters panel on the board: what strong players play from the board position (Lichess
// masters database), with each move's results, and the top games that reached it. Tap a move
// to play it; tap a game to open it on the board (read-only, Save to Games to keep it).
//
// Looked up only while the panel is open, after the position has settled, and remembered for
// the session; the server caches every position for months (shared with the gap finder).

import { api } from './api.js';
import { store } from './ui.js';

const key = (fen) => fen.split(' ').slice(0, 4).join(' ');
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

/** Surname-ish short name: "Carlsen, Magnus" -> "Carlsen". */
export function shortName(name) {
  const n = (name || '?').trim();
  return n.includes(',') ? n.split(',')[0].trim() : n;
}

/** "1.2k", "34k", "512" for game counts. */
export function compactCount(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** Win/draw/loss shares (whole percents that add up to 100) for a move or position. */
export function shares({ white, draws, black }) {
  const total = white + draws + black;
  if (!total) return { white: 0, draws: 0, black: 0 };
  const w = Math.round((white / total) * 100);
  const b = Math.round((black / total) * 100);
  return { white: w, draws: Math.max(0, 100 - w - b), black: b };
}

/** Drop a bar segment's percentage when it doesn't fit inside the segment (narrow bars, small shares). */
export function fitBarLabels(root) {
  for (const i of root.querySelectorAll('.mx-bar i')) {
    if (i.textContent && i.scrollWidth > i.clientWidth) i.textContent = '';
  }
}

export class MastersPanel {
  /**
   * @param {object} deps
   * @param {(uci: string) => void} deps.onPlay          play a move on the board
   * @param {(id: string, key: string) => void} deps.onOpenGame
   */
  constructor({ onPlay, onOpenGame }) {
    Object.assign(this, { onPlay, onOpenGame });
    const $ = (id) => document.getElementById(id);
    this.el = {
      box: $('masters-box'),
      total: $('masters-total'),
      status: $('masters-status'),
      retry: $('masters-retry'),
      moves: $('masters-moves'),
      gamesHead: $('masters-games-head'),
      games: $('masters-games'),
    };
    this.cache = new Map(); // key -> data (this session)
    this.fen = null;
    this.hidden = false;
    this.shown = null; // key currently drawn
    this.timer = null;
    this.seq = 0;
    this.el.box.open = Boolean(store.get('mastersOpen', false));
    this.el.box.addEventListener('toggle', () => {
      store.set('mastersOpen', this.el.box.open);
      if (this.el.box.open) this._load(true);
    });
    this.el.retry.addEventListener('click', () => this._load(true));
  }

  /** Call on every render. Hidden while training, drilling, solving or playing (it gives answers away). */
  update(fen, hidden) {
    const changed = fen !== this.fen || hidden !== this.hidden;
    this.fen = fen;
    this.hidden = hidden;
    this.el.box.hidden = hidden;
    if (!changed || hidden || !this.el.box.open) return;
    this._load(false);
  }

  _load(now) {
    if (this.hidden || !this.el.box.open || !this.fen) return;
    const k = key(this.fen);
    if (this.cache.has(k)) {
      clearTimeout(this.timer);
      this._render(k, this.cache.get(k));
      return;
    }
    if (this.shown !== k) this._status('Looking up masters games…');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._fetch(this.fen), now ? 0 : 350); // let rapid stepping settle
  }

  async _fetch(fen) {
    const k = key(fen);
    const seq = ++this.seq;
    let data;
    try {
      data = await api.masters(fen);
    } catch (err) {
      if (seq !== this.seq || key(this.fen) !== k) return;
      this._clear();
      this._status(err.message, true);
      return;
    }
    this.cache.set(k, data);
    if (seq === this.seq && key(this.fen) === k) this._render(k, data);
  }

  _status(text, error = false) {
    this.el.status.textContent = text;
    this.el.status.hidden = !text;
    this.el.status.classList.toggle('error', error);
    this.el.retry.hidden = !error;
  }

  _clear() {
    this.shown = null;
    this.el.total.textContent = '';
    this.el.moves.innerHTML = '';
    this.el.games.innerHTML = '';
    this.el.gamesHead.hidden = true;
  }

  _render(k, data) {
    this._clear();
    this.shown = k;
    this._status('');
    if (!data.total) {
      this._status('No masters games reached this position.');
      return;
    }
    this.el.total.textContent = `${data.total.toLocaleString()} game${data.total === 1 ? '' : 's'}`;
    for (const m of data.moves) this.el.moves.appendChild(this._moveRow(m, data.total));
    requestAnimationFrame(() => fitBarLabels(this.el.moves));
    const sanOf = new Map(data.moves.map((m) => [m.uci, m.san]));
    this.el.gamesHead.hidden = data.games.length === 0;
    for (const g of data.games) this.el.games.appendChild(this._gameRow(g, sanOf.get(g.uci), k));
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
    btn.querySelector('.mx-elo').textContent = m.average_rating ? `Ø ${m.average_rating}` : '';
    btn.setAttribute(
      'aria-label',
      `${m.san}: ${m.games} games, ${pct(m.games, total)}%. White wins ${s.white}%, draws ${s.draws}%, Black wins ${s.black}%.` +
        (m.average_rating ? ` Average rating ${m.average_rating}.` : ''),
    );
    btn.addEventListener('click', () => this.onPlay(m.uci));
    return btn;
  }

  _gameRow(g, san, k) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mx-game';
    btn.title = 'Open this game on the board';
    const side = (name, elo) => `${shortName(name)}${elo ? ` (${elo})` : ''}`;
    btn.innerHTML = '<span class="mx-players"></span><span class="mx-meta"></span>';
    btn.querySelector('.mx-players').textContent = `${side(g.white, g.white_elo)} – ${side(g.black, g.black_elo)}`;
    btn.querySelector('.mx-meta').textContent = [g.result.replace('1/2-1/2', '½-½'), g.year, san ? `played ${san}` : ''].filter(Boolean).join(' · ');
    btn.addEventListener('click', () => this.onOpenGame(g.id, k));
    li.appendChild(btn);
    return li;
  }
}
