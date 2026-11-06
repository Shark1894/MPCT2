// Endgame drills in the Training tab: EndgameTrainer plays a drill on the board against perfect
// defence (the Lichess tablebase, through the server; Stockfish if it can't be reached), and
// EndgamePage shows a drill's stats and recent attempts in the tab.
//
// A mating drill is passed by mate within the 50-move rule; K+P v K by queening with the win
// still there. A move that throws the win away ends the attempt (recorded as missed); you can
// take it back and carry on as practice.

import { api } from './api.js';
import { Chess } from '../vendor/chess.js/chess.js';
import { Engine } from './engine.js';
import {
  RESULT_TEXT,
  bestDefence,
  drillById,
  isSuccess,
  judge,
  movesToMate,
  randomMatePosition,
  ruleEnd,
  winningMoves,
} from './endgame-core.js';
import { clock, duration } from './woodpecker-core.js';
import { plural, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const REPLY_DELAY_MS = 350;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class EndgameTrainer {
  /**
   * @param {object} deps
   * @param {import('./game.js').Game} deps.game
   * @param {import('./board.js').BoardView} deps.board
   * @param {() => void} deps.render
   * @param {(active: boolean) => void} deps.onModeChange
   * @param {(locked: boolean) => void} deps.onLock
   * @param {() => void} deps.onFinished   back to the Training tab
   */
  constructor({ game, board, render, onModeChange, onLock, onFinished }) {
    Object.assign(this, { game, board, render, onModeChange, onLock, onFinished });
    this.active = false;
    this.run = null;
    this.el = {
      box: $('eg'),
      title: $('eg-title'),
      sub: $('eg-sub'),
      status: $('eg-status'),
      message: $('eg-message'),
      playing: $('eg-playing'),
      hint: $('eg-hint'),
      giveUp: $('eg-giveup'),
      takeBack: $('eg-takeback'),
      end: $('eg-end'),
      result: $('eg-result'),
      again: $('eg-again'),
      next: $('eg-next'),
      stop: $('eg-stop'),
    };
    this.el.stop.addEventListener('click', () => this.stop(true));
    this.el.hint.addEventListener('click', () => this.hint());
    this.el.giveUp.addEventListener('click', () => this.giveUp());
    this.el.takeBack.addEventListener('click', () => this.takeBack());
    this.el.again.addEventListener('click', () => this.start(this.run.drill.id, this.run.startFen));
    this.el.next.addEventListener('click', () => this.start(this.run.drill.id));
  }

  /** Playing (the board belongs to the drill): no navigation, no engine. */
  get locked() {
    return this.active && Boolean(this.run) && !this.run.over;
  }

  canMove() {
    return this.locked && !this.busy && this.game.turn() === this.run.you;
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  /** A new attempt at a drill: a random position, or `fen` to replay one. */
  async start(drillId, fen = null) {
    const drill = drillById(drillId);
    if (!drill) return;
    this._ensureOn(drill);
    this._message('Setting up…');
    if (!fen) {
      try {
        fen = drill.id === 'kp' ? (await api.endgameKp()).fen : randomMatePosition(drill.id);
      } catch (err) {
        this._message(
          drill.id === 'kp' ? `K+P positions come from the tablebase, which can't be reached right now (${err.message}).` : err.message,
          'wrong',
        );
        this.el.playing.hidden = true;
        this.el.end.hidden = false;
        this.el.again.hidden = true;
        this.el.result.textContent = '';
        return;
      }
    }
    const you = fen.split(' ')[1] === 'w' ? 'white' : 'black';
    this.run = {
      drill,
      startFen: fen,
      you,
      moves: 0,
      hints: 0,
      optimal: null,
      mode: 'tablebase', // or 'engine' once the tablebase can't be reached
      started: performance.now(),
      over: false,
      recorded: false,
      practice: false,
    };
    const run = this.run;
    this.game.load(fen);
    this.board.setOrientation(you);
    this._arrow(null);
    this.el.end.hidden = true;
    this.el.playing.hidden = false;
    this.el.takeBack.hidden = true;
    this.el.hint.hidden = false;
    this.el.giveUp.hidden = false;
    this.el.title.textContent = `${drill.name} · ${drill.pieces}`;
    this.el.sub.textContent = drill.tip;
    this.onLock(true);
    this.render();
    try {
      const info = await api.tablebase(fen);
      if (this.run !== run) return;
      run.optimal = drill.goal === 'mate' ? movesToMate(info.dtm) : null;
    } catch {
      if (this.run !== run) return;
      this._engineMode('The tablebase can’t be reached: Stockfish defends, and slips aren’t pointed out.');
    }
    const side = you === 'white' ? 'White' : 'Black';
    this._message(drill.goal === 'mate' ? `You play ${side}: mate the king.` : `You play ${side}: queen the pawn and keep the win.`);
    this._status();
  }

  stop(back = false) {
    this.run = null;
    this.busy = false;
    this.engine?.cancelBestMove();
    if (!this.active) return;
    this.active = false;
    this._arrow(null);
    this.el.box.hidden = true;
    this.onLock(false);
    this.onModeChange(false);
    this.render();
    if (back) this.onFinished();
  }

  _ensureOn() {
    if (this.active) return;
    this.active = true;
    this.el.box.hidden = false;
    this.onModeChange(true);
  }

  _engineMode(note) {
    if (!this.run) return;
    this.run.mode = 'engine';
    this.engine ??= new Engine({ onUpdate: () => {}, onStatus: () => {} });
    toast(note);
  }

  // ---- moves -----------------------------------------------------------------------------------------

  /** The game's moves replayed in chess.js (for the rules: repetition, 50 moves). */
  _chess() {
    const c = new Chess(this.run.startFen);
    for (const m of this.game.moves.slice(0, this.game.ply)) c.move({ from: m.from, to: m.to, promotion: m.promotion });
    return c;
  }

  async onUserMove(from, to, promotion) {
    const run = this.run;
    if (!this.canMove()) {
      this.render();
      return;
    }
    const before = this.game.fen();
    const played = this.game.play(from, to, promotion);
    if (!played) {
      this.render();
      return;
    }
    this.game.truncate();
    run.moves += 1;
    this._arrow(null);
    this.render();
    this._status();
    const ended = ruleEnd(this._chess());
    if (ended === 'mate') return this._finish('mate');
    if (ended && ended !== 'fifty') return this._slip(ended, before); // stalemate, nothing left, repetition
    if (run.mode === 'engine') {
      if (run.drill.goal === 'promote' && played.promotion) return this._finish('promoted');
      if (ended) return this._finish(ended);
      return this._reply();
    }
    this.busy = true;
    let info;
    try {
      info = await api.tablebase(this.game.fen());
    } catch {
      if (this.run !== run) return;
      this.busy = false;
      this._engineMode('The tablebase stopped answering: Stockfish defends from here.');
      return this._reply();
    }
    if (this.run !== run) return;
    this.busy = false;
    const verdict = judge(info);
    if (verdict === 'ok' && run.drill.goal === 'promote' && played.promotion) return this._finish('promoted');
    if (ended === 'fifty') return this._finish('fifty');
    if (verdict === 'mate') return this._finish('mate');
    if (verdict !== 'ok') return this._slip(verdict, before);
    return this._reply(info);
  }

  /** The defender's move: the tablebase's best defence (or Stockfish's). */
  async _reply(info = null) {
    const run = this.run;
    this.busy = true;
    let uci = info ? bestDefence(info) : null;
    if (!uci) {
      const moves = this.game.moves.slice(0, this.game.ply).map((m) => m.uci);
      uci = await this.engine.bestMove({ startFen: run.startFen, moves, movetime: 600 });
    } else {
      await new Promise((r) => setTimeout(r, REPLY_DELAY_MS));
    }
    if (this.run !== run || !uci) return;
    this.game.play(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
    this.busy = false;
    this.render();
    this._status();
    const ended = ruleEnd(this._chess());
    if (ended) return this._finish(ended);
    this._message('Your move.');
  }

  /** A move that lets the win go: the attempt is missed; take it back to carry on as practice. */
  async _slip(verdict, beforeFen) {
    const run = this.run;
    const text = {
      thrown: 'That lets the win go: it’s a draw now.',
      fifty: 'That still wins, but not within the 50-move rule any more.',
      stalemate: 'Stalemate!',
      material: 'Nothing left to mate with.',
      repetition: 'That repeats the position a third time: a draw.',
    }[verdict];
    await this._finish(verdict, { keepBoard: true });
    if (this.run !== run) return;
    this._message(`${text} Take it back to see a winning move and carry on (practice).`, 'wrong');
    this.el.takeBack.hidden = false;
    this.slipFen = beforeFen;
  }

  async takeBack() {
    const run = this.run;
    if (!run?.over) return;
    this.game.back();
    this.game.truncate();
    run.over = false;
    run.practice = true;
    run.moves = Math.max(0, run.moves - 1);
    this.el.end.hidden = true;
    this.el.playing.hidden = false;
    this.el.takeBack.hidden = true;
    this.onLock(true);
    this.render();
    this._status();
    await this.hint('Practice from here (not recorded).');
  }

  async hint(prefix = '') {
    const run = this.run;
    if (!this.canMove()) return;
    if (run.mode === 'engine') {
      this._message('Hints need the tablebase, which can’t be reached right now.', 'wrong');
      return;
    }
    let info;
    try {
      info = await api.tablebase(this.game.fen());
    } catch {
      this._message('The tablebase can’t be reached for a hint right now.', 'wrong');
      return;
    }
    if (this.run !== run) return;
    const best = winningMoves(info)[0];
    if (!best) {
      this._message('No winning move here.', 'wrong');
      return;
    }
    if (!run.practice) run.hints += 1;
    this._arrow(best.uci);
    const left = movesToMate(info.dtm);
    this._message(`${prefix ? `${prefix} ` : ''}Best: ${best.san}${left ? ` (mate in ${left})` : ''}.`);
  }

  giveUp() {
    if (this.locked) this._finish('gave-up');
  }

  async _finish(result, { keepBoard = false } = {}) {
    const run = this.run;
    run.over = true;
    this.busy = false;
    this.onLock(false);
    this.el.playing.hidden = true;
    this.el.end.hidden = false;
    this.el.again.hidden = false;
    const ok = isSuccess(result);
    const seconds = (performance.now() - run.started) / 1000;
    const perfect = run.optimal ? ` (perfect play: ${run.optimal})` : '';
    if (ok) setTimeout(() => document.dispatchEvent(new CustomEvent('mpct:sound', { detail: 'success' })), 250);
    else document.dispatchEvent(new CustomEvent('mpct:sound', { detail: 'wrong' }));
    this.el.result.textContent =
      `${ok ? '✓' : '✗'} ${RESULT_TEXT[result]}` +
      (run.drill.goal === 'mate' && ok ? ` in ${plural(run.moves, 'move')}${perfect}` : '') +
      (run.hints ? ` · ${plural(run.hints, 'hint')}` : '') +
      ` · ${clock(seconds)}` +
      (run.practice ? ' · practice, not recorded' : '');
    this.el.result.className = `train-result ${ok ? 'good' : 'bad'}`;
    if (!keepBoard) this._message('');
    this.render();
    if (run.recorded || run.practice) return;
    run.recorded = true;
    try {
      await api.endgameAttempt({
        drill: run.drill.id,
        start_fen: run.startFen,
        color: run.you,
        result,
        moves: run.moves,
        optimal: run.optimal,
        hints: run.hints,
        seconds: Math.round(seconds * 10) / 10,
      });
    } catch (err) {
      toast(`Result not saved: ${err.message}`, 'error');
    }
  }

  _status() {
    const run = this.run;
    if (!run) return;
    const half = Number(this.game.fen().split(' ')[4]);
    const parts = [`Moves: ${run.moves}`];
    if (run.drill.goal === 'mate') parts.push(`50-move count: ${Math.floor(half / 2)}/50`);
    if (run.optimal) parts.push(`perfect play mates in ${run.optimal}`);
    if (run.mode === 'engine') parts.push('Stockfish defending');
    this.el.status.textContent = parts.join(' · ');
  }

  _message(text, kind = '') {
    this.el.message.textContent = text;
    this.el.message.className = `train-message ${kind}`;
  }

  _arrow(uci) {
    this.board.setLayer('hint', uci ? [{ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'green' }] : []);
  }
}

// ---- a drill's page in the Training tab -----------------------------------------------------------

/** "12/15" style progress for the list. */
export function drillProgress(st) {
  if (!st?.attempts) return 'not tried';
  return `${st.successes}/${st.attempts}`;
}

export class EndgamePage {
  /** @param {{onStart: (drillId: string, fen?: string) => void}} deps */
  constructor({ onStart }) {
    this.onStart = onStart;
  }

  render(box, drillId, stats) {
    const drill = drillById(drillId);
    const st = stats?.[drillId] ?? { attempts: 0, successes: 0, recent: [] };
    const head = el('section', 'dash-card cv-head-card');
    const top = el('div', 'cv-head');
    const title = el('div', 'cv-title');
    title.append(el('h2', 'dash-h', drill.name), el('span', 'cv-kind cv-kind-endgames', drill.pieces));
    top.appendChild(title);
    const actions = el('div', 'cv-actions');
    const go = el('button', 'primary', st.attempts ? 'New position' : 'Start');
    go.type = 'button';
    go.addEventListener('click', () => this.onStart(drillId));
    actions.appendChild(go);
    top.appendChild(actions);
    head.appendChild(top);
    head.appendChild(el('p', 'meta eg-tip', drill.tip));
    head.appendChild(
      el(
        'p',
        'meta',
        drill.goal === 'mate'
          ? 'A random position each time; the defence is perfect (the longest resistance). Pass = mate before the 50-move rule.'
          : 'A position that’s won but needs the right idea; the defence is perfect. Pass = queening with the win still there.',
      ),
    );

    const card = el('section', 'dash-card');
    card.appendChild(el('h3', 'wp-h', 'Your results'));
    const stats_ = el('div', 'wp-stats');
    const stat = (label, value, sub = '') => {
      const s = el('div', 'wp-stat');
      s.append(el('span', 'stat-label', label), el('span', 'wp-stat-value', value));
      if (sub) s.appendChild(el('span', 'meta', sub));
      stats_.appendChild(s);
    };
    const rate = st.attempts ? Math.round((100 * st.successes) / st.attempts) : null;
    stat('Attempts', String(st.attempts));
    stat('Passed', rate == null ? '—' : `${rate}%`, st.attempts ? `${st.successes} of ${st.attempts}` : '');
    if (drill.goal === 'mate') {
      stat('Best', st.best_moves != null ? plural(st.best_moves, 'move') : '—');
      stat('Average', st.avg_moves != null ? `${st.avg_moves} move${st.avg_moves === 1 ? '' : 's'}` : '—', st.avg_optimal != null ? `perfect play ${st.avg_optimal}` : '');
    }
    stat('Time', st.avg_seconds != null ? duration(st.avg_seconds) : '—', st.avg_seconds != null ? 'average' : '');
    card.appendChild(stats_);

    if (st.recent.length) {
      const table = el('table', 'wp-table');
      const h = el('tr');
      for (const t of ['When', 'Result', 'Moves', 'Time', '']) h.appendChild(el('th', '', t));
      table.appendChild(el('thead')).appendChild(h);
      const body = table.appendChild(el('tbody'));
      for (const a of st.recent) {
        const tr = el('tr');
        tr.appendChild(el('td', '', new Date(a.finished_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })));
        tr.appendChild(el('td', a.success ? 'good' : 'bad', `${a.success ? '✓' : '✗'} ${RESULT_TEXT[a.result] ?? a.result}${a.hints ? ` (${plural(a.hints, 'hint')})` : ''}`));
        tr.appendChild(el('td', 'num', `${a.moves}${a.optimal ? ` / ${a.optimal}` : ''}`));
        tr.appendChild(el('td', 'num', clock(a.seconds)));
        const td = el('td');
        const again = el('button', 'small', 'Again');
        again.type = 'button';
        again.title = 'Play this starting position again';
        again.addEventListener('click', () => this.onStart(drillId, a.start_fen));
        td.appendChild(again);
        tr.appendChild(td);
        body.appendChild(tr);
      }
      const wrap = el('div', 'wp-table-wrap');
      wrap.appendChild(table);
      card.appendChild(el('h3', 'wp-h eg-recent-h', 'Recent'));
      card.appendChild(wrap);
    }
    box.replaceChildren(head, card);
  }
}
