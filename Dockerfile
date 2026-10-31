FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv/mpct

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY alembic.ini .
COPY app ./app
COPY web ./web

RUN useradd --system --uid 10001 mpct
USER mpct

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"

# Bring the database schema up to date, then serve. Skips migrations if no database is configured.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then alembic upgrade head; fi && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
