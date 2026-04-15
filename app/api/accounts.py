"""Account management API routes."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from telethon.errors import (
    AuthKeyError,
    FloodWaitError,
    RPCError,
)

from app.models.schemas import AccountStatus
from app.telegram.client_manager import TelegramClientManager
from app.telegram.error_map import format_flood_wait_error, humanize_rpc_error
from app.telegram.utils import get_user_info

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


def _get_manager() -> TelegramClientManager:
    """Get the singleton client manager."""
    return TelegramClientManager()


def _serialize_managed(managed) -> dict[str, Any]:
    """Serialize a ManagedClient-like object into AccountStatus shape."""
    return {
        "session_name": managed.session_name,
        "phone": managed.phone,
        "name": managed.name,
        "status": managed.status.value,
        "error_msg": managed.error_msg,
        "avatar_url": getattr(managed, "avatar_url", None),
    }


def _flood_wait_exception(exc: FloodWaitError) -> HTTPException:
    """Return a consistent HTTPException for Telegram flood waits."""
    return HTTPException(
        status_code=429,
        detail=format_flood_wait_error(exc),
        headers={"Retry-After": str(exc.seconds)},
    )


@router.get("/", response_model=list[AccountStatus])
async def list_accounts() -> list[dict[str, Any]]:
    """List all sessions and their statuses."""
    manager = _get_manager()
    statuses = manager.get_all_statuses()
    logger.info("Listed accounts: %d session(s)", len(statuses))
    return list(statuses.values())


@router.post("/{session_name}/connect", response_model=AccountStatus)
async def connect_account(session_name: str) -> dict[str, Any]:
    """Connect a Telegram account session."""
    manager = _get_manager()
    logger.info("Connect requested for session %s", session_name)
    try:
        managed = await manager.connect(session_name)
        logger.info("Connect finished for session %s with status %s", session_name, managed.status.value)
        return _serialize_managed(managed)
    except FloodWaitError as e:
        raise _flood_wait_exception(e)
    except AuthKeyError:
        raise HTTPException(
            status_code=401,
            detail="Invalid session key. Session file may be corrupted.",
        )
    except ConnectionError as e:
        raise HTTPException(
            status_code=503,
            detail="Cannot connect to Telegram servers.",
        )
    except RPCError as e:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(e))
    except Exception as e:
        logger.exception("Unexpected error connecting %s", session_name)
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred while connecting.",
        )


@router.post("/{session_name}/disconnect", response_model=AccountStatus)
async def disconnect_account(session_name: str) -> dict[str, Any]:
    """Disconnect a Telegram account session."""
    manager = _get_manager()
    logger.info("Disconnect requested for session %s", session_name)
    try:
        success = await manager.disconnect(session_name)
        if not success:
            raise HTTPException(status_code=404, detail="Session not found.")
        logger.info("Disconnect finished for session %s", session_name)
        return manager.get_status(session_name)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error disconnecting %s", session_name)
        raise HTTPException(
            status_code=500,
            detail="An error occurred while disconnecting.",
        )


@router.post("/{session_name}/reconnect", response_model=AccountStatus)
async def reconnect_account(session_name: str) -> dict[str, Any]:
    """Reconnect a Telegram account session."""
    manager = _get_manager()
    logger.info("Reconnect requested for session %s", session_name)
    try:
        managed = await manager.reconnect(session_name)
        logger.info("Reconnect finished for session %s with status %s", session_name, managed.status.value)
        return _serialize_managed(managed)
    except FloodWaitError as e:
        raise _flood_wait_exception(e)
    except ConnectionError:
        raise HTTPException(
            status_code=503,
            detail="Cannot connect to Telegram servers.",
        )
    except Exception as e:
        logger.exception("Error reconnecting %s", session_name)
        raise HTTPException(
            status_code=500,
            detail="An error occurred while reconnecting.",
        )


@router.get("/{session_name}/status", response_model=AccountStatus)
async def get_account_status(session_name: str) -> dict[str, Any]:
    """Get the status of a specific account."""
    manager = _get_manager()
    status = manager.get_status(session_name)
    logger.info("Status requested for session %s: %s", session_name, status.get("status"))
    return status


@router.get("/{session_name}/me")
async def get_own_profile(session_name: str) -> dict[str, Any]:
    """Get the profile information for the connected account."""
    manager = _get_manager()
    client = manager.get_client(session_name)
    if not client:
        raise HTTPException(
            status_code=400,
            detail="Account is not connected.",
        )

    try:
        me = await client.get_me()
        info = await get_user_info(client, me, session_name=session_name, self_avatar=True)
        logger.info("Loaded own profile for session %s", session_name)
        return info
    except FloodWaitError as e:
        raise _flood_wait_exception(e)
    except RPCError as e:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(e))
    except Exception as e:
        logger.exception("Error getting profile for %s", session_name)
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve profile information.",
        )
