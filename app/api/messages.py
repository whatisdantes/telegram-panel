"""Message and dialog API routes."""

import logging
import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from telethon.errors import (
    FloodWaitError,
    RPCError,
    UserNotMutualContactError,
)
from telethon.tl.functions.contacts import AddContactRequest, GetContactsRequest, ImportContactsRequest
from telethon.tl.functions.messages import GetPeerDialogsRequest
from telethon.tl.functions.users import GetFullUserRequest
from telethon.tl.types import InputDialogPeer, InputPhoneContact, User

from app.models.schemas import (
    AddContactRequest as AddContactByIdentifierRequest,
    ContactNameRequest,
    OpenDialogRequest,
    SendMessageRequest,
)
from app.telegram.client_manager import TelegramClientManager
from app.telegram.error_map import (
    format_flood_wait_error,
    humanize_error,
    humanize_rpc_error,
)
from app.telegram.utils import (
    ensure_entity_avatar_downloaded,
    ensure_message_media_downloaded,
    format_message,
    get_message_preview_text,
    get_user_info,
    resolve_entity,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/messages", tags=["messages"])
PHONE_IDENTIFIER_RE = re.compile(r"^[\d\+\-\(\)\s]+$")


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


def _looks_like_phone_identifier(identifier: str) -> bool:
    """Return True when an identifier should be treated as a phone number."""
    value = (identifier or "").strip()
    digits = re.sub(r"\D+", "", value)
    return bool(value and PHONE_IDENTIFIER_RE.fullmatch(value) and len(digits) >= 5)


def _normalize_phone_identifier(identifier: str) -> str:
    """Normalize a phone identifier to digits-only format."""
    return re.sub(r"\D+", "", (identifier or "").strip())


async def _get_read_outbox_max_id(client, entity) -> int:
    """Return the highest outgoing message id already read by the peer."""
    input_entity = await client.get_input_entity(entity)
    peer_dialogs = await client(
        GetPeerDialogsRequest(
            peers=[InputDialogPeer(peer=input_entity)]
        )
    )
    dialogs = getattr(peer_dialogs, "dialogs", []) or []
    if not dialogs:
        return 0
    return int(getattr(dialogs[0], "read_outbox_max_id", 0) or 0)


def _ensure_regular_user(entity) -> User:
    """Ensure the target entity is a regular non-self user."""
    if not isinstance(entity, User) or getattr(entity, "self", False) or getattr(entity, "bot", False):
        raise HTTPException(
            status_code=400,
            detail="Only regular users can be added to contacts.",
        )
    return entity


async def _build_contact_response(
    client,
    session_name: str,
    entity: User,
    *,
    already_contact: bool,
    updated_contact: bool = False,
) -> dict[str, Any]:
    """Build a consistent response for contact-add actions."""
    info = await get_user_info(client, entity, session_name=session_name)
    full_user = await client(GetFullUserRequest(entity))
    info["about"] = getattr(full_user, "about", "") or ""
    info["common_chats_count"] = getattr(full_user, "common_chats_count", None)
    info["message"] = (
        "Contact name updated."
        if updated_contact
        else "User is already in contacts."
        if already_contact
        else "User added to contacts."
    )
    info["success"] = True
    return info


def _build_contact_name_parts(
    entity: User,
    *,
    fallback_phone: str = "",
    first_name_override: str | None = None,
    last_name_override: str | None = None,
) -> tuple[str, str]:
    """Choose the best available contact name for saving into Telegram contacts."""
    base_first_name = (getattr(entity, "first_name", "") or "").strip()
    base_last_name = (getattr(entity, "last_name", "") or "").strip()
    username = (getattr(entity, "username", "") or "").strip()
    phone = (getattr(entity, "phone", "") or "").strip() or fallback_phone.strip()
    first_name_override = (first_name_override or "").strip()
    last_name_override = (last_name_override or "").strip()

    if base_first_name:
        first_name = base_first_name
        last_name = base_last_name
    elif username:
        first_name = username
        last_name = ""
    elif phone:
        first_name = phone
        last_name = ""
    else:
        first_name = "Unknown"
        last_name = ""

    return first_name_override or first_name, last_name_override or last_name


async def _save_contact_with_entity_name(
    client,
    entity: User,
    *,
    fallback_phone: str = "",
    first_name_override: str | None = None,
    last_name_override: str | None = None,
) -> User:
    """Save a contact using the user's actual Telegram name whenever possible."""
    entity = _ensure_regular_user(entity)
    first_name, last_name = _build_contact_name_parts(
        entity,
        fallback_phone=fallback_phone,
        first_name_override=first_name_override,
        last_name_override=last_name_override,
    )
    phone = (getattr(entity, "phone", "") or "").strip() or fallback_phone.strip()

    await client(
        AddContactRequest(
            id=entity,
            first_name=first_name,
            last_name=last_name,
            phone=phone,
        )
    )
    return await client.get_entity(entity.id)


async def _add_entity_to_contacts(
    client,
    entity: User,
    *,
    first_name_override: str | None = None,
    last_name_override: str | None = None,
) -> tuple[User, bool, bool]:
    """Add a resolved user entity to contacts when needed."""
    entity = _ensure_regular_user(entity)
    already_contact = bool(
        getattr(entity, "contact", False) or getattr(entity, "mutual_contact", False)
    )
    current_first_name = (getattr(entity, "first_name", "") or "").strip()
    current_last_name = (getattr(entity, "last_name", "") or "").strip()
    normalized_first_name_override = (first_name_override or "").strip()
    normalized_last_name_override = (last_name_override or "").strip()
    has_name_override = bool(normalized_first_name_override or normalized_last_name_override)
    updated_contact = bool(
        already_contact and (
            (normalized_first_name_override and normalized_first_name_override != current_first_name)
            or (normalized_last_name_override and normalized_last_name_override != current_last_name)
        )
    )

    if not already_contact or has_name_override:
        entity = await _save_contact_with_entity_name(
            client,
            entity,
            first_name_override=first_name_override,
            last_name_override=last_name_override,
        )

    return entity, already_contact, updated_contact


async def _import_contact_by_phone(
    client,
    phone_number: str,
    *,
    first_name_override: str | None = None,
    last_name_override: str | None = None,
) -> tuple[User, bool, bool]:
    """Import a new contact directly by phone number."""
    normalized_phone = _normalize_phone_identifier(phone_number)
    if not normalized_phone:
        raise HTTPException(status_code=400, detail="Phone number is empty or invalid.")

    client_id = int(time.time_ns() % (2**63 - 1))
    result = await client(
        ImportContactsRequest(
            contacts=[
                InputPhoneContact(
                    client_id=client_id,
                    phone=normalized_phone,
                    first_name=normalized_phone,
                    last_name="",
                )
            ]
        )
    )

    imported_user_id = next(
        (item.user_id for item in getattr(result, "imported", []) if getattr(item, "client_id", None) == client_id),
        None,
    )
    if imported_user_id is None:
        imported_user_id = next(
            (getattr(item, "user_id", None) for item in getattr(result, "imported", [])),
            None,
        )
    entity = None
    if imported_user_id is not None:
        entity = next(
            (user for user in getattr(result, "users", []) if getattr(user, "id", None) == imported_user_id),
            None,
        )
        if entity is None:
            entity = await client.get_entity(imported_user_id)

    if entity is None and len(getattr(result, "users", [])) == 1:
        entity = result.users[0]

    if entity is None:
        try:
            entity = await client.get_entity(normalized_phone)
        except Exception:
            entity = None

    if entity is None:
        raise HTTPException(
            status_code=404,
            detail="No Telegram account was found for this phone number.",
        )

    entity = _ensure_regular_user(entity)
    entity = await _save_contact_with_entity_name(
        client,
        entity,
        fallback_phone=normalized_phone,
        first_name_override=first_name_override,
        last_name_override=last_name_override,
    )
    return entity, False, False


@router.get("/{session_name}/dialogs")
async def list_dialogs(
    session_name: str,
    limit: int = Query(default=20, ge=1, le=100),
) -> list[dict[str, Any]]:
    """List recent dialogs for the account."""
    client = _require_client(session_name)

    try:
        dialogs = await client.get_dialogs(limit=limit)
        result = []
        for dialog in dialogs:
            entity = dialog.entity
            is_group = (
                getattr(entity, "megagroup", False)
                or hasattr(entity, "participants_count")
                and not getattr(entity, "broadcast", False)
            )
            is_channel = getattr(entity, "broadcast", False)

            last_message_text = ""
            last_message_date = ""
            last_message_sender = ""
            if dialog.message:
                last_message_text = get_message_preview_text(dialog.message)
                last_message_date = dialog.message.date.isoformat() if dialog.message.date else ""
                if dialog.message.sender:
                    first = getattr(dialog.message.sender, "first_name", "") or ""
                    last = getattr(dialog.message.sender, "last_name", "") or ""
                    last_message_sender = f"{first} {last}".strip()

            result.append({
                "id": dialog.entity.id,
                "name": dialog.name or getattr(entity, "title", "") or f"Chat {dialog.entity.id}",
                "username": getattr(entity, "username", "") or "",
                "is_group": bool(is_group),
                "is_channel": bool(is_channel),
                "unread_count": dialog.unread_count,
                "last_message": last_message_text[:200] if last_message_text else None,
                "last_message_date": last_message_date,
                "last_message_sender": last_message_sender,
            })

        logger.info(
            "Loaded dialogs for %s: %d dialog(s), limit=%d",
            session_name,
            len(result),
            limit,
        )
        return result

    except FloodWaitError as e:
        raise _flood_wait_exception(e)
    except RPCError as e:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(e))
    except Exception as e:
        logger.exception("Error listing dialogs for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to list dialogs.")


@router.get("/{session_name}/contacts")
async def list_contacts(session_name: str) -> list[dict[str, Any]]:
    """List imported contacts for the account."""
    client = _require_client(session_name)

    try:
        contacts_result = await client(GetContactsRequest(hash=0))
        contacts = []

        for user in contacts_result.users:
            if (
                not isinstance(user, User)
                or getattr(user, "self", False)
                or getattr(user, "deleted", False)
            ):
                continue

            contacts.append(await get_user_info(client, user, session_name=session_name))

        contacts.sort(
            key=lambda item: (
                (item.get("display_name") or "").lower(),
                str(item.get("id") or ""),
            )
        )

        logger.info(
            "Loaded contacts for %s: %d contact(s)",
            session_name,
            len(contacts),
        )
        return contacts

    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error listing contacts for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to list contacts.")


@router.get("/{session_name}/history/{entity_id}")
async def get_message_history(
    session_name: str,
    entity_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    offset_id: int = Query(default=0, ge=0),
) -> list[dict[str, Any]]:
    """Get message history for a specific chat."""
    client = _require_client(session_name)

    try:
        entity = await client.get_entity(entity_id)
        read_outbox_max_id = await _get_read_outbox_max_id(client, entity)
        messages = await client.get_messages(
            entity,
            limit=limit,
            offset_id=offset_id,
        )

        result = []
        for msg in messages:
            result.append(
                format_message(
                    msg,
                    session_name=session_name,
                    read_outbox_max_id=read_outbox_max_id,
                )
            )

        logger.info(
            "Loaded history for %s chat %s: %d message(s), limit=%d, offset_id=%d",
            session_name,
            entity_id,
            len(result),
            limit,
            offset_id,
        )
        return result

    except ValueError:
        raise HTTPException(status_code=404, detail="Chat not found.")
    except FloodWaitError as e:
        raise _flood_wait_exception(e)
    except RPCError as e:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(e))
    except Exception as e:
        logger.exception("Error getting history for %s in %s", entity_id, session_name)
        raise HTTPException(status_code=500, detail="Failed to get message history.")


@router.delete("/{session_name}/dialog/{entity_id}")
async def delete_dialog(session_name: str, entity_id: int) -> dict[str, Any]:
    """Delete a private chat with revoke enabled so history is removed for both users."""
    client = _require_client(session_name)

    try:
        entity = await client.get_entity(entity_id)
        if not isinstance(entity, User) or getattr(entity, "self", False):
            raise HTTPException(
                status_code=400,
                detail="This action is available only for private chats with other users.",
            )

        logger.info("Deleting private dialog for both participants: %s -> %s", session_name, entity_id)
        await client.delete_dialog(entity, revoke=True)
        logger.info("Deleted private dialog for both participants: %s -> %s", session_name, entity_id)

        return {
            "ok": True,
            "entity_id": entity.id,
            "deleted_for_both": True,
        }

    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail="Chat not found.")
    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error deleting dialog %s for %s", entity_id, session_name)
        raise HTTPException(status_code=500, detail="Failed to delete chat.")


@router.post("/{session_name}/send")
async def send_message(session_name: str, request: SendMessageRequest) -> dict[str, Any]:
    """Send a message to a target user/chat."""
    client = _require_client(session_name)

    try:
        logger.info(
            "Send message requested: session=%s target=%s text_length=%d",
            session_name,
            request.target,
            len(request.text or ""),
        )
        entity = await resolve_entity(client, request.target)
        result = await client.send_message(entity, request.text)
        logger.info(
            "Message sent: session=%s target=%s message_id=%s",
            session_name,
            request.target,
            getattr(result, "id", "unknown"),
        )
        return format_message(result, session_name=session_name)

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except UserNotMutualContactError:
        raise HTTPException(
            status_code=403,
            detail=humanize_error("USER_NOT_MUTUAL_CONTACT"),
        )
    except FloodWaitError as e:
        raise _flood_wait_exception(e)
    except RPCError as e:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(e))
    except Exception as e:
        logger.exception("Error sending message from %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to send message.")


@router.post("/{session_name}/resolve")
async def resolve_target(session_name: str, request: OpenDialogRequest) -> dict[str, Any]:
    """Resolve an entity by username, phone, or ID."""
    client = _require_client(session_name)

    try:
        logger.info("Resolving target for %s: %s", session_name, request.identifier)
        entity = await resolve_entity(client, request.identifier)
        info = await get_user_info(client, entity, session_name=session_name)
        logger.info("Resolved target for %s: %s -> %s", session_name, request.identifier, info.get("id"))
        return info

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except FloodWaitError as e:
        raise _flood_wait_exception(e)
    except RPCError as e:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(e))
    except Exception as e:
        logger.exception("Error resolving entity for %s", session_name)
        raise HTTPException(status_code=500, detail="Failed to resolve entity.")


@router.post("/{session_name}/contacts")
async def add_contact_by_identifier(
    session_name: str,
    request: AddContactByIdentifierRequest,
) -> dict[str, Any]:
    """Add a contact by @username or phone number."""
    client = _require_client(session_name)
    identifier = (request.identifier or "").strip()
    custom_first_name = (request.first_name or "").strip()
    custom_last_name = (request.last_name or "").strip()

    if not identifier:
        raise HTTPException(status_code=400, detail="Username or phone number is required.")

    try:
        logger.info(
            "Add contact by identifier requested for %s: %s first_name=%r last_name=%r",
            session_name,
            identifier,
            custom_first_name,
            custom_last_name,
        )

        if _looks_like_phone_identifier(identifier):
            entity, already_contact, updated_contact = await _import_contact_by_phone(
                client,
                identifier,
                first_name_override=custom_first_name,
                last_name_override=custom_last_name,
            )
        else:
            entity = await resolve_entity(client, identifier)
            entity, already_contact, updated_contact = await _add_entity_to_contacts(
                client,
                entity,
                first_name_override=custom_first_name,
                last_name_override=custom_last_name,
            )

        info = await _build_contact_response(
            client,
            session_name,
            entity,
            already_contact=already_contact,
            updated_contact=updated_contact,
        )
        logger.info(
            "Add contact by identifier finished for %s: identifier=%s entity_id=%s is_contact=%s",
            session_name,
            identifier,
            info.get("id"),
            info.get("is_contact"),
        )
        return info

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error adding contact by identifier for %s: %s", session_name, identifier)
        raise HTTPException(status_code=500, detail="Failed to add contact.")


@router.get("/{session_name}/user/{entity_id}")
async def get_user_details(session_name: str, entity_id: int) -> dict[str, Any]:
    """Get detailed user information."""
    client = _require_client(session_name)

    try:
        entity = await client.get_entity(entity_id)
        if not isinstance(entity, User) or getattr(entity, "self", False):
            raise HTTPException(
                status_code=400,
                detail="This action is available only for private chats with other users.",
            )

        info = await get_user_info(client, entity, session_name=session_name)
        full_user = await client(GetFullUserRequest(entity))
        info["about"] = getattr(full_user, "about", "") or ""
        info["common_chats_count"] = getattr(full_user, "common_chats_count", None)
        logger.info(
            "Opened chat profile for %s: entity_id=%s is_contact=%s",
            session_name,
            entity_id,
            info.get("is_contact"),
        )
        return info

    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail="User not found.")
    except FloodWaitError as e:
        raise _flood_wait_exception(e)
    except RPCError as e:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(e))
    except Exception as e:
        logger.exception("Error getting user %s for %s", entity_id, session_name)
        raise HTTPException(status_code=500, detail="Failed to get user info.")


@router.post("/{session_name}/user/{entity_id}/contact")
async def add_user_to_contacts(
    session_name: str,
    entity_id: int,
    request: ContactNameRequest | None = None,
) -> dict[str, Any]:
    """Add a user from the current chat to contacts."""
    client = _require_client(session_name)
    custom_first_name = ((request.first_name if request else "") or "").strip()
    custom_last_name = ((request.last_name if request else "") or "").strip()

    try:
        entity = await client.get_entity(entity_id)
        entity = _ensure_regular_user(entity)
        _, already_contact, updated_contact = await _add_entity_to_contacts(
            client,
            entity,
            first_name_override=custom_first_name,
            last_name_override=custom_last_name,
        )
        logger.info(
            "Add contact requested for %s: entity_id=%s already_contact=%s first_name=%r last_name=%r",
            session_name,
            entity_id,
            already_contact,
            custom_first_name,
            custom_last_name,
        )
        entity = await client.get_entity(entity_id)
        info = await _build_contact_response(
            client,
            session_name,
            entity,
            already_contact=already_contact,
            updated_contact=updated_contact,
        )

        logger.info(
            "Add contact finished for %s: entity_id=%s is_contact=%s",
            session_name,
            entity_id,
            info.get("is_contact"),
        )
        return info

    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail="User not found.")
    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception("Error adding user %s to contacts for %s", entity_id, session_name)
        raise HTTPException(status_code=500, detail="Failed to add user to contacts.")


@router.get("/{session_name}/user/{entity_id}/avatar")
async def get_user_avatar(session_name: str, entity_id: int):
    """Download and serve a user or chat avatar."""
    client = _require_client(session_name)

    try:
        entity = await client.get_entity(entity_id)
        if not getattr(entity, "photo", None):
            raise HTTPException(status_code=404, detail="Profile photo not found.")

        file_path, media_type = await ensure_entity_avatar_downloaded(
            client,
            entity,
            session_name,
            cache_key=f"entity_{entity_id}",
        )
        logger.info("Served entity avatar for %s: entity_id=%s path=%s", session_name, entity_id, file_path)
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
        logger.exception("Error loading avatar for entity %s (%s)", entity_id, session_name)
        raise HTTPException(status_code=500, detail="Failed to load profile photo.")


@router.get("/{session_name}/media/{entity_id}/{message_id}")
async def get_message_media(session_name: str, entity_id: int, message_id: int):
    """Download and serve message media for browser rendering."""
    client = _require_client(session_name)

    try:
        entity = await client.get_entity(entity_id)
        message = await client.get_messages(entity, ids=message_id)
        if not message or not getattr(message, "media", None):
            raise HTTPException(status_code=404, detail="Media file not found.")

        file_path, media_type, file_name = await ensure_message_media_downloaded(
            client,
            message,
            session_name,
        )
        logger.info(
            "Served message media for %s: chat=%s message=%s file=%s",
            session_name,
            entity_id,
            message_id,
            file_name,
        )
        return FileResponse(
            file_path,
            media_type=media_type,
            filename=file_name,
            content_disposition_type="inline",
        )

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except FloodWaitError as exc:
        raise _flood_wait_exception(exc)
    except RPCError as exc:
        raise HTTPException(status_code=500, detail=humanize_rpc_error(exc))
    except Exception:
        logger.exception(
            "Error loading media for message %s in chat %s (%s)",
            message_id,
            entity_id,
            session_name,
        )
        raise HTTPException(status_code=500, detail="Failed to load media.")
