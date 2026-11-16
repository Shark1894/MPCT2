// Practical tab: moves in your openings that take the opponent into sharp territory, even at an
// engine cost. Pick an opening (or one branch of it, such as a branch tag) and Analyse: for every
// position where it's your move, each candidate move is judged from the engine's evaluations of
// the opponent's best replies to it: how many are good, how far the second-best falls behind, and
// how much worse the rest are on average. No model of the opponent, no game data: it works in
// lines nobody has played. See practical-core.js for the measures.
//
// The engine runs here in the browser (Stockfish, like the reviews), never on the server; its
// lines are saved so a second run is quick.

import { Chess } from '../vendor/chess.js/chess.js';
import { api } from './api.js';
import { button, el, miniBoard } from './dom.js';
import { Engine } from './engine.js';
import {
  DEFAULTS, candidateMoves, evalChange, evalText, finalCandidate, finish, movetext, pct, scoreCandidate, signed, worthALook,
} from './practical-core.js';
import { plural, store, toast } from './ui.js';

const ENGINE_NAME = 'Stockfish 19 Lite';
const THINK = [
  [300, 'Quick (0.3 s a position)'],
  [800, 'Normal (0.8 s)'],
  [2000, 'Deep (2 s)'],
];
const CAPS = [
  [8, 'Up to 8 points worse'],
  [15, 'Up to 15 points worse'],
  [25, 'Up to 25 points worse'],
];
const SAVE_BATCH = 20;

/** A move's sharpness, marked when it's only a capture they take back. */
function sharpCell(c) {
  if (c.final || !Number.isFinite(c.sharpness)) return el('td', 'num', '–');
  const td = el('td', `num${c.sharpness >= 10 && !c.recapture ? ' pr-hot' : ''}`, String(Math.round(c.sharpness)));
  if (c.recapture) {
    td.appendChild(el('span', 'pr-model', 'recapture'));
    td.title = 'They simply take back: the only move is obvious, so this isn’t sharp in practice';
  }
  return td;
}

/** How the eval moves against your own move, White's view as written, coloured by who it helps. */
function evalChangeCell(d) {
  const td = el('td', 'num pr-diff', d === null ? '–' : d.cp === 0 ? '0.00' : evalText({ cp: d.cp }));
  if (d !== null) td.classList.add(d.better ? 'up' : d.worse ? 'down' : 'same');
  td.title = 'Eval of this move minus your move’s (pawns, White’s view): green when it’s better for you, red when worse';
  return td;
}

/** The sharpness gained (or lost) against your own move, coloured. */
function diffCell(d) {
  const td = el('td', 'num pr-diff', d === null ? '–' : signed(d));
  if (d !== null) td.classList.add(d > 0 ? 'up' : d < 0 ? 'down' : 'same');
  td.title = 'Sharpness of this move minus your own move’s';
  return td;
}

/** The SAN of a UCI move in a position (or the UCI if it isn't legal). */
function sanOf(fen, uci) {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return uci;
  }
}

/** The FEN after a UCI move, with whether the game is over then. */
function after(fen, uci) {
  const c = new Chess(fen);
  c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: c.fen(), over: c.isGameOver(), mate: c.isCheckmate() };
}

/**
 * The engine work for one analysis: each position asked for once, saved lines used when good
 * enough, new ones saved in batches.
 */
class Worker {
  constructor({ movetime }) {
    this.movetime = movetime;
    this.engine = null;
    this.evals = new Map(); // fen|multipv -> lines
    this.pending = [];
    this.cancelled = false;
    this.counts = { engine: 0, saved: 0 };
  }

  /** The engine's best `multipv` moves: [{uci, score}] (White-POV). */
  async lines(fen, multipv) {
    const k = `${fen}|${multipv}`;
    if (this.evals.has(k)) return this.evals.get(k);
    let found = null;
    try {
      found = (await api.practicalEvals([fen], multipv, this.movetime)).evals[0];
    } catch {
      // the cache is a help, not a need
    }
    let lines;
    if (found) {
      lines = found.lines;
      this.counts.saved += 1;
    } else {
      this.engine ??= new Engine({ onUpdate: () => {}, onStatus: () => {} });
      const r = await this.engine.evaluate(fen, { multipv, movetime: this.movetime });
      if (!r || this.cancelled) throw new Error('stopped');
      const seen = new Set(); // a move can come back under two lines as the search settles
      lines = r.lines
        .filter((l) => l.pv?.length && !seen.has(l.pv[0]) && seen.add(l.pv[0]))
        .map((l) => ({ uci: l.pv[0], score: l.score, pv: l.pv.slice(0, 12) }));
      this.counts.engine += 1;
      this.pending.push({ fen, multipv, movetime_ms: this.movetime, depth: r.depth, engine: ENGINE_NAME, lines });
      if (this.pending.length >= SAVE_BATCH) this.flush();
    }
    this.evals.set(k, lines);
    return lines;
  }

  flush() {
    const batch = this.pending.splice(0);
    if (batch.length) api.savePracticalEvals(batch).catch(() => {});
  }

  stop() {
    this.cancelled = true;
    this.engine?.terminate();
    this.engine = null;
    this.flush();
  }
}

/** Your candidate moves in one position, scored. */
async function analysePosition(w, position, me, opts) {
  const fen = position.fen;
  const mine = await w.lines(fen, opts.candidates);
  const cands = [];
  for (const uci of candidateMoves(mine, position.repertoire, opts)) {
    if (w.cancelled) break;
    let next;
    try {
      next = after(fen, uci);
    } catch {
      continue;
    }
    const san = sanOf(fen, uci);
    const repertoire = position.repertoire.includes(uci);
    if (next.over) {
      cands.push(finalCandidate({ uci, san, value: next.mate ? 100 : 50, repertoire }));
      continue;
    }
    const theirLines = await w.lines(next.fen, opts.replies);
    const sans = Object.fromEntries(theirLines.map((l) => [l.uci, sanOf(next.fen, l.uci)]));
    cands.push(scoreCandidate({ uci, san, me, theirLines, sans, repertoire, capture: san.includes('x') }, opts));
  }
  return finish(cands, opts);
}

export class PracticalView {
  /** @param {{ onShowLine: (sans: string[]) => void }} deps  open moves on the Board tab */
  constructor({ onShowLine }) {
    this.onShowLine = onShowLine;
    this.box = document.getElementById('practical-view');
    const saved = store.get('practical', {});
    this.settings = { openingId: saved.openingId ?? null, tagId: saved.tagId ?? null, movetime: saved.movetime ?? 800, cap: saved.cap ?? 15 };
    this.results = [];
    this.run = null;
    this.info = null;
    this.built = false;
  }

  _save() {
    store.set('practical', this.settings);
  }

  /** Shown: build once, then refresh the opening list. */
  async refresh() {
    if (!this.built) this._build();
    await this._loadOpenings();
  }

  hide() {}

  _build() {
    this.built = true;
    const head = el('section', 'dash-card pr-head');
    head.append(
      el('h1', 'dash-h', 'Practical choices'),
      el('p', 'pr-lead', 'Moves in your openings that take your opponent into sharp territory, even if the engine says you give a little away: few good replies, the second-best clearly worse, most others losing. All from the engine’s evaluations, so niche and never-played lines are fine.'),
    );
    const controls = el('div', 'pr-controls');
    const field = (label, control) => {
      const l = el('label', 'pr-field');
      l.append(el('span', '', label), control);
      return l;
    };
    this.el = {};
    this.el.opening = el('select');
    this.el.opening.id = 'pr-opening';
    this.el.opening.addEventListener('change', () => {
      this.settings.openingId = Number(this.el.opening.value) || null;
      this.settings.tagId = null;
      this._save();
      this._loadTags();
    });
    this.el.tag = el('select');
    this.el.tag.id = 'pr-tag';
    this.el.tag.addEventListener('change', () => {
      this.settings.tagId = Number(this.el.tag.value) || null;
      this._save();
    });
    const select = (id, options, value, key) => {
      const s = el('select');
      s.id = id;
      for (const [v, t] of options) {
        const o = el('option', '', t);
        o.value = String(v);
        s.appendChild(o);
      }
      s.value = String(value);
      s.addEventListener('change', () => {
        this.settings[key] = Number(s.value);
        this._save();
      });
      return s;
    };
    this.el.think = select('pr-think', THINK, this.settings.movetime, 'movetime');
    this.el.cap = select('pr-cap', CAPS, this.settings.cap, 'cap');

    this.el.go = button('Analyse', 'primary', () => (this.run ? this.stop() : this.start()));
    this.el.go.id = 'pr-go';
    controls.append(
      field('Opening', this.el.opening),
      field('Branch', this.el.tag),
      field('Engine time', this.el.think),
      field('Moves to consider', this.el.cap),
      this.el.go,
    );
    this.el.progress = el('div', 'pr-progress');
    this.el.progress.id = 'pr-progress';
    this.el.progress.hidden = true;
    head.append(controls, this.el.progress);

    this.el.worth = el('section', 'dash-card pr-worth');
    this.el.worth.id = 'pr-worth';
    this.el.worth.hidden = true;
    this.el.positions = el('div', 'pr-positions');
    this.el.positions.id = 'pr-positions';
    this.el.help = el('section', 'dash-card pr-help');
    this.el.help.append(
      el('h2', 'dash-h2', 'How to read it'),
      this._helpList([
        ['Eval', 'the engine’s evaluation after the move and their best reply, in pawns from White’s side (+ good for White)'],
        ['Engine', 'the same as your winning chances (0–100)'],
        ['Cost', 'winning chances the move gives away against the engine’s best move here. Points aren’t pawns: near equality a pawn is about 9 points (half a pawn about 5), and the same pawn is worth fewer points when one side is already well ahead'],
        ['Good replies', 'how many of their 8 best replies stay within 7 points of their best: 1 means an only move'],
        ['Gap', 'how many points worse their second-best reply is than their best'],
        ['Sharpness', 'how many points worse their other top replies are than their best, on average: high when nearly everything but the best move goes wrong for them. Marked “recapture” when your move takes something and their best is simply to take back: obvious, so not sharp in practice (left out of the sharpest alternatives)'],
      ]),
      el('p', 'pr-note', 'Points are winning chances (0–100) from the engine’s evaluations. ✗ marks a reply that isn’t good for them.'),
    );
    this.box.replaceChildren(head, this.el.worth, this.el.positions, this.el.help);
  }

  _helpList(rows) {
    const dl = el('dl', 'pr-defs');
    for (const [t, d] of rows) dl.append(el('dt', '', t), el('dd', '', d));
    return dl;
  }

  async _loadOpenings() {
    let reps;
    try {
      reps = await api.repertoires();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const sel = this.el.opening;
    sel.replaceChildren();
    const lists = await Promise.all(reps.map((r) => api.openings(r.id).catch(() => [])));
    let first = null;
    reps.forEach((r, i) => {
      if (!lists[i].length) return;
      const g = el('optgroup');
      g.label = r.name;
      for (const o of lists[i]) {
        const opt = el('option', '', `${o.name} (${o.color})`);
        opt.value = String(o.id);
        g.appendChild(opt);
        first ??= o.id;
      }
      sel.appendChild(g);
    });
    const ids = lists.flat().map((o) => o.id);
    if (!ids.includes(this.settings.openingId)) this.settings.openingId = first;
    sel.value = String(this.settings.openingId ?? '');
    this.el.go.disabled = !this.settings.openingId;
    await this._loadTags();
  }

  async _loadTags() {
    const sel = this.el.tag;
    sel.replaceChildren();
    const all = el('option', '', 'Whole opening');
    all.value = '';
    sel.appendChild(all);
    if (!this.settings.openingId) return;
    let tags = [];
    try {
      tags = await api.tags(this.settings.openingId);
    } catch {
      // no tags: the whole opening
    }
    for (const t of tags) {
      const o = el('option', '', `${t.name} (${(t.path ?? []).join(' ')})`);
      o.value = String(t.id);
      sel.appendChild(o);
    }
    if (!tags.some((t) => t.id === this.settings.tagId)) this.settings.tagId = null;
    sel.value = String(this.settings.tagId ?? '');
  }

  // ---- the analysis --------------------------------------------------------------------------

  async start() {
    if (!this.settings.openingId) return;
    let info;
    try {
      info = await api.practicalPositions(this.settings.openingId, this.settings.tagId);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (!info.positions.length) {
      toast('No positions with you to move in these lines.');
      return;
    }
    this.info = info;
    this.results = [];
    const opts = { ...DEFAULTS, cap: this.settings.cap };
    this.opts = opts;
    const w = new Worker({ movetime: this.settings.movetime });
    this.run = { w, started: performance.now(), done: 0, total: info.positions.length };
    this.el.go.textContent = 'Stop';
    this.el.positions.replaceChildren();
    this.el.worth.hidden = true;
    this.el.progress.hidden = false;
    this._keepAwake();
    let failed = null;
    try {
      for (const position of info.positions) {
        if (w.cancelled) break;
        this._progress(position);
        let cands;
        try {
          cands = await analysePosition(w, position, info.color, opts);
        } catch (err) {
          if (w.cancelled) break;
          failed = err;
          break;
        }
        if (w.cancelled) break;
        const r = { position, cands };
        this.results.push(r);
        this.run.done += 1;
        this.el.positions.appendChild(this._positionCard(r));
        this._drawWorth();
      }
    } finally {
      const run = this.run;
      w.stop();
      this.run = null;
      this._releaseAwake();
      this.el.go.textContent = 'Analyse';
      const secs = Math.round((performance.now() - run.started) / 1000);
      this.el.progress.textContent = failed
        ? `Stopped: ${failed.message}`
        : `${run.done === run.total ? 'Done' : 'Stopped'}: ${plural(run.done, 'position')} of ${run.total} in ${secs} s (engine: ${w.counts.engine} new, ${w.counts.saved} saved).`;
      if (failed) toast(failed.message, 'error');
      this._drawWorth(true);
    }
  }

  stop() {
    this.run?.w.stop();
  }

  _progress(position) {
    const { done, total, started } = this.run;
    const secs = Math.round((performance.now() - started) / 1000);
    const bar = el('div', 'pr-bar');
    const fill = el('div', 'pr-bar-fill');
    fill.style.width = `${(100 * done) / total}%`;
    bar.appendChild(fill);
    this.el.progress.replaceChildren(
      bar,
      el('span', 'pr-progress-text', `Position ${done + 1} of ${total} · ${secs} s · ${movetext(position.sans)} …`),
    );
  }

  async _keepAwake() {
    try {
      if (!this.wakeLock && 'wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // not allowed: the analysis still runs while the tab is open
    }
  }

  _releaseAwake() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  // ---- drawing -------------------------------------------------------------------------------

  _drawWorth(final = false) {
    const box = this.el.worth;
    const picks = worthALook(this.results, this.opts ?? DEFAULTS);
    box.hidden = !picks.length && !final;
    box.replaceChildren(
      el('h2', 'dash-h2', 'Sharpest alternatives'),
      el('p', 'pr-note', 'Moves you don’t play yet, at least as sharp as yours, where they have at most two good replies and their second-best is at least 5 points worse, sharpest first. Eval change is in pawns from White’s side: green when it’s better for you. Tap a heading to sort; tap a move to see it on the board.'),
    );
    if (!picks.length) {
      box.appendChild(el('p', 'pr-note', final && this.results.length
        ? 'No alternative here is that sharp: the tables below show every one with its sharpness.'
        : 'Nothing yet.'));
      return;
    }
    box.appendChild(this._worthTable(picks));
  }

  /** "5.Qxe2 Qxd5 6.Nf3": the moves since the start of the branch (at least the last one). */
  _since(sans) {
    const root = this.info.positions[0]?.ply ?? 0;
    const from = Math.min(root, Math.max(0, sans.length - 1));
    return movetext(sans.slice(from), from);
  }

  _worthTable(picks) {
    const sharp = (c) => (Number.isFinite(c?.sharpness) ? Math.round(c.sharpness) : null);
    const COLS = [
      // [heading, sort key, value for sorting, ascending]
      ['After', null],
      ['Play', null],
      ['Sharpness', 'sharpness', (p) => p.cand.sharpness],
      ['Yours', null],
      ['Difference', 'diff', (p) => (sharp(p.mine) === null ? -Infinity : sharp(p.cand) - sharp(p.mine))],
      ['Good replies', 'good', (p) => p.cand.good, true],
      ['Gap', 'gap', (p) => (Number.isFinite(p.cand.gap) ? p.cand.gap : -1)],
      ['Cost', 'cost', (p) => p.cand.cost, true],
      ['Eval', null],
      ['Yours (eval)', null],
      ['Eval change', 'evalchg', (p) => {
        const d = evalChange(p.cand, p.mine, this.info.color);
        return d === null ? -Infinity : this.info.color === 'white' ? d.cp : -d.cp; // best for you first
      }],
      ['Only move(s) → you', null],
      ['Next best → you', null],
    ];
    const sortKey = this.worthSort ?? 'sharpness';
    const col = COLS.find((c) => c[1] === sortKey) ?? COLS[2];
    const rows = [...picks].sort((a, b) => (col[3] ? col[2](a) - col[2](b) : col[2](b) - col[2](a)) || b.cand.sharpness - a.cand.sharpness);

    const wrap = el('div', 'pr-table-wrap');
    const table = el('table', 'pr-table pr-worth-table');
    table.id = 'pr-worth-table';
    const hr = el('tr');
    for (const [h, key] of COLS) {
      const th = el('th', key ? 'sortable' : '');
      if (key) {
        const b = button(h, `pr-sort${key === sortKey ? ' on' : ''}`, () => {
          this.worthSort = key;
          this._drawWorth(!this.run);
        });
        b.dataset.sort = key;
        th.setAttribute('aria-sort', key === sortKey ? (col[3] ? 'ascending' : 'descending') : 'none');
        th.appendChild(b);
      } else th.textContent = h;
      hr.appendChild(th);
    }
    const thead = el('thead');
    thead.appendChild(hr);
    const tbody = el('tbody');
    for (const { position, cand: c, mine } of rows) {
      const tr = el('tr');
      const where = el('td', 'pr-where', `${this._since(position.sans)} …`);
      where.title = movetext(position.sans);
      const play = el('td', 'pr-move');
      play.appendChild(button(c.san, 'pr-move-btn', () => this.onShowLine([...position.sans, c.san]), 'Show on board'));
      if (mine) play.appendChild(el('span', 'pr-instead', `not ${mine.san}`));
      const good = c.replies.filter((r) => r.good).slice(0, 2);
      const next = c.replies.filter((r) => !r.good).slice(0, 2);
      const cells = [
        where,
        play,
        el('td', 'num pr-hot', sharp(c) === null ? '–' : String(sharp(c))),
        el('td', 'num', sharp(mine) === null ? '–' : `${sharp(mine)}${mine.recapture ? ' (recapture)' : ''}`),
        diffCell(sharp(mine) === null || sharp(c) === null ? null : sharp(c) - sharp(mine)), // from the shown values, so they add up
        el('td', `num${c.good === 1 ? ' pr-hot' : ''}`, String(c.good)),
        el('td', 'num', Number.isFinite(c.gap) ? String(Math.round(c.gap)) : '–'),
        el('td', 'num', String(Math.round(c.cost))),
        el('td', 'num pr-eval', evalText(c.score)),
        el('td', 'num pr-eval', mine ? evalText(mine.score) : '–'),
        evalChangeCell(evalChange(c, mine, this.info.color)),
        el('td', 'pr-only', good.length ? good.map((r) => `${r.san} → ${pct(r.mine)}`).join(', ') : '–'),
        el('td', 'pr-replies', next.map((r) => `${r.san} → ${pct(r.mine)}`).join(', ') || '–'),
      ];
      cells.forEach((td, i) => (td.dataset.label = COLS[i][0]));
      tr.append(...cells);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  _positionCard({ position, cands }) {
    const card = el('section', 'dash-card pr-pos');
    card.id = `pr-pos-${position.key}`;
    const head = el('div', 'pr-pos-head');
    const flipped = this.info.color === 'black';
    head.appendChild(miniBoard(position.fen, movetext(position.sans), flipped));
    const t = el('div', 'pr-pos-title');
    const yours = position.repertoire.map((u) => cands.find((c) => c.uci === u)?.san).filter(Boolean);
    t.append(
      el('h3', 'pr-pos-moves', `${movetext(position.sans)} …`),
      el('p', 'pr-note', yours.length ? `Your move here: ${yours.join(', ')}` : 'Your move here'),
      button('Show on board', 'small', () => this.onShowLine(position.sans)),
    );
    head.appendChild(t);
    card.appendChild(head);
    const wrap = el('div', 'pr-table-wrap');
    const table = el('table', 'pr-table');
    const thead = el('thead');
    const hr = el('tr');
    const HEADS = ['Move', 'Eval', 'Engine', 'Cost', 'Good replies', 'Gap', 'Sharpness', 'Their replies → you'];
    for (const h of HEADS) hr.appendChild(el('th', '', h));
    thead.appendChild(hr);
    const tbody = el('tbody');
    for (const c of cands) {
      const tr = el('tr', c.repertoire ? 'mine' : '');
      const move = el('td', 'pr-move');
      const b = button(c.san, 'pr-move-btn', () => this.onShowLine([...position.sans, c.san]), 'Show on board');
      move.appendChild(b);
      if (c.repertoire) move.appendChild(el('span', 'pr-yours', 'yours'));
      const likely = el('td', 'pr-replies');
      likely.textContent = c.replies
        .slice(0, 5)
        .map((r) => `${r.san} → ${pct(r.mine)}${r.good ? '' : ' ✗'}`)
        .join(', ');
      const final = c.final;
      tr.append(
        move,
        el('td', 'num pr-eval', c.mate ? '#' : evalText(c.score)),
        el('td', 'num', pct(c.engine)),
        el('td', 'num', String(Math.round(c.cost))),
        el('td', `num${c.good === 1 ? ' pr-hot' : ''}`, final ? '–' : String(c.good)),
        el('td', 'num', final || !Number.isFinite(c.gap) ? '–' : String(Math.round(c.gap))),
        sharpCell(c),
        likely,
      );
      [...tr.children].forEach((td, i) => (td.dataset.label = HEADS[i]));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    return card;
  }
}

