// Play a game against Stockfish on the main board. You pick a side and a strength
// and can start from the initial position or the one on the board. The engine
// panel is hidden while you play; afterwards you can save the game to the games
// database or carry on analysing it.

import { Engine } from './engine.js';
import { START_FEN } from './game.js';
import { api } from './api.js';
import { confirmDialog, formDialog, store, toast } from './ui.js';

const $ = (id) => document.getElementById(id);

/**
 * Strength levels. The first three use Stockfish's Skill Level with a shallow search
 * (rough ratings); the rest use its own Elo limiter (UCI_LimitStrength).
 */
export const LEVELS = [
  { id: 1, label: 'Beginner ~800', skill: 0, depth: 1, movetime: 100 },
  { id: 2, label: 'Novice ~1000', skill: 2, depth: 3, movetime: 200 },
  { id: 3, label: 'Casual ~1200', skill: 4, depth: 5, movetime: 300 },
  { id: 4, label: '1400', elo: 1400, movetime: 600 },
  { id: 5, label: '1600', elo: 1600, movetime: 700 },
  { id: 6, label: '1800', elo: 1800, movetime: 800 },
  { id: 7, label: '2000', elo: 2000, movetime: 900 },
  { id: 8, label: '2200', elo: 2200, movetime: 1000 },
  { id: 9, label: '2500', elo: 2500, movetime: 1200 },
  { id: 10, label: 'Full strength', movetime: 1500 },
];

export const levelById = (id) => LEVELS.find((l) => l.id === Number(id)) ?? LEVELS[3];

/** Options for Engine.bestMove() at a level. */
export function engineOptions(level) {
  return { skill: level.skill ?? null, elo: level.elo ?? null, movetime: level.movetime, depth: level.depth ?? null };
}

/** Competition saved with a game; games played on from a training line name the opening. */
export const competitionFor = (opening) => (opening ? `Practice vs engine (${opening})` : 'Practice vs engine');

/** Engine name for saved games and the panel title. */
export const engineName = (level) => `Stockfish (${level.label})`;

/**
 * Result of a finished position from game.status(): { score: '1-0'|'0-1'|'1/2-1/2', text }.
 * `side` is the colour you play; `turn` the side to move in the final position.
 */
export function resultFor(status, turn, side) {
  if (!status.over) return null;
  if (status.text.startsWith('Checkmate')) {
    const winner = turn === 'white' ? 'black' : 'white';
    return { score: winner === 'white' ? '1-0' : '0-1', text: winner === side ? 'You won by checkmate' : 'Stockfish won by checkmate' };
  }
  return { score: '1/2-1/2', text: status.text };
}

/**
 * The ply to go back to for a takeback: before your last move (and the engine's reply,
 * if it has made one). Never before the ply the game started at. `turn` is the side to
 * move at the end of the game.
 */
export function takebackPly(length, startPly, turn, side) {
  let ply = length;
  if (turn === side) ply -= 1; // engine replied: take that back too
  ply -= 1; // your move
  return Math.max(startPly, ply);
}

export class PlayController {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {import('./board.js').BoardView} deps.board
   * @param {() => void} deps.render
   * @param {(active: boolean) => void} deps.onModeChange
   * @param {() => Promise<boolean>} deps.beforeStart  e.g. close an open game; false cancels
   * @param {(gameId: number) => void} deps.onSaved
   */
  constructor({ game, board, render, onModeChange, beforeStart, onSaved }) {
    Object.assign(this, { game, board, render, onModeChange, beforeStart, onSaved });
    this.settings = { side: 'white', level: 4, from: 'start', name: '', ...store.get('playSettings', {}) };
    this.active = false;
    this.side = 'white';
    this.level = levelById(this.settings.level);
    this.startPly = 0;
    this.result = null; // { score, text } once the game is over
    this.thinking = false;
    this.token = 0; // bumps to discard engine replies that are no longer wanted
    this.engine = null;
    this.engineStatus = '';
    this.opening = null; // set when the game continues a training line
    this.returnTo = null; // { label, onReturn, onEnd } while a training session waits
    this.el = {
      start: $('play-start'),
      panel: $('play-panel'),
      title: $('play-title'),
      status: $('play-status'),
      takeback: $('play-takeback'),
      resign: $('play-resign'),
      save: $('play-save'),
      again: $('play-again'),
      back: $('play-back'),
      stop: $('play-stop'),
    };
    this.el.start.addEventListener('click', () => this.setup());
    this.el.takeback.addEventListener('click', () => this.takeback());
    this.el.resign.addEventListener('click', () => this.resign());
    this.el.save.addEventListener('click', () => this.save());
    this.el.again.addEventListener('click', () => this.setup());
    this.el.stop.addEventListener('click', () => this.confirmStop());
    this.el.back.addEventListener('click', () => this.backToTraining());
  }

  /** True when the user may move on the board now. */
  canMove() {
    return this.active && !this.result && !this.thinking && this.atEnd() && this.game.turn() === this.side;
  }

  atEnd() {
    return this.game.ply === this.game.moves.length;
  }

  // ---- starting and stopping ------------------------------------------------

  async setup() {
    if (this.active && !(await this.confirmStop())) return;
    const g = this.game;
    const hasPosition = g.moves.length > 0 || g.startFen.split(' ').slice(0, 4).join(' ') !== START_FEN.split(' ').slice(0, 4).join(' ');
    const fields = [
      {
        name: 'side',
        label: 'Play as',
        type: 'select',
        options: [
          ['white', 'White'],
          ['black', 'Black'],
          ['random', 'Random'],
        ],
        value: this.settings.side,
      },
      { name: 'level', label: 'Engine strength', type: 'select', options: LEVELS.map((l) => [l.id, l.label]), value: this.settings.level },
    ];
    if (hasPosition) {
      fields.push({
        name: 'from',
        label: 'Start from',
        type: 'select',
        options: [
          ['start', 'The starting position'],
          ['board', 'The position on the board'],
        ],
        value: this.settings.from,
      });
    }
    fields.push({ name: 'name', label: 'Your name', required: false, placeholder: 'Used when you save the game', value: this.settings.name });
    const values = await formDialog({
      title: 'Play against the engine',
      message: 'Stockfish runs in your browser. The engine panel is hidden until the game ends.',
      fields,
      submit: 'Play',
    });
    if (!values) return;
    if (!(await this.beforeStart())) return;
    this.settings = { ...this.settings, ...values, level: Number(values.level), from: values.from ?? 'start' };
    store.set('playSettings', this.settings);
    const side = values.side === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : values.side;
    this.start(side, this.settings.level, hasPosition && values.from === 'board');
  }

  /**
   * Strength picker for playing on from the end of a training line (the side is the
   * repertoire's). Resolves to a level id, or null if cancelled.
   */
  async chooseContinueLevel(opening) {
    const values = await formDialog({
      title: 'Play on against the engine',
      message: `Carry on from the end of this ${opening} line. Practice only: the line's review schedule doesn't change.`,
      fields: [{ name: 'level', label: 'Engine strength', type: 'select', options: LEVELS.map((l) => [l.id, l.label]), value: this.settings.level }],
      submit: 'Play',
    });
    if (!values) return null;
    this.settings = { ...this.settings, level: Number(values.level) };
    store.set('playSettings', this.settings);
    return this.settings.level;
  }

  /**
   * Start a game. fromBoard keeps the moves up to the shown position.
   * opening: names the line being continued (saved with the game).
   * returnTo: { label, onReturn, onEnd } shows a button back to a waiting training session;
   * onEnd runs if the game is left any other way.
   */
  start(side, levelId, fromBoard = false, { opening = null, returnTo = null } = {}) {
    const g = this.game;
    if (fromBoard) g.truncate();
    else g.load(START_FEN);
    this.active = true;
    this.side = side;
    this.level = levelById(levelId);
    this.startPly = g.ply;
    this.result = null;
    this.thinking = false;
    this.token += 1;
    this.opening = opening;
    this.returnTo = returnTo;
    this.board.setOrientation(side);
    this.onModeChange(true);
    this._save();
    this.render();
    this.update();
  }

  /** Leave play mode, keeping the moves on the board. Asks first if the game is still on. */
  async confirmStop() {
    if (!this.active) return true;
    if (!this.result && this.game.moves.length > this.startPly) {
      const ok = await confirmDialog('Abandon the game?', 'The moves stay on the board, but the game against the engine ends.', 'Abandon');
      if (!ok) return false;
    }
    this.stop();
    return true;
  }

  stop() {
    this.token += 1;
    this.engine?.cancelBestMove();
    this.thinking = false;
    this.active = false;
    this.result = null;
    this.opening = null;
    const waiting = this.returnTo;
    this.returnTo = null;
    this._save();
    this.onModeChange(false);
    this.render();
    waiting?.onEnd?.();
  }

  /** Leave the game (asking if it's still on) and carry on with the training session. */
  async backToTraining() {
    const r = this.returnTo;
    if (!this.active || !r) return;
    if (!this.result && this.game.moves.length > this.startPly) {
      const ok = await confirmDialog('Leave the game?', 'The game against the engine ends and training carries on.', 'Leave');
      if (!ok) return;
    }
    this.returnTo = null; // not an abandoned session: no onEnd
    this.stop();
    r.onReturn();
  }

  /** Resume a game saved in local storage (after a reload). */
  restore() {
    const saved = store.get('play');
    if (!saved?.active) return;
    this.active = true;
    this.side = saved.side;
    this.level = levelById(saved.level);
    this.startPly = Math.min(saved.startPly ?? 0, this.game.moves.length);
    this.result = saved.result ?? null;
    this.opening = saved.opening ?? null; // a waiting training session doesn't survive a reload
    this.board.setOrientation(this.side);
    this.onModeChange(true);
    this.render();
    this.update();
  }

  _save() {
    store.set(
      'play',
      this.active
        ? { active: true, side: this.side, level: this.level.id, startPly: this.startPly, result: this.result, opening: this.opening }
        : null,
    );
  }

  // ---- moves ---------------------------------------------------------------------

  /** Call after every render: checks for the end of the game and asks the engine to move. */
  update() {
    if (!this.active) return this._renderPanel(); // hides the panel
    const g = this.game;
    if (!this.result && this.atEnd()) {
      this.result = resultFor(g.status(), g.turn(), this.side);
      if (this.result) this._save();
    }
    if (!this.result && !this.thinking && this.atEnd() && g.turn() !== this.side) this._engineMove();
    this._renderPanel();
  }

  async _engineMove() {
    const token = ++this.token;
    this.thinking = true;
    this._renderPanel();
    if (!this.engine) {
      this.engine = new Engine({
        onUpdate: () => {},
        onStatus: (text) => {
          this.engineStatus = text;
          this._renderPanel();
        },
      });
    }
    const started = performance.now();
    const g = this.game;
    let uci = null;
    try {
      uci = await this.engine.bestMove({ startFen: g.startFen, moves: g.moves.map((m) => m.uci), ...engineOptions(this.level) });
    } catch (err) {
      toast(`Engine error: ${err.message}`, 'error');
    }
    const wait = 500 - (performance.now() - started); // don't reply instantly
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (token !== this.token || !this.active) return; // taken back, stopped or restarted
    this.thinking = false;
    if (uci && this.atEnd()) {
      g.play(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
    } else if (uci) {
      // The user stepped back to look at an earlier move: add the reply without moving the view.
      const ply = g.ply;
      g.toEnd();
      g.play(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
      g.goTo(ply);
    }
    this.render(); // calls update()
  }

  takeback() {
    const g = this.game;
    if (!this.active) return;
    g.toEnd();
    const target = takebackPly(g.moves.length, this.startPly, g.turn(), this.side);
    this.token += 1;
    this.engine?.cancelBestMove();
    this.thinking = false;
    this.result = null;
    g.goTo(target);
    g.truncate();
    this._save();
    this.render();
  }

  async resign() {
    if (!this.active || this.result) return;
    if (!(await confirmDialog('Resign?', 'The game will be scored as a loss.', 'Resign'))) return;
    this.token += 1;
    this.engine?.cancelBestMove();
    this.thinking = false;
    this.result = { score: this.side === 'white' ? '0-1' : '1-0', text: 'You resigned' };
    this._save();
    this.render();
  }

  async save() {
    if (!this.result) return;
    const g = this.game;
    const you = this.settings.name?.trim() || 'You';
    const bot = engineName(this.level);
    const body = {
      white: this.side === 'white' ? you : bot,
      black: this.side === 'white' ? bot : you,
      white_team: '',
      black_team: '',
      competition: competitionFor(this.opening),
      category: 'practice',
      played_on: new Date().toLocaleDateString('en-CA'), // YYYY-MM-DD, local date
      result: this.result.score,
      start_fen: g.startFen,
      moves: g.moves.map((m) => m.uci),
    };
    try {
      const saved = await api.createGame(body);
      const r = this.returnTo;
      if (r) {
        // In a training session: keep training; the game is in the Games tab.
        toast('Saved to Games. Back to training.');
        this.returnTo = null;
        this.stop();
        r.onReturn();
        return;
      }
      toast('Saved to Games');
      this.stop();
      this.onSaved(saved.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---- panel ---------------------------------------------------------------------

  _renderPanel() {
    const el = this.el;
    el.panel.hidden = !this.active;
    if (!this.active) return;
    const you = this.side === 'white' ? 'White' : 'Black';
    el.title.textContent = `You (${you}) v ${engineName(this.level)}`;
    let status;
    if (this.result) status = `${this.result.text} · ${this.result.score.replace('1/2-1/2', '½-½')}`;
    else if (this.thinking) status = this.engineStatus || 'Stockfish is thinking…';
    else if (!this.atEnd()) status = 'Viewing an earlier move. Go to the end to play.';
    else status = 'Your move';
    el.status.textContent = status;
    el.status.classList.toggle('over', Boolean(this.result));
    const g = this.game;
    const played = g.moves.length > this.startPly;
    const endTurn = (g.moves.at(-1)?.fen ?? g.startFen).split(' ')[1] === 'w' ? 'white' : 'black';
    const youMoved = takebackPly(g.moves.length, this.startPly, endTurn, this.side) < g.moves.length - (endTurn === this.side ? 1 : 0);
    el.takeback.disabled = !youMoved || this.result?.text === 'You resigned';
    el.resign.hidden = Boolean(this.result);
    el.resign.disabled = !played;
    el.save.hidden = !this.result;
    el.again.hidden = !this.result || Boolean(this.returnTo);
    el.back.hidden = !this.returnTo;
    if (this.returnTo) el.back.textContent = this.returnTo.label;
    el.stop.textContent = this.result ? 'Analyse' : 'Stop';
    el.stop.title =
      (this.result ? 'Leave play mode and analyse the game' : 'Abandon the game') + (this.returnTo ? ' (ends the training session)' : '');
  }
}
