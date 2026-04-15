/**
 * Main Application Controller
 * Manages global state, routing, API calls, and component coordination
 */
class App {
    constructor() {
        this.state = {
            currentAccount: null,
            currentChat: null,
            currentChatTitle: null,
            accounts: {},
            dialogs: [],
            contacts: [],
            sidebarView: 'dialogs',
            messages: [],
            customization: null,
            currentChatStatus: '',
            currentChatIsOnline: false,
            ghostModeEnabled: this._loadGhostModePreference()
        };

        this.accountManager = null;
        this.chatManager = null;
        this.profileManager = null;
        this.customizationManager = null;
    }

    /**
     * Initialize the application - called on DOMContentLoaded
     */
    async init() {
        console.log('[App] Initializing...');

        // Initialize component managers
        this.accountManager = new AccountManager(this);
        this.chatManager = new ChatManager(this);
        this.profileManager = new ProfileManager(this);
        this.customizationManager = new CustomizationManager(this);

        // Connect global WebSocket
        window.wsManager.connect(null);
        window.wsManager.onMessage((data) => this.handleWSMessage(data));

        await this.customizationManager.loadSettings();
        this.setSidebarView(this.state.sidebarView);

        // Load accounts
        this.accountManager.loadAccounts();

        // Wire up global UI events
        this._bindGlobalEvents();
        this.updateGhostModeButton();

        console.log('[App] Initialized');
    }

    /**
     * Bind global UI event listeners
     */
    _bindGlobalEvents() {
        // Profile button
        const btnProfile = document.getElementById('btn-profile');
        if (btnProfile) {
            btnProfile.addEventListener('click', () => {
                if (this.state.currentAccount) {
                    this.profileManager.showProfileModal();
                } else {
                    this.showToast('Select an account first', 'warning');
                }
            });
        }

        // Refresh accounts
        const btnRefresh = document.getElementById('btn-refresh-accounts');
        if (btnRefresh) {
            btnRefresh.addEventListener('click', () => {
                this.accountManager.loadAccounts();
            });
        }

        // New dialog button
        const btnNewDialog = document.getElementById('btn-new-dialog');
        if (btnNewDialog) {
            btnNewDialog.addEventListener('click', () => {
                if (this.state.currentAccount) {
                    this.chatManager.openNewDialog();
                } else {
                    this.showToast('Select an account first', 'warning');
                }
            });
        }

        const btnSidebarDialogs = document.getElementById('btn-sidebar-dialogs');
        if (btnSidebarDialogs) {
            btnSidebarDialogs.addEventListener('click', () => {
                this.setSidebarView('dialogs');
            });
        }

        const btnSidebarContacts = document.getElementById('btn-sidebar-contacts');
        if (btnSidebarContacts) {
            btnSidebarContacts.addEventListener('click', () => {
                this.setSidebarView('contacts');
            });
        }

        const btnDeleteChat = document.getElementById('btn-delete-chat');
        if (btnDeleteChat) {
            btnDeleteChat.addEventListener('click', () => {
                this.chatManager.deleteCurrentChat();
            });
        }

        const btnGhostMode = document.getElementById('btn-ghost-mode');
        if (btnGhostMode) {
            btnGhostMode.addEventListener('click', () => {
                this.setGhostMode(!this.state.ghostModeEnabled);
            });
        }

        // Send button
        const btnSend = document.getElementById('btn-send');
        if (btnSend) {
            btnSend.addEventListener('click', () => {
                this.chatManager.sendMessage();
            });
        }

        // Message input - Enter to send, Shift+Enter for newline, auto-grow
        const msgInput = document.getElementById('message-input');
        if (msgInput) {
            msgInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.chatManager.sendMessage();
                }
            });

            msgInput.addEventListener('input', () => {
                msgInput.style.height = 'auto';
                msgInput.style.height = Math.min(msgInput.scrollHeight, 150) + 'px';
            });
        }

        // Modal close buttons (backdrop clicks + close buttons)
        document.querySelectorAll('.modal').forEach(modal => {
            const backdrop = modal.querySelector('.modal-backdrop');
            if (backdrop) {
                backdrop.addEventListener('click', () => this.hideModal(modal.id));
            }
            modal.querySelectorAll('.modal-close, .modal-close-btn').forEach(btn => {
                btn.addEventListener('click', () => this.hideModal(modal.id));
            });
        });

        // Escape to close modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal:not(.hidden)').forEach(modal => {
                    this.hideModal(modal.id);
                });
            }
        });

        // Messages area scroll for loading older messages
        const messagesArea = document.getElementById('messages-area');
        if (messagesArea) {
            messagesArea.addEventListener('scroll', () => {
                this.chatManager.handleScroll();
            });
        }
    }

    /**
     * Select an account and load its dialogs
     * @param {string} sessionName
     */
    selectAccount(sessionName) {
        if (this.state.currentAccount === sessionName) return;

        this.state.currentAccount = sessionName;
        this.state.currentChat = null;
        this.state.currentChatTitle = null;
        this.state.dialogs = [];
        this.state.contacts = [];
        this.state.messages = [];

        // Update account list UI
        document.querySelectorAll('.account-item').forEach(el => {
            el.classList.toggle('active', el.dataset.session === sessionName);
        });

        if (this.accountManager) {
            this.accountManager.handleAccountSelected(sessionName);
        }

        // Reset chat area
        this._resetChatArea();

        // Load dialogs for selected account
        this.chatManager.loadDialogs(sessionName);
        this.chatManager.loadContacts(sessionName);

        console.log('[App] Selected account:', sessionName);
    }

    /**
     * Select a chat and load its history
     * @param {string|number} entityId
     * @param {string} title
     */
    selectChat(entityId, title) {
        this.state.currentChat = entityId;
        this.state.currentChatTitle = title;
        this.state.messages = [];
        this.state.currentChatStatus = '';
        this.state.currentChatIsOnline = false;

        // Update dialog list UI
        document.querySelectorAll('.dialog-item').forEach(el => {
            el.classList.toggle('active', el.dataset.entityId == entityId);
        });
        document.querySelectorAll('.contact-item').forEach(el => {
            el.classList.toggle('active', el.dataset.entityId == entityId);
        });

        // Show chat area
        const chatHeader = document.getElementById('chat-header');
        const inputBar = document.getElementById('input-bar');
        const messagesEmpty = document.getElementById('messages-empty');
        const messagesContainer = document.getElementById('messages-container');

        chatHeader.classList.remove('hidden');
        inputBar.classList.remove('hidden');
        messagesEmpty.classList.add('hidden');
        messagesContainer.classList.remove('hidden');

        this.chatManager.renderChatHeader(entityId, title);
        this.chatManager.updateDeleteChatButton();
        if (this.profileManager) {
            this.profileManager.updateChatProfileButton();
        }

        // Clear messages and load history
        messagesContainer.innerHTML = '';
        const sessionName = this.state.currentAccount;
        this.chatManager.loadHistory(sessionName, entityId).then((loaded) => {
            if (loaded) {
                this.chatManager.markChatReadIfNeeded(sessionName, entityId, 'chat_open');
            }
        });
        this.chatManager.loadCurrentChatPresence();

        // Focus input
        const msgInput = document.getElementById('message-input');
        if (msgInput) msgInput.focus();

        console.log('[App] Selected chat:', entityId, title);
    }

    /**
     * Reset the chat area to empty state
     */
    _resetChatArea() {
        document.getElementById('chat-header').classList.add('hidden');
        document.getElementById('input-bar').classList.add('hidden');
        document.getElementById('messages-empty').classList.remove('hidden');
        document.getElementById('messages-container').classList.add('hidden');
        document.getElementById('messages-container').innerHTML = '';
        document.getElementById('messages-empty').innerHTML = this.emptyStateHtml({
            icon: 'MSG',
            title: 'Select a chat',
            text: 'Open a dialog to start messaging.'
        });
        if (this.chatManager) {
            this.chatManager.updateDeleteChatButton();
        }
        if (this.profileManager) {
            this.profileManager.updateChatProfileButton();
        }
    }

    /**
     * Switch the left sidebar between chats and contacts.
     * @param {string} view
     */
    setSidebarView(view) {
        const nextView = view === 'contacts' ? 'contacts' : 'dialogs';
        this.state.sidebarView = nextView;

        const isDialogsView = nextView === 'dialogs';
        const btnDialogs = document.getElementById('btn-sidebar-dialogs');
        const btnContacts = document.getElementById('btn-sidebar-contacts');
        const dialogList = document.getElementById('dialog-list');
        const contactList = document.getElementById('contact-list');
        const contactToolbar = document.getElementById('contact-toolbar');
        const btnNewDialog = document.getElementById('btn-new-dialog');

        if (btnDialogs) {
            btnDialogs.classList.toggle('active', isDialogsView);
            btnDialogs.setAttribute('aria-selected', String(isDialogsView));
        }

        if (btnContacts) {
            btnContacts.classList.toggle('active', !isDialogsView);
            btnContacts.setAttribute('aria-selected', String(!isDialogsView));
        }

        if (dialogList) {
            dialogList.classList.toggle('hidden', !isDialogsView);
        }

        if (contactList) {
            contactList.classList.toggle('hidden', isDialogsView);
        }

        if (btnNewDialog) {
            btnNewDialog.classList.toggle('hidden', !isDialogsView);
        }

        if (contactToolbar) {
            contactToolbar.classList.toggle('hidden', isDialogsView);
        }
    }

    /**
     * Show a toast notification
     * @param {string} message
     * @param {string} type - 'info', 'success', 'error', 'warning'
     * @param {number} duration - ms before auto-dismiss
     */
    showToast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        const dismiss = () => {
            toast.classList.add('toast-out');
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        };

        toast.addEventListener('click', dismiss);

        if (duration > 0) {
            setTimeout(dismiss, duration);
        }
    }

    /**
     * Enable or disable Ghost-mode.
     * When Ghost-mode is enabled, opening chats does not mark messages as read in Telegram.
     * @param {boolean} enabled
     */
    setGhostMode(enabled) {
        const nextValue = Boolean(enabled);
        this.state.ghostModeEnabled = nextValue;

        try {
            localStorage.setItem('telegramPanelGhostModeEnabled', nextValue ? '1' : '0');
        } catch (error) {
            console.warn('[App] Could not save Ghost-mode setting:', error);
        }

        this.updateGhostModeButton();

        if (nextValue) {
            this.showToast('Ghost-mode enabled: messages stay unread in Telegram', 'info', 3500);
            return;
        }

        this.showToast('Ghost-mode disabled: opened chats will be marked as read', 'warning', 4500);
        if (this.chatManager) {
            this.chatManager.markCurrentChatReadIfNeeded('ghost_disabled');
        }
    }

    /**
     * Sync the Ghost-mode toggle UI with the current setting.
     */
    updateGhostModeButton() {
        const btnGhostMode = document.getElementById('btn-ghost-mode');
        if (!btnGhostMode) return;

        const enabled = Boolean(this.state.ghostModeEnabled);
        const label = btnGhostMode.querySelector('.ghost-mode-label');

        btnGhostMode.classList.toggle('active', enabled);
        btnGhostMode.setAttribute('aria-pressed', String(enabled));
        btnGhostMode.title = enabled
            ? 'Ghost-mode is on: messages will stay unread in Telegram'
            : 'Ghost-mode is off: opened chats will be marked as read';

        if (label) {
            label.textContent = enabled ? 'Ghost' : 'Read';
        }
    }

    /**
     * Load persisted Ghost-mode setting. Default is ON to preserve old behavior.
     * @returns {boolean}
     */
    _loadGhostModePreference() {
        try {
            const stored = localStorage.getItem('telegramPanelGhostModeEnabled');
            if (stored === null) {
                return true;
            }
            return stored !== '0';
        } catch {
            return true;
        }
    }

    /**
     * Show a modal
     * @param {string} modalId
     */
    showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('hidden');
        }
    }

    /**
     * Hide a modal
     * @param {string} modalId
     */
    hideModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('hidden');
        }

        if (modalId === 'modal-add-contact' && this.chatManager) {
            this.chatManager.contactModalContext = null;
        }

        if (modalId === 'modal-customization' && this.customizationManager) {
            this.customizationManager.handleModalHidden();
        }
    }

    /**
     * Show loading spinner inside an element
     * @param {HTMLElement} element
     */
    showLoading(element) {
        if (!element) return;
        element.innerHTML = this.loadingStateHtml(element.id || '');
    }

    /**
     * Hide loading spinner (replace with empty state or nothing)
     * @param {HTMLElement} element
     * @param {string} emptyText - optional text to show if empty
     */
    hideLoading(element, emptyText = '') {
        if (!element) return;
        const spinner = element.querySelector('.loading-spinner');
        if (spinner) {
            if (emptyText) {
                spinner.outerHTML = this.emptyStateHtml({ title: emptyText });
            } else {
                spinner.remove();
            }
        }
    }

    /**
     * Build a consistent empty state block.
     * @param {object} options
     * @returns {string}
     */
    emptyStateHtml(options = {}) {
        const icon = options.icon || '-';
        const title = options.title || 'Nothing here yet';
        const text = options.text || '';

        return `
            <div class="empty-state empty-state-card">
                <div class="empty-icon">${this._escapeHtml(icon)}</div>
                <div class="empty-title">${this._escapeHtml(title)}</div>
                ${text ? `<div class="empty-text">${this._escapeHtml(text)}</div>` : ''}
            </div>
        `;
    }

    /**
     * Build skeleton loading markup based on the target list.
     * @param {string} targetId
     * @returns {string}
     */
    loadingStateHtml(targetId = '') {
        if (targetId === 'account-list') {
            return this._listSkeletonHtml('account', 7);
        }

        if (targetId === 'dialog-list' || targetId === 'contact-list') {
            return this._listSkeletonHtml('dialog', 8);
        }

        return '<div class="loading-spinner"><div class="spinner"></div></div>';
    }

    /**
     * Build repeated list skeleton rows.
     * @param {string} type
     * @param {number} count
     * @returns {string}
     */
    _listSkeletonHtml(type, count) {
        const rows = Array.from({ length: count }, () => `
            <div class="skeleton-row skeleton-row-${type}">
                <div class="skeleton-avatar"></div>
                <div class="skeleton-lines">
                    <div class="skeleton-line skeleton-line-main"></div>
                    <div class="skeleton-line skeleton-line-sub"></div>
                </div>
            </div>
        `).join('');

        return `<div class="skeleton-list">${rows}</div>`;
    }

    /**
     * Escape HTML for generated UI strings.
     * @param {string} text
     * @returns {string}
     */
    _escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    /**
     * Handle incoming WebSocket message and route to correct handler
     * @param {object} data - parsed WS event
     */
    handleWSMessage(data) {
        if (!data || !data.event_type) return;

        switch (data.event_type) {
            case 'new_message':
                this.chatManager.onNewMessage(data);
                break;

            case 'status_change':
                if (data.session_name && data.data) {
                    this.accountManager.updateStatus(
                        data.session_name,
                        data.data.status,
                        data.data.error_msg || ''
                    );
                }
                break;

            case 'typing':
                if (this.chatManager && data.session_name && data.data) {
                    this.chatManager.onTyping(data);
                }
                break;

            case 'user_presence':
                if (this.chatManager && data.session_name && data.data) {
                    this.chatManager.onUserPresence(data);
                }
                break;

            case 'avatar_upload_progress':
                if (this.profileManager && data.session_name && data.data) {
                    this.profileManager.handleAvatarUploadProgress(data.session_name, data.data);
                }
                break;

            case 'messages_read':
                if (this.chatManager && data.session_name && data.data) {
                    this.chatManager.onMessagesRead(data);
                }
                break;

            case 'error':
                this.showToast(data.data?.message || 'An error occurred', 'error');
                break;

            default:
                console.log('[App] Unhandled WS event:', data.event_type, data);
        }
    }

    /**
     * API fetch wrapper with error handling
     * @param {string} method - HTTP method
     * @param {string} url - API endpoint
     * @param {object|FormData|null} body - request body
     * @returns {Promise<object|null>} parsed JSON response or null on error
     */
    async api(method, url, body = null) {
        const options = {
            method: method.toUpperCase(),
            headers: {}
        };

        if (body !== null && body !== undefined) {
            if (body instanceof FormData) {
                options.body = body;
                // Don't set Content-Type for FormData, browser sets it with boundary
            } else {
                options.headers['Content-Type'] = 'application/json';
                options.body = JSON.stringify(body);
            }
        }

        try {
            const response = await fetch(url, options);
            const contentType = response.headers.get('content-type') || '';

            let data = null;
            if (contentType.includes('application/json')) {
                data = await response.json();
            } else {
                const text = await response.text();
                data = { detail: text };
            }

            if (!response.ok) {
                const errorMsg = data?.detail || data?.message || `Error ${response.status}`;

                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After') || data?.retry_after || '';
                    const fallbackMsg = retryAfter
                        ? `Rate limited. Retry after ${retryAfter}s.`
                        : 'Rate limited.';
                    this.showToast(errorMsg || fallbackMsg, 'warning', 5000);
                } else if (response.status === 401) {
                    this.showToast(errorMsg, 'error');
                } else if (response.status === 503) {
                    this.showToast(errorMsg, 'error');
                } else {
                    this.showToast(errorMsg, 'error');
                }

                return null;
            }

            return data;
        } catch (e) {
            console.error('[App] API error:', method, url, e);
            this.showToast('Network error: ' + e.message, 'error');
            return null;
        }
    }

    /**
     * Simple string hash for avatar color assignment
     */
    _hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }
}

// Create global app instance and init on DOM ready
window.app = new App();
document.addEventListener('DOMContentLoaded', async () => {
    await window.app.init();
});
