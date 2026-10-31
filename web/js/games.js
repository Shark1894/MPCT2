// Games: the Games tab (list, search, new, PGN import/export, delete) and the game
// panel shown on the board while a game is open (details, save, close, and a check
// of where the game left your repertoire).

import { api } from './api.js';
import { START_FEN } from './game.js';
import { confirmDialog, formDialog, plural, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const RESULTS = [
  ['1-0', '1-0 (White won)'],
  ['0-1', '0-1 (Black won)'],
  ['1/2-1/2', '½-½ (draw)'],
  ['*', '* (unfinished)'],
];
const META = ['white', 'white_team', 'black', 'black_team', 'competition', 'played_on', 'result'];

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function playersText(g) {
  const side = (name, team) => `${name || '?'}${team ? ` (${team})` : ''}`;
  return `${side(g.white, g.white_team)} v ${side(g.black, g.black_team)}`;
}

function resultText(r) {
  return r === '1/2-1/2' ? '½-½' : r;
}

/** SAN list -> "1.d4 d5 2.c4" */
function preview(sans) {
  return sans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}.${san}` : san)).join(' ');
}

// ---- the game open on the board ------------------------------------------------

export class GamePanel {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {() => object|null} deps.getOpening   the repertoire panel's selected opening
   * @param {() => void} deps.render
   * @param {() => void} deps.onClosed
   */
  constructor({ game, getOpening, render, onClosed }) {
    Object.assign(this, { game, getOpening, render, onClosed });
    this.current = null; // { id, saved: snapshot }
    this.el = {
      panel: $('game-panel'),
      title: $('game-title'),
      dirty: $('game-dirty'),
      save: $('game-save'),
      close: $('game-close'),
      pgn: $('game-pgn'),
      compare: $('game-compare'),
      compareResult: $('game-compare-result'),
      fields: Object.fromEntries(META.map((f) => [f, $(`game-${f.replace('_', '-')}`)])),
    };
    for (const [value, label] of RESULTS) this.el.fields.result.appendChild(new Option(label, value));
    for (const input of Object.values(this.el.fields)) input.addEventListener('input', () => this.updateState());
    this.el.save.addEventListener('click', () => this.save());
    this.el.close.addEventListener('click', () => this.close());
    this.el.compare.addEventListener('click', () => this.compare());
    window.addEventListener('beforeunload', (e) => {
      if (this.isDirty()) e.preventDefault(); // browser asks before leaving with unsaved changes
    });
  }

  get isOpen() {
    return this.current !== null;
  }

  async open(id) {
    if (!(await this.confirmLeave())) return false;
    let data;
    try {
      data = await api.game(id);
    } catch (err) {
      toast(err.message, 'error');
      if (err.status === 404) store.set('openGameId', null);
      return false;
    }
    this.game.load(data.start_fen || START_FEN);
    for (const m of data.moves) if (!this.game.play(m.uci.slice(0, 2), m.uci.slice(2, 4), m.uci[4])) break;
    this.game.toEnd();
    for (const f of META) this.el.fields[f].value = data[f] ?? '';
    this.el.pgn.href = api.gamePgnUrl(id);
    this.el.compareResult.innerHTML = '';
    this.current = { id, saved: null };
    this.current.saved = this._snapshot();
    store.set('openGameId', id); // reopened after a reload
    this.el.panel.hidden = false;
    this.render();
    this.updateState();
    return true;
  }

  /** Close the game; asks first if there are unsaved changes. Returns false if the user cancels. */
  async confirmLeave() {
    if (!this.isOpen) return true;
    if (this.isDirty()) {
      const ok = await confirmDialog('Discard unsaved changes?', 'The open game has changes that haven’t been saved.', 'Discard');
      if (!ok) return false;
    }
    this._close();
    return true;
  }

  async close() {
    await this.confirmLeave();
  }

  /** Forget the open game without asking (e.g. it was deleted). */
  _close() {
    this.current = null;
    store.set('openGameId', null);
    this.el.panel.hidden = true;
    this.onClosed?.();
  }

  forget(id) {
    if (this.current?.id === id) this._close();
  }

  _meta() {
    const out = {};
    for (const f of META) out[f] = this.el.fields[f].value.trim();
    out.played_on = out.played_on || null;
    return out;
  }

  _snapshot() {
    return JSON.stringify({ ...this._meta(), start: this.game.startFen, moves: this.game.moves.map((m) => m.uci) });
  }

  isDirty() {
    return this.isOpen && this._snapshot() !== this.current.saved;
  }

  /** Refresh the title and unsaved marker (called on every board change). */
  updateState() {
    if (!this.isOpen) return;
    const meta = this._meta();
    this.el.title.textContent = `${playersText(meta)} · ${resultText(meta.result)}`;
    const dirty = this.isDirty();
    this.el.dirty.hidden = !dirty;
    this.el.save.disabled = !dirty;
  }

  async save() {
    if (!this.isOpen) return;
    const body = { ...this._meta(), start_fen: this.game.startFen, moves: this.game.moves.map((m) => m.uci) };
    try {
      await api.updateGame(this.current.id, body);
      this.current.saved = this._snapshot();
      this.updateState();
      toast('Game saved');
    } catch (err) {
      toast(`Not saved: ${err.message}`, 'error');
    }
  }

  /** Where did this game leave the selected opening's repertoire? */
  async compare() {
    const box = this.el.compareResult;
    box.innerHTML = '';
    const opening = this.getOpening();
    if (!opening) {
      box.textContent = 'Choose an opening in the repertoire panel first.';
      return;
    }
    if (this.game.startFen !== START_FEN) {
      box.textContent = 'This game starts from a set-up position, so it can’t be compared with a repertoire.';
      return;
    }
    let res;
    try {
      res = await api.checkGame(opening.id, this.game.moves.map((m) => m.uci));
    } catch (err) {
      box.textContent = err.message;
      return;
    }
    const moveLabel = (ply, san) => `${Math.ceil(ply / 2)}.${ply % 2 ? '' : '..'}${san}`;
    const p = document.createElement('p');
    if (res.status === 'in_book') {
      p.textContent = `Every move of this game is in ${opening.name}.`;
    } else if (res.status === 'end_of_book') {
      p.textContent = `${opening.name} has no moves after move ${Math.ceil((res.ply - 1) / 2) || 1}: the game continued with ${moveLabel(res.ply, res.played)}.`;
    } else {
      const who = res.by === 'you' ? 'You' : 'Your opponent';
      p.textContent = `${who} left ${opening.name} with ${moveLabel(res.ply, res.played)}. Repertoire: ${res.repertoire.join(', ')}.`;
    }
    box.appendChild(p);
    if (res.status !== 'in_book') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'small';
      btn.textContent = 'Show that position';
      btn.addEventListener('click', () => {
        this.game.goTo(res.ply - 1);
        this.render();
      });
      box.appendChild(btn);
    }
  }
}

// ---- the Games tab -----------------------------------------------------------------

export class GamesView {
  /**
   * @param {object} deps
   * @param {GamePanel} deps.panel
   * @param {import('./game.js').Game} deps.game
   * @param {(id: number) => void} deps.onOpen  open a game on the board
   */
  constructor({ panel, game, onOpen }) {
    Object.assign(this, { panel, game, onOpen });
    this.el = {
      search: $('games-search'),
      list: $('games-list'),
      empty: $('games-empty'),
      count: $('games-count'),
      newGame: $('games-new'),
      importPgn: $('games-import'),
      exportAll: $('games-export'),
    };
    let timer;
    this.el.search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.refresh(), 250);
    });
    this.el.newGame.addEventListener('click', () => this.newGame());
    this.el.importPgn.addEventListener('click', () => this.importPgn());
  }

  async refresh() {
    const q = this.el.search.value.trim();
    this.el.exportAll.href = api.allGamesPgnUrl(q);
    let games;
    try {
      games = await api.games(q);
    } catch (err) {
      this.el.list.innerHTML = '';
      this.el.empty.hidden = false;
      this.el.empty.textContent = `Couldn't load games: ${err.message}`;
      return;
    }
    if (q !== this.el.search.value.trim()) return; // search changed meanwhile
    this.el.count.textContent = q ? `${plural(games.length, 'game')} found` : plural(games.length, 'game');
    this.el.list.innerHTML = '';
    this.el.empty.hidden = games.length > 0;
    this.el.empty.textContent = q ? 'No games match the search.' : 'No games yet. Add one with New game, or import a PGN.';
    this.el.exportAll.hidden = games.length === 0;
    for (const g of games) this.el.list.appendChild(this._row(g));
  }

  _row(g) {
    const row = document.createElement('div');
    row.className = 'game-row';
    if (this.panel.current?.id === g.id) row.classList.add('open');

    const date = document.createElement('div');
    date.className = 'game-date';
    date.textContent = g.played_on || 'No date';

    const main = document.createElement('div');
    main.className = 'game-main';
    const players = document.createElement('div');
    players.className = 'game-players';
    players.textContent = playersText(g);
    const sub = document.createElement('div');
    sub.className = 'game-sub';
    sub.textContent = [g.competition, g.opening.length ? `${preview(g.opening)}${g.plies > g.opening.length ? '…' : ''}` : 'No moves', g.plies ? `${Math.ceil(g.plies / 2)} moves` : '']
      .filter(Boolean)
      .join(' · ');
    main.append(players, sub);

    const result = document.createElement('div');
    result.className = 'game-result';
    result.textContent = resultText(g.result);

    const actions = document.createElement('div');
    actions.className = 'game-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'small primary';
    open.textContent = 'Open';
    open.addEventListener('click', () => this.onOpen(g.id));
    const pgn = document.createElement('a');
    pgn.className = 'button small';
    pgn.href = api.gamePgnUrl(g.id);
    pgn.textContent = 'PGN';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'small danger-outline';
    del.textContent = 'Delete';
    del.addEventListener('click', () => this.deleteGame(g));
    actions.append(open, pgn, del);

    row.append(date, main, result, actions);
    return row;
  }

  async newGame() {
    const boardMoves = this.game.moves.length;
    const fields = [
      { name: 'white', label: 'White', required: false, placeholder: 'Name' },
      { name: 'white_team', label: 'White’s team', required: false, placeholder: 'Club / team (optional)' },
      { name: 'black', label: 'Black', required: false, placeholder: 'Name' },
      { name: 'black_team', label: 'Black’s team', required: false, placeholder: 'Club / team (optional)' },
      { name: 'competition', label: 'Competition', required: false, placeholder: 'League / tournament', maxLength: 150 },
      { name: 'played_on', label: 'Date', type: 'date', value: todayIso() },
      { name: 'result', label: 'Result', type: 'select', options: RESULTS, value: '*' },
    ];
    if (boardMoves) {
      fields.push({
        name: 'moves_from',
        label: 'Moves',
        type: 'select',
        options: [
          ['board', `Use the ${plural(boardMoves, 'move')} on the board`],
          ['empty', 'Start with no moves'],
        ],
        value: 'board',
      });
    }
    const values = await formDialog({ title: 'New game', fields, submit: 'Create' });
    if (!values) return;
    const useBoard = values.moves_from === 'board';
    const body = {
      ...Object.fromEntries(META.map((f) => [f, values[f]])),
      played_on: values.played_on || null,
      start_fen: useBoard ? this.game.startFen : null,
      moves: useBoard ? this.game.moves.map((m) => m.uci) : [],
    };
    try {
      if (!(await this.panel.confirmLeave())) return;
      const g = await api.createGame(body);
      toast('Game created. Play or edit the moves on the board, then Save.');
      this.onOpen(g.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async importPgn() {
    const values = await formDialog({
      title: 'Import PGN',
      message: 'Paste one or more games, or choose a .pgn file. Only the main line is kept; games already in the app are skipped.',
      fields: [{ name: 'pgn', label: 'PGN', type: 'textarea', required: true, file: '.pgn,text/plain' }],
      submit: 'Import',
    });
    if (!values) return;
    try {
      const res = await api.importPgn(values.pgn);
      const parts = [`Imported ${plural(res.imported, 'game')}`];
      if (res.duplicates) parts.push(`${res.duplicates} already in the app`);
      toast(parts.join(', '), res.imported || !res.errors.length ? '' : 'error');
      if (res.errors.length) {
        await formDialog({
          title: `${plural(res.errors.length, 'game')} couldn’t be imported`,
          message: res.errors.join('\n'),
          submit: 'OK',
        });
      }
      await this.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async deleteGame(g) {
    const ok = await confirmDialog(`Delete this game?`, `${playersText(g)}${g.played_on ? `, ${g.played_on}` : ''}\n\nIt can’t be undone.`);
    if (!ok) return;
    try {
      await api.deleteGame(g.id);
      this.panel.forget(g.id);
      toast('Game deleted');
      await this.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
}
