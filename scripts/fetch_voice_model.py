"""Download the offline speech model for hands-free training and repack it for the browser.

Browsers without built-in speech recognition (Firefox) recognise moves with Vosk running in
the page (web/vendor/vosk). It needs Vosk's small English model as a .tar.gz with one top-level
folder; Vosk publishes it as a .zip, so this repacks it. Run at image build time (see the
Dockerfile), or by hand:

    python scripts/fetch_voice_model.py [target_dir] [zip_url_or_path]

Never fails the build: if the download doesn't work it says so and exits 0, and hands-free
training in those browsers falls back to typing moves.
"""

import io
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

NAME = "vosk-model-small-en-us-0.15"
URL = f"https://alphacephei.com/vosk/models/{NAME}.zip"
REQUIRED = ("am/final.mdl", "conf/mfcc.conf", "conf/model.conf", "graph/HCLr.fst", "graph/Gr.fst", "graph/words.txt")


def repack(zip_bytes: bytes, out: Path, folder: str = NAME) -> int:
    """Zip (one model folder, or the model files at the top) -> tar.gz with `folder/` on top. Returns files written."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        top = {n.split("/", 1)[0] for n in names}
        prefix = f"{top.pop()}/" if len(top) == 1 and all("/" in n for n in names) else ""
        inner = {n[len(prefix):]: n for n in names if n.startswith(prefix)}
        missing = [r for r in REQUIRED if r not in inner]
        if missing:
            raise ValueError(f"not a Vosk lookahead model (missing {', '.join(missing)})")
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".part")
        with tarfile.open(tmp, "w:gz") as tar:
            for rel, name in sorted(inner.items()):
                data = z.read(name)
                info = tarfile.TarInfo(f"{folder}/{rel}")
                info.size = len(data)
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(data))
        tmp.replace(out)
        return len(inner)


def main(argv: list[str]) -> int:
    target = Path(argv[1] if len(argv) > 1 else "voice")
    source = argv[2] if len(argv) > 2 else URL
    out = target / f"{NAME}.tar.gz"
    if out.exists():
        print(f"{out} already there")
        return 0
    try:
        if source.startswith(("http://", "https://")):
            print(f"Downloading {source} …")
            req = urllib.request.Request(source, headers={"User-Agent": "MPCT (personal chess training app)"})
            with urllib.request.urlopen(req, timeout=300) as res:
                data = res.read()
        else:
            data = Path(source).read_bytes()
        n = repack(data, out)
        print(f"Wrote {out} ({n} files, {out.stat().st_size // 1024} KB)")
    except Exception as exc:  # never fail the image build over this
        print(f"WARNING: offline speech model not installed ({exc}). Hands-free in Firefox will ask you to type moves.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
