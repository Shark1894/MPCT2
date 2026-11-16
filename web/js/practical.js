// Practical tab: moves in your openings that take the opponent into difficult territory, even
// at an engine cost. Pick an opening (or one branch of it, such as a branch tag) and Analyse:
// for every position where it's your move, each candidate move is judged by the engine's view of
// the opponent's replies (how many good ones, how far the next best falls behind, how often an
// opponent of the chosen strength would slip), so it works in lines nobody has played. Lichess
// games (2000+) can be used too where there are enough. See practical-core.js for the scoring.
//
// The engine runs here in the browser (Stockfish, like the reviews), never on the server; its
// lines are saved so a second run is quick. With Lichess data on, the server looks positions up
// in the explorer (one a second, with the app's LICHESS_TOKEN) and keeps the answers.

import { Chess } from '../vendor/chess.js/chess.js';
import { api } from './api.js';
import { button, el, miniBoard } from './dom.js';
import { Engine } from './engine.js';
import {
  DEFAULTS, STRENGTHS, candidateMoves, extraReplies, finalCandidate, finish, movetext, pct, scoreCandidate, winPct, worthALook,
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
const DATA = [
  [0, 'Engine only (any line)'],
  [1, 'Also Lichess games, 2000+ (where 30+)'],
];
const SAVE_BATCH = 20;

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
 * The engine and explorer work for one analysis: each answer asked for once, saved engine
 * lines used when good enough, new ones saved in batches.
 */
class Worker {
  constructor({ movetime, onWait }) {
    this.movetime = movetime;
    this.onWait = onWait;
    this.engine = null;
    this.evals = new Map(); // fen|multipv -> lines
    this.explored = new Map(); // fen -> stats | null
    this.pending = [];
    this.cancelled = false;
    this.counts = { engine: 0, saved: 0, lichess: 0 };
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

  /** How players at 2000+ continue (null: Lichess couldn't say; throws if there's no token). */
  async explore(fen) {
    if (this.explored.has(fen)) return this.explored.get(fen);
    let data = null;
    for (let attempt = 0; attempt < 2 && !this.cancelled; attempt++) {
      try {
        this.onWait?.(true);
        data = await api.practicalExplorer(fen);
        this.counts.lichess += 1;
        break;
      } catch (err) {
        if (err.status === 409) throw err; // no token: nothing will work
        if (attempt === 0) await new Promise((r) => setTimeout(r, 3000));
      } finally {
        this.onWait?.(false);
      }
    }
    this.explored.set(fen, data);
    return data;
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
  const here = opts.useData ? await w.explore(fen) : null;
  const hereStats = Object.fromEntries((here?.moves ?? []).map((m) => [m.uci, m]));
  const cands = [];
  for (const uci of candidateMoves(mine, here, position.repertoire, opts)) {
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
    const data = opts.useData ? await w.explore(next.fen) : null;
    const extra = {};
    for (const u of extraReplies(theirLines, data, opts)) {
      let r;
      try {
        r = after(next.fen, u);
      } catch {
        continue;
      }
      if (r.over) extra[u] = r.mate ? 0 : 50;
      else {
        const l = (await w.lines(r.fen, 1))[0];
        if (l) extra[u] = winPct(l.score, me);
      }
    }
    const sans = Object.fromEntries([...theirLines.map((l) => l.uci), ...Object.keys(extra)].map((u) => [u, sanOf(next.fen, u)]));
    cands.push(scoreCandidate({ uci, san, me, theirLines, extra, data, sans, moveStats: hereStats[uci] ?? null, repertoire }, opts));
  }
  return finish(cands, opts);
}

export class PracticalView {
  /** @param {{ onShowLine: (sans: string[]) => void }} deps  open moves on the Board tab */
  constructor({ onShowLine }) {
    this.onShowLine = onShowLine;
    this.box = document.getElementById('practical-view');
    this.settings = { openingId: null, tagId: null, movetime: 800, cap: 15, temperature: 8, data: 0, ...store.get('practical', {}) };
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
      el('p', 'pr-lead', 'Moves in your openings that take your opponent into difficult territory: few good replies, the next best clearly worse, so they’re likely to slip, even if the engine says you give a little away. It works from the engine’s view of their replies, so niche and never-played lines are fine.'),
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
    this.el.strength = select('pr-strength', STRENGTHS, this.settings.temperature, 'temperature');
    this.el.data = select('pr-data', DATA, this.settings.data, 'data');
    this.el.go = button('Analyse', 'primary', () => (this.run ? this.stop() : this.start()));
    this.el.go.id = 'pr-go';
    controls.append(
      field('Opening', this.el.opening),
      field('Branch', this.el.tag),
      field('Engine time', this.el.think),
      field('Moves to consider', this.el.cap),
      field('Opponent', this.el.strength),
      field('Replies from', this.el.data),
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
        ['Engine', 'your winning chances if they always find the best reply'],
        ['Cost', 'how many points of winning chances the move gives away against the engine’s best'],
        ['Good replies', 'how many of their replies stay within 7 points of their best: 1 means an only move'],
        ['Gap', 'how many points worse their second-best reply is than their best: the bigger, the more they must find exactly one move'],
        ['They go wrong', 'how often an opponent of the chosen strength would play a reply that isn’t good: a model that picks replies by how good they look to the engine, so slips are likelier when the alternatives are only a bit worse'],
        ['Trap value', 'the winning chances you expect to gain from their mistakes (practical minus engine)'],
        ['Practical', 'your expected winning chances over their replies, chosen that way'],
        ['Actual', 'with Lichess games on: your colour’s real score with the move at 2000+'],
      ]),
      el('p', 'pr-note', 'Points are winning chances (0–100). The opponent model is a rough guide: it can’t know which wrong moves look natural to a human, only how much worse they are.'),
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
    const opts = { ...DEFAULTS, cap: this.settings.cap, temperature: this.settings.temperature, useData: Boolean(this.settings.data) };
    this.opts = opts;
    const w = new Worker({ movetime: this.settings.movetime, onWait: (on) => this.el.progress.classList.toggle('waiting', on) });
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
      this.el.progress.classList.remove('waiting');
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
      el('span', 'pr-progress-wait', ' waiting for Lichess…'),
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
    box.replaceChildren(el('h2', 'dash-h2', 'Sharpest alternatives'), el('p', 'pr-note', 'Moves you don’t play yet where they have at most two good replies and slip at least 30% of the time, most trap value first.'));
    if (!picks.length) {
      box.appendChild(el('p', 'pr-note', final && this.results.length
        ? 'No alternative here is that sharp: the tables below show every one with its trap value.'
        : 'Nothing yet.'));
      return;
    }
    const list = el('ul', 'pr-worth-list');
    for (const p of picks) list.appendChild(this._worthItem(p));
    box.appendChild(list);
  }

  _worthItem({ position, cand: c, mine }) {
    const li = el('li', 'pr-worth-item');
    const flipped = this.info.color === 'black';
    let fenAfter = position.fen;
    try {
      fenAfter = after(position.fen, c.uci).fen;
    } catch {
      // keep the position before
    }
    li.appendChild(miniBoard(fenAfter, `After ${c.san}`, flipped));
    const text = el('div', 'pr-worth-text');
    const title = el('p', 'pr-worth-title');
    title.append(`${movetext(position.sans)} … `, el('strong', '', c.san), mine ? ` instead of ${mine.san}` : '');
    const facts = el('p', 'pr-facts');
    const chip = (label, value, cls = '') => {
      const s = el('span', `pr-chip ${cls}`);
      s.append(el('span', 'pr-chip-label', label), el('span', 'pr-chip-value', value));
      return s;
    };
    facts.append(
      chip('Trap value', `+${Math.round(c.trap)} pts${mine ? ` (yours +${Math.round(mine.trap)})` : ''}`, 'good'),
      chip('Good replies', String(c.good)),
      chip('Gap', Number.isFinite(c.gap) ? `${Math.round(c.gap)} pts` : '–'),
      chip('They go wrong', `${Math.round(c.wrong * 100)}%`),
      chip('Engine cost', `${Math.round(c.cost)} pts`),
    );
    if (c.actualGames) facts.appendChild(chip('Actual', `${pct(c.actual)} in ${c.actualGames.toLocaleString('en-GB')}`));
    const wrong = c.replies.filter((r) => !r.good && r.prob >= 0.05).slice(0, 2);
    const good = c.replies.filter((r) => r.good).slice(0, 2);
    const why = el('p', 'pr-why');
    why.textContent = [
      good.length ? `${good.length === 1 ? 'Only' : 'Just'} ${good.map((r) => r.san).join(' or ')} ${good.length === 1 ? 'holds' : 'hold'}, after which you’re at ${pct(c.engine)}.` : '',
      wrong.length ? `Tempting slips: ${wrong.map((r) => `${r.san} (you’re then at ${pct(r.mine)})`).join(', ')}.` : '',
      c.source === 'data' ? 'Reply shares from Lichess games.' : '',
    ].filter(Boolean).join(' ');
    const actions = el('div', 'pr-actions');
    actions.append(
      button('Show on board', 'small', () => this.onShowLine([...position.sans, c.san])),
      button('Details', 'small ghost', () => document.getElementById(`pr-pos-${position.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })),
    );
    text.append(title, facts, why, actions);
    li.appendChild(text);
    return li;
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
    const withData = Boolean(this.opts?.useData);
    const HEADS = ['Move', 'Trap value', 'Good replies', 'Gap', 'They go wrong', 'Engine', 'Cost', 'Practical', ...(withData ? ['Actual'] : []), 'Their replies → you'];
    for (const h of HEADS) hr.appendChild(el('th', '', h));
    thead.appendChild(hr);
    const tbody = el('tbody');
    for (const c of cands) {
      const tr = el('tr', c.repertoire ? 'mine' : '');
      const move = el('td', 'pr-move');
      const b = button(c.san, 'pr-move-btn', () => this.onShowLine([...position.sans, c.san]), 'Show on board');
      move.appendChild(b);
      if (c.repertoire) move.appendChild(el('span', 'pr-yours', 'yours'));
      const practical = el('td', 'num');
      practical.append(pct(c.practical));
      if (withData && c.source === 'model') practical.appendChild(el('span', 'pr-model', 'model'));
      const likely = el('td', 'pr-replies');
      likely.textContent = c.replies
        .filter((r) => r.prob >= 0.03)
        .slice(0, 4)
        .map((r) => `${r.san} ${Math.round(r.prob * 100)}% → ${pct(r.mine)}${r.good ? '' : ' ✗'}`)
        .join(', ');
      const final = c.source === 'final';
      tr.append(
        move,
        el('td', `num${c.trap >= 3 ? ' pr-hot' : ''}`, final ? '–' : `+${Math.round(c.trap)}`),
        el('td', `num${c.good === 1 ? ' pr-hot' : ''}`, final ? '–' : String(c.good)),
        el('td', 'num', final || !Number.isFinite(c.gap) ? '–' : String(Math.round(c.gap))),
        el('td', 'num', final ? '–' : `${Math.round(c.wrong * 100)}%`),
        el('td', 'num', pct(c.engine)),
        el('td', 'num', String(Math.round(c.cost))),
        practical,
        ...(withData ? [el('td', 'num', c.actualGames ? `${pct(c.actual)} (${c.actualGames.toLocaleString('en-GB')})` : '–')] : []),
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

