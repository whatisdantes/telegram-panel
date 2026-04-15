/**
 * WebSocket Manager - handles connections, reconnection, heartbeat, and message dispatching
 */
class WebSocketManager {
    constructor() {
        this.ws = null;
        this.sessionName = null;
        this.handlers = [];
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000;
        this.baseReconnectDelay = 1000;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.heartbeatInterval = 30000;
        this.isConnected = false;
        this.intentionalClose = false;
    }

    /**
     * Connect to WebSocket endpoint
     * @param {string|null} sessionName - session name for session-specific events, null for global
     */
    connect(sessionName = null) {
        this.sessionName = sessionName;
        this.intentionalClose = false;

        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const path = sessionName ? `/ws/${encodeURIComponent(sessionName)}` : '/ws';
        const url = `${protocol}//${host}${path}`;

        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            console.error('[WS] Failed to create WebSocket:', e);
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            console.log('[WS] Connected to', url);
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this._updateStatusUI(true);
            this._startHeartbeat();
        };

        this.ws.onmessage = (event) => {
            this._handleMessage(event);
        };

        this.ws.onclose = (event) => {
            console.log('[WS] Disconnected, code:', event.code, 'reason:', event.reason);
            this.isConnected = false;
            this._updateStatusUI(false);
            this._stopHeartbeat();

            if (!this.intentionalClose) {
                this._scheduleReconnect();
            }
        };

        this.ws.onerror = (error) => {
            console.error('[WS] Error:', error);
        };
    }

    /**
     * Intentionally disconnect
     */
    disconnect() {
        this.intentionalClose = true;
        this._stopHeartbeat();
        this._clearReconnect();

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.isConnected = false;
        this._updateStatusUI(false);
    }

    /**
     * Reconnect with exponential backoff
     */
    reconnect() {
        this.disconnect();
        this.intentionalClose = false;
        this.reconnectAttempts = 0;
        this.connect(this.sessionName);
    }

    /**
     * Schedule a reconnect attempt with exponential backoff
     */
    _scheduleReconnect() {
        this._clearReconnect();
        const delay = Math.min(
            this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
            this.maxReconnectDelay
        );
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
        this._updateStatusUI('reconnecting');

        this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect(this.sessionName);
        }, delay);
    }

    /**
     * Clear any pending reconnect timer
     */
    _clearReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /**
     * Send data through WebSocket
     * @param {object} data - data to send as JSON
     */
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        } else {
            console.warn('[WS] Cannot send - not connected');
        }
    }

    /**
     * Register a message handler
     * @param {function} callback - function to call with parsed message data
     */
    onMessage(callback) {
        if (typeof callback === 'function' && !this.handlers.includes(callback)) {
            this.handlers.push(callback);
        }
    }

    /**
     * Remove a message handler
     * @param {function} callback - handler to remove
     */
    offMessage(callback) {
        this.handlers = this.handlers.filter(h => h !== callback);
    }

    /**
     * Handle incoming WebSocket message
     * @param {MessageEvent} event
     */
    _handleMessage(event) {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            console.warn('[WS] Non-JSON message received:', event.data);
            return;
        }

        // Ignore pong responses
        if (data.type === 'pong') {
            return;
        }

        // Dispatch to all registered handlers
        for (const handler of this.handlers) {
            try {
                handler(data);
            } catch (e) {
                console.error('[WS] Handler error:', e);
            }
        }
    }

    /**
     * Start heartbeat ping
     */
    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.send({ type: 'ping' });
        }, this.heartbeatInterval);
    }

    /**
     * Stop heartbeat
     */
    _stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Update the WebSocket status indicator in the UI
     * @param {boolean|string} status - true=connected, false=disconnected, 'reconnecting'
     */
    _updateStatusUI(status) {
        const el = document.getElementById('ws-status');
        if (!el) return;

        el.classList.remove('connected', 'reconnecting');

        if (status === true) {
            el.classList.add('connected');
            el.title = 'WebSocket connected';
        } else if (status === 'reconnecting') {
            el.classList.add('reconnecting');
            el.title = 'WebSocket reconnecting...';
        } else {
            el.title = 'WebSocket disconnected';
        }
    }
}

// Global instance
window.wsManager = new WebSocketManager();
