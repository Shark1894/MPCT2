#!/usr/bin/env python3
"""Practical choices: moves that put a human opponent under pressure, even at an engine cost.

Prototype for backlog item 7 (sharpness). For every position in your lines where it's your move,
it compares your candidate moves on two scales:

  engine     your win% if the opponent always finds the best reply (what Stockfish says)
  practical  your expected win% if they reply as real players do: each reply weighted by how
             often players rated 2000+ choose it on Lichess, and scored by Stockfish after it

and on what actually happened: the score players of your colour got with the move at 2000+.

A move that costs a little on the engine scale but gains on the practical one is a weapon: the
opponent has few good replies ("only moves") and the natural ones go wrong. The report shows
what they have to find, how often they don't, and where you stand if they do.

Needs python-chess (pip install chess, or Arch: python-chess) and a Stockfish binary. Uses the
Lichess opening explorer, which needs a token: LICHESS_TOKEN in the environment (the same free,
no-scope token as the app's .env). Without one (--no-explorer) replies are guessed from the
engine evals alone, which can't know which mistakes are natural: a much weaker test.

Usage:
    # 1. on the server: your lines from the app
    docker compose exec mpct python -m app.tools.export_lines "Wuss" > wuss.txt
    # 2. on a machine with Stockfish (your desktop: faster than the server)
    LICHESS_TOKEN=lip_... python scripts/practical_choices.py --lines wuss.txt \\
        --root "e4 d5 exd5 Nf6 d4 Bg4 Be2 Bxe2" --out wuss-practical.md

Engine and explorer answers are cached in a JSON file (--cache), so a second run with other
thresholds is quick. Explorer requests go one a second, as Lichess asks.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

import chess
import chess.engine

EXPLORER = "https://explorer.lichess.ovh/lichess"
USER_AGENT = "MPCT practical-choices prototype (personal chess training)"


# ---- numbers ---------------------------------------------------------------------------------


def win_pct(score: chess.engine.PovScore, color: chess.Color) -> float:
    """Lichess's win% (0-100) from `color`'s side: 50 + 50 * (2 / (1 + e^(-0.00368208 cp)) - 1)."""
    s = score.pov(color)
    if s.is_mate():
        return 100.0 if s.mate() > 0 else 0.0
    cp = max(-1000, min(1000, s.score()))
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def model_probs(values: dict[str, float], temperature: float) -> dict[str, float]:
    """No explorer data: guess how often each reply is played from how good it is for the replier
    (softmax over their win%). Strong replies likelier; it can't know which mistakes look natural."""
    if not values:
        return {}
    top = max(values.values())
    w = {m: math.exp((v - top) / temperature) for m, v in values.items()}
    total = sum(w.values())
    return {m: x / total for m, x in w.items()}


# ---- engine ------------------------------------------------------------------------------------


class Engine:
    """Stockfish with a cache of analyses by (position, depth, multipv)."""

    def __init__(self, path: str, depth: int, threads: int, hash_mb: int, cache: dict):
        self.depth = depth
        self.cache = cache.setdefault("engine", {})
        self.engine = chess.engine.SimpleEngine.popen_uci(path)
        self.engine.configure({"Threads": threads, "Hash": hash_mb})
        self.calls = 0

    def lines(self, board: chess.Board, multipv: int) -> list[tuple[str, chess.engine.PovScore]]:
        """The best `multipv` moves from this position with their scores (best first)."""
        key = f"{board.epd()}|{self.depth}|{multipv}"
        if key not in self.cache:
            infos = self.engine.analyse(board, chess.engine.Limit(depth=self.depth), multipv=multipv)
            self.cache[key] = [
                [info["pv"][0].uci(), info["score"].white().score(mate_score=None), info["score"].white().mate()]
                for info in infos
                if info.get("pv")
            ]
            self.calls += 1
        out = []
        for uci, cp, mate in self.cache[key]:
            score = chess.engine.Mate(mate) if mate is not None else chess.engine.Cp(cp)
            out.append((uci, chess.engine.PovScore(score, chess.WHITE)))
        return out

    def best_for(self, board: chess.Board, color: chess.Color) -> float:
        """`color`'s win% in this position with best play (game over: from the result)."""
        if board.is_game_over():
            result = board.result(claim_draw=True)
            return 50.0 if result == "1/2-1/2" else (100.0 if (result == "1-0") == (color == chess.WHITE) else 0.0)
        return win_pct(self.lines(board, 1)[0][1], color)

    def close(self):
        self.engine.quit()


# ---- explorer ----------------------------------------------------------------------------------


class Explorer:
    """The Lichess opening explorer (Lichess games, chosen rating bands), cached, one request a second."""

    def __init__(self, token: str | None, ratings: str, speeds: str | None, cache: dict, enabled: bool = True):
        self.token = token
        self.ratings = ratings
        self.speeds = speeds
        self.cache = cache.setdefault("explorer", {})
        self.enabled = enabled and bool(token)
        self.last = 0.0
        self.calls = 0

    def lookup(self, board: chess.Board) -> dict | None:
        if not self.enabled:
            return None
        params = {"variant": "standard", "fen": board.fen(), "ratings": self.ratings, "moves": 30,
                  "topGames": 0, "recentGames": 0}
        if self.speeds:
            params["speeds"] = self.speeds
        key = f"{board.epd()}|{self.ratings}|{self.speeds or 'all'}"
        if key in self.cache:
            return self.cache[key]
        url = f"{EXPLORER}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json",
                                                   "Authorization": f"Bearer {self.token}"})
        for attempt in range(4):
            wait = 1.0 - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                with urllib.request.urlopen(req, timeout=30) as res:
                    data = json.loads(res.read().decode())
                break
            except urllib.error.HTTPError as exc:
                if exc.code == 429 and attempt < 3:
                    print("  explorer: too many requests, waiting a minute", file=sys.stderr)
                    time.sleep(61)
                    continue
                if exc.code in (401, 403):
                    raise SystemExit(f"Lichess refused the token (HTTP {exc.code}): check LICHESS_TOKEN") from exc
                raise SystemExit(f"Lichess explorer: HTTP {exc.code}") from exc
        else:
            raise SystemExit("Lichess explorer kept answering 429")
        slim = {
            "white": data.get("white", 0), "draws": data.get("draws", 0), "black": data.get("black", 0),
            "moves": [{"uci": m["uci"], "san": m["san"], "white": m["white"], "draws": m["draws"], "black": m["black"]}
                      for m in data.get("moves", [])],
        }
        self.cache[key] = slim
        self.calls += 1
        return slim


def games(stats: dict) -> int:
    return stats["white"] + stats["draws"] + stats["black"]


def score_for(stats: dict, color: chess.Color) -> float:
    """Percentage score for `color` in these games (wins + half the draws)."""
    n = games(stats)
    won = stats["white"] if color == chess.WHITE else stats["black"]
    return 100 * (won + stats["draws"] / 2) / n if n else float("nan")


# ---- analysis ----------------------------------------------------------------------------------


@dataclass
class Reply:
    uci: str
    san: str
    prob: float  # how often it's played (explorer share, or the model's guess)
    games: int  # explorer games (0 when modelled)
    mine: float  # your win% after it (engine, your best reply)
    good: bool  # within --good of their best reply


@dataclass
class Candidate:
    uci: str
    san: str
    engine: float  # your win% if they find the best reply
    cost: float  # engine win% given up against your best move
    practical: float  # expected win% over their likely replies
    wrong: float  # chance they don't play a good reply
    good_replies: int  # how many replies keep them within --good of their best
    source: str  # "data" (explorer shares) or "model"
    replies: list[Reply] = field(default_factory=list)
    actual: float = float("nan")  # your colour's score with this move at the chosen ratings
    actual_games: int = 0
    repertoire: bool = False


def analyse_position(board: chess.Board, me: chess.Color, rep_move: str | None, eng: Engine, exp: Explorer,
                     args) -> list[Candidate]:
    """Your candidate moves here, each with engine and practical values."""
    here = exp.lookup(board)
    cands = [uci for uci, _ in eng.lines(board, args.candidates)]
    if here:
        for m in here["moves"]:
            if games(m) >= args.min_move_games and m["uci"] not in cands:
                cands.append(m["uci"])
    if rep_move and rep_move not in cands:
        cands.append(rep_move)
    here_stats = {m["uci"]: m for m in here["moves"]} if here else {}

    out = []
    for uci in cands:
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            continue
        san = board.san(move)
        after = board.copy()
        after.push(move)
        if after.is_game_over():
            v = eng.best_for(after, me)
            out.append(Candidate(uci, san, v, 0, v, 0, 0, "-", repertoire=uci == rep_move))
            continue
        them = not me
        # Their replies: the engine's best few, plus what people actually play.
        top = eng.lines(after, args.replies)
        their = {u: win_pct(sc, them) for u, sc in top}
        data = exp.lookup(after)
        total = games(data) if data else 0
        played = {m["uci"]: m for m in data["moves"]} if data else {}
        use_data = total >= args.min_games
        for u, m in played.items():
            if u not in their and (not use_data or games(m) / total >= args.min_share):
                nb = after.copy()
                nb.push(chess.Move.from_uci(u))
                their[u] = 100 - eng.best_for(nb, me)
        best_theirs = max(their.values())
        if use_data:
            counted = {u: games(m) for u, m in played.items() if u in their}
            n = sum(counted.values()) or 1
            probs = {u: counted.get(u, 0) / n for u in their}
            source = "data"
        else:
            probs = model_probs(their, args.temperature)
            source = "model"
        replies = []
        for u, v in their.items():
            r = chess.Move.from_uci(u)
            replies.append(Reply(u, after.san(r), probs.get(u, 0.0), games(played[u]) if u in played else 0,
                                 100 - v, v >= best_theirs - args.good))
        replies.sort(key=lambda r: (-r.prob, -r.mine))
        engine_v = 100 - best_theirs
        c = Candidate(
            uci, san, engine_v, 0.0,
            sum(r.prob * r.mine for r in replies),
            sum(r.prob for r in replies if not r.good),
            sum(1 for r in replies if r.good),
            source, replies, repertoire=uci == rep_move,
        )
        if uci in here_stats and games(here_stats[uci]) >= args.min_move_games:
            c.actual, c.actual_games = score_for(here_stats[uci], me), games(here_stats[uci])
        out.append(c)
    if not out:
        return out
    best = max(c.engine for c in out)
    for c in out:
        c.cost = best - c.engine
    keep = [c for c in out if c.cost <= args.cap or c.repertoire]
    keep.sort(key=lambda c: -c.practical)
    return keep


# ---- lines -------------------------------------------------------------------------------------


def read_lines(path: str) -> tuple[list[list[str]], chess.Color | None]:
    lines, color = [], None
    with open(path) as f:
        for row in f:
            row = row.strip()
            if not row:
                continue
            if row.startswith("#"):
                if "(white)" in row:
                    color = chess.WHITE
                elif "(black)" in row:
                    color = chess.BLACK
                continue
            lines.append(row.split())
    return lines, color


def parse_root(text: str) -> list[str]:
    """SAN or UCI moves from the start ("e4 d5 exd5 Nf6", move numbers allowed) -> UCI."""
    board = chess.Board()
    out = []
    for tok in text.replace(".", ". ").split():
        if tok.rstrip(".").isdigit() or tok.endswith("."):
            continue
        try:
            move = board.parse_san(tok)
        except ValueError:
            move = chess.Move.from_uci(tok)
            if move not in board.legal_moves:
                raise SystemExit(f"--root: {tok} isn't legal there")
        out.append(move.uci())
        board.push(move)
    return out


def positions(lines: list[list[str]], root: list[str], me: chess.Color, max_ply: int):
    """Your-move positions after the root along the lines, in order, each with how to get there and
    the move your repertoire plays there. Transpositions count once."""
    seen = {}
    for ucis in lines:
        if ucis[: len(root)] != root:
            continue
        board = chess.Board()
        sans = []
        for i, uci in enumerate(ucis):
            move = chess.Move.from_uci(uci)
            if board.turn == me and i >= len(root) and i < max_ply:
                key = board.epd()
                if key not in seen:
                    seen[key] = (board.copy(), list(sans), uci)
            if move not in board.legal_moves:
                print(f"  skipped a line: {uci} isn't legal after {' '.join(sans)}", file=sys.stderr)
                break
            sans.append(board.san(move))
            board.push(move)
    return list(seen.values())


def movetext(sans: list[str]) -> str:
    out = []
    for i, san in enumerate(sans):
        if i % 2 == 0:
            out.append(f"{i // 2 + 1}.{san}")
        else:
            out.append(san)
    return " ".join(out)


# ---- report ------------------------------------------------------------------------------------


def fmt(x: float) -> str:
    return "–" if math.isnan(x) else f"{x:.0f}%"


def report(results, me: chess.Color, args) -> str:
    side = "White" if me == chess.WHITE else "Black"
    out = [f"# Practical choices ({side})", ""]
    out.append(
        f"Ratings {args.ratings} on Lichess ({args.speeds or 'all time controls'}); Stockfish depth {args.depth}. "
        f"Engine = your win% if they find the best reply; practical = expected win% over the replies people "
        f"actually play; go wrong = how often they don't play a reply within {args.good:g} points of their best; "
        f"actual = {side}'s score with the move in those games. Moves costing up to {args.cap:g} points are listed."
    )
    out.append("")
    picks = []
    for board, sans, rep, cands in results:
        if not cands:
            continue
        rep_c = next((c for c in cands if c.repertoire), None)
        base = rep_c.practical if rep_c else max(c.practical for c in cands)
        for c in cands:
            if c.repertoire or c.cost <= 0.5:
                continue
            if c.practical >= base + args.margin and c.wrong >= args.min_wrong:
                picks.append((sans, c, rep_c))
    out.append("## Worth a look")
    out.append("")
    if not picks:
        out.append("Nothing beats your repertoire's moves on practical value by the margin; see the positions below.")
    for sans, c, rep_c in sorted(picks, key=lambda p: -(p[1].practical - (p[2].practical if p[2] else 0))):
        wrong = [r for r in c.replies if not r.good and r.prob >= 0.05][:2]
        good = [r for r in c.replies if r.good][:2]
        line = (f"- **{movetext(sans)} … {c.san}** — practical {fmt(c.practical)} vs "
                f"{fmt(rep_c.practical) + ' for ' + rep_c.san if rep_c else '–'}; engine cost {c.cost:.0f} points. "
                f"They go wrong {c.wrong * 100:.0f}% of the time"
                + (f" (most often {', '.join(f'{r.san} {r.prob * 100:.0f}% → you {fmt(r.mine)}' for r in wrong)})" if wrong else "")
                + (f"; only {' or '.join(r.san for r in good)} holds, after which you're at {fmt(c.engine)}" if good else "")
                + (f". Actual score {fmt(c.actual)} in {c.actual_games} games." if c.actual_games else ". Not enough games for an actual score.")
                + (" (replies modelled: few games)" if c.source == "model" else ""))
        out.append(line)
    out.append("")
    out.append("## Positions")
    for board, sans, rep, cands in results:
        out.append("")
        rep_san = board.san(chess.Move.from_uci(rep)) if rep else "–"
        out.append(f"### {movetext(sans)} …  (your move: {rep_san})")
        out.append("")
        out.append("| Move | Cost | Engine | Practical | Go wrong | Good replies | Actual (games) | Their likely replies → you |")
        out.append("|---|---|---|---|---|---|---|---|")
        for c in cands:
            name = f"**{c.san}** (yours)" if c.repertoire else c.san
            likely = ", ".join(f"{r.san} {r.prob * 100:.0f}% → {fmt(r.mine)}{'' if r.good else ' ✗'}" for r in c.replies[:4] if r.prob >= 0.03)
            actual = f"{fmt(c.actual)} ({c.actual_games})" if c.actual_games else "–"
            src = "" if c.source == "data" else " *(model)*"
            out.append(f"| {name} | {c.cost:.0f} | {fmt(c.engine)} | {fmt(c.practical)}{src} | {c.wrong * 100:.0f}% | "
                       f"{c.good_replies} | {actual} | {likely} |")
    out.append("")
    out.append("✗ = a reply that isn't good for them (more than "
               f"{args.good:g} points worse than their best). *(model)*: too few games at these ratings, so how "
               "often each reply is played is guessed from the engine evals.")
    return "\n".join(out) + "\n"


# ---- main --------------------------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lines", help="your lines (app.tools.export_lines output); without it, only --root is analysed")
    ap.add_argument("--root", default="", help='moves to start from, e.g. "e4 d5 exd5 Nf6 d4 Bg4 Be2 Bxe2"')
    ap.add_argument("--color", choices=["white", "black"], help="your side (default: from the lines file)")
    ap.add_argument("--engine", default=shutil.which("stockfish") or "/usr/games/stockfish", help="Stockfish binary")
    ap.add_argument("--depth", type=int, default=18)
    ap.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--hash", type=int, default=256, help="engine hash, MB")
    ap.add_argument("--candidates", type=int, default=8, help="engine moves considered for you")
    ap.add_argument("--replies", type=int, default=5, help="engine replies considered for them")
    ap.add_argument("--cap", type=float, default=15, help="most win%% a move may cost to be listed")
    ap.add_argument("--good", type=float, default=7, help="a reply within this many win%% of their best is 'good'")
    ap.add_argument("--margin", type=float, default=3, help="practical gain over your move to be worth a look")
    ap.add_argument("--min-wrong", type=float, default=0.3, help="'worth a look' needs them to go wrong this often")
    ap.add_argument("--ratings", default="2000,2200,2500", help="Lichess rating bands")
    ap.add_argument("--speeds", default=None, help="e.g. blitz,rapid,classical (default: all)")
    ap.add_argument("--min-games", type=int, default=30, help="games needed to use real reply shares")
    ap.add_argument("--min-move-games", type=int, default=10, help="games needed to consider/score a move from data")
    ap.add_argument("--min-share", type=float, default=0.02, help="ignore replies played less often than this")
    ap.add_argument("--temperature", type=float, default=6, help="model: lower = they find good moves more often")
    ap.add_argument("--max-ply", type=int, default=30, help="ignore positions deeper than this many plies")
    ap.add_argument("--limit", type=int, default=0, help="analyse at most this many positions (0 = all)")
    ap.add_argument("--no-explorer", action="store_true", help="model the replies only (no Lichess)")
    ap.add_argument("--cache", default="practical-cache.json")
    ap.add_argument("--out", default="-", help="report file (markdown); - for the screen")
    args = ap.parse_args(argv)

    root = parse_root(args.root)
    lines, file_color = read_lines(args.lines) if args.lines else ([root], None)
    me = {"white": chess.WHITE, "black": chess.BLACK}.get(args.color, file_color)
    if me is None:
        raise SystemExit("Which side are you? Use --color white|black")
    todo = positions(lines, root, me, args.max_ply)
    if not args.lines:
        board = chess.Board()
        for u in root:
            board.push_uci(u)
        if board.turn != me:
            raise SystemExit("Without --lines the root must end with you to move")
        todo = [(board, _sans(root), None)]
    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        raise SystemExit("No positions with you to move after the root in those lines")
    token = os.environ.get("LICHESS_TOKEN", "").strip()
    if not token and not args.no_explorer:
        print("No LICHESS_TOKEN: replies will be modelled from the engine only (--no-explorer).", file=sys.stderr)

    cache = {}
    if os.path.exists(args.cache):
        with open(args.cache) as f:
            cache = json.load(f)
    eng = Engine(args.engine, args.depth, args.threads, args.hash, cache)
    exp = Explorer(token, args.ratings, args.speeds, cache, enabled=not args.no_explorer)
    results = []
    started = time.time()
    try:
        for i, (board, sans, rep) in enumerate(todo, 1):
            print(f"[{i}/{len(todo)}] {movetext(sans)} …", file=sys.stderr, flush=True)
            results.append((board, sans, rep, analyse_position(board, me, rep, eng, exp, args)))
            if i % 5 == 0:
                _save(args.cache, cache)
    finally:
        _save(args.cache, cache)
        eng.close()
    text = report(results, me, args)
    if args.out == "-":
        print(text)
    else:
        with open(args.out, "w") as f:
            f.write(text)
        print(f"Report: {args.out}", file=sys.stderr)
    print(f"{len(results)} positions in {time.time() - started:.0f} s ({eng.calls} engine analyses, "
          f"{exp.calls} explorer lookups not cached)", file=sys.stderr)
    return 0


def _sans(ucis: list[str]) -> list[str]:
    board, out = chess.Board(), []
    for u in ucis:
        m = chess.Move.from_uci(u)
        out.append(board.san(m))
        board.push(m)
    return out


def _save(path: str, cache: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f)
    os.replace(tmp, path)


if __name__ == "__main__":
    sys.exit(main())
