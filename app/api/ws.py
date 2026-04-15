"""WebSocket manager and endpoints."""

import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


class WSManager:
    """WebSocket connection manager for real-time events."""

    def __init__(self) -> None:
        self.connections: dict[str, list[WebSocket]] = {
            "global": [],
        }

    async def connect(self, ws: WebSocket, session_name: str | None = None) -> None:
        """Accept and register a WebSocket connection."""
        await ws.accept()
        key = session_name or "global"
        if key not in self.connections:
            self.connections[key] = []
        self.connections[key].append(ws)
        logger.info("WebSocket connected: %s (total: %d)", key, len(self.connections[key]))

    async def disconnect(self, ws: WebSocket) -> None:
        """Remove a WebSocket from all subscription lists."""
        for key in list(self.connections.keys()):
            if ws in self.connections[key]:
                self.connections[key].remove(ws)
                logger.info("WebSocket disconnected from: %s", key)
            if key != "global" and not self.connections[key]:
                del self.connections[key]

    async def _send_safe(self, ws: WebSocket, data: dict[str, Any]) -> bool:
        """Send data to a WebSocket, returning False if it fails."""
        try:
            await ws.send_text(json.dumps(data, default=str))
            return True
        except Exception as e:
            logger.debug("Failed to send to WebSocket: %s", e)
            return False

    async def broadcast(self, session_name: str, event: dict[str, Any]) -> None:
        """Broadcast an event to session-specific subscribers and global subscribers."""
        event_type = event.get("event_type", "unknown")
        session_count = len(self.connections.get(session_name, []))
        global_count = len(self.connections.get("global", []))
        logger.info(
            "Broadcasting event %s for %s to %d session subscriber(s) and %d global subscriber(s)",
            event_type,
            session_name,
            session_count,
            global_count,
        )
        # Send to session subscribers
        if session_name in self.connections:
            dead = []
            for ws in self.connections[session_name]:
                if not await self._send_safe(ws, event):
                    dead.append(ws)
            for ws in dead:
                self.connections[session_name].remove(ws)

        # Send to global subscribers
        dead = []
        for ws in self.connections.get("global", []):
            if not await self._send_safe(ws, event):
                dead.append(ws)
        for ws in dead:
            self.connections["global"].remove(ws)

    async def broadcast_global(self, event: dict[str, Any]) -> None:
        """Broadcast an event only to global subscribers."""
        event_type = event.get("event_type", "unknown")
        global_count = len(self.connections.get("global", []))
        logger.info(
            "Broadcasting global event %s to %d subscriber(s)",
            event_type,
            global_count,
        )
        dead = []
        for ws in self.connections.get("global", []):
            if not await self._send_safe(ws, event):
                dead.append(ws)
        for ws in dead:
            self.connections["global"].remove(ws)


# Singleton instance
ws_manager = WSManager()


@router.websocket("/ws")
async def websocket_global(ws: WebSocket) -> None:
    """Global WebSocket endpoint for all events."""
    await ws_manager.connect(ws, session_name=None)
    try:
        while True:
            data = await ws.receive_text()
            logger.info("Global WebSocket received payload: %s", data[:200])
            # Client can send ping/pong or subscribe messages
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
                    logger.info("Global WebSocket pong sent")
            except json.JSONDecodeError:
                logger.warning("Global WebSocket received non-JSON payload")
                pass
    except WebSocketDisconnect:
        await ws_manager.disconnect(ws)
        logger.info("Global WebSocket client disconnected")
    except Exception as e:
        logger.error("Global WebSocket error: %s", e)
        await ws_manager.disconnect(ws)


@router.websocket("/ws/{session_name}")
async def websocket_session(ws: WebSocket, session_name: str) -> None:
    """Session-specific WebSocket endpoint."""
    await ws_manager.connect(ws, session_name=session_name)
    try:
        while True:
            data = await ws.receive_text()
            logger.info("Session WebSocket received payload for %s: %s", session_name, data[:200])
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
                    logger.info("Session WebSocket pong sent for %s", session_name)
            except json.JSONDecodeError:
                logger.warning("Session WebSocket received non-JSON payload for %s", session_name)
                pass
    except WebSocketDisconnect:
        await ws_manager.disconnect(ws)
        logger.info("Session WebSocket client disconnected: %s", session_name)
    except Exception as e:
        logger.error("Session WebSocket error for %s: %s", session_name, e)
        await ws_manager.disconnect(ws)
