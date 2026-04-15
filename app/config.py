"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from .env file."""

    API_ID: int = 2040
    API_HASH: str = "b18441a1ff607e10a989891a5462e627"
    DEVICE_MODEL: str = "Asus TUF"
    APP_VERSION: str = "6.7.5 x64"
    SYSTEM_VERSION: str = "Windows 11 x64"
    LANG_CODE: str = "ru"
    SYSTEM_LANG_CODE: str = "ru-RU"
    SESSIONS_DIR: str = "accounts"
    HOST: str = "0.0.0.0"
    PORT: int = 8080
    LOG_LEVEL: str = "INFO"
    LOG_FILE: str = "logs.log"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
