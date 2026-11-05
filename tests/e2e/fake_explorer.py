"""Fake Lichess masters explorer for e2e tests: canned answers, checks the token."""
import json, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
import chess

def key(ucis):
    b = chess.Board()
    for u in ucis: b.push_uci(u)
    return b.epd()

def mv(san, n): return {"uci": "x", "san": san, "white": n // 2, "draws": n - n // 2, "black": 0, "averageRating": 2400}

def with_uci(k, moves):
    b = chess.Board(k + " 0 1")
    for m in moves:
        try: m["uci"] = b.parse_san(m["san"]).uci()
        except ValueError: pass
    return moves

def top(gid, white, black, winner, year, uci):
    return {"id": gid, "white": {"name": white, "rating": 2700}, "black": {"name": black, "rating": 2650}, "winner": winner, "year": year, "month": f"{year}-05", "uci": uci}

PGN = {
    "fake0001": '[Event "Fake Masters"]\n[Site "Somewhere"]\n[Date "2019.??.??"]\n[Round "3"]\n[White "Carlsen, Magnus"]\n[Black "Caruana, Fabiano"]\n[Result "1-0"]\n[WhiteElo "2862"]\n[BlackElo "2832"]\n\n1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3 e6 1-0\n',
    "fake0002": '[Event "Fake Open"]\n[Site "Elsewhere"]\n[Date "2005.06.01"]\n[Round "1"]\n[White "Anand, Viswanathan"]\n[Black "Karpov, Anatoly"]\n[Result "1/2-1/2"]\n\n1. e4 c6 2. d4 d5 3. Nc3 dxe4 1/2-1/2\n',
}
TOP = {
    (): [top("fake0001", "Carlsen, Magnus", "Caruana, Fabiano", "white", 2019, "e2e4"), top("fake0002", "Anand, Viswanathan", "Karpov, Anatoly", None, 2005, "e2e4")],
    ("e2e4", "c7c6"): [top("fake0001", "Carlsen, Magnus", "Caruana, Fabiano", "white", 2019, "d2d4"), top("fake0002", "Anand, Viswanathan", "Karpov, Anatoly", None, 2005, "d2d4")],
}

DATA = {
    key([]): [mv("e4", 500), mv("d4", 400), mv("Nf3", 100)],
    key(["e2e4", "c7c6"]): [mv("d4", 800), mv("Nc3", 100), mv("Nf3", 60), mv("c4", 40)],
    key(["e2e4", "c7c6", "d2d4", "d7d5"]): [mv("e5", 400), mv("Nc3", 300), mv("exd5", 200), mv("Nd2", 80), mv("f3", 17)],
}
DATA = {k: with_uci(k, v) for k, v in DATA.items()}
TOP = {key(list(k)): v for k, v in TOP.items()}
LOG = []

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/log":
            body = json.dumps(LOG).encode()
        elif u.path == "/masters":
            if self.headers.get("Authorization") != "Bearer lip_e2e":
                self.send_response(401); self.end_headers(); return
            fen = urllib.parse.parse_qs(u.query)["fen"][0]
            k = " ".join(fen.split()[:4]); LOG.append(k)
            moves = DATA.get(k, [])
            body = json.dumps({"white": sum(m["white"] for m in moves), "draws": sum(m["draws"] for m in moves), "black": 0, "moves": moves, "topGames": TOP.get(k, [])}).encode()
        elif u.path.startswith("/masters/pgn/"):
            if self.headers.get("Authorization") != "Bearer lip_e2e":
                self.send_response(401); self.end_headers(); return
            gid = u.path.rsplit("/", 1)[1]; LOG.append("pgn:" + gid)
            if gid not in PGN:
                self.send_response(404); self.end_headers(); return
            body = PGN[gid].encode()
            self.send_response(200); self.send_header("Content-Type", "application/x-chess-pgn"); self.end_headers(); self.wfile.write(body); return
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)

HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8099), H).serve_forever()
