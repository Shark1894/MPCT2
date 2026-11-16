// Practical choices: the scoring, apart from the engine and the page (unit tested).
//
// Everything here comes from the engine's evaluations, in winning chances (Lichess's win%, 0-100),
// with no model of the opponent. For a position where it's your move, each candidate move gets,
// from the engine's view of the opponent's best replies to it:
//   engine     your win% after the move and their best reply (score: the same as an eval)
//   cost       win% the move gives away against the engine's best move here
//   good       how many of their replies stay within `good` win% of their best (1 = an only move)
//   gap        how much worse (win%) their second-best reply is than their best
//   sharpness  how much worse their other top replies are than their best, on average (win%):
//              high when nearly everything but the best move goes wrong for them
//   recapture  your move captures and their best reply simply takes back on that square: the
//              "only move" is obvious, so it isn't sharp in practice (as in the old Sharpness scripts)

export const DEFAULTS = {
  candidates: 8, // engine moves considered for you
  replies: 8, // engine replies considered for them
  cap: 15, // most win% a move may cost to be listed
  good: 7, // a reply within this many win% of their best is good
  maxGood: 2, // sharpest alternatives: they have at most this many good replies
  minGap: 5, // and their second-best is at least this much worse
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

export const other = (color) => (color === 'white' ? 'black' : 'white');

/** Your candidate moves: the engine's best (each once), then your repertoire's. */
export function candidateMoves(myLines, repertoire = [], opts = DEFAULTS) {
  const out = [...new Set(myLines.slice(0, opts.candidates).map((l) => l.uci))];
  for (const u of repertoire) if (!out.includes(u)) out.push(u);
  return out;
}

/**
 * Score one of your moves from the engine's best replies to it.
 * @param {object} p
 * @param {string} p.uci, p.san
 * @param {string} p.me              your colour
 * @param {{uci, score}[]} p.theirLines  the engine's best replies after your move (White-POV scores)
 * @param {Object<string, string>} p.sans  reply uci -> SAN
 * @param {boolean} p.repertoire
 * @param {boolean} p.capture  your move takes something
 */
export function scoreCandidate({ uci, san, me, theirLines, sans = {}, repertoire = false, capture = false }, opts = DEFAULTS) {
  const them = other(me);
  const replies = theirLines
    .map((l) => ({ uci: l.uci, san: sans[l.uci] ?? l.uci, score: l.score, theirs: winPct(l.score, them) }))
    .sort((a, b) => b.theirs - a.theirs);
  const best = replies[0]?.theirs ?? 50;
  for (const r of replies) {
    r.mine = 100 - r.theirs;
    r.loss = best - r.theirs; // what this reply costs them against their best
    r.good = r.loss <= opts.good;
  }
  const others = replies.slice(1);
  return {
    uci,
    san,
    repertoire,
    engine: 100 - best,
    score: replies[0]?.score ?? null, // the eval after the move and their best reply (White's view)
    cost: 0,
    good: replies.filter((r) => r.good).length,
    gap: others.length ? others[0].loss : NaN,
    sharpness: others.length ? others.reduce((a, r) => a + r.loss, 0) / others.length : NaN,
    recapture: Boolean(capture && replies[0] && replies[0].uci.slice(2, 4) === uci.slice(2, 4)),
    replies,
    final: false,
  };
}

/** A move that ends the game: its value straight from the result. */
export function finalCandidate({ uci, san, value, repertoire = false }) {
  return { uci, san, repertoire, engine: value, score: value === 50 ? { cp: 0 } : null, cost: 0, good: 0, gap: NaN, sharpness: NaN, replies: [], final: true, mate: value === 100 };
}

/** Costs against your best move; keep those within the cap (and yours); least cost first. */
export function finish(cands, opts = DEFAULTS) {
  if (!cands.length) return [];
  const best = Math.max(...cands.map((c) => c.engine));
  for (const c of cands) c.cost = best - c.engine;
  return cands.filter((c) => c.cost <= opts.cap || c.repertoire).sort((a, b) => a.cost - b.cost || (b.sharpness || 0) - (a.sharpness || 0));
}

/**
 * The sharpest alternatives to your repertoire's moves: moves (within the cost cap) where they
 * have at most `maxGood` good replies and their second-best is at least `minGap` worse, sharpest
 * first. Captures they simply take back are left out, and so are moves less sharp than yours
 * (compared as shown, rounded). results: [{position, cands}]. Returns [{position, cand, mine}].
 */
export function worthALook(results, opts = DEFAULTS) {
  const out = [];
  for (const r of results) {
    const mine = r.cands.find((c) => c.repertoire) ?? null;
    for (const c of r.cands) {
      if (c.repertoire || c.final || c.recapture) continue;
      if (!(c.good <= opts.maxGood && c.gap >= opts.minGap)) continue;
      // never less sharp than what you play (unless yours only looks sharp because it's a recapture)
      if (mine && !mine.recapture && Number.isFinite(mine.sharpness) && Math.round(c.sharpness) < Math.round(mine.sharpness)) continue;
      out.push({ position: r.position, cand: c, mine });
    }
  }
  return out.sort((a, b) => b.cand.sharpness - a.cand.sharpness || a.cand.cost - b.cand.cost).slice(0, opts.maxWorth);
}

/**
 * How the eval changes if you play `cand` instead of `mine` (after their best reply each time):
 * {cp} in White's view (as evals are written) and whether that's better for you (`me`).
 * null when either is unknown or a mate.
 */
export function evalChange(cand, mine, me) {
  const a = cand?.score;
  const b = mine?.score;
  if (!a || !b || a.mate != null || b.mate != null || a.cp == null || b.cp == null) return null;
  const cp = a.cp - b.cp;
  const forMe = me === 'white' ? cp : -cp;
  return { cp, better: forMe > 0, worse: forMe < 0 };
}

/**
 * Break-even: how often they'd have to miss their best reply (playing their second-best instead)
 * for `cand` to score better than `mine`, all in your winning chances from the engine:
 *   A, A2 = your move after their best / second-best reply; B, B2 = the same for the suggestion
 *   break-even = (A - B) / ((A - B) + (B2 - A2))
 * 0 when the suggestion is at least as good even if they find their best (it costs nothing);
 * Infinity when their mistake gains you no more than against your move (it never pays).
 * null when there's nothing to compare with.
 */
export function breakEven(cand, mine) {
  if (!cand || !mine || cand.final || mine.final) return null;
  const A = mine.engine;
  const A2 = mine.replies[1]?.mine ?? A;
  const B = cand.engine;
  const B2 = cand.replies[1]?.mine ?? B;
  const cost = A - B;
  if (cost <= 0) return 0;
  const gain = B2 - A2;
  if (gain <= 0) return Infinity;
  return cost / (cost + gain);
}

/** "20%", "free" (0) or "never". */
export function breakEvenText(p) {
  if (p === null) return '–';
  if (p === 0) return 'free';
  if (p === Infinity) return 'never';
  return `${Math.max(1, Math.round(p * 100))}%`;
}

/** An eval as players write it, White's view: "+0.35", "−1.20", "#3", "#−2" ("–" when unknown). */
export function evalText(score) {
  if (!score) return '–';
  if (score.mate != null) return score.mate === 0 ? '#' : `#${score.mate < 0 ? '−' : ''}${Math.abs(score.mate)}`;
  const p = score.cp / 100;
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(2)}`;
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

/** "+3", "−2", "0" (rounded; "–" when unknown). */
export const signed = (x) => {
  if (!Number.isFinite(x)) return '–';
  const n = Math.round(x);
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
};
