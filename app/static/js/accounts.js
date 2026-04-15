/**
 * Account Manager - handles account listing, connecting, disconnecting, and status updates
 */
class AccountManager {
    constructor(app) {
        this.app = app;
        this.searchTerm = '';
        this.isBrowserOpen = true;
        this.hasManualBrowserPreference = false;

        this._bindControls();
    }

    /**
     * Bind account section controls
     */
    _bindControls() {
        const searchInput = document.getElementById('account-search');
        if (searchInput) {
            searchInput.addEventListener('input', (event) => {
                this.searchTerm = event.target.value.trim().toLowerCase();
                this.renderAccounts(this.getAccounts());
            });
        }
    }

    /**
     * Load all accounts from API and render
     */
    async loadAccounts() {
        const listEl = document.getElementById('account-list');
        this.app.showLoading(listEl);
        const previousOrder = this.getAccounts().map(account => account.session_name);

        const data = await this.app.api('GET', '/api/accounts/');
        if (!data) {
            if (listEl) {
                listEl.innerHTML = this.app.emptyStateHtml({
                    icon: '!',
                    title: 'Failed to load accounts',
                    text: 'Check logs and refresh the account list.'
                });
            }
            this._updateSummary([]);
            return;
        }

        const accounts = this._preserveAccountOrder(
            Array.isArray(data) ? data : [],
            previousOrder
        );
        this.app.state.accounts = {};
        accounts.forEach(acc => {
            this.app.state.accounts[acc.session_name] = acc;
        });

        this._clearMissingSelection(accounts);

        this._applyAutoBrowserState(accounts.length);
        this.renderAccounts(accounts);
    }

    /**
     * Render the account list into the sidebar
     * @param {Array} accounts
     */
    renderAccounts(accounts) {
        const listEl = document.getElementById('account-list');
        if (!listEl) return;

        const filteredAccounts = this._filterAccounts(this._sortAccounts(accounts || []));
        this._applyBrowserState();
        this._updateSummary(accounts || []);
        listEl.classList.toggle('account-list-compact', (accounts || []).length >= 8);

        if ((accounts || []).length === 0) {
            listEl.innerHTML = this.app.emptyStateHtml({
                icon: 'AC',
                title: 'No accounts found',
                text: 'Add .session files to accounts/ and refresh the panel.'
            });
            return;
        }

        listEl.innerHTML = '';
        filteredAccounts.forEach(account => {
            listEl.appendChild(this.renderAccountItem(account));
        });
    }

    /**
     * Render a single account list item
     * @param {object} account
     * @returns {HTMLElement}
     */
    renderAccountItem(account) {
        const item = document.createElement('div');
        item.className = 'account-item';
        item.dataset.session = account.session_name;

        if (this.searchTerm && !this._accountMatchesSearch(account)) {
            item.classList.add('search-dimmed');
        }

        if (this.app.state.currentAccount === account.session_name) {
            item.classList.add('active');
        }

        const status = account.status || 'disconnected';
        const displayName = this._getDisplayName(account);
        const statusText = this._formatStatusText(status, account.error_msg);
        const metaText = this._getAccountMeta(account);

        item.innerHTML = `
            <div class="account-avatar-wrap">
                ${this._buildAvatarHtml(account.avatar_url, displayName, account.session_name, 'avatar account-avatar')}
                <div class="account-status-dot account-status-dot-overlay status-${status}"></div>
            </div>
            <div class="account-info">
                <div class="account-top-row">
                    <div class="account-name">${this._escapeHtml(displayName)}</div>
                    <div class="account-status-pill account-status-pill-${status}">${this._escapeHtml(this._getStatusShortLabel(status))}</div>
                </div>
                <div class="account-meta-line">${this._escapeHtml(metaText)}</div>
                <div class="account-status-text">${this._escapeHtml(statusText)}</div>
            </div>
            <div class="account-actions">
                ${status === 'connected' ? `
                    <button class="action-btn disconnect-btn" title="Disconnect" data-action="disconnect" data-session="${this._escapeHtml(account.session_name)}">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A6.92 6.92 0 0119 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.05.88-3.89 2.29-5.17L5.88 5.46A8.96 8.96 0 003 12c0 4.97 4.03 9 9 9s9-4.03 9-9a8.96 8.96 0 00-3.17-6.83z"/></svg>
                    </button>
                ` : `
                    <button class="action-btn connect-btn" title="Connect" data-action="connect" data-session="${this._escapeHtml(account.session_name)}">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                    </button>
                `}
                <button class="action-btn info-btn" title="Account Info" data-action="info" data-session="${this._escapeHtml(account.session_name)}">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                </button>
            </div>
        `;

        item.addEventListener('click', (e) => {
            if (e.target.closest('.action-btn')) return;
            this.app.selectAccount(account.session_name);
        });

        item.querySelectorAll('.action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const session = btn.dataset.session;
                switch (action) {
                    case 'connect':
                        this.connectAccount(session);
                        break;
                    case 'disconnect':
                        this.disconnectAccount(session);
                        break;
                    case 'info':
                        this.showAccountInfo(session);
                        break;
                }
            });
        });

        return item;
    }

    /**
     * Connect an account
     * @param {string} sessionName
     */
    async connectAccount(sessionName) {
        this.app.showToast(`Connecting ${sessionName}...`, 'info', 2000);
        this.updateStatus(sessionName, 'reconnecting', '');

        const data = await this.app.api('POST', `/api/accounts/${encodeURIComponent(sessionName)}/connect`);
        if (data) {
            this.updateStatus(sessionName, data.status || 'connected', data.error_msg || '');
            this._showAccountActionResult(sessionName, data, 'connect');
            if (
                data.status === 'unauthorized' ||
                data.status === 'frozen' ||
                data.status === 'temporary_spamblock' ||
                data.status === 'permanent_spamblock'
            ) {
                this.loadAccounts();
                return;
            }
        } else {
            this.updateStatus(sessionName, 'error', this.app.state.accounts[sessionName]?.error_msg || '');
        }

        setTimeout(() => this.loadAccounts(), 1000);
    }

    /**
     * Disconnect an account
     * @param {string} sessionName
     */
    async disconnectAccount(sessionName) {
        this.app.showToast(`Disconnecting ${sessionName}...`, 'info', 2000);

        const data = await this.app.api('POST', `/api/accounts/${encodeURIComponent(sessionName)}/disconnect`);
        if (data) {
            this.app.showToast(`${sessionName} disconnected`, 'success');
            this.updateStatus(sessionName, 'disconnected', '');
        }

        setTimeout(() => this.loadAccounts(), 1000);
    }

    /**
     * Reconnect an account
     * @param {string} sessionName
     */
    async reconnectAccount(sessionName) {
        this.app.showToast(`Reconnecting ${sessionName}...`, 'info', 2000);
        this.updateStatus(sessionName, 'reconnecting', '');

        const data = await this.app.api('POST', `/api/accounts/${encodeURIComponent(sessionName)}/reconnect`);
        if (data) {
            this.updateStatus(sessionName, data.status || 'connected', data.error_msg || '');
            this._showAccountActionResult(sessionName, data, 'reconnect');
            if (
                data.status === 'unauthorized' ||
                data.status === 'frozen' ||
                data.status === 'temporary_spamblock' ||
                data.status === 'permanent_spamblock'
            ) {
                this.loadAccounts();
                return;
            }
        }

        setTimeout(() => this.loadAccounts(), 1000);
    }

    /**
     * Update the status of an account in the UI
     * @param {string} sessionName
     * @param {string} status
     * @param {string|null} errorMsg
     */
    updateStatus(sessionName, status, errorMsg = null) {
        if (this.app.state.accounts[sessionName]) {
            this.app.state.accounts[sessionName].status = status;
            if (errorMsg !== null) {
                this.app.state.accounts[sessionName].error_msg = errorMsg;
            }
        }

        this.renderAccounts(this.getAccounts());
    }

    /**
     * Sync compact picker after account selection
     */
    handleAccountSelected() {
        this.renderAccounts(this.getAccounts());
    }

    /**
     * Toggle the expanded account browser
     * @param {boolean|null} forceOpen
     */
    toggleBrowser(forceOpen = null) {
        this.isBrowserOpen = true;
        this.renderAccounts(this.getAccounts());
    }

    /**
     * Show account info modal
     * @param {string} sessionName
     */
    async showAccountInfo(sessionName) {
        this.app.showModal('modal-account-info');
        const body = document.getElementById('account-info-body');
        const titleEl = document.getElementById('account-info-title');
        const primaryBtn = document.getElementById('btn-account-info-primary');
        const openChatBtn = document.getElementById('btn-account-info-open-chat');
        const deleteChatBtn = document.getElementById('btn-account-info-delete-chat');
        this.app.showLoading(body);
        if (titleEl) titleEl.textContent = 'Account Details';
        if (primaryBtn) {
            primaryBtn.classList.add('hidden');
            primaryBtn.disabled = false;
            primaryBtn.textContent = '';
        }
        if (openChatBtn) openChatBtn.classList.add('hidden');
        if (deleteChatBtn) deleteChatBtn.classList.add('hidden');

        const data = await this.app.api('GET', `/api/accounts/${encodeURIComponent(sessionName)}/me`);

        if (!data) {
            body.innerHTML = '<div class="empty-state">Failed to load account info.<br><small>Make sure the account is connected.</small></div>';
            return;
        }

        const fullName = [data.first_name, data.last_name].filter(Boolean).join(' ') ||
            this._getDisplayName(this.app.state.accounts[sessionName] || { session_name: sessionName });

        body.innerHTML = `
            <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
                ${this._buildAvatarHtml(data.photo_url, fullName, data.id || sessionName, 'avatar large')}
                <div>
                    <div style="font-size:18px;font-weight:600;">${this._escapeHtml(fullName)}</div>
                    ${data.username ? `<div style="color:var(--text-secondary);">@${this._escapeHtml(data.username)}</div>` : ''}
                </div>
            </div>
            <div class="account-info-grid">
                <div class="label">Session</div>
                <div class="value">${this._escapeHtml(sessionName)}</div>
                <div class="label">User ID</div>
                <div class="value">${data.id || 'N/A'}</div>
                <div class="label">Phone</div>
                <div class="value">${this._escapeHtml(data.phone || 'N/A')}</div>
                <div class="label">Username</div>
                <div class="value">${data.username ? '@' + this._escapeHtml(data.username) : 'N/A'}</div>
                <div class="label">Bot</div>
                <div class="value">${data.is_bot ? 'Yes' : 'No'}</div>
                <div class="label">Status</div>
                <div class="value">${this._escapeHtml(data.status || 'N/A')}</div>
            </div>
        `;
    }

    /**
     * Return accounts as array
     * @returns {Array}
     */
    getAccounts() {
        return Object.values(this.app.state.accounts || {});
    }

    /**
     * Keep the incoming order stable
     * @param {Array} accounts
     * @returns {Array}
     */
    _sortAccounts(accounts) {
        return [...accounts];
    }

    /**
     * Filter accounts by search input
     * @param {Array} accounts
     * @returns {Array}
     */
    _filterAccounts(accounts) {
        if (!this.searchTerm) return accounts;

        const matches = [];
        const rest = [];

        accounts.forEach(account => {
            if (this._accountMatchesSearch(account)) {
                matches.push(account);
            } else {
                rest.push(account);
            }
        });

        return [...matches, ...rest];
    }

    /**
     * Set compact mode automatically when there are many accounts
     * @param {number} count
     */
    _applyAutoBrowserState(count) {
        this.isBrowserOpen = true;
        this._applyBrowserState();
    }

    /**
     * Update compact account summary and controls
     * @param {Array} accounts
     */
    _updateSummary(accounts) {
        const summary = document.getElementById('account-summary');
        const summaryDot = document.getElementById('account-summary-dot');
        const summaryName = document.getElementById('account-summary-name');
        const summaryMeta = document.getElementById('account-summary-meta');
        const countBadge = document.getElementById('account-count-badge');
        const summaryAvatar = document.getElementById('account-summary-avatar-image');

        if (!summary || !summaryDot || !summaryName || !summaryMeta || !countBadge || !summaryAvatar) return;

        const total = accounts.length;
        const connected = accounts.filter(account => account.status === 'connected').length;
        const selected = this.app.state.currentAccount
            ? this.app.state.accounts[this.app.state.currentAccount]
            : null;
        const summaryAccount = selected || accounts[0] || null;

        countBadge.textContent = String(total);
        countBadge.classList.toggle('hidden', total === 0);

        summaryDot.className = `account-status-dot account-status-dot-overlay status-${summaryAccount?.status || 'disconnected'}`;

        if (!total) {
            this._applyAvatarToElement(summaryAvatar, null, 'No', 'Account', 'account-summary-empty', 'avatar account-avatar');
            summaryName.textContent = 'No accounts found';
            summaryMeta.textContent = 'Add .session files to accounts/';
            return;
        }

        if (selected) {
            this._applyAvatarToElement(
                summaryAvatar,
                selected.avatar_url,
                this._getPrimaryNamePart(selected),
                this._getSecondaryNamePart(selected),
                selected.session_name,
                'avatar account-avatar'
            );
            summaryName.textContent = this._getDisplayName(selected);
            summaryMeta.textContent = `${this._formatStatusText(selected.status, selected.error_msg)} · ${connected}/${total} connected`;
            return;
        }

        const previewAccount = accounts[0];
        this._applyAvatarToElement(
            summaryAvatar,
            previewAccount?.avatar_url || null,
            this._getPrimaryNamePart(previewAccount),
            this._getSecondaryNamePart(previewAccount),
            previewAccount?.session_name || 'account-summary-preview',
            'avatar account-avatar'
        );
        summaryName.textContent = total === 1 ? this._getDisplayName(accounts[0]) : 'Choose an account';
        summaryMeta.textContent = `${connected}/${total} connected · Click to switch`;
    }

    /**
     * Apply browser open/collapsed state to the DOM
     */
    _applyBrowserState() {
        const browser = document.getElementById('account-browser');
        if (browser) {
            browser.classList.remove('collapsed');
        }
    }

    /**
     * Preserve the current visible order after reloads
     * @param {Array} accounts
     * @param {Array<string>} previousOrder
     * @returns {Array}
     */
    _preserveAccountOrder(accounts, previousOrder) {
        if (!previousOrder.length) {
            return [...accounts];
        }

        const previousIndex = new Map(previousOrder.map((sessionName, index) => [sessionName, index]));
        const incomingIndex = new Map(accounts.map((account, index) => [account.session_name, index]));

        return [...accounts].sort((a, b) => {
            const aPrev = previousIndex.has(a.session_name) ? previousIndex.get(a.session_name) : Number.MAX_SAFE_INTEGER;
            const bPrev = previousIndex.has(b.session_name) ? previousIndex.get(b.session_name) : Number.MAX_SAFE_INTEGER;

            if (aPrev !== bPrev) {
                return aPrev - bPrev;
            }

            return (incomingIndex.get(a.session_name) || 0) - (incomingIndex.get(b.session_name) || 0);
        });
    }

    /**
     * Clear current selection if the account disappeared from the list
     * @param {Array} accounts
     */
    _clearMissingSelection(accounts) {
        const activeSession = this.app.state.currentAccount;
        if (!activeSession) return;

        const stillExists = accounts.some(account => account.session_name === activeSession);
        if (stillExists) return;

        this.app.state.currentAccount = null;
        this.app.state.currentChat = null;
        this.app.state.currentChatTitle = null;
        this.app.state.dialogs = [];
        this.app.state.contacts = [];
        this.app.state.messages = [];

        if (typeof this.app._resetChatArea === 'function') {
            this.app._resetChatArea();
        }

        const dialogList = document.getElementById('dialog-list');
        if (dialogList) {
            dialogList.innerHTML = this.app.emptyStateHtml({
                icon: 'AC',
                title: 'Select an account',
                text: 'Chats will load after account selection.'
            });
        }

        const contactList = document.getElementById('contact-list');
        if (contactList) {
            contactList.innerHTML = this.app.emptyStateHtml({
                icon: 'CO',
                title: 'Select an account',
                text: 'Contacts will load after account selection.'
            });
        }
    }

    /**
     * Show a contextual toast for connect/reconnect results
     * @param {string} sessionName
     * @param {object} data
     * @param {string} action
     */
    _showAccountActionResult(sessionName, data, action) {
        const actionWord = action === 'reconnect' ? 'reconnected' : 'connected';
        const status = data.status || 'disconnected';

        if (status === 'connected') {
            this.app.showToast(`${sessionName} ${actionWord}`, 'success');
            return;
        }

        if (status === 'unauthorized') {
            this.app.showToast(
                data.error_msg || `${sessionName} was moved to accounts/dead/`,
                'warning',
                6000
            );
            return;
        }

        if (status === 'frozen') {
            this.app.showToast(
                data.error_msg || 'Аккаунт заморожен',
                'warning',
                7000
            );
            return;
        }

        if (status === 'temporary_spamblock') {
            this.app.showToast(
                data.error_msg || 'Аккаунт во временном спамблоке',
                'warning',
                7000
            );
            return;
        }

        if (status === 'permanent_spamblock') {
            this.app.showToast(
                data.error_msg || 'Аккаунт в вечном спамблоке',
                'warning',
                7000
            );
            return;
        }

        if (status === 'error' || status === 'invalid_session') {
            this.app.showToast(
                data.error_msg || `${sessionName} could not be ${action === 'reconnect' ? 'reconnected' : 'connected'}`,
                'error',
                6000
            );
        }
    }

    /**
     * Reset search UI
     */
    _clearSearch() {
        this.searchTerm = '';
        const searchInput = document.getElementById('account-search');
        if (searchInput) searchInput.value = '';
    }

    /**
     * Format status text for display
     * @param {string} status
     * @param {string} errorMsg
     * @returns {string}
     */
    _formatStatusText(status, errorMsg) {
        const labels = {
            connected: 'Connected',
            disconnected: 'Disconnected',
            unauthorized: 'Unauthorized',
            frozen: 'Frozen',
            temporary_spamblock: 'Временный спамблок',
            permanent_spamblock: 'Вечный спамблок',
            invalid_session: 'Invalid Session',
            reconnecting: 'Reconnecting...',
            error: errorMsg ? `Error: ${errorMsg}` : 'Error'
        };
        return labels[status] || status;
    }

    /**
     * Short label for compact account status pills.
     * @param {string} status
     * @returns {string}
     */
    _getStatusShortLabel(status) {
        const labels = {
            connected: 'ON',
            disconnected: 'OFF',
            unauthorized: 'AUTH',
            frozen: 'FRZ',
            temporary_spamblock: 'SB',
            permanent_spamblock: 'SB+',
            invalid_session: 'BAD',
            reconnecting: 'SYNC',
            error: 'ERR'
        };
        return labels[status] || String(status || '').slice(0, 4).toUpperCase();
    }

    /**
     * Build a compact account metadata line.
     * @param {object} account
     * @returns {string}
     */
    _getAccountMeta(account) {
        const parts = [];

        if (account.phone && account.phone !== account.session_name) {
            parts.push(account.phone);
        }

        if (account.session_name) {
            parts.push(account.session_name);
        }

        return parts.join(' · ') || 'Telegram session';
    }

    /**
     * Check whether an account matches the active search term.
     * Search should reorder, not hide, available accounts.
     * @param {object} account
     * @returns {boolean}
     */
    _accountMatchesSearch(account) {
        if (!this.searchTerm) return true;

        const searchBase = [
            account.session_name,
            account.name,
            account.phone,
            account.status
        ].join(' ').toLowerCase();

        return searchBase.includes(this.searchTerm);
    }

    /**
     * Get preferred account label
     * @param {object} account
     * @returns {string}
     */
    _getDisplayName(account) {
        return account.name || account.phone || account.session_name;
    }

    /**
     * Build avatar markup for account list and info blocks
     * @param {string|null} avatarUrl
     * @param {string} label
     * @param {string|number} seed
     * @param {string} className
     * @returns {string}
     */
    _buildAvatarHtml(avatarUrl, label, seed, className = 'avatar') {
        const initials = this._getInitialsFromLabel(label);
        const colorIdx = Math.abs(this._simpleHash(String(seed || label || initials))) % 8;
        const classes = `${className} avatar-color-${colorIdx}${avatarUrl ? ' has-photo' : ''}`;

        if (avatarUrl) {
            return `
                <div class="${classes}">
                    <img src="${this._escapeHtml(avatarUrl)}" alt="${this._escapeHtml(label || 'Account avatar')}">
                </div>
            `;
        }

        return `<div class="${classes}">${this._escapeHtml(initials)}</div>`;
    }

    /**
     * Apply avatar data to an existing element
     * @param {HTMLElement|null} element
     * @param {string|null} avatarUrl
     * @param {string} firstPart
     * @param {string} secondPart
     * @param {string|number} seed
     * @param {string} className
     */
    _applyAvatarToElement(element, avatarUrl, firstPart, secondPart, seed, className = 'avatar') {
        if (!element) return;

        const label = [firstPart, secondPart].filter(Boolean).join(' ').trim();
        const initials = this._getInitials(firstPart, secondPart);
        const colorIdx = Math.abs(this._simpleHash(String(seed || label || initials))) % 8;

        element.className = `${className} avatar-color-${colorIdx}`;
        element.textContent = '';
        element.innerHTML = '';

        if (avatarUrl) {
            element.classList.add('has-photo');
            const img = document.createElement('img');
            img.src = avatarUrl;
            img.alt = label || 'Account avatar';
            element.appendChild(img);
            return;
        }

        element.classList.remove('has-photo');
        element.textContent = initials;
    }

    /**
     * Derive initials from a single display label
     * @param {string} label
     * @returns {string}
     */
    _getInitialsFromLabel(label) {
        const parts = String(label || '')
            .trim()
            .split(/[\s._-]+/)
            .filter(Boolean);

        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        if (parts.length === 1 && parts[0].length >= 2) {
            return parts[0].slice(0, 2).toUpperCase();
        }
        if (parts.length === 1) {
            return parts[0][0].toUpperCase();
        }
        return '?';
    }

    /**
     * Get first word from account display name
     * @param {object|null} account
     * @returns {string}
     */
    _getPrimaryNamePart(account) {
        const parts = this._splitDisplayName(account);
        return parts[0] || '';
    }

    /**
     * Get second word from account display name
     * @param {object|null} account
     * @returns {string}
     */
    _getSecondaryNamePart(account) {
        const parts = this._splitDisplayName(account);
        return parts[1] || '';
    }

    /**
     * Split a display name into parts for avatar fallbacks
     * @param {object|null} account
     * @returns {Array<string>}
     */
    _splitDisplayName(account) {
        return this._getDisplayName(account || {})
            .split(/[\s._-]+/)
            .filter(Boolean);
    }

    /**
     * Escape HTML entities
     * @param {string} text
     * @returns {string}
     */
    _escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Get initials from first and last name
     * @param {string} firstName
     * @param {string} lastName
     * @returns {string}
     */
    _getInitials(firstName, lastName) {
        const f = (firstName || '').trim();
        const l = (lastName || '').trim();
        if (f && l) return (f[0] + l[0]).toUpperCase();
        if (f) return f[0].toUpperCase();
        return '?';
    }

    /**
     * Simple hash for avatar color
     * @param {string} str
     * @returns {number}
     */
    _simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }
}
