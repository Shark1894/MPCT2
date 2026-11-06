"""Settings from environment variables (or a .env file in the working directory)."""

from datetime import date

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # e.g. postgresql+psycopg://mpct:secret@postgres:5432/mpct
    database_url: str | None = None

    # "live" for the real app. Anything else (e.g. "test") marks the page with a TEST badge
    # and an orange top bar so a test instance is never mistaken for the live one.
    mpct_env: str = "live"

    # Repertoire in the wild: fetch tournament games (Lichess broadcasts, The Week in Chess)
    # in the background. WILD_FETCH=false turns it off.
    wild_fetch: bool = True
    wild_interval_hours: float = 6
    # How far back TWIC issues and Lichess broadcasts are fetched. Every game is kept, so the
    # history builds up from here as new games are fetched.
    wild_since: date = date(2026, 1, 1)

    # Repertoire gap finder: the Lichess opening explorer needs a personal API token (free,
    # no scopes: https://lichess.org/account/oauth/token). Keep it in .env, never in code.
    lichess_token: str | None = None
    lichess_explorer_url: str = "https://explorer.lichess.org"
    # Lichess game import (Games tab): your recent games come from the public API by username.
    # LICHESS_TOKEN is sent when set (Lichess lets authenticated requests download faster).
    lichess_api_url: str = "https://lichess.org"
    # Cached explorer answers older than this are asked for again.
    explorer_cache_days: int = 180

    # Hands-free training in browsers without built-in speech recognition (Firefox): the Vosk
    # model the page downloads (once). The image fetches it at build time (scripts/fetch_voice_model.py).
    voice_model_dir: str = "/srv/mpct/voice"


settings = Settings()
