"""Helpers for translating Telegram RPC errors into human-readable messages."""

from __future__ import annotations

import re

from telethon.errors import FloodWaitError, RPCError

ERROR_MAP = {
    "AUTH_KEY_INVALID": "Ключ сессии Telegram поврежден или устарел.",
    "BAD_REQUEST": (
        "Telegram отклонил запрос. Обычно это значит, что получатель недоступен, "
        "данные запроса некорректны или это действие нельзя выполнить в этом чате."
    ),
    "CHANNEL_PRIVATE": "Канал или чат закрыт, и у аккаунта нет доступа к нему.",
    "CHAT_ADMIN_REQUIRED": "Для этого действия в чате нужны права администратора.",
    "CHAT_WRITE_FORBIDDEN": "В этот чат сейчас нельзя отправлять сообщения.",
    "FLOOD_WAIT": "Telegram временно ограничил количество запросов. Нужно немного подождать.",
    "INPUT_USER_DEACTIVATED": "Этот аккаунт деактивирован и недоступен для общения.",
    "MESSAGE_EMPTY": "Нельзя отправить пустое сообщение.",
    "MESSAGE_TOO_LONG": "Сообщение слишком длинное. Telegram принимает до 4096 символов.",
    "PEER_FLOOD": "Telegram временно ограничил отправку сообщений с этого аккаунта.",
    "PEER_ID_INVALID": "Не удалось определить получателя. Возможно, чат или пользователь недоступен.",
    "PHONE_NUMBER_INVALID": "Указан некорректный номер телефона.",
    "USER_BANNED_IN_CHANNEL": "Аккаунт заблокирован в этом канале или чате.",
    "USER_IS_BLOCKED": "Пользователь заблокировал этот аккаунт.",
    "USER_NOT_MUTUAL_CONTACT": (
        "Пользователю нельзя написать напрямую, пока контакт не является взаимным."
    ),
    "USER_PRIVACY_RESTRICTED": (
        "Настройки приватности пользователя не позволяют выполнить это действие."
    ),
    "USERNAME_INVALID": "Указано некорректное имя пользователя.",
    "USERNAME_NOT_OCCUPIED": "Такое имя пользователя сейчас никем не занято.",
}


def _camel_to_snake(value: str) -> str:
    """Convert a Telethon exception class name to uppercase snake case."""
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).upper()


def normalize_error_code(code: str) -> str:
    """Normalize a Telegram error code to a stable uppercase form."""
    if not code:
        return "UNKNOWN"

    normalized = code.strip().replace("-", "_").replace(" ", "_")
    normalized = normalized.replace("Error", "").replace("__", "_").upper()

    if normalized.startswith("FLOOD_WAIT"):
        return "FLOOD_WAIT"

    return normalized or "UNKNOWN"


def extract_rpc_error_code(exc: Exception) -> str:
    """Extract the most useful Telegram error code from an exception."""
    raw_message = getattr(exc, "message", "") or ""
    normalized_message = normalize_error_code(raw_message)
    if normalized_message != "UNKNOWN":
        return normalized_message

    class_name = exc.__class__.__name__.replace("Error", "")
    return normalize_error_code(_camel_to_snake(class_name))


def humanize_error(code: str, message: str = "") -> str:
    """Convert a Telegram error code to a human-readable message with the code."""
    clean_code = normalize_error_code(code)
    human_msg = ERROR_MAP.get(clean_code)

    if human_msg is None:
        if clean_code.endswith("_INVALID"):
            human_msg = "Telegram отклонил одно из значений в запросе как некорректное."
        elif clean_code.endswith("_FORBIDDEN") or clean_code.endswith("_RESTRICTED"):
            human_msg = "Telegram не разрешает выполнить это действие для текущего аккаунта."
        elif clean_code.endswith("_REQUIRED"):
            human_msg = "Для этого действия Telegram требует дополнительные права или условия."
        else:
            human_msg = "Telegram не смог выполнить запрос."

        raw_message = (message or "").strip()
        if raw_message and normalize_error_code(raw_message) not in {clean_code, "UNKNOWN"}:
            human_msg = f"{human_msg} Детали Telegram: {raw_message}."

    return f"{human_msg} (код: {clean_code})"


def humanize_rpc_error(exc: RPCError) -> str:
    """Translate a Telethon RPCError into a human-readable message."""
    raw_message = getattr(exc, "message", "") or str(exc)
    return humanize_error(extract_rpc_error_code(exc), raw_message)


def format_flood_wait_error(exc: FloodWaitError) -> str:
    """Return a consistent human-readable message for flood wait errors."""
    return (
        f"Telegram временно ограничил количество запросов. "
        f"Повторите попытку через {exc.seconds} сек. (код: FLOOD_WAIT)"
    )
