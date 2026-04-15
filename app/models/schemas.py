"""Pydantic models for request/response schemas."""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class AccountStatus(BaseModel):
    """Status information for a Telegram account session."""

    session_name: str
    phone: str = ""
    name: str = ""
    status: str = "disconnected"
    error_msg: str = ""
    avatar_url: Optional[str] = None


class MessageSchema(BaseModel):
    """Schema for a Telegram message."""

    id: int
    text: str = ""
    date: str = ""
    chat_id: Optional[int] = None
    sender_id: Optional[int] = None
    sender_name: str = ""
    is_outgoing: bool = False
    is_read: bool = False
    media_type: Optional[str] = None
    media_kind: Optional[str] = None
    media_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    file_name: Optional[str] = None
    mime_type: Optional[str] = None
    file_size: Optional[int] = None
    duration: Optional[float] = None
    contact: Optional[dict[str, Any]] = None
    preview_text: Optional[str] = None


class SendMessageRequest(BaseModel):
    """Request body for sending a message."""

    target: str = Field(..., description="Username, phone, or user ID of the recipient")
    text: str = Field(..., min_length=1, description="Message text to send")


class OpenDialogRequest(BaseModel):
    """Request body for opening a dialog with a user."""

    identifier: str = Field(..., description="Username, phone, or user ID to open dialog with")


class ContactNameRequest(BaseModel):
    """Optional contact name override when saving a user into contacts."""

    first_name: Optional[str] = Field(None, description="Custom first name for the contact")
    last_name: Optional[str] = Field(None, description="Custom last name for the contact")


class AddContactRequest(ContactNameRequest):
    """Request body for adding a contact by identifier."""

    identifier: str = Field(..., description="Username, phone, or user ID to add to contacts")


class ProfileUpdateRequest(BaseModel):
    """Request body for updating profile information."""

    first_name: Optional[str] = Field(None, description="New first name")
    last_name: Optional[str] = Field(None, description="New last name")
    username: Optional[str] = Field(None, description="New username (without @)")


class UserInfo(BaseModel):
    """User information schema."""

    id: int
    display_name: str = ""
    first_name: str = ""
    last_name: str = ""
    username: str = ""
    phone: str = ""
    photo_url: Optional[str] = None
    is_bot: bool = False
    status: str = "unknown"
    about: str = ""
    common_chats_count: Optional[int] = None
    is_contact: bool = False
    can_add_to_contacts: bool = False


PrivacyMode = Literal["everyone", "contacts", "nobody", "contacts_premium"]
ThemeMode = Literal["dark", "light"]


class PrivacySettingsRequest(BaseModel):
    """Request body for updating supported privacy settings."""

    status_timestamp: Optional[PrivacyMode] = None
    phone_number: Optional[PrivacyMode] = None
    profile_photo: Optional[PrivacyMode] = None
    forwards: Optional[PrivacyMode] = None
    chat_invite: Optional[PrivacyMode] = None
    phone_call: Optional[PrivacyMode] = None
    no_paid_messages: Optional[PrivacyMode] = None


class CustomizationSettingsRequest(BaseModel):
    """Request body for updating interface customization settings."""

    theme: ThemeMode = Field(..., description="Preferred interface theme")


class DialogSchema(BaseModel):
    """Schema for a Telegram dialog (chat)."""

    id: int
    name: str = ""
    username: str = ""
    is_group: bool = False
    is_channel: bool = False
    unread_count: int = 0
    last_message: Optional[str] = None
    last_message_date: Optional[str] = None
    last_message_sender: Optional[str] = None


class WSEvent(BaseModel):
    """WebSocket event schema."""

    event_type: str = Field(..., description="Type of event: new_message, status_change, typing, error")
    session_name: str = ""
    data: Any = None


class ErrorResponse(BaseModel):
    """Standard error response."""

    detail: str
    error_code: Optional[str] = None
