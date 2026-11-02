"""Settings from environment variables (or a .env file in the working directory)."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # e.g. postgresql+psycopg://mpct:secret@postgres:5432/mpct
    database_url: str | None = None

    # "live" for the real app. Anything else (e.g. "test") marks the page with a TEST badge
    # and an orange top bar so a test instance is never mistaken for the live one.
    mpct_env: str = "live"


settings = Settings()
