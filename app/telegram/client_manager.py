"""Core Telethon client manager with singleton pattern."""

import asyncio
import enum
import logging
import os
import re
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from telethon import TelegramClient, events
from telethon.errors import (
    AuthKeyError,
    FloodWaitError,
    RPCError,
    SessionPasswordNeededError,
)

from app.config import settings
from app.telegram.error_map import format_flood_wait_error, humanize_rpc_error
from app.telegram.utils import (
    build_own_avatar_url,
    format_message,
    get_entity_photo_version,
    get_user_status_string,
)

logger = logging.getLogger(__name__)

SPAMBOT_USERNAME = "SpamBot"
SPAMBOT_REPLY_POLL_ATTEMPTS = 8
SPAMBOT_REPLY_POLL_INTERVAL = 1.0
SPAMBOT_TOS_BLOCK_MARKERS = (
    "your account was blocked for violations of the telegram terms of service",
    "based on user reports confirmed by our moderators",
)
SPAMBOT_TEMPORARY_BLOCK_MARKERS = (
    "ваш аккаунт временно ограничен",
    "ограничения будут автоматически сняты",
)
SPAMBOT_PERMANENT_BLOCK_MARKER_GROUPS = (
    (
        "иногда наша антиспам-система излишне сурово реагирует на некоторые действия",
        "пока действуют ограничения, вы не сможете писать тем, кто не сохранил ваш номер в список контактов",
    ),
    (
        "some actions can trigger a harsh response from our anti-spam systems",
        "while the account is limited, you will not be able to send messages to people who do not have your number in their phone contacts or add them to groups and channels",
    ),
)
SPAMBOT_TEMPORARY_UNTIL_RE = re.compile(
    r"Ограничения будут автоматически сняты\s+(.+?)(?:\s*\(|\.)",
    re.IGNORECASE | re.DOTALL,
)


class ClientStatus(str, enum.Enum):
    """Status of a managed Telegram client."""

    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    UNAUTHORIZED = "unauthorized"
    FROZEN = "frozen"
    TEMPORARY_SPAMBLOCK = "temporary_spamblock"
    PERMANENT_SPAMBLOCK = "permanent_spamblock"
    INVALID_SESSION = "invalid_session"
    RECONNECTING = "reconnecting"
    ERROR = "error"


@dataclass
class ManagedClient:
    """Container for a managed Telegram client and its metadata."""

    client: Optional[TelegramClient] = None
    status: ClientStatus = ClientStatus.DISCONNECTED
    phone: str = ""
    name: str = ""
    session_name: str = ""
    error_msg: str = ""
    avatar_url: Optional[str] = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class TelegramClientManager:
    """Singleton manager for multiple Telegram client sessions."""

    _instance: Optional["TelegramClientManager"] = None
    _initialized: bool = False

    def __new__(cls) -> "TelegramClientManager":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        self.clients: dict[str, ManagedClient] = {}
        self._ws_manager = None
        logger.info("TelegramClientManager initialized")

    def set_ws_manager(self, ws_manager) -> None:
        """Set the WebSocket manager for broadcasting events."""
        self._ws_manager = ws_manager
        logger.info("WebSocket manager attached to TelegramClientManager")

    def _get_session_path(self, session_name: str) -> str:
        """Get the full path for a session file."""
        return os.path.join(settings.SESSIONS_DIR, session_name)

    def _get_quarantine_dir(self, folder_name: str) -> str:
        """Return a quarantine directory inside the accounts folder."""
        quarantine_dir = os.path.join(settings.SESSIONS_DIR, folder_name)
        os.makedirs(quarantine_dir, exist_ok=True)
        return quarantine_dir

    def _get_session_file_candidates(self, session_name: str) -> list[str]:
        """Return all known files that belong to a Telethon session."""
        session_base = self._get_session_path(session_name)
        suffixes = [
            ".session",
            ".session-journal",
            ".session-shm",
            ".session-wal",
        ]
        return [
            f"{session_base}{suffix}"
            for suffix in suffixes
            if os.path.exists(f"{session_base}{suffix}")
        ]

    def _build_quarantine_destination(self, source_path: str, folder_name: str) -> str:
        """Build a unique destination path inside a quarantine folder."""
        target_dir = self._get_quarantine_dir(folder_name)
        base_name = os.path.basename(source_path)
        destination = os.path.join(target_dir, base_name)

        if not os.path.exists(destination):
            return destination

        timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
        return os.path.join(target_dir, f"{base_name}.{timestamp}")

    def _normalize_spambot_text(self, text: str) -> str:
        """Normalize bot text for reliable substring matching."""
        return " ".join((text or "").strip().lower().split())

    def _is_frozen_spambot_reply(self, text: str) -> bool:
        """Check whether a SpamBot reply says the account is blocked."""
        normalized = self._normalize_spambot_text(text)
        return all(marker in normalized for marker in SPAMBOT_TOS_BLOCK_MARKERS)

    def _matches_spambot_marker_groups(
        self,
        normalized_text: str,
        marker_groups: tuple[tuple[str, ...], ...],
    ) -> bool:
        """Check whether the normalized text matches any full marker group."""
        return any(
            all(marker in normalized_text for marker in marker_group)
            for marker_group in marker_groups
        )

    def _extract_spambot_temporary_until(self, text: str) -> str:
        """Extract the end time from a temporary SpamBot restriction message."""
        match = SPAMBOT_TEMPORARY_UNTIL_RE.search(text or "")
        if not match:
            return ""
        return " ".join(match.group(1).split()).strip()

    def _detect_spambot_restriction(self, text: str) -> Optional[dict[str, str]]:
        """Classify a SpamBot reply into a known account restriction type."""
        normalized = self._normalize_spambot_text(text)

        if all(marker in normalized for marker in SPAMBOT_TOS_BLOCK_MARKERS):
            return {
                "status": ClientStatus.FROZEN.value,
                "reason": "Аккаунт заморожен. Сессия перемещена в accounts/frozen/ и скрыта из панели.",
                "folder_name": "frozen",
            }

        if all(marker in normalized for marker in SPAMBOT_TEMPORARY_BLOCK_MARKERS):
            restriction_until = self._extract_spambot_temporary_until(text)
            reason = "Аккаунт во временном спамблоке"
            if restriction_until:
                reason += f" до {restriction_until}"
            reason += ". Сессия перемещена в accounts/time_sb/ и скрыта из панели."
            return {
                "status": ClientStatus.TEMPORARY_SPAMBLOCK.value,
                "reason": reason,
                "folder_name": "time_sb",
            }

        if self._matches_spambot_marker_groups(
            normalized,
            SPAMBOT_PERMANENT_BLOCK_MARKER_GROUPS,
        ):
            return {
                "status": ClientStatus.PERMANENT_SPAMBLOCK.value,
                "reason": "Аккаунт в вечном спамблоке. Сессия перемещена в accounts/immortal_sb/ и скрыта из панели.",
                "folder_name": "immortal_sb",
            }

        return None

    async def _check_spambot_status(
        self,
        client: TelegramClient,
        session_name: str,
    ) -> Optional[dict[str, str]]:
        """Send /start to @SpamBot and detect whether the account has restrictions."""
        try:
            entity = await client.get_entity(SPAMBOT_USERNAME)
            recent_messages = await client.get_messages(entity, limit=1)
            previous_latest_id = recent_messages[0].id if recent_messages else 0
            seen_message_ids: set[int] = set()

            await client.send_message(entity, "/start")
            logger.info("Sent /start to @%s for %s", SPAMBOT_USERNAME, session_name)

            for _ in range(SPAMBOT_REPLY_POLL_ATTEMPTS):
                await asyncio.sleep(SPAMBOT_REPLY_POLL_INTERVAL)
                messages = await client.get_messages(entity, limit=5)
                for message in sorted(messages, key=lambda item: item.id):
                    if (
                        message.id <= previous_latest_id
                        or message.out
                        or message.id in seen_message_ids
                    ):
                        continue

                    seen_message_ids.add(message.id)
                    text = getattr(message, "raw_text", "") or getattr(message, "message", "") or ""
                    logger.info(
                        "Received @%s reply for %s: %s",
                        SPAMBOT_USERNAME,
                        session_name,
                        text[:200].replace("\n", " "),
                    )

                    restriction = self._detect_spambot_restriction(text)
                    if restriction:
                        return restriction

            logger.warning(
                "@%s did not reply in time while checking %s",
                SPAMBOT_USERNAME,
                session_name,
            )
        except Exception as exc:
            logger.warning(
                "Could not complete @%s check for %s: %s",
                SPAMBOT_USERNAME,
                session_name,
                exc,
            )

        return None

    async def _quarantine_session(
        self,
        session_name: str,
        managed: ManagedClient,
        reason: str,
        folder_name: str,
        status: ClientStatus,
        client: Optional[TelegramClient] = None,
    ) -> ManagedClient:
        """Move a session into a quarantine folder and hide it from the UI."""
        client_to_disconnect = client or managed.client
        if client_to_disconnect:
            try:
                await client_to_disconnect.disconnect()
            except Exception as exc:
                logger.warning(
                    "Error disconnecting quarantined client %s before move: %s",
                    session_name,
                    exc,
                )

        moved_files = []
        for source_path in self._get_session_file_candidates(session_name):
            destination = self._build_quarantine_destination(source_path, folder_name)
            shutil.move(source_path, destination)
            moved_files.append(destination)

        managed.client = None
        managed.phone = ""
        managed.name = ""
        managed.status = status
        managed.avatar_url = None
        managed.error_msg = reason

        logger.warning(
            "Quarantined session %s into accounts/%s/; moved files: %s",
            session_name,
            folder_name,
            moved_files or "none",
        )
        await self._broadcast_status_change(session_name, managed)
        self.clients.pop(session_name, None)
        return managed

    async def _quarantine_unauthorized_session(
        self,
        session_name: str,
        managed: ManagedClient,
        reason: str,
        client: Optional[TelegramClient] = None,
    ) -> ManagedClient:
        """Move an unauthorized session into accounts/dead and hide it from the UI."""
        return await self._quarantine_session(
            session_name,
            managed,
            f"{reason} Session was moved to accounts/dead/ and hidden from the panel.",
            folder_name="dead",
            status=ClientStatus.UNAUTHORIZED,
            client=client,
        )

    async def _quarantine_frozen_session(
        self,
        session_name: str,
        managed: ManagedClient,
        client: Optional[TelegramClient] = None,
    ) -> ManagedClient:
        """Move a frozen account session into accounts/frozen and hide it from the UI."""
        return await self._quarantine_session(
            session_name,
            managed,
            "Аккаунт заморожен. Сессия перемещена в accounts/frozen/ и скрыта из панели.",
            folder_name="frozen",
            status=ClientStatus.FROZEN,
            client=client,
        )

    async def _quarantine_temporary_spamblock_session(
        self,
        session_name: str,
        managed: ManagedClient,
        reason: str,
        client: Optional[TelegramClient] = None,
    ) -> ManagedClient:
        """Move a temporarily spam-blocked account into accounts/time_sb/."""
        return await self._quarantine_session(
            session_name,
            managed,
            reason,
            folder_name="time_sb",
            status=ClientStatus.TEMPORARY_SPAMBLOCK,
            client=client,
        )

    async def _quarantine_permanent_spamblock_session(
        self,
        session_name: str,
        managed: ManagedClient,
        reason: str,
        client: Optional[TelegramClient] = None,
    ) -> ManagedClient:
        """Move a permanently spam-blocked account into accounts/immortal_sb/."""
        return await self._quarantine_session(
            session_name,
            managed,
            reason,
            folder_name="immortal_sb",
            status=ClientStatus.PERMANENT_SPAMBLOCK,
            client=client,
        )

    def scan_sessions(self) -> list[str]:
        """Scan the sessions directory for .session files."""
        sessions_dir = settings.SESSIONS_DIR
        if not os.path.isdir(sessions_dir):
            os.makedirs(sessions_dir, exist_ok=True)
            logger.info("Created sessions directory: %s", sessions_dir)
            return []

        session_files = []
        for filename in os.listdir(sessions_dir):
            if filename.endswith(".session"):
                session_name = filename.replace(".session", "")
                session_files.append(session_name)
                if session_name not in self.clients:
                    self.clients[session_name] = ManagedClient(
                        session_name=session_name,
                        status=ClientStatus.DISCONNECTED,
                    )

        logger.info("Found %d session files: %s", len(session_files), session_files)
        return session_files

    async def connect(self, session_name: str) -> ManagedClient:
        """Connect a client by session name."""
        if session_name not in self.clients:
            self.clients[session_name] = ManagedClient(session_name=session_name)

        managed = self.clients[session_name]

        async with managed.lock:
            if managed.status == ClientStatus.CONNECTED and managed.client and managed.client.is_connected():
                logger.info("Client %s already connected", session_name)
                return managed

            session_path = self._get_session_path(session_name)
            logger.info("Connecting client: %s (path: %s)", session_name, session_path)
            client: Optional[TelegramClient] = None

            try:
                client = TelegramClient(
                    session_path,
                    settings.API_ID,
                    settings.API_HASH,
                    device_model=settings.DEVICE_MODEL,
                    system_version=settings.SYSTEM_VERSION,
                    app_version=settings.APP_VERSION,
                    lang_code=settings.LANG_CODE,
                    system_lang_code=settings.SYSTEM_LANG_CODE,
                )
                await client.connect()

                if not await client.is_user_authorized():
                    logger.warning("Client %s is not authorized", session_name)
                    return await self._quarantine_unauthorized_session(
                        session_name,
                        managed,
                        "Session is not authorized.",
                        client=client,
                    )

                me = await client.get_me()
                spambot_status = await self._check_spambot_status(client, session_name)
                if spambot_status:
                    logger.warning(
                        "Client %s marked as %s after @SpamBot check",
                        session_name,
                        spambot_status["status"],
                    )
                    if spambot_status["status"] == ClientStatus.FROZEN.value:
                        return await self._quarantine_frozen_session(
                            session_name,
                            managed,
                            client=client,
                        )
                    if spambot_status["status"] == ClientStatus.TEMPORARY_SPAMBLOCK.value:
                        return await self._quarantine_temporary_spamblock_session(
                            session_name,
                            managed,
                            spambot_status["reason"],
                            client=client,
                        )
                    if spambot_status["status"] == ClientStatus.PERMANENT_SPAMBLOCK.value:
                        return await self._quarantine_permanent_spamblock_session(
                            session_name,
                            managed,
                            spambot_status["reason"],
                            client=client,
                        )

                managed.client = client
                managed.status = ClientStatus.CONNECTED
                managed.phone = me.phone or ""
                managed.name = f"{me.first_name or ''} {me.last_name or ''}".strip()
                managed.avatar_url = (
                    build_own_avatar_url(
                        session_name,
                        get_entity_photo_version(me),
                    )
                    if getattr(me, "photo", None)
                    else None
                )
                managed.error_msg = ""

                self._register_event_handlers(client, session_name)

                logger.info(
                    "Client %s connected successfully (phone: %s, name: %s)",
                    session_name,
                    managed.phone,
                    managed.name,
                )
                await self._broadcast_status_change(session_name, managed)
                return managed

            except AuthKeyError:
                managed.status = ClientStatus.INVALID_SESSION
                managed.error_msg = "Invalid session key. Session file may be corrupted."
                logger.error("AuthKeyError for client %s", session_name)
                await self._broadcast_status_change(session_name, managed)
                return managed

            except SessionPasswordNeededError:
                logger.warning("2FA required for client %s", session_name)
                return await self._quarantine_unauthorized_session(
                    session_name,
                    managed,
                    "Two-factor authentication is required for this session.",
                    client=client,
                )

            except FloodWaitError as e:
                managed.status = ClientStatus.ERROR
                managed.error_msg = format_flood_wait_error(e)
                logger.error("FloodWaitError for client %s: %d seconds", session_name, e.seconds)
                await self._broadcast_status_change(session_name, managed)
                return managed

            except ConnectionError as e:
                managed.status = ClientStatus.ERROR
                managed.error_msg = f"Connection error: {str(e)}"
                logger.error("ConnectionError for client %s: %s", session_name, e)
                await self._broadcast_status_change(session_name, managed)
                return managed

            except RPCError as e:
                managed.status = ClientStatus.ERROR
                managed.error_msg = humanize_rpc_error(e)
                logger.error("RPCError for client %s: %s", session_name, e)
                await self._broadcast_status_change(session_name, managed)
                return managed

            except Exception as e:
                managed.status = ClientStatus.ERROR
                managed.error_msg = f"Unexpected error: {str(e)}"
                logger.exception("Unexpected error connecting client %s", session_name)
                await self._broadcast_status_change(session_name, managed)
                return managed

    async def disconnect(self, session_name: str) -> bool:
        """Safely disconnect a client."""
        if session_name not in self.clients:
            logger.warning("Cannot disconnect unknown session: %s", session_name)
            return False

        managed = self.clients[session_name]

        async with managed.lock:
            if managed.client:
                try:
                    await managed.client.disconnect()
                    logger.info("Client %s disconnected", session_name)
                except Exception as e:
                    logger.error("Error disconnecting client %s: %s", session_name, e)

            managed.status = ClientStatus.DISCONNECTED
            managed.error_msg = ""
            managed.avatar_url = None
            managed.client = None
            await self._broadcast_status_change(session_name, managed)
            return True

    async def disconnect_all(self) -> None:
        """Disconnect all clients. Used during shutdown."""
        logger.info("Disconnecting all clients...")
        tasks = []
        for session_name in list(self.clients.keys()):
            tasks.append(self.disconnect(session_name))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        logger.info("All clients disconnected")

    def get_client(self, session_name: str) -> Optional[TelegramClient]:
        """Get an active TelegramClient by session name."""
        managed = self.clients.get(session_name)
        if managed and managed.status == ClientStatus.CONNECTED and managed.client:
            return managed.client
        return None

    def get_status(self, session_name: str) -> dict:
        """Return the status of a specific client."""
        managed = self.clients.get(session_name)
        if not managed:
            return {
                "session_name": session_name,
                "phone": "",
                "name": "",
                "status": ClientStatus.DISCONNECTED.value,
                "error_msg": "Session not found",
                "avatar_url": None,
            }
        return {
            "session_name": managed.session_name,
            "phone": managed.phone,
            "name": managed.name,
            "status": managed.status.value,
            "error_msg": managed.error_msg,
            "avatar_url": managed.avatar_url,
        }

    def get_all_statuses(self) -> dict[str, dict]:
        """Return statuses of all managed clients."""
        self.scan_sessions()
        return {name: self.get_status(name) for name in self.clients}

    async def reconnect(self, session_name: str) -> ManagedClient:
        """Disconnect and reconnect a client."""
        logger.info("Reconnecting client %s", session_name)
        managed = self.clients.get(session_name)
        if managed:
            managed.status = ClientStatus.RECONNECTING
            await self._broadcast_status_change(session_name, managed)

        await self.disconnect(session_name)
        return await self.connect(session_name)

    def _register_event_handlers(self, client: TelegramClient, session_name: str) -> None:
        """Register Telethon event handlers for incoming messages."""

        @client.on(events.NewMessage)
        async def on_new_message(event):
            """Handle incoming new messages."""
            try:
                sender = await event.get_sender()
                message_data = format_message(
                    event.message,
                    session_name=session_name,
                    sender=sender,
                )
                logger.info(
                    "Telethon new message for %s: id=%s outgoing=%s chat_id=%s sender_id=%s preview=%s",
                    session_name,
                    message_data.get("id"),
                    message_data.get("is_outgoing"),
                    message_data.get("chat_id"),
                    message_data.get("sender_id"),
                    (message_data.get("preview_text") or "")[:120],
                )

                if self._ws_manager:
                    await self._ws_manager.broadcast(
                        session_name,
                        {
                            "event_type": "new_message",
                            "session_name": session_name,
                            "data": message_data,
                        },
                    )
            except Exception as e:
                logger.error("Error in new message handler for %s: %s", session_name, e)

        @client.on(events.UserUpdate)
        async def on_user_update(event):
            """Handle user typing and status updates."""
            try:
                if event.typing:
                    logger.info("Typing event for %s from user %s", session_name, event.user_id)
                    if self._ws_manager:
                        await self._ws_manager.broadcast(
                            session_name,
                            {
                                "event_type": "typing",
                                "session_name": session_name,
                                "data": {
                                    "user_id": event.user_id,
                                    "entity_id": event.user_id,
                                    "typing": True,
                                },
                            },
                        )

                status = getattr(event, "status", None)
                if status is not None and getattr(event, "user_id", None):
                    status_text = get_user_status_string(status)
                    logger.info(
                        "Presence update for %s from user %s: %s",
                        session_name,
                        event.user_id,
                        status_text,
                    )
                    if self._ws_manager:
                        await self._ws_manager.broadcast(
                            session_name,
                            {
                                "event_type": "user_presence",
                                "session_name": session_name,
                                "data": {
                                    "user_id": event.user_id,
                                    "entity_id": event.user_id,
                                    "status": status_text,
                                    "is_online": status_text == "online",
                                },
                            },
                        )
            except Exception as e:
                logger.error("Error in user update handler for %s: %s", session_name, e)

        @client.on(events.MessageRead)
        async def on_message_read(event):
            """Handle outgoing message read receipts."""
            try:
                if not getattr(event, "outbox", False):
                    return

                chat_id = self._extract_read_event_chat_id(event)
                max_id = int(getattr(event, "max_id", 0) or 0)
                if not chat_id or not max_id:
                    return

                logger.info(
                    "Outgoing messages read for %s: chat_id=%s max_id=%s",
                    session_name,
                    chat_id,
                    max_id,
                )

                if self._ws_manager:
                    await self._ws_manager.broadcast(
                        session_name,
                        {
                            "event_type": "messages_read",
                            "session_name": session_name,
                            "data": {
                                "chat_id": chat_id,
                                "max_id": max_id,
                                "message_ids": list(getattr(event, "message_ids", []) or []),
                            },
                        },
                    )
            except Exception as e:
                logger.error("Error in message read handler for %s: %s", session_name, e)

    def _extract_read_event_chat_id(self, event) -> Optional[int]:
        """Extract a dialog identifier from a Telethon MessageRead event."""
        direct_chat_id = getattr(event, "chat_id", None)
        if direct_chat_id is not None:
            return int(direct_chat_id)

        direct_user_id = getattr(event, "user_id", None)
        if direct_user_id is not None:
            return int(direct_user_id)

        peer = getattr(event, "peer", None)
        if peer is None:
            return None

        for attr in ("user_id", "chat_id", "channel_id"):
            value = getattr(peer, attr, None)
            if value is not None:
                return int(value)

        return None

    async def _broadcast_status_change(self, session_name: str, managed: ManagedClient) -> None:
        """Broadcast status change via WebSocket."""
        logger.info(
            "Broadcasting status change for %s: status=%s phone=%s name=%s error=%s",
            session_name,
            managed.status.value,
            managed.phone,
            managed.name,
            managed.error_msg,
        )
        if self._ws_manager:
            try:
                await self._ws_manager.broadcast(
                    session_name,
                    {
                        "event_type": "status_change",
                        "session_name": session_name,
                        "data": {
                            "status": managed.status.value,
                            "phone": managed.phone,
                            "name": managed.name,
                            "error_msg": managed.error_msg,
                        },
                    },
                )
            except Exception as e:
                logger.error("Error broadcasting status change: %s", e)
