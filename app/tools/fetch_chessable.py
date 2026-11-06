"""Download a Chessable course you own (its structure and every line) into a folder, for
import_chessable. Standard library only, so it runs anywhere with Python 3.10+ (your desktop or
the server), with no MPCT install:

    python3 fetch_chessable.py 156667 --headers ~/chessable-headers.txt --out ~/chessable/156667

Chessable has no public API: this asks for the same data its own pages load while you're
logged in, sending your browser's own request headers (login, user agent and all). Make the
headers file in Firefox: DevTools > Network > the getGame request > Headers > Request Headers >
"Raw" or right-click > Copy > Copy Request Headers, and paste it into a text file. The API path and
your user id are read from it too. Keep that file private (chmod 600) and delete it afterwards;
it is never printed or saved elsewhere. Requests are made one at a time with a pause between them (default 3-5 s), and every
answer is kept in the folder: a re-run only fetches what's missing, so a stopped download carries
on where it left off. Files: course.json, chapter-<lid>.json (line ids in order), line-<oid>.json.
"""

import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://www.chessable.com/api/v1"
# Headers not to repeat from the copied request: they describe that one request, not your login.
DROP = {"host", "content-length", "accept-encoding", "connection", "te", "if-none-match", "if-modified-since", "priority"}


class Stop(Exception):
    pass


def read_headers(path: Path) -> tuple[dict[str, str], str | None, int | None]:
    """The file made with Firefox's "Copy Request Headers" on a getGame request (or just
    "Name: value" lines): (headers to send, API base URL, your user id) from it."""
    headers, api, uid, host = {}, None, None, "www.chessable.com"
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        request = line.split()
        if len(request) >= 2 and request[0] in ("GET", "POST") and request[1].startswith("/"):
            url = urllib.parse.urlparse(request[1])  # GET /api/v1/getGame?lng=en&uid=…&oid=… HTTP/2
            api = url.path.rsplit("/", 1)[0]
            uid = next((int(v) for v in urllib.parse.parse_qs(url.query).get("uid", []) if v.isdigit()), None)
            continue
        if ":" not in line:
            continue
        name, value = (x.strip() for x in line.split(":", 1))
        if name.lower() == "host":
            host = value
        if name.lower() not in DROP and not name.startswith(":"):
            headers[name] = value
    if not any(n.lower() in ("cookie", "authorization") for n in headers):
        raise Stop(f"No Cookie or Authorization header in {path}: copy the getGame request's headers into it")
    return headers, (f"https://{host}{api}" if api else None), uid


class Client:
    def __init__(self, headers: dict[str, str], api: str, pause: tuple[float, float]):
        self.headers = {"Accept": "application/json", **headers}  # your browser's own headers, as copied
        self.api = api.rstrip("/")
        self.pause = pause
        self.requests = 0

    def get(self, endpoint: str, params: dict) -> dict:
        if self.requests:
            time.sleep(random.uniform(*self.pause))
        self.requests += 1
        url = f"{self.api}/{endpoint}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers=self.headers)
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as res:
                    return json.loads(res.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403):
                    raise Stop(f"Chessable refused the login (HTTP {exc.code}) for {endpoint}: copy fresh headers from the browser") from exc
                if exc.code == 429 or exc.code >= 500:
                    wait = 60 * (attempt + 1)
                    print(f"  HTTP {exc.code}, waiting {wait} s…", flush=True)
                    time.sleep(wait)
                    continue
                raise Stop(f"HTTP {exc.code} for {endpoint}") from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt == 2:
                    raise Stop(f"Couldn't reach Chessable: {exc}") from exc
                time.sleep(30)
            except json.JSONDecodeError as exc:
                raise Stop(f"{endpoint} didn't answer with JSON (logged out?)") from exc
        raise Stop(f"Chessable kept refusing {endpoint}; try again later")


def cached(path: Path, fetch, refresh: bool = False) -> dict:
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    data = fetch()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)  # a stopped run never leaves half a file
    return data


def chapters(course: dict) -> list[dict]:
    data = (course.get("course") or {}).get("data") or []
    return sorted((c for c in data if isinstance(c, dict) and "id" in c), key=lambda c: c.get("order", 0))


def fetch_course(client: Client, bid: int, uid: int, out: Path, only: set[int] | None, skip: set[int], refresh: bool) -> int:
    out.mkdir(parents=True, exist_ok=True)
    course = cached(out / "course.json", lambda: client.get("getCourse", {"bid": bid, "uid": uid}), refresh)
    todo = [c for c in chapters(course) if (only is None or c["id"] in only) and c["id"] not in skip]
    name = (course.get("course") or {}).get("name", bid)
    print(f"{name}: {len(todo)} chapter(s)", flush=True)
    fetched = 0
    for c in todo:
        lid = c["id"]
        listing = cached(
            out / f"chapter-{lid}.json",
            lambda: client.get("getOpeningsForBookLevelInCorrectOrder", {"bid": bid, "lid": lid}),
            refresh,
        )
        oids = listing.get("openings") or []
        missing = [oid for oid in oids if not (out / f"line-{oid}.json").exists()]
        print(f"  {c.get('title', lid)}: {len(oids)} lines, {len(missing)} to fetch", flush=True)
        for oid in missing:
            data = client.get("getGame", {"lng": "en", "uid": uid, "oid": oid})
            data.get("game", {}).pop("commentsByFEN", None)  # the community forum: large and not needed
            cached(out / f"line-{oid}.json", lambda d=data: d)
            fetched += 1
    return fetched


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Download a Chessable course you own, for import_chessable.")
    p.add_argument("course", type=int, help="course id (the number in chessable.com/course/<id>)")
    p.add_argument("--uid", type=int, help="your Chessable user id (default: from the copied request)")
    p.add_argument("--headers", type=Path, required=True, help="file with your login headers, one 'Name: value' per line")
    p.add_argument("--out", type=Path, required=True, help="folder for the downloaded files")
    p.add_argument("--chapters", help="only these chapter ids (comma-separated)")
    p.add_argument("--skip-chapters", default="", help="leave out these chapter ids (comma-separated)")
    p.add_argument("--pause", type=float, nargs=2, default=(3.0, 5.0), metavar=("MIN", "MAX"), help="seconds between requests")
    p.add_argument("--api", help=argparse.SUPPRESS)
    p.add_argument("--refresh", action="store_true", help="fetch the course and chapter lists again (lines already saved are kept)")
    args = p.parse_args(argv)

    ids = lambda text: {int(x) for x in text.split(",") if x.strip()}  # noqa: E731
    try:
        headers, api, uid = read_headers(args.headers.expanduser())
        uid = args.uid or uid
        if not uid:
            raise Stop("Your user id wasn't in the copied headers: give it with --uid (the uid= number in the getGame URL)")
        client = Client(headers, args.api or api or API, tuple(args.pause))
        n = fetch_course(
            client, args.course, uid, args.out.expanduser(),
            ids(args.chapters) if args.chapters else None, ids(args.skip_chapters), args.refresh,
        )
    except Stop as exc:
        print(f"Stopped: {exc}\nWhat's saved so far is kept; run again to carry on.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nStopped. What's saved so far is kept; run again to carry on.", file=sys.stderr)
        return 1
    print(f"Done: {n} line(s) fetched, {client.requests} request(s). Now import the folder with import_chessable.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
