// Practical choices: the scoring, apart from the engine and the page (unit tested).
//
// For a position where it's your move, each candidate move gets:
//   engine     your win% if the opponent always finds their best reply
//   practical  your expected win% over the replies real players choose (Lichess games at the
//              practical ratings): each reply weighted by how often it's played, scored by the
//              engine after it
//   wrong      how often they don't play a good reply (one within `good` win% of their best)
//   good       how many good replies they have (1 = an only move)
//   actual     your colour's real score with the move in those games
// With too few games the replies are guessed from the engine (a softmax over their win%): it
// can't know which mistakes look natural, so these are marked as modelled.

export const DEFAULTS = {
  candidates: 8, // engine moves considered for you
  replies: 5, // engine replies considered for them
  cap: 15, // most win% a move may cost to be listed
  good: 7, // a reply within this many win% of their best is good
  minGames: 30, // games in a position needed to trust real reply shares
  minMoveGames: 10, // games needed to consider (or score) a move from the data
  minMoveShare: 0.03, // and a move people play is only considered when this common
  extraShare: 0.05, // replies beyond the engine's best are scored when played at least this often
  maxExtra: 3, // and at most this many of them (most played first)
  temperature: 6, // the model: lower = they find good moves more often
  margin: 3, // practical gain over your move to be worth a look
  minWrong: 0.3, // and they must go wrong at least this often
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
  for (const m of here?.moves ?? []) {
    if (games(m) >= opts.minMoveGames && games(m) >= total * opts.minMoveShare && !out.includes(m.uci)) out.push(m.uci);
  }
  for (const u of repertoire) if (!out.includes(u)) out.push(u);
  return out;
}

/** Their replies worth scoring beyond the engine's best: the ones people play often (only when
 *  there are enough games to say what's played). Each costs an engine analysis. */
export function extraReplies(theirLines, data, opts = DEFAULTS) {
  const total = games(data);
  if (total < opts.minGames) return [];
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
  const useData = total >= opts.minGames;
  let probs;
  if (useData) {
    const n = Object.keys(theirs).reduce((a, u) => a + games(played[u]), 0) || 1;
    probs = Object.fromEntries(Object.keys(theirs).map((u) => [u, games(played[u]) / n]));
  } else probs = modelProbs(theirs, opts.temperature);
  const replies = Object.entries(theirs)
    .map(([u, v]) => ({ uci: u, san: sans[u] ?? played[u]?.san ?? u, prob: probs[u] ?? 0, games: games(played[u]), mine: 100 - v, good: v >= best - opts.good }))
    .sort((a, b) => b.prob - a.prob || b.mine - a.mine);
  const actualOk = moveStats && games(moveStats) >= opts.minMoveGames;
  return {
    uci,
    san,
    repertoire,
    engine: 100 - best,
    practical: replies.reduce((a, r) => a + r.prob * r.mine, 0),
    wrong: replies.filter((r) => !r.good).reduce((a, r) => a + r.prob, 0),
    good: replies.filter((r) => r.good).length,
    source: useData ? 'data' : 'model',
    replies,
    actual: actualOk ? scoreFor(moveStats, me) : NaN,
    actualGames: actualOk ? games(moveStats) : 0,
    cost: 0,
  };
}

/** A move that ends the game: its value straight from the result. */
export function finalCandidate({ uci, san, value, repertoire = false }) {
  return { uci, san, repertoire, engine: value, practical: value, wrong: 0, good: 0, source: 'final', replies: [], actual: NaN, actualGames: 0, cost: 0 };
}

/** Costs against your best move; keep those within the cap (and yours); best practical first. */
export function finish(cands, opts = DEFAULTS) {
  if (!cands.length) return [];
  const best = Math.max(...cands.map((c) => c.engine));
  for (const c of cands) c.cost = best - c.engine;
  return cands.filter((c) => c.cost <= opts.cap || c.repertoire).sort((a, b) => b.practical - a.practical || a.cost - b.cost);
}

/**
 * Moves that beat your repertoire's on practical value by the margin, where they go wrong often
 * enough. results: [{position, cands}]. Returns [{position, cand, mine}] best gain first.
 */
export function worthALook(results, opts = DEFAULTS) {
  const out = [];
  for (const r of results) {
    if (!r.cands.length) continue;
    const mine = r.cands.find((c) => c.repertoire) ?? null;
    const base = mine ? mine.practical : Math.max(...r.cands.map((c) => c.practical));
    for (const c of r.cands) {
      if (c.repertoire || c.cost <= 0.5) continue;
      if (c.practical >= base + opts.margin && c.wrong >= opts.minWrong) out.push({ position: r.position, cand: c, mine, gain: c.practical - base });
    }
  }
  return out.sort((a, b) => b.gain - a.gain);
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

/** "63%" (or "–" when unknown). */
export const pct = (x) => (Number.isFinite(x) ? `${Math.round(x)}%` : '–');
