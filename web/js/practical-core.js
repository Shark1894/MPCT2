// Practical choices: the scoring, apart from the engine and the page (unit tested).
//
// For a position where it's your move, each candidate move gets, from the engine's view of the
// opponent's replies (so it works in lines nobody has played):
//   engine     your win% if the opponent always finds their best reply
//   good       how many good replies they have (within `good` win% of their best; 1 = an only move)
//   gap        how much worse (win%) their second-best reply is than their best
//   wrong      how often an opponent of the chosen strength doesn't play a good reply: a model
//              where each reply is chosen with weight exp(-(how much worse it is) / temperature),
//              so slips are likelier when the alternatives are only a bit worse
//   practical  your expected win% over their replies chosen that way
//   trap       practical - engine: what you expect to gain from their mistakes
// Optionally (useData) the reply shares come from Lichess games at the practical ratings where
// there are enough of them, and `actual` is your colour's real score with the move there.

export const DEFAULTS = {
  candidates: 8, // engine moves considered for you
  replies: 8, // engine replies considered for them
  cap: 15, // most win% a move may cost to be listed
  good: 7, // a reply within this many win% of their best is good
  minGames: 30, // games in a position needed to trust real reply shares
  minMoveGames: 10, // games needed to consider (or score) a move from the data
  minMoveShare: 0.03, // and a move people play is only considered when this common
  extraShare: 0.05, // replies beyond the engine's best are scored when played at least this often
  maxExtra: 3, // and at most this many of them (most played first)
  temperature: 8, // the model: lower = they find good moves more often (see STRENGTHS)
  useData: false, // use Lichess games for reply shares where there are enough
  maxGood: 2, // worth a look: they have at most this many good replies
  minWrong: 0.3, // and slip at least this often
  maxWorth: 12, // and the list stops here
};

/** Lichess's win% (0-100) for `color` ('white' | 'black') from a White-POV score {cp} | {mate}. */
export function winPct(score, color) {
  let w;
  if (score.mate != null) w = score.mate > 0 ? 100 : score.mate < 0 ? 0 : 50; // saved lines carry mate: null
  else {
    const cp = Math.max(-1000, Math.min(1000, score.cp));
    w = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }
  return color === 'white' ? w : 100 - w;
}

/** Opponent strength -> the model's temperature (win% points): a rough guide, not a fit. */
export const STRENGTHS = [
  [5, 'Strong (2200+): rarely slips'],
  [8, 'Club 2000: slips under pressure'],
  [12, 'Club 1800: slips more often'],
];

export const other = (color) => (color === 'white' ? 'black' : 'white');

export const games = (s) => (s ? s.white + s.draws + s.black : 0);

/** Percentage score for `color` in these games (wins + half the draws); NaN with none. */
export function scoreFor(s, color) {
  const n = games(s);
  if (!n) return NaN;
  return (100 * ((color === 'white' ? s.white : s.black) + s.draws / 2)) / n;
}

/** The model's guess at how often each reply is played, from how good it is for them. */
export function modelProbs(values, temperature) {
  const entries = Object.entries(values);
  if (!entries.length) return {};
  const top = Math.max(...entries.map(([, v]) => v));
  const w = entries.map(([m, v]) => [m, Math.exp((v - top) / temperature)]);
  const total = w.reduce((n, [, x]) => n + x, 0);
  return Object.fromEntries(w.map(([m, x]) => [m, x / total]));
}

/** Your candidate moves: the engine's best, then moves people play here, then your repertoire's. */
export function candidateMoves(myLines, here, repertoire = [], opts = DEFAULTS) {
  const out = [...new Set(myLines.slice(0, opts.candidates).map((l) => l.uci))];
  const total = games(here);
  for (const m of opts.useData ? (here?.moves ?? []) : []) {
    if (games(m) >= opts.minMoveGames && games(m) >= total * opts.minMoveShare && !out.includes(m.uci)) out.push(m.uci);
  }
  for (const u of repertoire) if (!out.includes(u)) out.push(u);
  return out;
}

/** Their replies worth scoring beyond the engine's best: the ones people play often (only when
 *  there are enough games to say what's played). Each costs an engine analysis. */
export function extraReplies(theirLines, data, opts = DEFAULTS) {
  const total = games(data);
  if (!opts.useData || total < opts.minGames) return [];
  const known = new Set(theirLines.map((l) => l.uci));
  return (data?.moves ?? [])
    .filter((m) => !known.has(m.uci) && games(m) / total >= opts.extraShare)
    .sort((a, b) => games(b) - games(a))
    .slice(0, opts.maxExtra)
    .map((m) => m.uci);
}

/**
 * Score one of your moves.
 * @param {object} p
 * @param {string} p.uci, p.san
 * @param {string} p.me              your colour
 * @param {{uci, score}[]} p.theirLines  the engine's best replies after your move (White-POV scores)
 * @param {Object<string, number>} p.extra  your win% after other replies people play (uci -> win%)
 * @param {object|null} p.data       explorer stats after your move
 * @param {Object<string, string>} p.sans  reply uci -> SAN
 * @param {object|null} p.moveStats  explorer stats of your move in the position before
 * @param {boolean} p.repertoire
 */
export function scoreCandidate({ uci, san, me, theirLines, extra = {}, data = null, sans = {}, moveStats = null, repertoire = false }, opts = DEFAULTS) {
  const them = other(me);
  const theirs = {}; // reply -> their win%
  for (const l of theirLines) theirs[l.uci] = winPct(l.score, them);
  for (const [u, mine] of Object.entries(extra)) if (!(u in theirs)) theirs[u] = 100 - mine;
  const best = Math.max(...Object.values(theirs));
  const total = games(data);
  const played = Object.fromEntries((data?.moves ?? []).map((m) => [m.uci, m]));
  const useData = opts.useData && total >= opts.minGames;
  let probs;
  if (useData) {
    const n = Object.keys(theirs).reduce((a, u) => a + games(played[u]), 0) || 1;
    probs = Object.fromEntries(Object.keys(theirs).map((u) => [u, games(played[u]) / n]));
  } else probs = modelProbs(theirs, opts.temperature);
  const replies = Object.entries(theirs)
    .map(([u, v]) => ({ uci: u, san: sans[u] ?? played[u]?.san ?? u, prob: probs[u] ?? 0, games: games(played[u]), mine: 100 - v, good: v >= best - opts.good }))
    .sort((a, b) => b.prob - a.prob || b.mine - a.mine);
  const actualOk = moveStats && games(moveStats) >= opts.minMoveGames;
  const sorted = Object.values(theirs).sort((a, b) => b - a);
  const engine = 100 - best;
  const top = theirLines.find((l) => winPct(l.score, them) === best) ?? theirLines[0];
  const practical = replies.reduce((a, r) => a + r.prob * r.mine, 0);
  return {
    uci,
    san,
    repertoire,
    engine,
    score: top ? top.score : null, // the engine's eval after the move and their best reply (White's view)
    practical,
    trap: practical - engine,
    wrong: replies.filter((r) => !r.good).reduce((a, r) => a + r.prob, 0),
    good: replies.filter((r) => r.good).length,
    gap: sorted.length > 1 ? sorted[0] - sorted[1] : NaN,
    source: useData ? 'data' : 'model',
    replies,
    actual: actualOk ? scoreFor(moveStats, me) : NaN,
    actualGames: actualOk ? games(moveStats) : 0,
    cost: 0,
  };
}

/** A move that ends the game: its value straight from the result. */
export function finalCandidate({ uci, san, value, repertoire = false }) {
  return { uci, san, repertoire, engine: value, score: value === 50 ? { cp: 0 } : null, final: value === 100, practical: value, trap: 0, wrong: 0, good: 0, gap: NaN, source: 'final', replies: [], actual: NaN, actualGames: 0, cost: 0 };
}

/** Costs against your best move; keep those within the cap (and yours); best practical first. */
export function finish(cands, opts = DEFAULTS) {
  if (!cands.length) return [];
  const best = Math.max(...cands.map((c) => c.engine));
  for (const c of cands) c.cost = best - c.engine;
  return cands.filter((c) => c.cost <= opts.cap || c.repertoire).sort((a, b) => b.practical - a.practical || a.cost - b.cost);
}

/**
 * The sharpest alternatives to your repertoire's moves: moves (within the cost cap) where the
 * opponent has at most `maxGood` good replies and slips at least `minWrong` of the time, most
 * trap value first. results: [{position, cands}]. Returns [{position, cand, mine}].
 */
export function worthALook(results, opts = DEFAULTS) {
  const out = [];
  for (const r of results) {
    const mine = r.cands.find((c) => c.repertoire) ?? null;
    for (const c of r.cands) {
      if (c.repertoire || c.source === 'final') continue;
      if (c.good <= opts.maxGood && c.wrong >= opts.minWrong) out.push({ position: r.position, cand: c, mine });
    }
  }
  return out.sort((a, b) => b.cand.trap - a.cand.trap || a.cand.cost - b.cand.cost).slice(0, opts.maxWorth);
}

/** "1.e4 d5 2.exd5" from SAN moves (from the start). */
export function movetext(sans, from = 0) {
  return sans
    .map((s, i) => {
      const ply = from + i;
      if (ply % 2 === 0) return `${ply / 2 + 1}.${s}`;
      return i === 0 ? `${Math.floor(ply / 2) + 1}…${s}` : s;
    })
    .join(' ');
}

/** An eval as players write it, White's view: "+0.35", "−1.20", "#3", "#−2" ("–" when unknown). */
export function evalText(score) {
  if (!score) return '–';
  if (score.mate != null) return score.mate === 0 ? '#' : `#${score.mate < 0 ? '−' : ''}${Math.abs(score.mate)}`;
  const p = score.cp / 100;
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(2)}`;
}

/** "63%" (or "–" when unknown). */
export const pct = (x) => (Number.isFinite(x) ? `${Math.round(x)}%` : '–');
