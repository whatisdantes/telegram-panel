"""FastAPI application entry point."""

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import accounts, customization, messages, profile, ws
from app.api.ws import ws_manager
from app.config import settings
from app.logging_setup import setup_logging
from app.telegram.client_manager import TelegramClientManager

LOG_FILE_PATH = setup_logging(settings.LOG_LEVEL, settings.LOG_FILE)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown."""
    # Startup
    logger.info("Starting Telegram Panel. Log file: %s", LOG_FILE_PATH)
    manager = TelegramClientManager()
    manager.set_ws_manager(ws_manager)
    sessions = manager.scan_sessions()
    logger.info("Found %d session(s) on startup", len(sessions))
    yield
    # Shutdown
    logger.info("Shutting down Telegram Panel...")
    manager = TelegramClientManager()
    await manager.disconnect_all()
    logger.info("Shutdown complete.")


app = FastAPI(
    title="Telegram Panel",
    description="Web panel for managing Telegram accounts",
    version="1.0.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def log_http_requests(request: Request, call_next):
    """Log every HTTP request and response with timing details."""
    started_at = time.perf_counter()
    client_host = request.client.host if request.client else "unknown"
    request_path = request.url.path
    if request.url.query:
        request_path = f"{request_path}?{request.url.query}"

    logger.info(
        "HTTP request started: %s %s from %s",
        request.method,
        request_path,
        client_host,
    )

    try:
        response = await call_next(request)
    except Exception:
        duration_ms = (time.perf_counter() - started_at) * 1000
        logger.exception(
            "HTTP request failed: %s %s from %s in %.2fms",
            request.method,
            request_path,
            client_host,
            duration_ms,
        )
        raise

    duration_ms = (time.perf_counter() - started_at) * 1000
    logger.info(
        "HTTP request completed: %s %s -> %s in %.2fms",
        request.method,
        request_path,
        response.status_code,
        duration_ms,
    )
    return response

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routers
app.include_router(accounts.router)
app.include_router(customization.router)
app.include_router(messages.router)
app.include_router(profile.router)
app.include_router(ws.router)

# Determine static files directory
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Mount static files
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def serve_index():
    """Serve the main index.html page."""
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.isfile(index_path):
        return FileResponse(index_path)
    return JSONResponse(
        {"message": "Telegram Panel API is running. Static files not found."},
        status_code=200,
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler that returns safe error messages."""
    logger.exception(
        "Unhandled exception during %s %s: %s",
        request.method,
        request.url.path,
        exc,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "An internal server error occurred. Please try again later.",
        },
    )


@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    """Handle 404 errors."""
    logger.warning("404 for %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=404,
        content={"detail": "The requested resource was not found."},
    )
