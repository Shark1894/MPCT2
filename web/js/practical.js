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
  DEFAULTS, addDecision, breakEven, lineLinks, stillSharp, worthFollowing, breakEvenText, candidateMoves, decision, evalChange, evalText, finalCandidate, finish, movetext, pct, scoreCandidate, signed, worthALook,
} from './practical-core.js';
import { plural, store, tagTree, toast } from './ui.js';

const ENGINE_NAME = 'Stockfish 19 Lite';
const DEPTHS = [
  [12, 'Fast (depth 12)'],
  [16, 'Normal (depth 16)'],
  [20, 'Deep (depth 20)'],
  [24, 'Very deep (depth 24, slow)'],
];
const LIMIT_MS = 30000; // most time one analysis may take, so a hard position can't stall the run
const DECISIONS = [
  [1, 'Their reply only'],
  [2, '2 of their decisions'],
  [3, '3 of their decisions'],
];
const CAPS = [
  [8, 'Up to 8 points worse'],
  [15, 'Up to 15 points worse'],
  [25, 'Up to 25 points worse'],
];
const SAVE_BATCH = 20;

/** The depth a line was searched to; amber when the time limit stopped it short of `wanted`. */
function depthCell(depth, wanted) {
  const short = depth != null && depth < wanted;
  const td = el('td', `num pr-depth${short ? ' short' : ''}`, depth == null ? '–' : String(depth));
  td.title = depth == null ? '' : short ? `Searched to depth ${depth}: the ${LIMIT_MS / 1000} s limit stopped it before depth ${wanted}` : `Searched to depth ${depth}`;
  return td;
}

/** A move's sharpness, marked when it's only a capture they take back. */
function sharpCell(c) {
  if (c.final || !Number.isFinite(c.sharpness)) return el('td', 'num', '–');
  const td = el('td', `num${c.sharpness >= 10 && !c.allRecapture ? ' pr-hot' : ''}`, String(Math.round(c.sharpness)));
  if (c.allRecapture) {
    td.appendChild(el('span', 'pr-model', 'recapture'));
    td.title = 'They simply take back: the only move is obvious, so this isn’t sharp in practice';
  } else {
    td.title = `Sharpest at their decision ${c.peakAt}. Decision by decision (worst case over their good replies): ${(c.levels ?? c.chain).map((d) => (d.recapture ? 'recapture' : Number.isFinite(d.sharpness) ? Math.round(d.sharpness) : '–')).join(' → ')}`;
  }
  return td;
}

/** Their good replies decision by decision ("3 → 1 → 1"); tap to see the line on the board. */
function chainCell(c, onShow) {
  const td = el('td', 'num pr-chain');
  if (c.final || !c.chain.length) {
    td.textContent = '–';
    return td;
  }
  const b = button('', 'pr-chain-btn', onShow);
  (c.levels ?? c.chain).forEach((d, i) => {
    if (i) b.append(' → ');
    const v = d.recapture ? 'r' : String(d.good);
    b.appendChild(el('span', d.recapture ? 'pr-chain-r' : d.good === 1 ? 'pr-chain-1' : '', v));
  });
  if (c.stopped) {
    b.append(' → ');
    b.appendChild(el('span', 'pr-chain-r', '…'));
  }
  b.title = `Main line: ${c.line.join(' ')}. Good replies at each of their decisions, the most in any position they can reach by playing only good moves (positions checked: ${(c.levels ?? []).map((d) => d.nodes ?? 1).join(', ')}; r = they just take back).${c.stopped ? ' Not followed further: too many good replies (or too costly) for it to be a sharp alternative.' : ''} Tap to see the line on the board.`;
  td.appendChild(b);
  return td;
}

/** How the eval moves against your own move, White's view as written, coloured by who it helps. */
function evalChangeCell(d) {
  const td = el('td', 'num pr-diff', d === null ? '–' : d.cp === 0 ? '0.0' : evalText({ cp: d.cp }));
  if (d !== null) td.classList.add(d.better ? 'up' : d.worse ? 'down' : 'same');
  td.title = 'Eval of this move minus your move’s (pawns, White’s view): green when it’s better for you, red when worse';
  return td;
}

/** The gap at their sharpest decision. */
function gapCell(c) {
  const td = el('td', 'num', c.final || !Number.isFinite(c.gap) ? '–' : String(Math.round(c.gap)));
  if (!c.final && c.chain.length > 1) td.title = `At their decision ${c.peakAt} (the sharpest)`;
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
  constructor({ depth }) {
    this.depth = depth;
    this.engine = null;
    this.evals = new Map(); // fen|multipv -> lines
    this.depths = new Map(); // fen|multipv -> depth the search reached
    this.pending = [];
    this.cancelled = false;
    this.counts = { engine: 0, saved: 0, limited: 0 };
    this.missing = new Set(); // fen|multipv looked up and not saved: straight to the engine
  }

  /**
   * Look up saved lines for many positions in one request (a request per position adds up over
   * the internet), so lines() then finds them here.
   */
  async prefetch(fens, multipv) {
    const want = [...new Set(fens)].filter((f) => !this.evals.has(`${f}|${multipv}`) && !this.missing.has(`${f}|${multipv}`));
    for (let i = 0; i < want.length; i += 200) {
      const chunk = want.slice(i, i + 200);
      let found;
      try {
        found = (await api.practicalEvals(chunk, multipv, { depth: this.depth })).evals;
      } catch {
        return; // the cache is a help, not a need: lines() asks again
      }
      chunk.forEach((f, j) => {
        const k = `${f}|${multipv}`;
        if (found[j]) {
          this.evals.set(k, found[j].lines);
          this.depths.set(k, found[j].depth);
          this.counts.saved += 1;
        } else this.missing.add(k);
      });
    }
  }

  /** The engine's best `multipv` moves: [{uci, score}] (White-POV). */
  async lines(fen, multipv) {
    const k = `${fen}|${multipv}`;
    if (this.evals.has(k)) return this.evals.get(k);
    let found = null;
    if (!this.missing.has(k)) {
      try {
        found = (await api.practicalEvals([fen], multipv, { depth: this.depth })).evals[0];
      } catch {
        // the cache is a help, not a need
      }
    }
    let lines;
    let depth;
    if (found) {
      lines = found.lines;
      depth = found.depth;
      this.counts.saved += 1;
    } else {
      this.engine ??= new Engine({ onUpdate: () => {}, onStatus: () => {} });
      const t0 = performance.now();
      const r = await this.engine.evaluate(fen, { multipv, depth: this.depth, movetime: LIMIT_MS });
      if (!r || this.cancelled) throw new Error('stopped');
      const ms = Math.max(10, Math.round(performance.now() - t0));
      if (r.depth < this.depth) this.counts.limited += 1; // the time limit stopped it first
      depth = r.depth;
      const seen = new Set(); // a move can come back under two lines as the search settles
      lines = r.lines
        .filter((l) => l.pv?.length && !seen.has(l.pv[0]) && seen.add(l.pv[0]))
        .map((l) => ({ uci: l.pv[0], score: l.score, pv: l.pv.slice(0, 12) }));
      this.counts.engine += 1;
      this.pending.push({ fen, multipv, movetime_ms: Math.min(ms, 60000), depth: r.depth, asked_depth: this.depth, engine: ENGINE_NAME, lines });
      if (this.pending.length >= SAVE_BATCH) this.flush();
    }
    this.evals.set(k, lines);
    this.depths.set(k, depth);
    return lines;
  }

  /** How deep the search behind lines(fen, multipv) went. */
  depthOf(fen, multipv) {
    return this.depths.get(`${fen}|${multipv}`) ?? null;
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

/**
 * Follow the engine's main line after one of your moves: their best reply, your best answer, and
 * score their next decision; up to opts.decisions of them. Stops at the end of the game.
 */
/**
 * Your best answer to their reply `uci` in `fen` (they're to move): the next move of the engine's
 * line for that reply if it has one, else ask the engine. {fen after your answer, san, uci} | null.
 */
async function answer(w, fen, lines, uci) {
  let r;
  try {
    r = after(fen, uci);
  } catch {
    return null;
  }
  if (r.over) return null;
  let mine = lines.find((l) => l.uci === uci)?.pv?.[1];
  let m = null;
  if (mine) {
    try {
      m = after(r.fen, mine);
    } catch {
      m = null;
    }
  }
  if (!m) {
    mine = (await w.lines(r.fen, 1))[0]?.uci;
    if (!mine) return null;
    try {
      m = after(r.fen, mine);
    } catch {
      return null;
    }
  }
  if (m.over) return null;
  return { fen: m.fen, uci: mine, san: sanOf(r.fen, mine) };
}

/**
 * Before a decision's positions are scored: look up, in one go, the saved lines for every position
 * they'll need (after your answer to each reply followed; where the engine's line has no answer,
 * the position before it, to ask for one).
 */
async function prefetchAnswers(w, pairs, opts) {
  const answered = [];
  const toAsk = [];
  for (const [node, replies] of pairs) {
    for (const reply of replies) {
      let r;
      try {
        r = after(node.fen, reply.uci);
      } catch {
        continue;
      }
      if (r.over) continue;
      const mine = node.lines.find((l) => l.uci === reply.uci)?.pv?.[1];
      let m = null;
      try {
        m = mine ? after(r.fen, mine) : null;
      } catch {
        m = null;
      }
      if (m && !m.over) answered.push(m.fen);
      else if (!m) toAsk.push(r.fen);
    }
  }
  await Promise.all([w.prefetch(answered, opts.replies), w.prefetch(toAsk, 1)]);
}

/**
 * Follow their decisions after your move `c`: every good reply of theirs (your best answer to
 * each), so each decision covers all the positions they can reach by playing only good moves,
 * summed up worst case for you. The main line (their best reply each time) is tracked too. A
 * move other than yours stops as soon as a decision has more than `maxGood` good replies (it
 * can't be a sharp alternative then); after such a decision your own move follows the main line only.
 */
async function followLine(w, c, fen, theirLines, me, opts) {
  // positions where they're to move: {fen, lines, d (their decision there), main}
  let frontier = [{ fen, lines: theirLines, d: c.chain[0], main: true }];
  let wide = stillSharp(c.levels[0], opts);
  for (let k = 2; k <= opts.decisions && !w.cancelled; k++) {
    const next = [];
    let mainSans = null;
    const follow = (node) => (wide ? node.d.replies.filter((r) => r.good).slice(0, opts.maxGood) : node.main ? node.d.replies.slice(0, 1) : []);
    await prefetchAnswers(w, frontier.map((node) => [node, follow(node)]), opts);
    for (const node of frontier) {
      if (w.cancelled) return;
      // their replies to follow: the good ones (at most maxGood: more and it isn't sharp anyway),
      // or just the best once the line has stopped being sharp (your own move only)
      const replies = follow(node);
      for (const [i, reply] of replies.entries()) {
        const a = await answer(w, node.fen, node.lines, reply.uci);
        if (!a) continue;
        const lines = await w.lines(a.fen, opts.replies);
        if (!lines.length) continue;
        const sans = Object.fromEntries(lines.map((l) => [l.uci, sanOf(a.fen, l.uci)]));
        const d = decision(lines, me, { sans, capture: a.san.includes('x'), myUci: a.uci }, opts);
        const main = node.main && i === 0;
        if (main) mainSans = [reply.san, a.san];
        next.push({ fen: a.fen, lines, d, main });
        const depth = w.depthOf(a.fen, opts.replies);
        if (depth != null && (c.depth == null || depth < c.depth)) c.depth = depth;
      }
    }
    const mainNode = next.find((n) => n.main);
    if (!mainNode) return; // the main line ended (mate or no moves)
    addDecision(c, mainNode.d, mainSans[0], mainSans[1], next.filter((n) => !n.main).map((n) => n.d));
    if (!stillSharp(c.levels[c.levels.length - 1], opts)) {
      if (!c.repertoire) {
        if (k < opts.decisions) c.stopped = true;
        return;
      }
      wide = false;
    }
    frontier = next;
  }
}

/** Your candidate moves in one position, scored. */
async function analysePosition(w, position, me, opts) {
  const fen = position.fen;
  const mine = await w.lines(fen, opts.candidates);
  const nexts = [];
  for (const uci of candidateMoves(mine, position.repertoire, opts)) {
    try {
      const n = after(fen, uci);
      if (!n.over) nexts.push(n.fen);
    } catch {
      // skipped below too
    }
  }
  await w.prefetch(nexts, opts.replies);
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
    const c = scoreCandidate({ uci, san, me, theirLines, sans, repertoire, capture: san.includes('x') }, opts);
    c.depth = w.depthOf(next.fen, opts.replies); // how deep their replies were searched (the shallowest decision)
    c.start = { fen: next.fen, theirLines };
    cands.push(c);
  }
  // then follow the main line, but only for moves that can still be sharp alternatives (and yours)
  const best = cands.length ? Math.max(...cands.map((c) => c.engine)) : 0;
  for (const c of cands) {
    if (w.cancelled) break;
    if (c.final) continue;
    if (worthFollowing(c, best, opts)) await followLine(w, c, c.start.fen, c.start.theirLines, me, opts);
    else if (opts.decisions > 1) c.stopped = true;
    delete c.start;
  }
  position.depth = w.depthOf(fen, opts.candidates); // how deep your candidate moves were searched
  return finish(cands, opts);
}

export class PracticalView {
  /** @param {{ onShowLine: (sans: string[]) => void }} deps  open moves on the Board tab */
  constructor({ onShowLine }) {
    this.onShowLine = onShowLine;
    this.box = document.getElementById('practical-view');
    const saved = store.get('practical', {});
    this.settings = { openingId: saved.openingId ?? null, tagId: saved.tagId ?? null, depth: saved.depth ?? 16, cap: saved.cap ?? 15, decisions: saved.decisions ?? 3 };
    this.results = [];
    this.run = null;
    this.info = null;
    this.built = false;
    this.seen = new Set(); // `${position key}|${uci}` of moves you've opened on the board
    this.hideSeen = Boolean(saved.hideSeen);
  }

  _save() {
    store.set('practical', { ...this.settings, hideSeen: this.hideSeen });
  }

  _isSeen(position, uci) {
    return this.seen.has(`${position.key}|${uci}`);
  }

  /** Open a move on the board, and remember you've looked at it. */
  _open(position, c) {
    this._setSeen(position, c.uci, true);
    this.onShowLine([...position.sans, c.san]);
  }

  /** Open a move's main line on the board (and count the move as seen). */
  _openLine(position, c) {
    this._setSeen(position, c.uci, true);
    this.onShowLine([...position.sans, ...c.line]);
  }

  async _setSeen(position, uci, on) {
    const k = `${position.key}|${uci}`;
    if (on === this.seen.has(k)) return;
    if (on) this.seen.add(k);
    else this.seen.delete(k);
    this._redraw();
    try {
      if (on) await api.markPracticalSeen(position.key, uci);
      else await api.unmarkPracticalSeen(position.key, uci);
    } catch (err) {
      toast(`Not saved: ${err.message}`, 'error');
    }
  }

  async _loadSeen(positions) {
    this.seen = new Set();
    try {
      for (const r of await api.practicalSeen(positions.map((p) => p.key))) this.seen.add(`${r.key}|${r.uci}`);
    } catch {
      // not knowing what you've seen only loses the ticks
    }
  }

  /** Open or fold every position. */
  _openAll(open) {
    for (const d of this.el.positions.querySelectorAll('details.pr-pos')) d.open = open;
  }

  /** Draw the results again (after a seen tick changes). */
  _redraw() {
    if (!this.info) return;
    this._drawWorth(!this.run);
    const cards = this.results.map((r) => this._positionCard(r));
    this.el.positions.replaceChildren(...cards);
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
    this.el.depth = select('pr-depth', DEPTHS, this.settings.depth, 'depth');
    this.el.cap = select('pr-cap', CAPS, this.settings.cap, 'cap');
    this.el.decisions = select('pr-decisions', DECISIONS, this.settings.decisions, 'decisions');

    this.el.go = button('Analyse', 'primary', () => (this.run ? this.stop() : this.start()));
    this.el.go.id = 'pr-go';
    controls.append(
      field('Opening', this.el.opening),
      field('Branch', this.el.tag),
      field('Engine depth', this.el.depth),
      field('Moves to consider', this.el.cap),
      field('Follow', this.el.decisions),
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
    this.el.positionsHead = el('div', 'pr-positions-head');
    this.el.positionsHead.hidden = true;
    this.el.positionsHead.append(
      el('h2', 'dash-h2', 'Every position'),
      el('p', 'pr-note', 'One line each: your move with their good replies decision by decision, and how many other moves stay sharp all the way. Tap a position to see every move checked there.'),
      button('Open all', 'small', () => this._openAll(true)),
      button('Close all', 'small', () => this._openAll(false)),
    );
    this.el.help = el('details', 'dash-card pr-help');
    const helpSum = el('summary', 'pr-help-sum');
    helpSum.appendChild(el('h2', 'dash-h2', 'How to read it'));
    this.el.help.append(
      helpSum,
      this._helpList([
        ['Eval', 'the engine’s evaluation after the move and their best reply, in pawns from White’s side (+ good for White)'],
        ['Engine', 'the same as your winning chances (0–100)'],
        ['Cost', 'winning chances the move gives away against the engine’s best move here. Points aren’t pawns: near equality a pawn is about 9 points (half a pawn about 5), and the same pawn is worth fewer points when one side is already well ahead'],
        ['Good replies', 'how many of their 8 best replies stay within 7 points of their best, at each of their decisions: “3 → 1 → 1”. Every good reply of theirs is followed (with your best answer), and each number is the most good replies they have in any position they can reach by playing only good moves, so a 1 means an only move whichever good path they took. 1 is an only move; r is a recapture (obvious); … means the line wasn’t followed further, as it already had too many good replies (or cost too much) to be a sharp alternative. Tap it to see the line on the board'],
        ['In a row', 'how many only moves they have to find one after another, from their first decision'],
        ['Gap', 'how many points worse their second-best reply is than their best, at their sharpest decision (the smallest gap among the positions they can reach there)'],
        ['Depth', 'how deep the engine searched their replies (in half-moves; the shallowest of their decisions). It’s the depth you chose unless the 30-second limit for one analysis stopped it first (shown in amber)'],
        ['Sharpness', 'how many points worse their other top replies are than their best, on average, at their sharpest decision (the least sharp of the positions they can reach there by playing good moves): high when nearly everything but the best move goes wrong for them. Recaptures (your move takes something and their best is simply to take back) are obvious, so they’re never the sharpest point; a move that only leads to recaptures is marked “recapture”'],
      ]),
      el('p', 'pr-note', 'Points are winning chances (0–100) from the engine’s evaluations. ✗ marks a reply that isn’t good for them.'),
    );
    this.box.replaceChildren(head, this.el.worth, this.el.positionsHead, this.el.positions, this.el.help);
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
    for (const { tag: t, depth } of tagTree(tags)) {
      const pad = depth ? `${'\u00a0\u00a0\u00a0'.repeat(depth - 1)}\u00a0└\u00a0` : '';
      const o = el('option', '', `${pad}${t.name} (${(t.path ?? []).join(' ')})`);
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
    await this._loadSeen(info.positions);
    const opts = { ...DEFAULTS, cap: this.settings.cap, depth: this.settings.depth, decisions: this.settings.decisions };
    this.opts = opts;
    const w = new Worker({ depth: this.settings.depth });
    this.run = { w, started: performance.now(), done: 0, total: info.positions.length };
    this.el.go.textContent = 'Stop';
    this.el.positions.replaceChildren();
    this.el.positionsHead.hidden = true;
    this.el.worth.hidden = true;
    this.el.progress.hidden = false;
    this._keepAwake();
    let failed = null;
    try {
      await w.prefetch(info.positions.map((p) => p.fen), opts.candidates);
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
        this.el.positionsHead.hidden = false;
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
        : `${run.done === run.total ? 'Done' : 'Stopped'}: ${plural(run.done, 'position')} of ${run.total} in ${secs} s at depth ${this.settings.depth} (engine: ${w.counts.engine} new, ${w.counts.saved} saved${w.counts.limited ? `; ${w.counts.limited} stopped by the ${LIMIT_MS / 1000} s limit before reaching it` : ''}).`;
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
      el('p', 'pr-note', 'Moves you don’t play yet, at least as sharp as yours, where they have at most two good replies at every one of their decisions along the main line (all of the ones you chose to follow) and, at one of them, their second-best is at least 5 points worse. Break-even: how often they’d have to miss (playing their second-best, at any of their decisions on the line) for the move to score better than yours; “free” when it’s no worse even if they always find the best. Eval change is in pawns from White’s side: green when it’s better for you. ↑ / ↓ next to a position: other suggestions earlier / later in the same line (you’d only change one move per line); tap it to highlight them, or sort by After to group each line together. Tap a heading to sort; tap a move to see it on the board (it’s then ticked as seen).'),
    );
    if (!picks.length) {
      box.appendChild(el('p', 'pr-note', final && this.results.length
        ? 'No alternative here is that sharp: the tables below show every one with its sharpness.'
        : 'Nothing yet.'));
      return;
    }
    const seenCount = picks.filter((p) => this._isSeen(p.position, p.cand.uci)).length;
    const toggle = el('label', 'pr-hide-seen');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.id = 'pr-hide-seen';
    cb.checked = this.hideSeen;
    cb.addEventListener('change', () => {
      this.hideSeen = cb.checked;
      this._save();
      this._drawWorth(!this.run);
    });
    toggle.append(cb, ` Hide the ones you’ve seen (${seenCount} of ${picks.length})`);
    box.appendChild(toggle);
    const shown = this.hideSeen ? picks.filter((p) => !this._isSeen(p.position, p.cand.uci)) : picks;
    if (!shown.length) box.appendChild(el('p', 'pr-note', 'You’ve seen them all.'));
    else box.appendChild(this._worthTable(shown));
  }

  /** "5.Nxe2": the move that led to the position. */
  _last(sans) {
    return sans.length ? movetext(sans.slice(-1), sans.length - 1) : 'Start';
  }

  _worthTable(picks) {
    const sharp = (c) => (Number.isFinite(c?.sharpness) ? Math.round(c.sharpness) : null);
    const COLS = [
      // [heading, sort key, value for sorting, ascending]
      ['After', 'line', (p) => (p.position.sans ?? []).join('\u0001'), true], // grouped by line, earlier first
      ['Play', null],
      ['Break-even', 'breakeven', (p) => breakEven(p.cand, p.mine) ?? Infinity, true],
      ['Sharpness', 'sharpness', (p) => p.cand.sharpness],
      ['Yours', null],
      ['Difference', 'diff', (p) => (sharp(p.mine) === null || p.mine.allRecapture ? -Infinity : sharp(p.cand) - sharp(p.mine))],
      ['Good replies', 'good', (p) => p.cand.onlyMoves],
      ['In a row', 'inrow', (p) => p.cand.inRow],
      ['Gap', 'gap', (p) => (Number.isFinite(p.cand.gap) ? p.cand.gap : -1)],
      ['Cost', 'cost', (p) => p.cand.cost, true],
      ['Eval', null],
      ['Yours (eval)', null],
      ['Eval change', 'evalchg', (p) => {
        const d = evalChange(p.cand, p.mine, this.info.color);
        return d === null ? -Infinity : this.info.color === 'white' ? d.cp : -d.cp; // best for you first
      }],
      ['Depth', 'depth', (p) => p.cand.depth ?? 0],
      ['Seen', 'seen', (p) => (this._isSeen(p.position, p.cand.uci) ? 1 : 0), true],
    ];
    const sortKey = this.worthSort ?? 'breakeven';
    const col = COLS.find((c) => c[1] === sortKey) ?? COLS[2];
    const order = (a, b) => {
      const x = col[2](a);
      const y = col[2](b);
      if (x === y) return 0;
      if (x === Infinity || y === -Infinity) return 1; // "never" / unknown last, whichever way
      if (y === Infinity || x === -Infinity) return -1;
      const d = typeof x === 'string' ? x.localeCompare(y) : x - y; // the line: by its moves
      return col[3] ? d : -d;
    };
    const rows = [...picks].sort((a, b) => order(a, b) || b.cand.sharpness - a.cand.sharpness);

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
    const links = lineLinks(rows);
    const id = (p) => `${p.position.key}|${p.cand.uci}`;
    const focus = rows.findIndex((p) => id(p) === this.worthFocus);
    if (focus < 0) this.worthFocus = null;
    table.classList.toggle('pr-focusing', focus >= 0);
    for (const [i, { position, cand: c, mine }] of rows.entries()) {
      const seen = this._isSeen(position, c.uci);
      const tr = el('tr', seen ? 'seen' : '');
      if (focus >= 0) {
        const f = links[focus];
        tr.classList.add(i === focus ? 'pr-focus' : f.earlier.includes(i) ? 'pr-link-earlier' : f.later.includes(i) ? 'pr-link-later' : f.same.includes(i) ? 'pr-link-same' : 'pr-unlinked');
      }
      const where = el('td', 'pr-where');
      where.appendChild(el('span', '', this._last(position.sans)));
      where.title = `${movetext(position.sans)} …`;
      const { earlier, later, same } = links[i];
      if (earlier.length || later.length || same.length) {
        const parts = [earlier.length ? `↑${earlier.length}` : '', later.length ? `↓${later.length}` : '', same.length ? `=${same.length}` : ''].filter(Boolean);
        const tip = [
          earlier.length ? `${earlier.length} earlier in this line (changing ${earlier.length > 1 ? 'one of those' : 'that'} means this position doesn’t come up)` : '',
          later.length ? `${later.length} later in this line (this one would take ${later.length > 1 ? 'them' : 'it'} away)` : '',
          same.length ? `${same.length} more in this same position` : '',
        ].filter(Boolean).join('; ');
        const b = button(parts.join(' '), `pr-link-btn${i === focus ? ' on' : ''}`, () => {
          this.worthFocus = i === focus ? null : id(rows[i]);
          this._drawWorth(!this.run);
        }, `Same line: ${tip}. Tap to highlight them.`);
        b.setAttribute('aria-pressed', String(i === focus));
        where.appendChild(b);
      }
      const play = el('td', 'pr-move');
      play.appendChild(button(c.san, 'pr-move-btn', () => this._open(position, c), `Show on board. Main line: ${c.line.join(' ')}`));
      if (mine) play.appendChild(el('span', 'pr-instead', `not ${mine.san}`));
      const be = breakEven(c, mine);
      const beCell = el('td', `num pr-be${be === 0 ? ' free' : ''}`, breakEvenText(be));
      beCell.title = be === null ? '' : be === 0 ? 'At least as good as yours even if they find their best reply'
        : be === Infinity ? 'Their second-best gives you no more here than against your move: it never pays'
        : `It scores better than yours if they miss their best reply more than ${breakEvenText(be)} of the time`;
      const seenCell = el('td', 'pr-seen-cell');
      const tick = button(seen ? '✓' : '', `pr-seen${seen ? ' on' : ''}`, () => this._setSeen(position, c.uci, !seen), seen ? 'Seen: tap to unmark' : 'Mark as seen');
      tick.setAttribute('aria-pressed', String(seen));
      tick.setAttribute('aria-label', seen ? 'Seen' : 'Not seen');
      seenCell.appendChild(tick);
      const cells = [
        where,
        play,
        beCell,
        el('td', 'num pr-hot', sharp(c) === null ? '–' : String(sharp(c))),
        el('td', 'num', sharp(mine) === null ? '–' : `${sharp(mine)}${mine.allRecapture ? ' (recapture)' : ''}`),
        // from the shown values, so they add up; none against a recapture (its sharpness isn't real)
        diffCell(sharp(mine) === null || sharp(c) === null || mine.allRecapture ? null : sharp(c) - sharp(mine)),
        chainCell(c, () => this._openLine(position, c)),
        el('td', `num${c.inRow ? ' pr-hot' : ''}`, String(c.inRow)),
        gapCell(c),
        el('td', 'num', String(Math.round(c.cost))),
        el('td', 'num pr-eval', evalText(c.score)),
        el('td', 'num pr-eval', mine ? evalText(mine.score) : '–'),
        evalChangeCell(evalChange(c, mine, this.info.color)),
        depthCell(c.depth, this.opts.depth),
        seenCell,
      ];
      cells.forEach((td, i) => (td.dataset.label = COLS[i][0]));
      tr.append(...cells);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /** A position, folded to one line (your move, its chain, how many moves are still sharp); tap to see every move. */
  _positionCard({ position, cands }) {
    const card = el('details', 'dash-card pr-pos');
    card.id = `pr-pos-${position.key}`;
    this.openPositions ??= new Set();
    card.open = this.openPositions.has(position.key);
    card.addEventListener('toggle', () => (card.open ? this.openPositions.add(position.key) : this.openPositions.delete(position.key)));
    const sum = el('summary', 'pr-pos-sum');
    const mineC = cands.filter((c) => c.repertoire);
    const sharp = cands.filter((c) => !c.repertoire && !c.final && !c.stopped && (c.levels ?? []).length && c.levels.every((d) => stillSharp(d, this.opts ?? DEFAULTS)));
    const chainText = (c) => (c.final ? '' : `${c.goodChain.join(' → ')}${c.stopped ? ' → …' : ''}`);
    sum.append(
      el('span', 'pr-sum-after', this._last(position.sans)),
      el('span', 'pr-sum-yours', mineC.length ? mineC.map((c) => `${c.san} ${chainText(c)}`).join(', ') : 'not in your lines'),
      el('span', `pr-sum-sharp${sharp.length ? ' hot' : ''}`, `${sharp.length} of ${cands.length - mineC.length} still sharp${sharp.length ? `: ${sharp.map((c) => c.san).join(', ')}` : ''}`),
    );
    sum.title = `${movetext(position.sans)} … Tap to see every move checked here.`;
    card.appendChild(sum);
    const head = el('div', 'pr-pos-head');
    const flipped = this.info.color === 'black';
    head.appendChild(miniBoard(position.fen, movetext(position.sans), flipped));
    const t = el('div', 'pr-pos-title');
    const yours = position.repertoire.map((u) => cands.find((c) => c.uci === u)?.san).filter(Boolean);
    t.append(
      el('h3', 'pr-pos-moves', `${movetext(position.sans)} …`),
      el('p', 'pr-note', `${yours.length ? `Your move here: ${yours.join(', ')}` : 'Your move here'}${position.depth != null ? ` · your moves searched to depth ${position.depth}` : ''}`),
      button('Show on board', 'small', () => this.onShowLine(position.sans)),
    );
    head.appendChild(t);
    card.appendChild(head);
    const wrap = el('div', 'pr-table-wrap');
    const table = el('table', 'pr-table');
    const thead = el('thead');
    const hr = el('tr');
    const HEADS = ['Move', 'Eval', 'Engine', 'Cost', 'Good replies', 'In a row', 'Gap', 'Sharpness', 'Depth', 'Their replies → you'];
    for (const h of HEADS) hr.appendChild(el('th', '', h));
    thead.appendChild(hr);
    const tbody = el('tbody');
    for (const c of cands) {
      const tr = el('tr', c.repertoire ? 'mine' : '');
      const move = el('td', 'pr-move');
      const b = button(c.san, 'pr-move-btn', () => this._open(position, c), 'Show on board');
      move.appendChild(b);
      if (!c.repertoire && this._isSeen(position, c.uci)) move.appendChild(el('span', 'pr-seen-mark', '✓ seen'));
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
        chainCell(c, () => this._openLine(position, c)),
        el('td', `num${c.inRow ? ' pr-hot' : ''}`, final ? '–' : String(c.inRow)),
        gapCell(c),
        sharpCell(c),
        depthCell(c.final ? null : c.depth, this.opts.depth),
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

