FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv/mpct

COPY requirements.txt .
RUN pip install -r requirements.txt

# Offline speech model for hands-free training in browsers without built-in speech recognition
# (Firefox). Downloaded once; Docker's cache keeps it for later builds. Never fails the build.
COPY scripts/fetch_voice_model.py ./fetch_voice_model.py
RUN python fetch_voice_model.py /srv/mpct/voice

COPY alembic.ini .
COPY scripts/start.sh ./start.sh
COPY app ./app
COPY web ./web

RUN useradd --system --uid 10001 mpct
USER mpct

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"

# Migrate the database (with retries), then serve. See scripts/start.sh.
CMD ["./start.sh"]
