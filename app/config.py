"""Settings from environment variables (or a .env file in the working directory)."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # e.g. postgresql+psycopg://mpct:secret@postgres:5432/mpct
    database_url: str | None = None


settings = Settings()
