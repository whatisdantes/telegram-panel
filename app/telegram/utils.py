"""Telegram helpers for entities, media, and message formatting."""

from __future__ import annotations

import glob
import logging
import mimetypes
import os
import re
from typing import Optional
from urllib.parse import quote

from telethon import TelegramClient
from telethon.tl.types import (
    User,
    UserStatusEmpty,
    UserStatusLastMonth,
    UserStatusLastWeek,
    UserStatusOffline,
    UserStatusOnline,
    UserStatusRecently,
)

from app.config import settings

logger = logging.getLogger(__name__)

MEDIA_LABELS = {
    "audio": "Audio",
    "contact": "Contact",
    "document": "File",
    "gif": "GIF",
    "photo": "Photo",
    "sticker": "Sticker",
    "video": "Video",
    "voice": "Voice message",
}

DOWNLOADABLE_MEDIA_KINDS = {
    "audio",
    "document",
    "gif",
    "photo",
    "sticker",
    "video",
    "voice",
}

NON_INLINE_IMAGE_MIME_TYPES = {
    "image/heic",
    "image/heif",
    "image/heic-sequence",
    "image/heif-sequence",
}


def _sanitize_path_part(value: object) -> str:
    """Return a filesystem-safe identifier for cache paths."""
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value))
    sanitized = sanitized.strip("._")
    return sanitized or "unknown"


def _get_sender_name(sender, sender_id: Optional[int]) -> str:
    """Build a user-facing sender name from a Telegram entity."""
    if not sender:
        return ""

    first = getattr(sender, "first_name", "") or ""
    last = getattr(sender, "last_name", "") or ""
    sender_name = f"{first} {last}".strip()

    if sender_name:
        return sender_name

    return getattr(sender, "title", "") or (f"User {sender_id}" if sender_id else "")


def _get_display_name(entity) -> str:
    """Build a user-facing display name for a Telegram entity."""
    first = getattr(entity, "first_name", "") or ""
    last = getattr(entity, "last_name", "") or ""
    display_name = f"{first} {last}".strip()

    if display_name:
        return display_name

    username = getattr(entity, "username", "") or ""
    if username:
        return username

    phone = getattr(entity, "phone", "") or ""
    if phone:
        return phone

    title = getattr(entity, "title", "") or ""
    if title:
        return title

    entity_id = getattr(entity, "id", None)
    return f"User {entity_id}" if entity_id is not None else "Unknown"


def get_media_cache_dir() -> str:
    """Return the directory used for cached Telegram media downloads."""
    cache_dir = os.path.join(settings.SESSIONS_DIR, "_media_cache")
    os.makedirs(cache_dir, exist_ok=True)
    return cache_dir


def get_avatar_cache_dir() -> str:
    """Return the directory used for cached profile avatars."""
    cache_dir = os.path.join(settings.SESSIONS_DIR, "_avatar_cache")
    os.makedirs(cache_dir, exist_ok=True)
    return cache_dir


def _guess_path_media_type(file_path: str) -> str:
    """Infer HTTP content type from a file path."""
    return mimetypes.guess_type(file_path)[0] or "application/octet-stream"


def _build_versioned_url(url: str, version: object | None) -> str:
    """Append a cache-busting version query parameter when available."""
    if version in (None, ""):
        return url
    return f"{url}?v={quote(str(version), safe='')}"


def get_entity_photo_version(entity) -> Optional[int]:
    """Extract a stable version identifier from an entity photo."""
    photo = getattr(entity, "photo", None)
    return getattr(photo, "photo_id", None)


def build_own_avatar_url(session_name: str, version: object | None = None) -> str:
    """Build a frontend-consumable URL for the current account avatar."""
    url = f"/api/profile/{quote(session_name, safe='')}/avatar"
    return _build_versioned_url(url, version)


def build_entity_avatar_url(
    session_name: str,
    entity_id: int | str,
    version: object | None = None,
) -> str:
    """Build a frontend-consumable URL for another entity avatar."""
    url = (
        f"/api/messages/{quote(session_name, safe='')}/user/"
        f"{quote(str(entity_id), safe='')}/avatar"
    )
    return _build_versioned_url(url, version)


def _find_cached_variant(cache_dir: str, cache_key: str) -> Optional[str]:
    """Find an existing cached file variant by basename prefix."""
    candidates = sorted(
        candidate
        for candidate in glob.glob(os.path.join(cache_dir, f"{cache_key}*"))
        if os.path.basename(candidate) == cache_key
        or os.path.basename(candidate).startswith(f"{cache_key}.")
    )
    return candidates[0] if candidates else None


def build_message_media_url(session_name: str, chat_id: int | str, message_id: int) -> str:
    """Build a frontend-consumable URL for message media."""
    return (
        f"/api/messages/{quote(session_name, safe='')}/media/"
        f"{quote(str(chat_id), safe='')}/{quote(str(message_id), safe='')}"
    )


def get_media_kind(message) -> Optional[str]:
    """Return a normalized media kind for a Telethon message."""
    media = getattr(message, "media", None)
    if getattr(media, "phone_number", None):
        return "contact"
    if getattr(message, "photo", None):
        return "photo"
    if getattr(message, "voice", None):
        return "voice"
    if getattr(message, "audio", None):
        return "audio"
    if getattr(message, "video", None) or getattr(message, "video_note", None):
        return "video"
    if getattr(message, "gif", None):
        return "gif"
    if getattr(message, "sticker", None):
        return "sticker"
    if getattr(message, "document", None):
        return "document"
    inferred_kind = _infer_media_kind_from_metadata(message)
    if inferred_kind:
        return inferred_kind
    return None


def _infer_media_kind_from_metadata(message) -> Optional[str]:
    """Infer a media kind from file metadata when Telethon leaves media unsupported."""
    metadata = _get_message_file_metadata(message)
    mime_type = (metadata["mime_type"] or "").lower()
    file_name = (metadata["file_name"] or "").lower()

    if mime_type.startswith("image/"):
        if mime_type == "image/gif" or file_name.endswith(".gif"):
            return "gif"
        if mime_type in NON_INLINE_IMAGE_MIME_TYPES:
            return "document"
        return "photo"

    if mime_type.startswith("video/"):
        return "video"

    if mime_type.startswith("audio/"):
        if mime_type == "audio/ogg":
            return "voice"
        return "audio"

    if file_name.endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")):
        return "gif" if file_name.endswith(".gif") else "photo"
    if file_name.endswith((".mp4", ".mov", ".m4v", ".webm")):
        return "video"
    if file_name.endswith((".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac")):
        return "audio"

    if getattr(message, "media", None):
        return "document"

    return None


def _get_contact_payload(message) -> Optional[dict]:
    """Extract contact payload from a Telegram message."""
    media = getattr(message, "media", None)
    if not media or not getattr(media, "phone_number", None):
        return None

    first_name = getattr(media, "first_name", "") or ""
    last_name = getattr(media, "last_name", "") or ""
    phone_number = getattr(media, "phone_number", "") or ""
    user_id = getattr(media, "user_id", None) or None
    display_name = f"{first_name} {last_name}".strip() or phone_number or "Contact"

    return {
        "user_id": user_id,
        "phone_number": phone_number,
        "first_name": first_name,
        "last_name": last_name,
        "vcard": getattr(media, "vcard", "") or "",
        "display_name": display_name,
        "can_open": bool(user_id or phone_number),
    }


def get_media_label(message) -> Optional[str]:
    """Return a short label for message media."""
    media_kind = get_media_kind(message)
    if media_kind:
        return MEDIA_LABELS.get(media_kind, "Attachment")

    if getattr(message, "media", None):
        return type(message.media).__name__.replace("MessageMedia", "") or "Attachment"

    return None


def get_message_preview_text(message) -> str:
    """Return user-facing preview text for a message or media attachment."""
    text = (getattr(message, "text", "") or "").strip()
    if text:
        return text

    contact = _get_contact_payload(message)
    if contact:
        return f"[Contact] {contact['display_name']}"

    media_label = get_media_label(message)
    return f"[{media_label}]" if media_label else ""


def _get_message_file_metadata(message) -> dict:
    """Extract file metadata from a Telegram message."""
    file_info = getattr(message, "file", None)
    return {
        "file_name": getattr(file_info, "name", None) or None,
        "mime_type": getattr(file_info, "mime_type", None) or None,
        "file_size": getattr(file_info, "size", None),
        "duration": getattr(file_info, "duration", None),
    }


def _guess_media_type(message, file_path: str) -> str:
    """Infer an HTTP media type for a downloaded Telegram file."""
    metadata = _get_message_file_metadata(message)
    mime_type = metadata["mime_type"] or mimetypes.guess_type(file_path)[0]
    if mime_type:
        return mime_type

    media_kind = get_media_kind(message)
    fallback_types = {
        "audio": "audio/mpeg",
        "document": "application/octet-stream",
        "gif": "image/gif",
        "photo": "image/jpeg",
        "sticker": "image/webp",
        "video": "video/mp4",
        "voice": "audio/ogg",
    }
    return fallback_types.get(media_kind, "application/octet-stream")


def _is_downloadable_message_media(message) -> bool:
    """Return True when a Telegram message likely contains downloadable media."""
    media = getattr(message, "media", None)
    if not media:
        return False

    if getattr(media, "phone_number", None):
        return False

    if get_media_kind(message) in DOWNLOADABLE_MEDIA_KINDS:
        return True

    metadata = _get_message_file_metadata(message)
    if metadata["mime_type"] or metadata["file_name"] or metadata["file_size"]:
        return True

    media_type_name = type(media).__name__
    return media_type_name == "MessageMediaUnsupported"


def _build_download_name(message, file_path: str) -> str:
    """Choose a stable filename for downloaded media."""
    metadata = _get_message_file_metadata(message)
    file_name = metadata["file_name"] or os.path.basename(file_path)
    if file_name:
        return file_name

    extension = os.path.splitext(file_path)[1]
    media_kind = get_media_kind(message) or "media"
    return f"{media_kind}_{message.id}{extension}"


async def ensure_message_media_downloaded(
    client: TelegramClient,
    message,
    session_name: str,
) -> tuple[str, str, str]:
    """Download a message media file to cache and return path, media type, and name."""
    if not _is_downloadable_message_media(message):
        raise ValueError("Message does not contain downloadable media.")

    chat_id = getattr(message, "chat_id", None)
    if chat_id is None:
        raise ValueError("Message chat is unavailable for media download.")

    cache_dir = os.path.join(
        get_media_cache_dir(),
        _sanitize_path_part(session_name),
        _sanitize_path_part(chat_id),
    )
    os.makedirs(cache_dir, exist_ok=True)

    cached_files = sorted(
        candidate
        for candidate in glob.glob(os.path.join(cache_dir, f"{message.id}*"))
        if os.path.basename(candidate) == str(message.id)
        or os.path.basename(candidate).startswith(f"{message.id}.")
    )
    file_path = cached_files[0] if cached_files else None

    if not file_path:
        target_path = os.path.join(cache_dir, str(message.id))
        file_path = await client.download_media(message, file=target_path)
        if not file_path:
            raise ValueError("Failed to download media from Telegram.")

    return (
        file_path,
        _guess_media_type(message, file_path),
        _build_download_name(message, file_path),
    )


async def ensure_entity_avatar_downloaded(
    client: TelegramClient,
    entity,
    session_name: str,
    cache_key: str,
) -> tuple[str, str]:
    """Download an entity avatar to cache and return path plus content type."""
    cache_dir = os.path.join(get_avatar_cache_dir(), _sanitize_path_part(session_name))
    os.makedirs(cache_dir, exist_ok=True)

    cached_file = _find_cached_variant(cache_dir, cache_key)
    if cached_file:
        return cached_file, _guess_path_media_type(cached_file)

    file_path = await client.download_profile_photo(entity, file=os.path.join(cache_dir, cache_key))
    if not file_path:
        raise ValueError("Profile photo not found.")

    return file_path, _guess_path_media_type(file_path)


async def resolve_entity(client: TelegramClient, identifier: str) -> object:
    """Resolve a Telegram entity by username, phone, or user ID."""
    identifier = identifier.strip()

    try:
        entity_id = int(identifier)
        entity = await client.get_entity(entity_id)
        logger.info("Resolved entity by ID: %s -> %s", identifier, entity)
        return entity
    except (ValueError, TypeError):
        pass
    except Exception as exc:
        logger.debug("Could not resolve as ID (%s): %s", identifier, exc)

    if identifier.startswith("@"):
        identifier_clean = identifier
    elif not identifier.startswith("+") and not identifier.isdigit():
        identifier_clean = f"@{identifier}"
    else:
        identifier_clean = identifier

    try:
        entity = await client.get_entity(identifier_clean)
        logger.info("Resolved entity: %s -> %s", identifier_clean, entity)
        return entity
    except Exception as exc:
        logger.error("Failed to resolve entity '%s': %s", identifier, exc)
        raise ValueError(f"Could not resolve entity: {identifier}") from exc


def get_user_status_string(status) -> str:
    """Convert a Telegram user status to a human-readable string."""
    if isinstance(status, UserStatusOnline):
        return "online"
    if isinstance(status, UserStatusOffline):
        return (
            f"last seen {status.was_online.strftime('%H:%M %d.%m.%Y')}"
            if status.was_online
            else "offline"
        )
    if isinstance(status, UserStatusRecently):
        return "recently"
    if isinstance(status, UserStatusLastWeek):
        return "last week"
    if isinstance(status, UserStatusLastMonth):
        return "last month"
    if isinstance(status, UserStatusEmpty):
        return "unknown"
    return "unknown"


async def get_user_info(
    client: TelegramClient,
    entity,
    session_name: Optional[str] = None,
    self_avatar: bool = False,
) -> dict:
    """Get detailed user information for a Telegram entity."""
    photo_version = get_entity_photo_version(entity)
    info = {
        "id": getattr(entity, "id", 0),
        "display_name": _get_display_name(entity),
        "first_name": getattr(entity, "first_name", "") or "",
        "last_name": getattr(entity, "last_name", "") or "",
        "username": getattr(entity, "username", "") or "",
        "phone": getattr(entity, "phone", "") or "",
        "photo_url": None,
        "is_bot": getattr(entity, "bot", False),
        "status": "unknown",
        "about": "",
        "common_chats_count": None,
        "is_contact": bool(
            getattr(entity, "contact", False) or getattr(entity, "mutual_contact", False)
        ),
        "can_add_to_contacts": False,
    }

    if isinstance(entity, User) and entity.status:
        info["status"] = get_user_status_string(entity.status)
        info["can_add_to_contacts"] = not (
            info["is_contact"]
            or getattr(entity, "self", False)
            or getattr(entity, "bot", False)
        )

    if getattr(entity, "photo", None) and session_name and getattr(entity, "id", None) is not None:
        if self_avatar:
            info["photo_url"] = build_own_avatar_url(session_name, photo_version)
        else:
            info["photo_url"] = build_entity_avatar_url(session_name, entity.id, photo_version)

    return info


def format_message(
    message,
    session_name: Optional[str] = None,
    sender=None,
    read_outbox_max_id: Optional[int] = None,
) -> dict:
    """Format a Telethon message into a serializable dictionary."""
    message_sender = sender if sender is not None else getattr(message, "sender", None)
    media_type = type(message.media).__name__ if getattr(message, "media", None) else None
    media_kind = get_media_kind(message)
    metadata = _get_message_file_metadata(message)
    chat_id = getattr(message, "chat_id", None)
    contact = _get_contact_payload(message)

    media_url = None
    if session_name and chat_id is not None and _is_downloadable_message_media(message):
        media_url = build_message_media_url(session_name, chat_id, message.id)

    return {
        "id": message.id,
        "text": message.text or "",
        "date": message.date.isoformat() if message.date else "",
        "chat_id": chat_id,
        "sender_id": message.sender_id,
        "sender_name": _get_sender_name(message_sender, message.sender_id),
        "is_outgoing": message.out,
        "is_read": bool(message.out and read_outbox_max_id and message.id <= read_outbox_max_id),
        "media_type": media_type,
        "media_kind": media_kind,
        "media_url": media_url,
        "thumbnail_url": None,
        "file_name": metadata["file_name"],
        "mime_type": metadata["mime_type"],
        "file_size": metadata["file_size"],
        "duration": metadata["duration"],
        "contact": contact,
        "preview_text": get_message_preview_text(message),
    }


async def download_avatar(client: TelegramClient, entity, path: str) -> Optional[str]:
    """Download a profile photo for an entity."""
    try:
        result = await client.download_profile_photo(entity, file=path)
        if result:
            logger.info(
                "Downloaded avatar for entity %s to %s",
                getattr(entity, "id", "?"),
                result,
            )
            return result
        logger.info("No avatar found for entity %s", getattr(entity, "id", "?"))
        return None
    except Exception as exc:
        logger.error("Error downloading avatar: %s", exc)
        return None
