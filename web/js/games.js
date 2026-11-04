// Games: the Games tab (list, search, new, PGN import/export, delete) and the game
// panel shown on the board while a game is open (details, save, close, and a check
// of where the game left your repertoire).

import { api } from './api.js';
import { START_FEN } from './game.js';
import { BATCH_MS, GameReviewer } from './gamereview.js';
import { describeDuration } from './review-core.js';
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

const accText = (x) => (x === null || x === undefined ? '—' : `${Math.round(x)}%`);

/** "White 84% · Black 71%" from a game's review. */
export function accuracyText(review) {
  return `White ${accText(review.white_accuracy)} · Black ${accText(review.black_accuracy)}`;
}

/** "1 blunder, 2 mistakes" for one side's counts ('' if none). */
function errorsText(c) {
  return [c.blunder ? plural(c.blunder, 'blunder') : '', c.mistake ? plural(c.mistake, 'mistake') : ''].filter(Boolean).join(', ');
}

// ---- filters ---------------------------------------------------------------------

/** Result filter choices: the chosen player's own results, or results by colour. */
export function resultOptions(player) {
  return player
    ? [['', 'Any result'], ['won', 'Won'], ['lost', 'Lost'], ['drawn', 'Drawn'], ['unfinished', 'Unfinished']]
    : [['', 'Any result'], ['white', 'White won'], ['black', 'Black won'], ['draw', 'Draw'], ['unfinished', 'Unfinished']];
}

/** Filters made consistent: colour needs a player; a result carries over between the two option sets where it can. */
export function normaliseFilters({ player = '', color = '', result = '', reviewed = '' } = {}) {
  if (player) {
    if (result === 'draw') result = 'drawn';
    if (result === 'white' || result === 'black') result = '';
  } else {
    color = '';
    if (result === 'drawn') result = 'draw';
    if (result === 'won' || result === 'lost') result = '';
  }
  if (!resultOptions(player).some(([v]) => v === result)) result = '';
  if (!['', 'white', 'black'].includes(color)) color = '';
  if (!['', 'yes', 'no'].includes(reviewed)) reviewed = '';
  return { player, color, result, reviewed };
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
  constructor({ game, getOpening, render, onClosed, onOpened }) {
    Object.assign(this, { game, getOpening, render, onClosed, onOpened });
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
      source: $('game-source'),
      wildSave: $('game-wild-save'),
      whiteTeamLabel: $('game-white-team-label'),
      blackTeamLabel: $('game-black-team-label'),
      competitionLabel: $('game-competition-label'),
      reviewInfo: $('game-review-info'),
      fields: Object.fromEntries(META.map((f) => [f, $(`game-${f.replace('_', '-')}`)])),
    };
    for (const [value, label] of RESULTS) this.el.fields.result.appendChild(new Option(label, value));
    for (const input of Object.values(this.el.fields)) input.addEventListener('input', () => this.updateState());
    this.el.save.addEventListener('click', () => this.save());
    this.el.wildSave.addEventListener('click', () => this.saveWild());
    this.el.close.addEventListener('click', () => this.close());
    this.el.compare.addEventListener('click', () => this.compare());
    window.addEventListener('beforeunload', (e) => {
      if (this.isDirty()) e.preventDefault(); // browser asks before leaving with unsaved changes
    });
  }

  get isOpen() {
    return this.current !== null;
  }

  /** A tournament game (Wild tab) is shown read-only; Save to Games makes it one of yours. */
  get isWild() {
    return Boolean(this.current?.wild);
  }

  _setMode(wild) {
    const e = this.el;
    for (const input of Object.values(e.fields)) {
      input.readOnly = wild;
      input.disabled = wild && input.tagName === 'SELECT';
    }
    e.whiteTeamLabel.textContent = e.blackTeamLabel.textContent = wild ? 'Rating' : 'Team';
    e.competitionLabel.textContent = wild ? 'Event' : 'Competition';
    e.save.hidden = wild;
    e.wildSave.hidden = !wild;
    e.wildSave.disabled = false;
    e.wildSave.textContent = 'Save to Games';
    e.source.hidden = !wild;
    e.dirty.hidden = true;
    e.panel.classList.toggle('wild-game', wild);
  }

  /** Open a tournament game from the Wild tab at `ply` (the watched position). */
  async openWild(id, ply = null) {
    if (!(await this.confirmLeave())) return null;
    let g;
    try {
      g = await api.wildGame(id);
    } catch (err) {
      toast(err.message, 'error');
      if (err.status === 404) store.set('openWild', null);
      return null;
    }
    this.game.load(START_FEN);
    for (const uci of g.moves) if (!this.game.play(uci.slice(0, 2), uci.slice(2, 4), uci[4])) break;
    if (ply === null) this.game.toEnd();
    else this.game.goTo(Math.min(ply, this.game.moves.length));
    const f = this.el.fields;
    f.white.value = g.white;
    f.black.value = g.black;
    f.white_team.value = g.white_elo ?? '';
    f.black_team.value = g.black_elo ?? '';
    f.competition.value = g.event;
    f.played_on.value = g.played_on ?? '';
    f.result.value = g.result;
    this.el.source.textContent = [
      'Tournament game',
      g.round ? `round ${g.round}` : '',
      g.site,
      g.source === 'twic' ? 'from The Week in Chess' : 'from a Lichess broadcast',
    ]
      .filter(Boolean)
      .join(' · ');
    this.el.pgn.href = api.wildGamePgnUrl(id);
    this.el.compareResult.innerHTML = '';
    this.current = { id, wild: true, data: g, saved: null };
    this._setMode(true);
    store.set('openGameId', null);
    store.set('openWild', { id, ply });
    this.el.panel.hidden = false;
    this.render();
    this.updateState();
    return g;
  }

  /** Copy the open tournament game into Games and carry on with it as one of yours. */
  async saveWild() {
    if (!this.isWild) return;
    const ply = this.game.ply;
    this.el.wildSave.disabled = true;
    let r;
    try {
      r = await api.saveWildGame(this.current.id);
    } catch (err) {
      this.el.wildSave.disabled = false;
      toast(err.message, 'error');
      return;
    }
    this._close();
    if (await this.open(r.game_id)) {
      this.game.goTo(Math.min(ply, this.game.moves.length));
      this.render();
    }
    toast(r.created ? 'Saved to your Games: edit the details and Save as usual.' : 'Already in your Games: opened that copy.');
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
    this.current = { id, saved: null, review: data.review, savedMoves: data.moves.map((m) => m.uci).join(' ') };
    this._setMode(false);
    this.current.saved = this._snapshot();
    store.set('openWild', null);
    store.set('openGameId', id); // reopened after a reload
    this.el.panel.hidden = false;
    this.render();
    this.updateState();
    this.onOpened?.(data);
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
    store.set('openWild', null);
    this._setMode(false);
    this.el.panel.hidden = true;
    this.onClosed?.();
  }

  forget(id) {
    if (this.current?.id === id && !this.isWild) this._close();
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
    return this.isOpen && !this.isWild && this._snapshot() !== this.current.saved;
  }

  /** Refresh the title and unsaved marker (called on every board change). */
  updateState() {
    if (!this.isOpen) return;
    const meta = this._meta();
    if (this.isWild) {
      const g = this.current.data;
      const side = (name, elo) => `${name || '?'}${elo ? ` (${elo})` : ''}`;
      this.el.title.textContent = `${side(g.white, g.white_elo)} v ${side(g.black, g.black_elo)} · ${resultText(g.result)}`;
      return;
    }
    this.el.title.textContent = `${playersText(meta)} · ${resultText(meta.result)}`;
    const dirty = this.isDirty();
    this.el.dirty.hidden = !dirty;
    this.el.save.disabled = !dirty;
    this._showReview();
  }

  /** The open saved game's id and moves, if the board shows exactly its saved moves (else null). */
  savedGameOnBoard() {
    if (!this.isOpen || this.isWild) return null;
    const ucis = this.game.moves.map((m) => m.uci);
    return ucis.join(' ') === this.current.savedMoves ? { id: this.current.id, ucis } : null;
  }

  /** A review of the open game was saved (or the game's review changed). */
  setReview(review) {
    if (!this.isOpen || this.isWild) return;
    this.current.review = review;
    this._showReview();
  }

  _showReview() {
    const box = this.el.reviewInfo;
    if (!this.isOpen || this.isWild) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const r = this.current.review;
    const movesChanged = this.game.moves.map((m) => m.uci).join(' ') !== this.current.savedMoves;
    box.classList.toggle('reviewed', Boolean(r) && !movesChanged);
    if (movesChanged) {
      box.textContent = 'Moves changed: save the game, then review it with the engine.';
    } else if (r) {
      const errs = [['White', r.counts.w], ['Black', r.counts.b]]
        .map(([side, c]) => (errorsText(c) ? `${side} ${errorsText(c)}` : ''))
        .filter(Boolean)
        .join('; ');
      box.textContent = `✓ Reviewed: accuracy ${accuracyText(r)}${errs ? ` · ${errs}` : ''}`;
    } else {
      box.textContent = 'Not reviewed yet: Review in the engine panel analyses every move (puzzles come from reviewed games).';
    }
  }

  async save() {
    if (!this.isOpen) return;
    const body = { ...this._meta(), start_fen: this.game.startFen, moves: this.game.moves.map((m) => m.uci) };
    try {
      const saved = await api.updateGame(this.current.id, body);
      this.current.saved = this._snapshot();
      this.current.savedMoves = body.moves.join(' ');
      if (saved && 'review' in saved) this.current.review = saved.review;
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
   * @param {{pause: Function, resume: Function}} deps.analysis  the live engine, paused while reviewing
   */
  constructor({ panel, game, onOpen, analysis }) {
    Object.assign(this, { panel, game, onOpen, analysis });
    this.reviewer = null;
    this.el = {
      search: $('games-search'),
      list: $('games-list'),
      empty: $('games-empty'),
      count: $('games-count'),
      newGame: $('games-new'),
      importPgn: $('games-import'),
      exportAll: $('games-export'),
      review: $('games-review'),
      reviewBox: $('games-review-box'),
      reviewBar: $('games-review-bar'),
      reviewProgress: $('games-review-progress'),
      reviewStop: $('games-review-stop'),
      player: $('games-player'),
      color: $('games-color'),
      result: $('games-result'),
      reviewed: $('games-reviewed'),
      clear: $('games-clear'),
    };
    this.filters = normaliseFilters(store.get('gamesFilters', {}));
    this.players = [];
    for (const key of ['player', 'color', 'result', 'reviewed']) {
      this.el[key].addEventListener('change', () => this.setFilters({ ...this.filters, [key]: this.el[key].value }));
    }
    this.el.clear.addEventListener('click', () => this.setFilters({}));
    this._renderFilters();
    this.el.review.addEventListener('click', () => this.reviewAll());
    this.el.reviewStop.addEventListener('click', () => this.reviewer?.cancel());
    let timer;
    this.el.search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.refresh(), 250);
    });
    this.el.newGame.addEventListener('click', () => this.newGame());
    this.el.importPgn.addEventListener('click', () => this.importPgn());
  }

  setFilters(filters) {
    this.filters = normaliseFilters(filters);
    store.set('gamesFilters', this.filters);
    this._renderFilters();
    this.refresh();
  }

  _renderFilters() {
    const f = this.filters;
    const e = this.el;
    const names = this.players.map((p) => p.name);
    e.player.innerHTML = '';
    e.player.appendChild(new Option('All players', ''));
    // A remembered player with no games left still shows, so the list isn't silently unfiltered.
    if (f.player && !names.some((n) => n.toLowerCase() === f.player.toLowerCase())) e.player.appendChild(new Option(f.player, f.player));
    for (const p of this.players) e.player.appendChild(new Option(`${p.name} (${p.games})`, p.name));
    const match = [...e.player.options].find((o) => o.value.toLowerCase() === f.player.toLowerCase());
    e.player.value = match ? match.value : '';
    e.color.hidden = !f.player;
    e.color.value = f.color;
    e.result.innerHTML = '';
    for (const [v, label] of resultOptions(f.player)) e.result.appendChild(new Option(label, v));
    e.result.value = f.result;
    e.reviewed.value = f.reviewed;
    e.clear.hidden = !Object.values(f).some(Boolean);
    for (const key of ['player', 'color', 'result', 'reviewed']) e[key].classList.toggle('active', Boolean(f[key]));
  }

  async _loadPlayers() {
    try {
      this.players = await api.gamePlayers();
    } catch {
      return; // the filter keeps its last list
    }
    this._renderFilters();
  }

  async refresh() {
    const q = this.el.search.value.trim();
    const filters = this.filters;
    const filtered = Boolean(q) || Object.values(filters).some(Boolean);
    this.el.exportAll.href = api.allGamesPgnUrl(q, filters);
    this._loadPlayers();
    let games;
    try {
      games = await api.games(q, filters);
    } catch (err) {
      this.el.list.innerHTML = '';
      this.el.empty.hidden = false;
      this.el.empty.textContent = `Couldn't load games: ${err.message}`;
      return;
    }
    if (q !== this.el.search.value.trim() || filters !== this.filters) return; // changed meanwhile
    this.el.count.textContent = filtered ? `${plural(games.length, 'game')} found` : plural(games.length, 'game');
    this.el.list.innerHTML = '';
    this.el.empty.hidden = games.length > 0;
    this.el.empty.textContent = filtered
      ? 'No games match the search and filters.'
      : 'No games yet. Add one with New game, or import a PGN.';
    this.el.exportAll.hidden = games.length === 0;
    for (const g of games) this.el.list.appendChild(this._row(g));
    this._reviewButton();
  }

  async _reviewButton() {
    let queue;
    try {
      queue = await api.gameReviewQueue();
    } catch {
      return;
    }
    this.queue = queue;
    const b = this.el.review;
    b.hidden = !queue.length || Boolean(this.reviewer);
    b.textContent = `Review ${plural(queue.length, 'unreviewed game')}`;
  }

  /** Review every game without a current review, one after another, with the engine in this browser. */
  async reviewAll() {
    if (this.reviewer) return;
    const queue = await api.gameReviewQueue().catch(() => []);
    if (!queue.length) return;
    const positions = queue.reduce((n, g) => n + g.moves.length + 1, 0);
    const ok = await formDialog({
      title: 'Review games with the engine',
      message:
        `Analyses every move of ${plural(queue.length, 'game')} (${plural(positions, 'position')}) at ${BATCH_MS / 1000} s per position: ` +
        `up to ${describeDuration(Math.ceil((positions * (BATCH_MS + 150)) / 1000))}, less where positions were analysed before. ` +
        `Each finished game gets its accuracy and its puzzles straight away; Stop keeps the games already done.\n\n` +
        `The engine runs in this browser: keep this tab open until it finishes.`,
      submit: 'Start',
    });
    if (!ok) return;
    const e = this.el;
    let lastRefresh = 0;
    this.reviewer = new GameReviewer({
      onProgress: ({ game, gameIndex, games: n, done, total }) => {
        const frac = (gameIndex + (total ? done / total : 1)) / n;
        e.reviewBar.style.width = `${(frac * 100).toFixed(1)}%`;
        e.reviewProgress.textContent = `Game ${gameIndex + 1} of ${n}: ${game.white || '?'} v ${game.black || '?'}` +
          (total ? `, position ${Math.min(done + 1, total)} of ${total}` : '');
      },
      onGameDone: (r) => {
        if (this.panel.current?.id === r.game.id) api.game(r.game.id).then((g) => this.panel.setReview(g.review)).catch(() => {});
        if (Date.now() - lastRefresh > 2000) {
          lastRefresh = Date.now();
          this.refresh();
        }
      },
    });
    e.review.hidden = true;
    e.reviewBox.hidden = false;
    e.reviewBar.style.width = '0%';
    e.reviewProgress.textContent = 'Starting the engine…';
    this.analysis?.pause('batch-review'); // one engine at a time
    let wakeLock = null;
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* not allowed: fine */
    }
    let result = null;
    try {
      result = await this.reviewer.review(queue);
    } catch (err) {
      toast(`Review stopped: ${err.message}`, 'error');
    } finally {
      wakeLock?.release().catch(() => {});
      this.analysis?.resume('batch-review');
      this.reviewer = null;
      e.reviewBox.hidden = true;
    }
    if (result) {
      toast(`${result.cancelled ? 'Stopped. ' : ''}Reviewed ${plural(result.reviewed, 'game')}: ${plural(result.newPuzzles, 'new puzzle')} from your mistakes.`);
    }
    await this.refresh();
  }

  _row(g) {
    const row = document.createElement('div');
    row.className = 'game-row';
    if (this.panel.current?.id === g.id && !this.panel.isWild) row.classList.add('open');

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
    const rv = document.createElement('div');
    if (g.review) {
      rv.className = 'game-reviewed yes';
      rv.textContent = `✓ Reviewed · ${accuracyText(g.review)}`;
      rv.title = `Engine review at ${g.review.movetime_ms / 1000} s per position`;
    } else {
      rv.className = 'game-reviewed';
      rv.textContent = g.plies >= 4 ? 'Not reviewed' : '';
    }
    main.append(players, sub, rv);

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
