#!/usr/bin/env python3
"""Entry point for the Telegram Panel application."""

import uvicorn
from app.config import settings
from app.logging_setup import setup_logging


def main():
    """Run the application with uvicorn."""
    setup_logging(settings.LOG_LEVEL, settings.LOG_FILE)
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        log_level=settings.LOG_LEVEL.lower(),
        reload=False,
        log_config=None,
    )


if __name__ == "__main__":
    main()
