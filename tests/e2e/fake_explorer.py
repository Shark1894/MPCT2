"""Fake Lichess masters explorer for e2e tests: canned answers, checks the token."""
import json, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
import chess

def key(ucis):
    b = chess.Board()
    for u in ucis: b.push_uci(u)
    return b.epd()

def mv(san, n): return {"uci": "x", "san": san, "white": n // 2, "draws": n - n // 2, "black": 0, "averageRating": 2400}

DATA = {
    key([]): [mv("e4", 500), mv("d4", 400), mv("Nf3", 100)],
    key(["e2e4", "c7c6"]): [mv("d4", 800), mv("Nc3", 100), mv("Nf3", 60), mv("c4", 40)],
    key(["e2e4", "c7c6", "d2d4", "d7d5"]): [mv("e5", 400), mv("Nc3", 300), mv("exd5", 200), mv("Nd2", 80), mv("f3", 17)],
}
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
            body = json.dumps({"white": sum(m["white"] for m in moves), "draws": sum(m["draws"] for m in moves), "black": 0, "moves": moves}).encode()
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)

HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8099), H).serve_forever()
