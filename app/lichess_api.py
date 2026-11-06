"""Reading your games from lichess.org (the public game export API).

No token is needed: games are public and found by username. LICHESS_TOKEN is sent when it's
set, because Lichess lets authenticated requests download faster; if Lichess refuses the token
the request is made again without it. Requests are made only when you ask (one at a time), so
a 429 fails at once with a message instead of waiting.
"""

import json
import urllib.error
import urllib.parse
import urllib.request

from app import __version__
from app.config import settings

USER_AGENT = f"MPCT/{__version__} (personal chess training app)"


class LichessError(Exception):
    pass


class NotFound(LichessError):
    pass


def _request(url: str, accept: str, token: str | None, timeout: float) -> str:
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as res:
        return res.read().decode("utf-8")


def get(path: str, params: dict | None = None, ndjson: bool = False, timeout: float = 20):
    """GET a Lichess API path: a list of objects for ndjson, else one JSON object."""
    url = settings.lichess_api_url.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    accept = "application/x-ndjson" if ndjson else "application/json"
    token = (settings.lichess_token or "").strip() or None
    try:
        try:
            body = _request(url, accept, token, timeout)
        except urllib.error.HTTPError as exc:
            if exc.code not in (401, 403) or not token:
                raise
            body = _request(url, accept, None, timeout)  # a bad token shouldn't block public data
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise NotFound("Lichess doesn't have that") from exc
        if exc.code == 429:
            raise LichessError("Lichess is limiting requests right now; try again in a minute") from exc
        raise LichessError(f"HTTP {exc.code} from Lichess") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise LichessError(f"Couldn't reach Lichess: {exc}") from exc
    try:
        if ndjson:
            return [json.loads(line) for line in body.splitlines() if line.strip()]
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise LichessError("Lichess sent something MPCT couldn't read") from exc
