"""Centralized logging configuration for the application."""

from __future__ import annotations

import logging
import logging.config
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
_CONFIGURED_LOG_PATH: Path | None = None

SENSITIVE_LOG_PATTERNS = (
    (
        re.compile(r"(Remaining bytes:\s*)[^\r\n]*", re.IGNORECASE),
        r"\1[redacted]",
    ),
    (
        re.compile(r"(Read [^\r\n]* bytes from a message\.)[^\r\n]*", re.IGNORECASE),
        r"\1",
    ),
)


def sanitize_log_text(text: str) -> str:
    """Remove noisy/sensitive Telethon payload tails while keeping useful diagnostics."""
    sanitized = text
    for pattern, replacement in SENSITIVE_LOG_PATTERNS:
        sanitized = pattern.sub(replacement, sanitized)
    return sanitized


class SafeLogFormatter(logging.Formatter):
    """Formatter that redacts volatile Telegram payload fragments from all handlers."""

    def format(self, record: logging.LogRecord) -> str:
        return sanitize_log_text(super().format(record))


def resolve_log_path(log_file: str) -> Path:
    """Resolve a log file path relative to the project root."""
    path = Path(log_file)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def setup_logging(log_level: str, log_file: str) -> Path:
    """Configure application-wide logging to console and file."""
    global _CONFIGURED_LOG_PATH

    level_name = (log_level or "INFO").upper()
    file_path = resolve_log_path(log_file)
    if _CONFIGURED_LOG_PATH == file_path:
        return file_path

    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "standard": {
                    "()": "app.logging_setup.SafeLogFormatter",
                    "format": "%(asctime)s | %(levelname)s | %(name)s | %(message)s",
                },
            },
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "level": level_name,
                    "formatter": "standard",
                },
                "file": {
                    "class": "logging.FileHandler",
                    "level": level_name,
                    "formatter": "standard",
                    "filename": str(file_path),
                    "encoding": "utf-8",
                },
            },
            "root": {
                "level": level_name,
                "handlers": ["console", "file"],
            },
            "loggers": {
                "uvicorn": {
                    "level": level_name,
                    "handlers": ["console", "file"],
                    "propagate": False,
                },
                "uvicorn.error": {
                    "level": level_name,
                    "handlers": ["console", "file"],
                    "propagate": False,
                },
                "uvicorn.access": {
                    "level": level_name,
                    "handlers": ["console", "file"],
                    "propagate": False,
                },
                "telethon": {
                    "level": "WARNING",
                    "handlers": ["console", "file"],
                    "propagate": False,
                },
            },
        }
    )
    logging.captureWarnings(True)
    _CONFIGURED_LOG_PATH = file_path
    logging.getLogger(__name__).info("Logging configured. Writing to %s", file_path)
    return file_path
