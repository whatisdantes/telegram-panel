"""Profile management API routes."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from telethon import types
from telethon.errors import FloodWaitError, RPCError
from telethon.tl.functions.account import (
    GetPrivacyRequest,
    SetPrivacyRequest,
    UpdateProfileRequest,
    UpdateUsernameRequest,
)
from telethon.tl.functions.photos import DeletePhotosRequest, UploadProfilePhotoRequest

from app.api.ws import ws_manager
from app.models.schemas import PrivacySettingsRequest, ProfileUpdateRequest
from app.telegram.client_manager import TelegramClientManager
from app.telegram.error_map import format_flood_wait_error, humanize_rpc_error
from app.telegram.utils import (
    build_own_avatar_url,
    ensure_entity_avatar_downloaded,
    get_entity_photo_version,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/profile", tags=["profile"])
ACTIVE_AVATAR_OPERATIONS: set[str] = set()

PRIVACY_MODE_LABELS = {
    "everyone": "Everybody",
    "contacts": "My Contacts",
    "nobody": "Nobody",
    "contacts_premium": "Contacts and Premium subscribers",
}

PRIVACY_RULE_BUILDERS = {
    "everyone": types.InputPrivacyValueAllowAll,
    "contacts": types.InputPrivacyValueAllowContacts,
    "nobody": types.InputPrivacyValueDisallowAll,
    "contacts_premium": types.InputPrivacyValueAllowContacts,
}

PRIVACY_FIELDS = {
    "status_timestamp": {
        "label": "Last seen & online",
        "key": types.InputPrivacyKeyStatusTimestamp,
        "options": ["everyone", "contacts", "nobody"],
    },
    "phone_number": {
        "label": "Phone number",
        "key": types.InputPrivacyKeyPhoneNumber,
        "options": ["everyone", "contacts", "nobody"],
    },
    "profile_photo": {
        "label": "Profile photo",
        "key": types.InputPrivacyKeyProfilePhoto,
        "options": ["everyone", "contacts", "nobody"],
    },
    "forwards": {
        "label": "Forwarded messages",
        "key": types.InputPrivacyKeyForwards,
        "options": ["everyone", "contacts", "nobody"],
    },
    "chat_invite": {
        "label": "Groups & channels",
        "key": types.InputPrivacyKeyChatInvite,
        "options": ["everyone", "contacts"],
    },
    "phone_call": {
        "label": "Calls",
        "key": types.InputPrivacyKeyPhoneCall,
        "options": ["everyone", "contacts", "nobody"],
    },
    "no_paid_messages": {
        "label": "Who can send me messages",
        "key": types.InputPrivacyKeyNoPaidMessages,
        "options": ["everyone", "contacts_premium"],
    },
}


def _get_manager() -> TelegramClientManager:
    """Get the singleton client manager."""
    return TelegramClientManager()


def _require_client(session_name: str):
    """Get connected client or raise 400."""
    manager = _get_manager()
    client = manager.get_client(session_name)
    if not client:
        raise HTTPException(status_code=400, detail="Account is not connected.")
    return client


def _flood_wait_exception(exc: FloodWaitError) -> HTTPException:
    """Return a consistent HTTPException for Telegram flood waits."""
    return HTTPException(
        status_code=429,
        detail=format_flood_wait_error(exc),
        headers={"Retry-After": str(exc.seconds)},
    )


def _build_self_avatar_cache_key(entity) -> str:
    """Build a cache key for the current account avatar."""
    return f"self_{get_entity_photo_version(entity) or 'current'}"


def _sync_managed_avatar(session_name: str, entity) -> None:
    """Update cached avatar metadata for the currently connected account."""
    managed = _get_manager().clients.get(session_name)
    if not managed:
        return

    photo_version = get_entity_photo_version(entity)
    managed.avatar_url = (
        build_own_avatar_url(session_name, photo_version)
        if getattr(entity, "photo", None)
        else None
    )


def _validate_avatar_upload(file: UploadFile) -> None:
    """Ensure the uploaded file looks like an image."""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image.")


def _get_avatar_upload_suffix(file: UploadFile) -> str:
    """Pick a safe temp-file suffix for an uploaded image."""
    suffix = Path(file.filename or "").suffix
    return suffix if suffix else ".jpg"


def _begin_avatar_operation(session_name: str, operation_name: str) -> None:
    """Prevent concurrent avatar mutations for the same account."""
    if session_name in ACTIVE_AVATAR_OPERATIONS:
        logger.warning(
            "Rejected avatar operation for %s because another operation is already running: %s",
            session_name,
            operation_name,
        )
        raise HTTPException(
            status_code=409,
            detail=(
                "Another profile photo operation is already in progress for this account. "
                "Please wait until it finishes."
            ),
        )

    ACTIVE_AVATAR_OPERATIONS.add(session_name)


def _finish_avatar_operation(session_name: str) -> None:
    """Release the avatar-mutation guard for an account."""
    ACTIVE_AVATAR_OPERATIONS.discard(session_name)


async def _broadcast_avatar_upload_progress(
    session_name: str,
    phase: str,
    *,
    current: int = 0,
    total: int = 0,
    file_name: str | None = None,
    message: str | None = None,
) -> None:
    """Broadcast queue upload progress to the UI."""
    progress = 0
    if total > 0:
        progress = max(0, min(100, round((current / total) * 100)))

    event = {
        "event_type": "avatar_upload_progress",
        "session_name": session_name,
        "data": {
            "phase": phase,
            "current": current,
            "total": total,
            "file_name": file_name or "",
            "message": message or "",
            "progress": progress,
        },
    }

    try:
        await ws_manager.broadcast(session_name, event)
    except Exception:
        logger.debug("Failed to broadcast avatar upload progress for %s", session_name, exc_info=True)


async def _upload_profile_photo_files(
    client,
    session_name: str,
    files: list[UploadFile],
) -> tuple[int, str | None]:
    """Upload one or more profile photos in the provided order."""
    if not files:
        raise HTTPException(status_code=400, detail="At least one image file is required.")

    temp_paths: list[str] = []
    uploaded_count = 0
    total = len(files)

    try:
        await _broadcast_avatar_upload_progress(
            session_name,
            "started",
            current=0,
            total=total,
            message=f"Preparing to upload {total} profile photo(s)...",
        )

        for index, file in enumerate(files, start=1):
            _validate_avatar_upload(file)
            file_name = file.filename or f"profile_photo_{index}.jpg"
            logger.info(
                "Uploading profile photo %d/%d for %s: filename=%s content_type=%s",
                index,
                total,
                session_name,
                file_name,
                file.content_type,
            )
            await _broadcast_avatar_upload_progress(
                session_name,
                "uploading",
                current=index,
                total=total,
                file_name=file_name,
                message=f"Uploading photo {index} of {total}",
            )

            with tempfile.NamedTemporaryFile(delete=False, suffix=_get_avatar_upload_suffix(file)) as tmp:
                content = await file.read()
                tmp.write(content)
                tmp_path = tmp.name
                temp_paths.append(tmp_path)

            uploaded_file = await client.upload_file(tmp_path)
            await client(UploadProfilePhotoRequest(file=uploaded_file))
            uploaded_count += 1

        me = await client.get_me()
        _sync_managed_avatar(session_name, me)
        photo_url = (
            build_own_avatar_url(session_name, get_entity_photo_version(me))
            if getattr(me, "photo", None)
            else None
        )
        return uploaded_count, photo_url

    finally:
        for temp_path in temp_paths:
            try:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
            except OSError:
                logger.warning("Could not remove temp avatar file %s", temp_path)


def _count_privacy_targets(rule) -> int:
    """Return approximate number of exception targets in a privacy rule."""
    users = getattr(rule, "users", None)
    if users:
        return len(users)

    chats = getattr(rule, "chats", None)
    if chats:
        return len(chats)

    return 1


def _serialize_privacy_rules(rules, field_name: str | None = None) -> dict[str, Any]:
    """Convert Telegram privacy rules into a simple UI-friendly structure."""
    mode = "everyone"
    allow_exceptions = 0
    disallow_exceptions = 0

    for rule in rules:
        if isinstance(rule, types.PrivacyValueAllowAll):
            mode = "everyone"
        elif isinstance(rule, types.PrivacyValueAllowContacts):
            mode = "contacts_premium" if field_name == "no_paid_messages" else "contacts"
        elif isinstance(rule, types.PrivacyValueDisallowAll):
            mode = "nobody"
        elif isinstance(
            rule,
            (
                types.PrivacyValueAllowUsers,
                types.PrivacyValueAllowChatParticipants,
                types.PrivacyValueAllowBots,
                types.PrivacyValueAllowCloseFriends,
                types.PrivacyValueAllowPremium,
            ),
        ):
            allow_exceptions += _count_privacy_targets(rule)
        elif isinstance(
            rule,
            (
                types.PrivacyValueDisallowUsers,
                types.PrivacyValueDisallowChatParticipants,
                types.PrivacyValueDisallowBots,
            ),
        ):
            disallow_exceptions += _count_privacy_targets(rule)

    return {
        "mode": mode,
        "allow_exceptions": allow_exceptions,
        "disallow_exceptions": disallow_exceptions,
        "has_exceptions": bool(allow_exceptions or disallow_exceptions),
    }


async def _read_privacy_settings(client) -> dict[str, Any]:
    """Read supported privacy settings from Telegram."""
    settings = {}

    for field_name, config in PRIVACY_FIELDS.items():
        result = await client(GetPrivacyRequest(key=config["key"]()))
        parsed = _serialize_privacy_rules(result.rules, field_name=field_name)
        settings[field_name] = {
            "label": config["label"],
            "value": parsed["mode"],
            "options": [
                {"value": option, "label": PRIVACY_MODE_LABELS[option]}
                for option in config["options"]
            ],
            "has_exceptions": parsed["has_exceptions"],
            "allow_exceptions": parsed["allow_exceptions"],
            "disallow_exceptions": parsed["disallow_exceptions"],
        }

    return settings


@router.put("/{session_name}/update")
async def update_profile(session_name: str, request: ProfileUpdateRequest) -> dict[str, Any]:
    """Update profile first_name, last_name, and/or username."""
    client = _require_client(session_name)
    logger.info(
        "Profile update requested for %s: first_name=%s last_name=%s username=%s",
        session_name,
        request.first_name is not None,
        request.last_name is not None,
        request.username is not None,
    )

    try:
        if request.first_name is not None or request.last_name is not None:
            kwargs = {}
            if request.first_name is not None:
                kwargs["first_name"] = request.first_name
            if request.last_name is not None:
                kwargs["last_name"] = request.last_name
            await client(UpdateProfileRequest(**kwargs))
            logger.info("Updated profile name for %s", session_name)

        if request.username is not None:
            username = request.username.lstrip("@")
            await client(UpdateUsernameRequest(username=username))
            logger.info("Updated username for %s to %s", session_name, username)

        me = await client.get_me()
        _sync_managed_avatar(session_name, me)
        return {
            "id": me.id,
            "first_name": me.first_name or "",
            "last_name": me.last_name or "",
            "username": me.username or "",
            "phone": me.phone or "",
            "photo_url": (
                build_own_avatar_url(session_name, get_entity_photo_version(me))
                if getattr(me, "photo", None)
                else None
            ),
            "success": True,
        }

    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error updating profile for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to update profile.")


@router.get("/{session_name}/avatar")
async def get_own_avatar(session_name: str):
    """Download and serve the current account avatar."""
    client = _require_client(session_name)

    try:
        me = await client.get_me()
        if not getattr(me, "photo", None):
            raise HTTPException(status_code=404, detail="Profile photo not found.")

        file_path, media_type = await ensure_entity_avatar_downloaded(
            client,
            me,
            session_name,
            cache_key=_build_self_avatar_cache_key(me),
        )
        logger.info("Served own avatar for %s: %s", session_name, file_path)
        return FileResponse(file_path, media_type=media_type, content_disposition_type="inline")

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error loading own avatar for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to load profile photo.")


@router.post("/{session_name}/avatar")
async def upload_avatar(session_name: str, file: UploadFile = File(...)) -> dict[str, Any]:
    """Upload a new profile avatar."""
    client = _require_client(session_name)
    _begin_avatar_operation(session_name, "single avatar upload")

    logger.info(
        "Avatar upload requested for %s: filename=%s content_type=%s",
        session_name,
        file.filename,
        file.content_type,
    )

    try:
        uploaded_count, photo_url = await _upload_profile_photo_files(client, session_name, [file])
        logger.info("Uploaded %d profile photo(s) for %s", uploaded_count, session_name)
        return {
            "success": True,
            "message": "Avatar uploaded successfully.",
            "photo_url": photo_url,
            "uploaded_count": uploaded_count,
        }
    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except HTTPException:
        raise
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error uploading avatar for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to upload avatar.")
    finally:
        _finish_avatar_operation(session_name)


@router.post("/{session_name}/avatar/batch")
async def upload_avatar_batch(
    session_name: str,
    files: list[UploadFile] = File(...),
) -> dict[str, Any]:
    """Upload multiple profile photos in the order provided by the client."""
    client = _require_client(session_name)
    _begin_avatar_operation(session_name, "batch avatar upload")

    logger.info(
        "Batch avatar upload requested for %s: count=%d",
        session_name,
        len(files),
    )

    try:
        uploaded_count, photo_url = await _upload_profile_photo_files(client, session_name, files)
        logger.info("Uploaded %d queued profile photo(s) for %s", uploaded_count, session_name)
        await _broadcast_avatar_upload_progress(
            session_name,
            "completed",
            current=uploaded_count,
            total=len(files),
            message=(
                f"Uploaded {uploaded_count} queued profile photo(s)."
            ),
        )
        noun = "photo" if uploaded_count == 1 else "photos"
        return {
            "success": True,
            "message": f"{uploaded_count} profile {noun} uploaded successfully.",
            "photo_url": photo_url,
            "uploaded_count": uploaded_count,
        }
    except FloodWaitError as exc:
        await _broadcast_avatar_upload_progress(
            session_name,
            "failed",
            current=0,
            total=len(files),
            message=format_flood_wait_error(exc),
        )
        raise _flood_wait_exception(exc)
    except HTTPException:
        await _broadcast_avatar_upload_progress(
            session_name,
            "failed",
            current=0,
            total=len(files),
            message="Profile photo upload failed.",
        )
        raise
    except RPCError as exc:
        await _broadcast_avatar_upload_progress(
            session_name,
            "failed",
            current=0,
            total=len(files),
            message=humanize_rpc_error(exc),
        )
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        await _broadcast_avatar_upload_progress(
            session_name,
            "failed",
            current=0,
            total=len(files),
            message="Failed to upload profile photos.",
        )
        logger.exception("Error uploading avatar batch for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to upload profile photos.")
    finally:
        _finish_avatar_operation(session_name)


@router.delete("/{session_name}/avatar")
async def delete_avatar(session_name: str) -> dict[str, Any]:
    """Delete all profile photos for the current account."""
    client = _require_client(session_name)
    _begin_avatar_operation(session_name, "delete avatar photos")
    logger.info("Delete-all profile photos requested for %s", session_name)

    try:
        me = await client.get_me()
        photos = await client.get_profile_photos(me, limit=None)
        photo_items = [item for item in photos if hasattr(item, "id")]

        if photo_items:
            deleted_count = 0
            for offset in range(0, len(photo_items), 100):
                batch = photo_items[offset:offset + 100]
                await client(DeletePhotosRequest(id=batch))
                deleted_count += len(batch)

            me = await client.get_me()
            _sync_managed_avatar(session_name, me)
            logger.info("Deleted %d profile photo(s) for %s", deleted_count, session_name)
            noun = "photo" if deleted_count == 1 else "photos"
            return {
                "success": True,
                "message": f"Deleted {deleted_count} profile {noun}.",
                "photo_url": None,
                "deleted_count": deleted_count,
            }
        return {
            "success": False,
            "message": "No profile photos to delete.",
            "photo_url": None,
            "deleted_count": 0,
        }

    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error deleting avatar for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to delete avatar.")
    finally:
        _finish_avatar_operation(session_name)


@router.get("/{session_name}/privacy")
async def get_privacy_info(session_name: str) -> dict[str, Any]:
    """Return current privacy settings that the panel can edit."""
    client = _require_client(session_name)

    try:
        settings = await _read_privacy_settings(client)
        logger.info("Loaded privacy settings for %s", session_name)
        return {
            "note": (
                "Only the base privacy mode is edited here. "
                "If a setting already has custom exceptions, saving a new value will replace them."
            ),
            "settings": settings,
        }

    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error loading privacy settings for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to load privacy settings.")


@router.put("/{session_name}/privacy")
async def update_privacy_settings(
    session_name: str,
    request: PrivacySettingsRequest,
) -> dict[str, Any]:
    """Update supported privacy settings using Telegram privacy rules."""
    client = _require_client(session_name)
    payload = request.model_dump(exclude_none=True)

    if not payload:
        raise HTTPException(status_code=400, detail="No privacy settings were provided.")

    logger.info("Privacy update requested for %s: fields=%s", session_name, sorted(payload.keys()))

    try:
        for field_name, mode in payload.items():
            config = PRIVACY_FIELDS.get(field_name)
            if not config:
                continue

            if mode not in config["options"]:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported value '{mode}' for {field_name}.",
                )

            rule_builder = PRIVACY_RULE_BUILDERS[mode]
            await client(
                SetPrivacyRequest(
                    key=config["key"](),
                    rules=[rule_builder()],
                )
            )
            logger.info("Updated privacy %s for %s to %s", field_name, session_name, mode)

        settings = await _read_privacy_settings(client)
        return {
            "success": True,
            "message": "Privacy settings updated successfully.",
            "settings": settings,
        }

    except HTTPException:
        raise
    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error updating privacy settings for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to update privacy settings.")
