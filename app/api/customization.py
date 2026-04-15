"""Interface customization API routes."""

from __future__ import annotations

import json
import logging
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from app.models.schemas import CustomizationSettingsRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/customization", tags=["customization"])

APP_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = APP_DIR.parent
STATIC_DIR = APP_DIR / "static"
CUSTOMIZATION_MEDIA_DIR = STATIC_DIR / "customization"
CUSTOMIZATION_SETTINGS_FILE = PROJECT_ROOT / "ui_customization.json"
BACKGROUND_BASENAME = "ui_background"
ALLOWED_THEMES = {"dark", "light"}
ALLOWED_BACKGROUND_SUFFIXES = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".mp4": "video",
}
ALLOWED_BACKGROUND_CONTENT_TYPES = {
    "image/png": "image",
    "image/jpeg": "image",
    "video/mp4": "video",
}
MAX_BACKGROUND_FILE_SIZE = 80 * 1024 * 1024
DEFAULT_BACKGROUND_WIDTH = 1920
DEFAULT_BACKGROUND_HEIGHT = 1080
MAX_BACKGROUND_WIDTH = 2560
MAX_BACKGROUND_HEIGHT = 2560
MAX_BACKGROUND_PIXEL_RATIO = 2.0


def _default_settings() -> dict[str, Any]:
    """Return default UI customization settings."""
    return {
        "theme": "dark",
        "background_path": None,
        "background_type": None,
        "background_name": None,
        "background_url": None,
        "background_muted": False,
        "background_width": None,
        "background_height": None,
    }


def _ensure_customization_dirs() -> None:
    """Ensure persistent customization directories exist."""
    CUSTOMIZATION_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    CUSTOMIZATION_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)


def _load_settings() -> dict[str, Any]:
    """Load persisted customization settings from disk."""
    _ensure_customization_dirs()

    if not CUSTOMIZATION_SETTINGS_FILE.exists():
        return _default_settings()

    try:
        data = json.loads(CUSTOMIZATION_SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning(
            "Could not parse customization settings file at %s. Falling back to defaults.",
            CUSTOMIZATION_SETTINGS_FILE,
            exc_info=True,
        )
        return _default_settings()

    merged = _default_settings()
    merged.update(data if isinstance(data, dict) else {})
    return _sanitize_settings(merged)


def _save_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Persist customization settings and return the sanitized payload."""
    sanitized = _sanitize_settings(settings)
    stored_payload = {
        "theme": sanitized["theme"],
        "background_path": sanitized["background_path"],
        "background_type": sanitized["background_type"],
        "background_name": sanitized["background_name"],
        "background_width": sanitized["background_width"],
        "background_height": sanitized["background_height"],
    }

    _ensure_customization_dirs()
    CUSTOMIZATION_SETTINGS_FILE.write_text(
        json.dumps(stored_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return sanitized


def _sanitize_settings(settings: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize customization settings and resolve media URLs."""
    safe = _default_settings()
    if isinstance(settings, dict):
        safe.update(settings)

    theme = str(safe.get("theme") or "dark").lower()
    safe["theme"] = theme if theme in ALLOWED_THEMES else "dark"

    background_path_value = safe.get("background_path")
    if background_path_value:
        background_path = CUSTOMIZATION_MEDIA_DIR / Path(str(background_path_value)).name
        if background_path.exists():
            safe["background_path"] = background_path.name
            safe["background_type"] = safe.get("background_type") or ALLOWED_BACKGROUND_SUFFIXES.get(
                background_path.suffix.lower()
            )
            safe["background_name"] = safe.get("background_name") or background_path.name
            safe["background_url"] = _build_background_url(background_path)
            safe["background_muted"] = safe["background_type"] == "video"
            safe["background_width"] = _coerce_dimension(safe.get("background_width"))
            safe["background_height"] = _coerce_dimension(safe.get("background_height"))
            return safe

    safe["background_path"] = None
    safe["background_type"] = None
    safe["background_name"] = None
    safe["background_url"] = None
    safe["background_muted"] = False
    safe["background_width"] = None
    safe["background_height"] = None
    return safe


def _build_background_url(path: Path) -> str:
    """Build a cache-busting static URL for the saved background asset."""
    version = path.stat().st_mtime_ns
    return f"/static/customization/{path.name}?v={version}"


def _remove_existing_backgrounds() -> None:
    """Delete any previously saved background assets."""
    _ensure_customization_dirs()
    for item in CUSTOMIZATION_MEDIA_DIR.glob(f"{BACKGROUND_BASENAME}.*"):
        if item.is_file():
            item.unlink(missing_ok=True)


def _detect_background_type(file: UploadFile) -> tuple[str, str]:
    """Validate a background upload and return its media kind and safe suffix."""
    file_name = file.filename or ""
    suffix = Path(file_name).suffix.lower()
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()

    type_from_suffix = ALLOWED_BACKGROUND_SUFFIXES.get(suffix)
    type_from_content = ALLOWED_BACKGROUND_CONTENT_TYPES.get(content_type)
    background_type = type_from_content or type_from_suffix

    if not background_type or suffix not in ALLOWED_BACKGROUND_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail="Background must be a PNG, JPG, or MP4 file.",
        )

    if type_from_content and type_from_suffix and type_from_content != type_from_suffix:
        raise HTTPException(
            status_code=400,
            detail="The selected file type does not match its extension.",
        )

    return background_type, suffix


def _coerce_dimension(value: Any) -> int | None:
    """Return a safe positive integer dimension when possible."""
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _build_target_dimensions(
    viewport_width: int | None,
    viewport_height: int | None,
    device_pixel_ratio: float | None,
) -> tuple[int, int]:
    """Choose a background size based on the current browser viewport."""
    width = _coerce_dimension(viewport_width) or DEFAULT_BACKGROUND_WIDTH
    height = _coerce_dimension(viewport_height) or DEFAULT_BACKGROUND_HEIGHT

    try:
        pixel_ratio = float(device_pixel_ratio or 1)
    except (TypeError, ValueError):
        pixel_ratio = 1

    pixel_ratio = max(1.0, min(pixel_ratio, MAX_BACKGROUND_PIXEL_RATIO))

    target_width = max(320, min(int(round(width * pixel_ratio)), MAX_BACKGROUND_WIDTH))
    target_height = max(320, min(int(round(height * pixel_ratio)), MAX_BACKGROUND_HEIGHT))
    return target_width, target_height


def _optimize_background_image(
    content: bytes,
    suffix: str,
    target_width: int,
    target_height: int,
) -> tuple[bytes, str]:
    """Resize and compress an uploaded background image to the viewport target size."""
    try:
        with Image.open(BytesIO(content)) as source_image:
            image = ImageOps.exif_transpose(source_image)
            source_width, source_height = image.size
            fit_width = min(target_width, source_width) if source_width else target_width
            fit_height = min(target_height, source_height) if source_height else target_height
            fit_width = max(1, fit_width)
            fit_height = max(1, fit_height)

            if image.size != (fit_width, fit_height):
                resampling = getattr(Image, "Resampling", Image).LANCZOS
                image = ImageOps.fit(
                    image,
                    (fit_width, fit_height),
                    method=resampling,
                    centering=(0.5, 0.5),
                )
            else:
                image = image.copy()

            output = BytesIO()
            normalized_suffix = ".jpg" if suffix == ".jpeg" else suffix

            if normalized_suffix in {".jpg", ".jpeg"}:
                if image.mode not in ("RGB", "L"):
                    image = image.convert("RGB")
                image.save(output, format="JPEG", quality=86, optimize=True, progressive=True)
                return output.getvalue(), ".jpg"

            if normalized_suffix == ".png":
                if image.mode not in ("RGBA", "RGB", "L", "LA", "P"):
                    image = image.convert("RGBA")
                image.save(output, format="PNG", optimize=True, compress_level=9)
                return output.getvalue(), ".png"

            return content, suffix
    except UnidentifiedImageError as exc:
        raise HTTPException(status_code=400, detail="Could not read the selected image file.") from exc


@router.get("")
async def get_customization_settings() -> dict[str, Any]:
    """Return saved interface customization settings."""
    settings = _load_settings()
    logger.info(
        "Loaded interface customization settings: theme=%s background=%s",
        settings["theme"],
        settings["background_path"] or "none",
    )
    return settings


@router.put("")
async def update_customization_settings(
    request: CustomizationSettingsRequest,
) -> dict[str, Any]:
    """Persist theme selection for the interface."""
    settings = _load_settings()
    settings["theme"] = request.theme
    saved = _save_settings(settings)
    logger.info("Updated interface theme to %s", saved["theme"])
    return {
        "success": True,
        "message": f"Interface theme changed to {saved['theme']}.",
        "settings": saved,
    }


@router.post("/background")
async def upload_background(
    file: UploadFile = File(...),
    viewport_width: int | None = Form(default=None),
    viewport_height: int | None = Form(default=None),
    device_pixel_ratio: float | None = Form(default=None),
) -> dict[str, Any]:
    """Upload or replace the global interface background media."""
    background_type, suffix = _detect_background_type(file)
    _ensure_customization_dirs()
    target_width, target_height = _build_target_dimensions(
        viewport_width,
        viewport_height,
        device_pixel_ratio,
    )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Background file is empty.")

    if len(content) > MAX_BACKGROUND_FILE_SIZE:
        raise HTTPException(status_code=400, detail="Background file must be 80MB or smaller.")

    original_size = len(content)
    if background_type == "image":
        content, suffix = _optimize_background_image(
            content,
            suffix,
            target_width,
            target_height,
        )

    target_path = CUSTOMIZATION_MEDIA_DIR / f"{BACKGROUND_BASENAME}{suffix}"
    _remove_existing_backgrounds()
    target_path.write_bytes(content)

    settings = _load_settings()
    settings["background_path"] = target_path.name
    settings["background_type"] = background_type
    settings["background_name"] = file.filename or target_path.name
    settings["background_width"] = target_width
    settings["background_height"] = target_height
    saved = _save_settings(settings)

    logger.info(
        "Uploaded interface background: type=%s file=%s size=%d optimized_size=%d target=%sx%s",
        background_type,
        target_path.name,
        original_size,
        len(content),
        target_width,
        target_height,
    )
    return {
        "success": True,
        "message": (
            "Video background uploaded. It will be fitted to the browser interface and play muted."
            if background_type == "video"
            else "Background image uploaded and optimized for the current browser size."
        ),
        "settings": saved,
    }


@router.delete("/background")
async def delete_background() -> dict[str, Any]:
    """Remove the saved global interface background."""
    settings = _load_settings()
    had_background = bool(settings.get("background_path"))
    _remove_existing_backgrounds()
    settings["background_path"] = None
    settings["background_type"] = None
    settings["background_name"] = None
    settings["background_width"] = None
    settings["background_height"] = None
    saved = _save_settings(settings)

    logger.info("Removed interface background: had_background=%s", had_background)
    return {
        "success": True,
        "message": "Background removed." if had_background else "Background was already empty.",
        "settings": saved,
    }
