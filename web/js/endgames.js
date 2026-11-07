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
import { button, diceIcon, el, miniBoard } from './dom.js';
import { drillLevel } from './training-core.js';

const $ = (id) => document.getElementById(id);
const REPLY_DELAY_MS = 350;

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

/** "12/15" style progress for lists. */
export function drillProgress(st) {
  if (!st?.attempts) return 'not tried';
  return `${st.successes}/${st.attempts}`;
}

const LADDER = ['New', 'Learning', 'Solid', 'Mastered'];

/** B+N: the mating corners for a light-squared bishop (a8, h1), as a small diagram. */
function cornerBoard() {
  const b = el('div', 'mb eg-corners');
  b.setAttribute('role', 'img');
  b.setAttribute('aria-label', 'The mating corners: a8 and h1 for a light-squared bishop, a1 and h8 for a dark one');
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const light = (r + f) % 2 === 0;
      const corner = (r === 0 && f === 0) || (r === 7 && f === 7);
      const near = !corner && ((r <= 1 && f <= 1) || (r >= 6 && f >= 6));
      b.appendChild(el('span', `mb-sq ${light ? 'l' : 'd'}${corner ? ' corner' : near ? ' near' : ''}`));
    }
  }
  return b;
}

export class EndgamePage {
  /** @param {{onStart: (drillId: string, fen?: string) => void}} deps */
  constructor({ onStart }) {
    this.onStart = onStart;
  }

  render(box, drillId, stats) {
    const drill = drillById(drillId);
    const st = stats?.[drillId] ?? { attempts: 0, successes: 0, recent: [] };
    const level = drillLevel(st);

    // hero
    const hero = el('section', 'tr-hero eg-hero cv-head-card');
    const glyphs = el('div', 'eg-hero-glyphs');
    glyphs.setAttribute('aria-hidden', 'true');
    glyphs.append(drill.glyphs, el('span', 'tr-vs', 'v'), el('span', 'tr-lone', '♚'));
    const text = el('div', 'tr-hero-text');
    const title = el('div', 'cv-title');
    title.append(el('h1', 'dash-h', drill.name), el('span', 'tr-chip kind-drill', drill.pieces));
    text.append(
      el('span', 'tr-eyebrow', `Endgame drill · ${drill.pieces}`),
      title,
      el(
        'p',
        'tr-hero-line',
        drill.goal === 'mate'
          ? 'Mate before the 50-move rule against perfect defence. Every start is random.'
          : 'Won positions that need the right idea, against perfect defence. Done when the pawn queens with the win kept.',
      ),
    );
    const cta = el('div', 'eg-cta');
    const go = button('', 'primary tr-cta big', () => this.onStart(drillId));
    go.append(diceIcon(20), ' New random position');
    cta.append(go, el('span', 'tr-muted', 'You play White or Black at random'));
    hero.append(glyphs, text, cta);

    // method
    const method = el('section', 'tr-card eg-method');
    method.appendChild(el('h2', 'tr-card-title', 'The method'));
    const mbody = el('div', 'eg-method-body');
    if (drill.id === 'kbn') {
      const fig = el('figure', 'eg-figure');
      fig.append(cornerBoard(), el('figcaption', 'tr-muted', 'Light bishop: mate on a8 or h1'));
      mbody.appendChild(fig);
    }
    const ol = el('ol', 'eg-steps');
    for (const step of drill.steps) {
      const li = el('li');
      // "Edge first: all three pieces…" -> a bold lead-in, then the rest (sentence case)
      const cut = step.indexOf(': ');
      const head = cut > 0 ? step.slice(0, cut) : '';
      if (head && head.length <= 32 && !head.includes('.')) {
        const rest = step.slice(cut + 2);
        li.append(el('strong', '', `${head}.`), ` ${rest[0].toUpperCase()}${rest.slice(1)}`);
      } else li.textContent = step;
      ol.appendChild(li);
    }
    mbody.appendChild(ol);
    method.appendChild(mbody);

    // mastery
    const mastery = el('section', 'tr-card eg-mastery');
    const mh = el('div', 'tr-card-head');
    mh.append(el('h2', 'tr-card-title', 'Mastery'), el('span', 'tr-muted', 'Pass 5 in a row to master it'));
    mastery.appendChild(mh);
    const ladder = el('ol', 'eg-ladder');
    ladder.setAttribute('aria-label', `Level: ${level}`);
    LADDER.forEach((name, i) => {
      const li = el('li', i <= LADDER.indexOf(level) ? 'on' : '');
      li.append(el('span', 'eg-rung'), el('span', name === level ? 'eg-rung-name now' : 'eg-rung-name', name));
      ladder.appendChild(li);
    });
    mastery.appendChild(ladder);
    const statsRow = el('div', 'wp-stats');
    const stat = (label, value, sub = '') => {
      const s = el('div', 'wp-stat');
      s.append(el('span', 'stat-label', label), el('span', 'wp-stat-value', value));
      if (sub) s.appendChild(el('span', 'meta', sub));
      statsRow.appendChild(s);
    };
    const rate = st.attempts ? Math.round((100 * st.successes) / st.attempts) : null;
    stat('Attempts', String(st.attempts));
    stat('Passed', rate == null ? '—' : `${rate}%`, st.attempts ? `${st.successes} of ${st.attempts}` : '');
    if (drill.goal === 'mate') {
      stat('Best', st.best_moves != null ? plural(st.best_moves, 'move') : '—');
      stat('Average', st.avg_moves != null ? `${st.avg_moves} move${st.avg_moves === 1 ? '' : 's'}` : '—', st.avg_optimal != null ? `perfect play ${st.avg_optimal}` : '');
    }
    stat('Time', st.avg_seconds != null ? duration(st.avg_seconds) : '—', st.avg_seconds != null ? 'average' : '');
    mastery.appendChild(statsRow);
    if (drill.goal === 'mate' && st.recent.length) mastery.appendChild(this._chart(st.recent));

    const row = el('div', 'tr-row-cards');
    row.append(method, mastery);

    // recent starts
    const recent = el('section', 'tr-card eg-recent');
    recent.appendChild(el('h2', 'tr-card-title', 'Recent starts'));
    if (st.recent.length) {
      const grid = el('div', 'eg-starts');
      for (const a of st.recent) {
        const card = el('div', 'eg-start');
        card.dataset.result = a.success ? 'pass' : 'fail';
        card.appendChild(miniBoard(a.start_fen, `Start position, you played ${a.color}`, a.color === 'black'));
        const foot = el('div', 'eg-start-foot');
        const info = el('div', 'tr-stack');
        const when = new Date(a.finished_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        info.append(
          el('span', `eg-start-result ${a.success ? 'ok' : 'bad'}`, `${a.success ? '✓' : '✗'} ${RESULT_TEXT[a.result] ?? a.result}`),
          el('span', 'tr-muted', `${when} · ${a.moves} moves${a.optimal ? ` (perfect ${a.optimal})` : ''}${a.hints ? ` · ${plural(a.hints, 'hint')}` : ''}`),
        );
        foot.append(info, button('Again', 'small eg-again', () => this.onStart(drillId, a.start_fen), 'Play this starting position again'));
        card.appendChild(foot);
        grid.appendChild(card);
      }
      recent.appendChild(grid);
    } else recent.appendChild(el('p', 'tr-muted', 'Your starting positions show here, to replay any of them.'));
    box.replaceChildren(hero, row, recent);
  }

  /** Moves used per attempt (oldest first) against perfect play and the 50-move limit. */
  _chart(recent) {
    const wrap = el('div', 'eg-chart-wrap');
    wrap.appendChild(el('span', 'tr-muted', 'Moves used per attempt, against perfect play'));
    const chart = el('div', 'eg-chart');
    chart.setAttribute('role', 'img');
    const items = [...recent].reverse();
    chart.setAttribute('aria-label', items.map((a) => `${a.success ? 'passed' : 'not passed'} in ${a.moves}${a.optimal ? ` (perfect ${a.optimal})` : ''}`).join('; '));
    chart.appendChild(el('span', 'eg-limit', '50-move limit'));
    for (const a of items) {
      const col = el('div', 'eg-col');
      const bar = el('div', `eg-bar ${a.success ? 'ok' : 'bad'}`);
      bar.style.height = `${(Math.min(a.moves, 50) / 50) * 100}%`;
      col.appendChild(bar);
      if (a.optimal) {
        const p = el('div', 'eg-perfect');
        p.style.bottom = `${(Math.min(a.optimal, 50) / 50) * 100}%`;
        col.appendChild(p);
      }
      chart.appendChild(col);
    }
    wrap.appendChild(chart);
    const legend = el('div', 'eg-legend');
    for (const [cls, label] of [['ok', 'passed'], ['bad', 'not passed'], ['perfect', 'perfect play']]) {
      const item = el('span', 'eg-legend-item');
      item.append(el('span', `eg-key ${cls}`), label);
      legend.appendChild(item);
    }
    wrap.appendChild(legend);
    return wrap;
  }
}
