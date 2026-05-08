"""Frontend action logging API routes."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from app.models.schemas import UILogRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ui-log", tags=["ui-log"])

ALLOWED_CONTEXT_KEYS = {
    "source",
    "mode",
    "result",
    "status",
    "count",
    "field",
    "has_custom_name",
    "deleted_for_both",
}


def _safe_context(context: dict[str, Any]) -> dict[str, Any]:
    """Keep UI logs useful without storing message text, phone numbers, or usernames."""
    safe: dict[str, Any] = {}
    for key, value in (context or {}).items():
        if key not in ALLOWED_CONTEXT_KEYS:
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            safe[key] = value
    return safe


@router.post("")
async def log_ui_action(payload: UILogRequest) -> dict[str, bool]:
    """Record a low-risk UI action in the main application log."""
    logger.info(
        "UI action: action=%s session=%s entity_id=%s context=%s",
        payload.action,
        payload.session_name or "",
        payload.entity_id if payload.entity_id is not None else "",
        _safe_context(payload.context),
    )
    return {"ok": True}
