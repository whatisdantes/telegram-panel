/**
 * Chat Manager - handles dialogs, message history, sending, and real-time updates
 */
class ChatManager {
    constructor(app) {
        this.app = app;
        this.isLoadingHistory = false;
        this.hasMoreMessages = true;
        this.oldestMessageId = null;
        this.resolvedEntity = null;
        this._lastDateSeparator = null;
        this.isLoadingContacts = false;
        this.contactsRequestId = 0;
        this.isRefreshingDialogs = false;
        this.isSubmittingContact = false;
        this.contactModalContext = null;
        this.typingResetTimer = null;
        this.markReadRequests = new Set();
        this.deletingContactIds = new Set();

        this._bindNewDialogEvents();
        this._bindContactEvents();
    }

    /**
     * Bind events for the new dialog modal
     */
    _bindNewDialogEvents() {
        const btnResolve = document.getElementById('btn-resolve-entity');
        const btnAddContact = document.getElementById('btn-add-resolved-contact');
        const btnOpenChat = document.getElementById('btn-open-resolved-chat');
        const input = document.getElementById('new-dialog-input');

        if (btnResolve) {
            btnResolve.addEventListener('click', () => {
                const identifier = input ? input.value.trim() : '';
                if (identifier) {
                    this.resolveEntity(identifier);
                }
            });
        }

        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const identifier = input.value.trim();
                    if (identifier) {
                        this.resolveEntity(identifier);
                    }
                }
            });
        }

        if (btnOpenChat) {
            btnOpenChat.addEventListener('click', () => {
                if (this.resolvedEntity) {
                    this.app.hideModal('modal-new-dialog');
                    const name = [this.resolvedEntity.first_name, this.resolvedEntity.last_name].filter(Boolean).join(' ') || this.resolvedEntity.username || String(this.resolvedEntity.id);
                    this.app.selectChat(this.resolvedEntity.id, name);
                }
            });
        }

        if (btnAddContact) {
            btnAddContact.addEventListener('click', () => {
                this.addResolvedEntityToContacts();
            });
        }
    }

    /**
     * Bind contacts-sidebar actions and add-contact modal events.
     */
    _bindContactEvents() {
        const btnAddContact = document.getElementById('btn-add-contact');
        const btnSubmit = document.getElementById('btn-submit-add-contact');
        const input = document.getElementById('add-contact-input');
        const firstNameInput = document.getElementById('add-contact-first-name');
        const lastNameInput = document.getElementById('add-contact-last-name');

        if (btnAddContact) {
            btnAddContact.addEventListener('click', () => {
                this.openAddContactModal();
            });
        }

        if (btnSubmit) {
            btnSubmit.addEventListener('click', () => {
                this.submitNewContact();
            });
        }

        if (input) {
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.submitNewContact();
                }
            });
        }

        [firstNameInput, lastNameInput].forEach(field => {
            if (!field) return;
            field.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.submitNewContact();
                }
            });
        });
    }

    /**
     * Load dialogs for a session
     * @param {string} sessionName
     */
    async loadDialogs(sessionName) {
        const listEl = document.getElementById('dialog-list');
        this.app.showLoading(listEl);

        const data = await this.app.api('GET', `/api/messages/${encodeURIComponent(sessionName)}/dialogs?limit=30`);
        if (!data) {
            if (listEl) {
                listEl.innerHTML = this.app.emptyStateHtml({
                    icon: '!',
                    title: 'Failed to load chats',
                    text: 'Check the account connection and try refreshing.'
                });
            }
            return;
        }

        const dialogs = Array.isArray(data) ? data : [];
        this.app.state.dialogs = dialogs;
        this.renderDialogs(dialogs);
    }

    /**
     * Load contacts for a session
     * @param {string} sessionName
     */
    async loadContacts(sessionName) {
        const requestId = ++this.contactsRequestId;
        this.isLoadingContacts = true;

        const listEl = document.getElementById('contact-list');
        this.app.showLoading(listEl);

        const data = await this.app.api('GET', `/api/messages/${encodeURIComponent(sessionName)}/contacts`);
        if (requestId === this.contactsRequestId) {
            this.isLoadingContacts = false;
        }
        if (requestId !== this.contactsRequestId) {
            return;
        }

        if (sessionName !== this.app.state.currentAccount) {
            return;
        }

        if (!data) {
            if (listEl) {
                listEl.innerHTML = this.app.emptyStateHtml({
                    icon: '!',
                    title: 'Failed to load contacts',
                    text: 'Check the account connection and try again.'
                });
            }
            return;
        }

        const contacts = Array.isArray(data) ? data : [];
        this.app.state.contacts = contacts;
        this.renderContacts(contacts);
    }

    /**
     * Render the dialog list
     * @param {Array} dialogs
     */
    renderDialogs(dialogs) {
        const listEl = document.getElementById('dialog-list');
        if (!listEl) return;

        if (dialogs.length === 0) {
            listEl.innerHTML = this.app.emptyStateHtml({
                icon: 'CH',
                title: 'No chats yet',
                text: 'Incoming and outgoing dialogs will appear here.'
            });
            this.updateDeleteChatButton();
            return;
        }

        listEl.innerHTML = '';
        dialogs.forEach(dialog => {
            const item = document.createElement('div');
            item.className = 'dialog-item';
            item.dataset.entityId = dialog.id || dialog.entity_id || '';

            if (this.app.state.currentChat == item.dataset.entityId) {
                item.classList.add('active');
            }

            const name = dialog.name || dialog.title || 'Unknown';
            const initials = this.getInitials(name);
            const colorIdx = Math.abs(this._hashCode(String(dialog.id || dialog.entity_id || ''))) % 8;
            const lastMsg = dialog.last_message || dialog.message || '';
            const time = dialog.last_message_date ? this.formatTime(dialog.last_message_date) : '';
            const unread = dialog.unread_count || 0;
            const typeLabel = this._getDialogTypeLabel(dialog);
            const previewBadge = this._getDialogPreviewBadge(lastMsg);

            item.innerHTML = `
                ${this._buildSidebarAvatarHtml(dialog.photo_url, name, dialog.id || dialog.entity_id || colorIdx)}
                <div class="dialog-content">
                    <div class="dialog-top-row">
                        <div class="dialog-title-wrap">
                            <div class="dialog-name">${this._escapeHtml(name)}</div>
                            ${typeLabel ? `<div class="dialog-type-pill">${this._escapeHtml(typeLabel)}</div>` : ''}
                        </div>
                        <div class="dialog-time">${this._escapeHtml(time)}</div>
                    </div>
                    <div class="dialog-bottom-row">
                        <div class="dialog-preview-wrap">
                            ${previewBadge ? `<span class="dialog-preview-badge">${this._escapeHtml(previewBadge)}</span>` : ''}
                            <div class="dialog-preview">${this._escapeHtml(this._truncate(this._cleanDialogPreview(lastMsg), 50))}</div>
                        </div>
                        ${unread > 0 ? `<div class="dialog-unread">${unread > 99 ? '99+' : unread}</div>` : ''}
                    </div>
                </div>
            `;

            item.addEventListener('click', () => {
                const entityId = dialog.id || dialog.entity_id;
                this.app.selectChat(entityId, name);
            });

            listEl.appendChild(item);
        });

        this.updateDeleteChatButton();
    }

    /**
     * Render the contact list
     * @param {Array} contacts
     */
    renderContacts(contacts) {
        const listEl = document.getElementById('contact-list');
        if (!listEl) return;

        if (contacts.length === 0) {
            listEl.innerHTML = this.app.emptyStateHtml({
                icon: 'CO',
                title: 'No contacts yet',
                text: 'Use "Добавить новый контакт" to save a user.'
            });
            return;
        }

        listEl.innerHTML = '';
        contacts.forEach(contact => {
            const item = document.createElement('div');
            const name = contact.display_name
                || [contact.first_name, contact.last_name].filter(Boolean).join(' ')
                || contact.username
                || String(contact.id);
            const meta = this._getContactListMeta(contact);

            item.className = 'dialog-item contact-item';
            item.dataset.entityId = contact.id || '';

            if (this.app.state.currentChat == item.dataset.entityId) {
                item.classList.add('active');
            }

            item.innerHTML = `
                ${this._buildSidebarAvatarHtml(contact.photo_url, name, contact.id)}
                <div class="dialog-content">
                    <div class="contact-top-row">
                        <div class="dialog-name">${this._escapeHtml(name)}</div>
                        ${contact.is_bot ? '<div class="contact-pill">Bot</div>' : ''}
                    </div>
                    <div class="contact-meta">${this._escapeHtml(meta)}</div>
                </div>
                <div class="contact-actions">
                    <button class="action-btn info-btn contact-open-btn" type="button" title="Open chat">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2zM6 9h12v2H6V9zm0-3h12v2H6V6zm0 6h8v2H6v-2z"/></svg>
                    </button>
                    <button class="action-btn info-btn contact-edit-btn" type="button" title="Edit contact name">✎</button>
                    <button class="action-btn danger-btn contact-delete-btn" type="button" title="Delete from contacts">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 7h12l-1 14H7L6 7zm3-4h6l1 2h4v2H4V5h4l1-2z"/></svg>
                    </button>
                </div>
            `;

            item.addEventListener('click', () => {
                this.app.selectChat(contact.id, name);
            });

            const editBtn = item.querySelector('.contact-edit-btn');
            if (editBtn) {
                editBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.openContactNamingModal({
                        entity: contact,
                        entityId: contact.id,
                        identifier: this._getContactIdentifierLabel(contact),
                        sourceLabel: 'contact list',
                        initialFirstName: contact.first_name || '',
                        initialLastName: contact.last_name || ''
                    });
                });
            }

            const openBtn = item.querySelector('.contact-open-btn');
            if (openBtn) {
                openBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.app.selectChat(contact.id, name);
                });
            }

            const deleteBtn = item.querySelector('.contact-delete-btn');
            if (deleteBtn) {
                deleteBtn.disabled = this.deletingContactIds.has(String(contact.id));
                deleteBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.deleteContact(contact, name);
                });
            }

            listEl.appendChild(item);
        });
    }

    /**
     * Remove a saved contact from Telegram contacts.
     * @param {object} contact
     * @param {string} name
     */
    async deleteContact(contact, name = '') {
        const sessionName = this.app.state.currentAccount;
        const entityId = contact?.id;
        if (!sessionName || !entityId) {
            this.app.showToast('Select an account and contact first', 'warning');
            return;
        }

        const label = name || contact.display_name || contact.username || String(entityId);
        const confirmed = window.confirm(
            `Delete "${label}" from contacts?\n\nThe chat history will stay; only the saved contact entry will be removed.`
        );
        if (!confirmed) {
            return;
        }

        const deleteKey = String(entityId);
        if (this.deletingContactIds.has(deleteKey)) {
            return;
        }
        this.deletingContactIds.add(deleteKey);
        this.renderContacts(this.app.state.contacts || []);

        try {
            const result = await this.app.api(
                'DELETE',
                `/api/messages/${encodeURIComponent(sessionName)}/contacts/${encodeURIComponent(entityId)}`
            );
            if (!result?.ok) {
                return;
            }

            this.app.state.contacts = (this.app.state.contacts || [])
                .filter(item => String(item.id) !== String(entityId));
            this.renderContacts(this.app.state.contacts);
            this.app.showToast(result.message || 'Contact removed', 'success');
        } finally {
            this.deletingContactIds.delete(deleteKey);
            this.refreshContactsForCurrentAccount();
        }
    }

    /**
     * Render chat header from the best locally available dialog/contact data.
     * @param {string|number} entityId
     * @param {string} title
     */
    renderChatHeader(entityId, title = '') {
        const context = this._getCurrentChatContext(entityId);
        const name = this._getChatHeaderName(context, title, entityId);
        const photoUrl = context?.photo_url || '';
        const colorIdx = Math.abs(this._hashCode(String(entityId || name || ''))) % 8;

        const nameEl = document.getElementById('chat-header-name');
        const statusEl = document.getElementById('chat-header-status');
        const metaEl = document.getElementById('chat-header-meta');
        const typeEl = document.getElementById('chat-header-type');
        const presenceEl = document.getElementById('chat-header-presence');
        const avatarEl = document.getElementById('chat-avatar');

        if (nameEl) {
            nameEl.textContent = name;
        }

        if (statusEl) {
            statusEl.textContent = '';
        }

        if (metaEl) {
            metaEl.textContent = this._getChatHeaderMeta(context, entityId);
        }

        if (typeEl) {
            const typeLabel = this._getChatHeaderType(context);
            typeEl.textContent = typeLabel;
            typeEl.classList.toggle('hidden', !typeLabel);
        }

        if (presenceEl) {
            presenceEl.textContent = '';
            presenceEl.classList.add('hidden');
        }

        if (avatarEl) {
            avatarEl.className = `avatar chat-header-avatar avatar-color-${colorIdx}${photoUrl ? ' has-photo' : ''}`;
            if (photoUrl) {
                avatarEl.innerHTML = `<img src="${this._escapeAttribute(photoUrl)}" alt="${this._escapeHtml(name)}">`;
            } else {
                avatarEl.innerHTML = '';
                avatarEl.textContent = this.getInitials(name || '?');
            }
        }
    }

    /**
     * Load message history for a chat
     * @param {string} sessionName
     * @param {string|number} entityId
     * @param {number} limit
     */
    async loadHistory(sessionName, entityId, limit = 50) {
        if (this.isLoadingHistory) return false;
        this.isLoadingHistory = true;
        this.hasMoreMessages = true;
        this.oldestMessageId = null;
        this._lastDateSeparator = null;

        const container = document.getElementById('messages-container');
        const loadingEl = document.getElementById('messages-loading');
        if (loadingEl) loadingEl.classList.remove('hidden');

        const url = `/api/messages/${encodeURIComponent(sessionName)}/history/${encodeURIComponent(entityId)}?limit=${limit}`;
        const data = await this.app.api('GET', url);

        if (loadingEl) loadingEl.classList.add('hidden');
        this.isLoadingHistory = false;

        if (!data) {
            if (container) container.innerHTML = '<div class="empty-state">Failed to load messages</div>';
            return false;
        }

        const messages = Array.isArray(data) ? data : [];
        this.app.state.messages = messages;

        if (messages.length < limit) {
            this.hasMoreMessages = false;
        }

        if (messages.length > 0) {
            this.oldestMessageId = messages[0].id;
        }

        this.renderMessages(messages, false);
        this.scrollToBottom(false);
        return true;
    }

    /**
     * Render messages into the container
     * @param {Array} messages
     * @param {boolean} append - if true, prepend to top (older messages)
     */
    renderMessages(messages, append = false) {
        const container = document.getElementById('messages-container');
        if (!container) return;

        if (messages.length === 0 && !append) {
            container.innerHTML = this.app.emptyStateHtml({
                icon: 'MSG',
                title: 'No messages yet',
                text: 'Send a message or wait for incoming activity.'
            });
            return;
        }

        if (!append) {
            container.innerHTML = '';
            this._lastDateSeparator = null;
        }

        // Messages come oldest first for prepend, newest first for initial load
        // Normalize: we want chronological order
        const sorted = [...messages].sort((a, b) => {
            const da = new Date(a.date).getTime();
            const db = new Date(b.date).getTime();
            return da - db;
        });

        const fragment = document.createDocumentFragment();

        sorted.forEach(msg => {
            // Date separator
            const msgDate = this._formatDate(msg.date);
            if (msgDate !== this._lastDateSeparator) {
                this._lastDateSeparator = msgDate;
                const sep = document.createElement('div');
                sep.className = 'message-date-separator';
                sep.innerHTML = `<span>${this._escapeHtml(msgDate)}</span>`;
                fragment.appendChild(sep);
            }

            fragment.appendChild(this.renderMessage(msg));
        });

        if (append) {
            // Prepend older messages at top
            const firstChild = container.firstChild;
            container.insertBefore(fragment, firstChild);
            const existingMessages = Array.isArray(this.app.state.messages) ? [...this.app.state.messages] : [];
            const existingIds = new Set(existingMessages.map(message => String(message.id)));
            const olderMessages = sorted.filter(message => !existingIds.has(String(message.id)));
            this.app.state.messages = [...olderMessages, ...existingMessages];
        } else {
            container.appendChild(fragment);
            this.app.state.messages = sorted;
        }
    }

    /**
     * Render a single message bubble
     * @param {object} msg - MessageSchema
     * @returns {HTMLElement}
     */
    renderMessage(msg) {
        const div = document.createElement('div');
        const isOutgoing = msg.is_outgoing;
        div.className = `message ${isOutgoing ? 'message-outgoing' : 'message-incoming'}`;
        if (msg.send_status) {
            div.classList.add(`message-${msg.send_status}`);
        }
        div.dataset.messageId = msg.id;

        let senderHtml = '';
        if (!isOutgoing && msg.sender_name) {
            senderHtml = `<div class="message-sender">${this._escapeHtml(msg.sender_name)}</div>`;
        }

        let textHtml = '';
        if (msg.text) {
            textHtml = `<div class="message-text">${this._escapeHtml(msg.text)}</div>`;
        }

        const mediaHtml = this._renderMediaHtml(msg);

        const time = this._formatTime(msg.date);

        div.innerHTML = `
            ${senderHtml}
            ${mediaHtml}
            ${textHtml}
            <div class="message-meta">
                <span class="message-time">${this._escapeHtml(time)}</span>
                ${this._renderDeliveryStatusHtml(msg)}
            </div>
        `;

        this._applyReadStatusToElement(div, msg);

        const contactCard = div.querySelector('.message-contact-card');
        if (contactCard && msg.contact?.can_open) {
            contactCard.addEventListener('click', () => {
                this.openContactChat(msg.contact);
            });
        }

        return div;
    }

    /**
     * Send a message from the input field
     */
    async sendMessage() {
        const input = document.getElementById('message-input');
        if (!input) return;

        const text = input.value.trim();
        if (!text) return;

        const sessionName = this.app.state.currentAccount;
        const target = this.app.state.currentChat;

        if (!sessionName || !target) {
            this.app.showToast('No account or chat selected', 'warning');
            return;
        }

        // Clear input immediately for responsiveness
        input.value = '';
        input.style.height = 'auto';

        // Optimistically add message to UI
        const tempMsg = {
            id: 'temp-' + Date.now(),
            text: text,
            date: new Date().toISOString(),
            chat_id: target,
            sender_id: null,
            sender_name: 'You',
            is_outgoing: true,
            is_read: false,
            send_status: 'sending',
            media_type: null,
            preview_text: text
        };

        const container = document.getElementById('messages-container');
        if (container) {
            container.appendChild(this.renderMessage(tempMsg));
            this.scrollToBottom(true);
        }
        this._storeIncomingMessage(tempMsg);

        // Send via API
        const data = await this.app.api('POST', `/api/messages/${encodeURIComponent(sessionName)}/send`, {
            target: String(target),
            text: text
        });

        if (!data) {
            const tempEl = container ? container.querySelector(`[data-message-id="${tempMsg.id}"]`) : null;
            const failedMsg = { ...tempMsg, send_status: 'failed' };
            if (tempEl) {
                tempEl.replaceWith(this.renderMessage(failedMsg));
            }
            this._replaceStoredMessage(tempMsg.id, failedMsg);
            this.app.showToast('Failed to send message', 'error');
        } else {
            const tempEl = container ? container.querySelector(`[data-message-id="${tempMsg.id}"]`) : null;
            if (tempEl) {
                tempEl.replaceWith(this.renderMessage(data));
            }
            this._replaceStoredMessage(tempMsg.id, data);
            this._syncDialogsWithMessage(data);
            this._updateDialogPreview(data);
        }
    }

    /**
     * Delete the currently selected private chat for both participants.
     */
    async deleteCurrentChat() {
        const sessionName = this.app.state.currentAccount;
        const entityId = this.app.state.currentChat;
        const dialog = this._getCurrentDialog();

        if (!sessionName || !entityId) {
            this.app.showToast('No chat selected', 'warning');
            return;
        }

        if (dialog && (dialog.is_group || dialog.is_channel)) {
            this.app.showToast('Only private chats with users can be deleted here', 'warning');
            return;
        }

        const title = this.app.state.currentChatTitle || dialog?.name || 'this chat';
        const confirmed = window.confirm(
            `Delete chat with "${title}" for both participants?\n\nTelegram will try to remove the private dialog history on both sides.`
        );
        if (!confirmed) {
            return;
        }

        const deleteButton = document.getElementById('btn-delete-chat');
        if (deleteButton) {
            deleteButton.disabled = true;
        }

        const result = await this.app.api(
            'DELETE',
            `/api/messages/${encodeURIComponent(sessionName)}/dialog/${encodeURIComponent(entityId)}`
        );

        if (deleteButton) {
            deleteButton.disabled = false;
        }

        if (!result) {
            return;
        }

        this._removeDialogFromState(entityId);
        this.app.state.currentChat = null;
        this.app.state.currentChatTitle = null;
        this.app.state.messages = [];
        this.app._resetChatArea();
        document.getElementById('messages-empty').querySelector('.empty-text').textContent = 'Chat deleted';
        this._refreshDialogsForCurrentAccount();
        this.app.showToast('Chat deleted for both participants', 'success');
    }

    /**
     * Open the new dialog modal
     */
    openNewDialog() {
        this.resolvedEntity = null;
        const input = document.getElementById('new-dialog-input');
        const resultEl = document.getElementById('new-dialog-result');
        const errorEl = document.getElementById('new-dialog-error');
        const btnAddContact = document.getElementById('btn-add-resolved-contact');
        const btnOpen = document.getElementById('btn-open-resolved-chat');

        if (input) input.value = '';
        if (resultEl) resultEl.classList.add('hidden');
        if (errorEl) errorEl.classList.add('hidden');
        if (btnAddContact) {
            btnAddContact.classList.add('hidden');
            btnAddContact.disabled = false;
            btnAddContact.textContent = 'Add to contact';
        }
        if (btnOpen) btnOpen.classList.add('hidden');

        this.app.showModal('modal-new-dialog');
        if (input) input.focus();
    }

    /**
     * Open the add-contact modal.
     */
    openAddContactModal() {
        if (!this.app.state.currentAccount) {
            this.app.showToast('Select an account first', 'warning');
            return;
        }

        this.contactModalContext = {
            mode: 'identifier',
            identifier: '',
            entityId: null,
            fallbackName: '',
            sourceLabel: ''
        };

        const titleEl = document.getElementById('add-contact-modal-title');
        const noteEl = document.getElementById('add-contact-target-note');
        const identifierGroup = document.getElementById('add-contact-identifier-group');
        const input = document.getElementById('add-contact-input');
        const firstNameInput = document.getElementById('add-contact-first-name');
        const lastNameInput = document.getElementById('add-contact-last-name');
        const helperEl = document.getElementById('add-contact-name-helper');
        const errorEl = document.getElementById('add-contact-error');
        const submitBtn = document.getElementById('btn-submit-add-contact');

        this.isSubmittingContact = false;
        if (titleEl) titleEl.textContent = 'Добавить новый контакт';
        if (noteEl) {
            noteEl.textContent = 'Если имя и фамилия пустые, контакт сохранится так, как он подписан в Telegram.';
            noteEl.classList.remove('hidden');
        }
        if (identifierGroup) {
            identifierGroup.classList.remove('hidden');
        }
        if (input) input.value = '';
        if (input) input.disabled = false;
        if (firstNameInput) firstNameInput.value = '';
        if (lastNameInput) lastNameInput.value = '';
        if (helperEl) {
            helperEl.textContent = 'Если имя или фамилия пустые, панель возьмет данные из Telegram-профиля.';
        }
        this._setContactModalStatus('', '');
        if (errorEl) {
            errorEl.textContent = '';
            errorEl.classList.add('hidden');
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Contact';
        }

        this.app.showModal('modal-add-contact');
        if (input) input.focus();
    }

    /**
     * Open the contact modal for a known Telegram user and allow optional renaming.
     * @param {object} options
     */
    openContactNamingModal(options = {}) {
        if (!this.app.state.currentAccount) {
            this.app.showToast('Select an account first', 'warning');
            return;
        }

        const entityId = options.entityId ?? options.entity?.id ?? null;
        if (!entityId) {
            this.app.showToast('User is not available for adding to contacts', 'warning');
            return;
        }

        const fallbackName = this._getUserEntityDisplayName(options.entity || {});
        const identifierValue = options.identifier
            || this._getContactIdentifierLabel(options.entity || {})
            || `ID: ${entityId}`;

        this.contactModalContext = {
            mode: 'entity',
            identifier: identifierValue,
            entityId,
            fallbackName,
            sourceLabel: options.sourceLabel || 'user'
        };

        const titleEl = document.getElementById('add-contact-modal-title');
        const noteEl = document.getElementById('add-contact-target-note');
        const identifierGroup = document.getElementById('add-contact-identifier-group');
        const input = document.getElementById('add-contact-input');
        const firstNameInput = document.getElementById('add-contact-first-name');
        const lastNameInput = document.getElementById('add-contact-last-name');
        const helperEl = document.getElementById('add-contact-name-helper');
        const errorEl = document.getElementById('add-contact-error');
        const submitBtn = document.getElementById('btn-submit-add-contact');

        this.isSubmittingContact = false;
        if (titleEl) titleEl.textContent = 'Сохранить контакт';
        if (noteEl) {
            noteEl.textContent = fallbackName
                ? `Пустые имя и фамилия сохранят контакт как "${fallbackName}" из Telegram.`
                : 'Если имя и фамилия пустые, контакт сохранится так, как он подписан в Telegram.';
            noteEl.classList.remove('hidden');
        }
        if (identifierGroup) {
            identifierGroup.classList.remove('hidden');
        }
        if (input) {
            input.value = identifierValue;
            input.disabled = true;
        }
        if (firstNameInput) firstNameInput.value = options.initialFirstName || '';
        if (lastNameInput) lastNameInput.value = options.initialLastName || '';
        if (helperEl) {
            helperEl.textContent = fallbackName
                ? `Если оставить поля пустыми, будет сохранено имя из Telegram: "${fallbackName}".`
                : 'Если имя или фамилия пустые, панель возьмет данные из Telegram-профиля.';
        }
        this._setContactModalStatus('', '');
        if (errorEl) {
            errorEl.textContent = '';
            errorEl.classList.add('hidden');
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Contact';
        }

        this.app.showModal('modal-add-contact');
        if (firstNameInput) {
            firstNameInput.focus();
        }
    }

    /**
     * Resolve an entity by identifier
     * @param {string} identifier
     */
    async resolveEntity(identifier) {
        const sessionName = this.app.state.currentAccount;
        if (!sessionName) {
            this.app.showToast('No account selected', 'warning');
            return;
        }

        const resultEl = document.getElementById('new-dialog-result');
        const errorEl = document.getElementById('new-dialog-error');
        const btnAddContact = document.getElementById('btn-add-resolved-contact');
        const btnOpen = document.getElementById('btn-open-resolved-chat');
        const btnResolve = document.getElementById('btn-resolve-entity');

        if (resultEl) resultEl.classList.add('hidden');
        if (errorEl) errorEl.classList.add('hidden');
        if (btnAddContact) btnAddContact.classList.add('hidden');
        if (btnOpen) btnOpen.classList.add('hidden');
        if (btnResolve) btnResolve.disabled = true;

        const data = await this.app.api('POST', `/api/messages/${encodeURIComponent(sessionName)}/resolve`, {
            identifier: identifier
        });

        if (btnResolve) btnResolve.disabled = false;

        if (!data) {
            if (errorEl) {
                errorEl.textContent = 'User not found or error occurred';
                errorEl.classList.remove('hidden');
            }
            return;
        }

        this.resolvedEntity = data;

        // Show resolved user
        if (resultEl) {
            const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || 'Unknown';
            const colorIdx = Math.abs(this._hashCode(String(data.id || ''))) % 8;
            const avatarEl = document.getElementById('resolved-avatar');

            if (avatarEl) {
                avatarEl.className = `avatar avatar-color-${colorIdx}`;
                avatarEl.textContent = '';
                avatarEl.innerHTML = '';

                if (data.photo_url) {
                    avatarEl.classList.add('has-photo');
                    avatarEl.innerHTML = `<img src="${this._escapeHtml(data.photo_url)}" alt="${this._escapeHtml(name)}">`;
                } else {
                    avatarEl.classList.remove('has-photo');
                    avatarEl.textContent = this.getInitials(name);
                }
            }
            document.getElementById('resolved-name').textContent = name;
            document.getElementById('resolved-username').textContent = data.username ? `@${data.username}` : `ID: ${data.id}`;

            resultEl.classList.remove('hidden');
        }

        this._updateResolvedContactButton();
        if (btnOpen) btnOpen.classList.remove('hidden');
    }

    /**
     * Add the resolved user from the new-chat modal to contacts.
     */
    async addResolvedEntityToContacts() {
        const sessionName = this.app.state.currentAccount;
        const resolved = this.resolvedEntity;

        if (!sessionName || !resolved?.id) {
            return;
        }

        this.openContactNamingModal({
            entity: resolved,
            entityId: resolved.id,
            identifier: this._getContactIdentifierLabel(resolved),
            sourceLabel: 'resolved user',
            initialFirstName: resolved.first_name || '',
            initialLastName: resolved.last_name || ''
        });
    }

    /**
     * Add a contact by username or phone number from the contacts modal.
     */
    async submitNewContact() {
        const sessionName = this.app.state.currentAccount;
        const input = document.getElementById('add-contact-input');
        const firstNameInput = document.getElementById('add-contact-first-name');
        const lastNameInput = document.getElementById('add-contact-last-name');
        const errorEl = document.getElementById('add-contact-error');
        const submitBtn = document.getElementById('btn-submit-add-contact');
        const context = this.contactModalContext || { mode: 'identifier' };
        const identifier = input ? input.value.trim() : '';
        const firstName = firstNameInput ? firstNameInput.value.trim() : '';
        const lastName = lastNameInput ? lastNameInput.value.trim() : '';

        if (!sessionName) {
            this.app.showToast('Select an account first', 'warning');
            return;
        }

        if ((context.mode !== 'entity' && !identifier) || this.isSubmittingContact) {
            if (context.mode !== 'entity' && !identifier && errorEl) {
                errorEl.textContent = 'Enter @username or a phone number';
                errorEl.classList.remove('hidden');
                this._setContactModalStatus('Нужно указать @username или номер телефона.', 'error');
            }
            return;
        }

        this.isSubmittingContact = true;
        if (errorEl) {
            errorEl.textContent = '';
            errorEl.classList.add('hidden');
        }
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Saving...';
        }
        this._setContactModalStatus('Saving contact...', 'loading');

        const payload = {
            first_name: firstName || null,
            last_name: lastName || null
        };
        const data = context.mode === 'entity'
            ? await this.app.api(
                'POST',
                `/api/messages/${encodeURIComponent(sessionName)}/user/${encodeURIComponent(context.entityId)}/contact`,
                payload
            )
            : await this.app.api(
                'POST',
                `/api/messages/${encodeURIComponent(sessionName)}/contacts`,
                {
                    identifier,
                    ...payload
                }
            );

        this.isSubmittingContact = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Contact';
        }

        if (!data) {
            if (errorEl) {
                errorEl.textContent = 'Could not save this contact';
                errorEl.classList.remove('hidden');
            }
            this._setContactModalStatus('Contact was not saved. Check the identifier and try again.', 'error');
            return;
        }

        this._setContactModalStatus(data.message || 'Contact saved', 'success');
        this.app.hideModal('modal-add-contact');
        this.contactModalContext = null;

        if (context.mode === 'entity' && this.resolvedEntity && String(this.resolvedEntity.id) === String(context.entityId)) {
            this.resolvedEntity = {
                ...this.resolvedEntity,
                ...data
            };
            this._updateResolvedContactButton();
        }

        if (
            this.app.profileManager
            && this.app.profileManager.loadedChatProfile
            && String(this.app.profileManager.loadedChatProfile.id) === String(context.entityId || '')
        ) {
            this.app.profileManager.loadedChatProfile = {
                ...this.app.profileManager.loadedChatProfile,
                ...data
            };
            this.app.profileManager._renderChatUserInfo(this.app.profileManager.loadedChatProfile);
        }

        this.refreshContactsForCurrentAccount();
        this.app.showToast(data.message || 'Contact added', 'success');
    }

    /**
     * Show an inline state inside the add/edit contact modal.
     * @param {string} message
     * @param {string} type
     */
    _setContactModalStatus(message, type = '') {
        const statusEl = document.getElementById('add-contact-status');
        if (!statusEl) return;

        if (!message) {
            statusEl.textContent = '';
            statusEl.className = 'contact-action-status hidden';
            return;
        }

        statusEl.textContent = message;
        statusEl.className = `contact-action-status${type ? ` is-${type}` : ''}`;
    }

    /**
     * Return a human-friendly user name.
     * @param {object} entity
     * @returns {string}
     */
    _getUserEntityDisplayName(entity) {
        return entity?.display_name
            || [entity?.first_name, entity?.last_name].filter(Boolean).join(' ')
            || entity?.username
            || (entity?.id ? String(entity.id) : '');
    }

    /**
     * Return a short identifier label for contact modals.
     * @param {object} entity
     * @returns {string}
     */
    _getContactIdentifierLabel(entity) {
        if (!entity) return '';
        if (entity.username) return `@${entity.username}`;
        if (entity.phone) return `${entity.phone}`;
        if (entity.id) return `ID: ${entity.id}`;
        return '';
    }

    /**
     * Update the Add to contact button state for the resolved entity.
     */
    _updateResolvedContactButton() {
        const btnAddContact = document.getElementById('btn-add-resolved-contact');
        if (!btnAddContact) return;

        const resolved = this.resolvedEntity;
        const canShow = Boolean(resolved && (resolved.can_add_to_contacts || resolved.is_contact));

        if (!canShow) {
            btnAddContact.classList.add('hidden');
            btnAddContact.disabled = false;
            btnAddContact.textContent = 'Add to contact';
            return;
        }

        btnAddContact.classList.remove('hidden');
        btnAddContact.textContent = resolved.is_contact ? 'Edit contact' : 'Add to contact';
        btnAddContact.disabled = false;
    }

    /**
     * Handle new message from WebSocket
     * @param {object} data - WSEvent with event_type='new_message'
     */
    onNewMessage(data) {
        if (!data || !data.data) return;

        const msg = data.data;
        const sessionName = data.session_name;

        // If message is for the currently active chat, append to view
        if (sessionName === this.app.state.currentAccount) {
            const senderId = msg.sender_id;
            const chatId = this.app.state.currentChat;
            this._syncDialogsWithMessage(msg);

            // Check if the message belongs to the current chat
            // The sender or the chat entity could match
            const isCurrentChat = (senderId == chatId) || msg.is_outgoing || (msg.chat_id && msg.chat_id == chatId);

            if (isCurrentChat) {
                const container = document.getElementById('messages-container');
                if (container && !container.classList.contains('hidden')) {
                    // Don't add duplicates
                    const existing = container.querySelector(`[data-message-id="${msg.id}"]`);
                    if (!existing) {
                        container.appendChild(this.renderMessage(msg));
                        this._storeIncomingMessage(msg);

                        // Auto-scroll if near bottom
                        const messagesArea = document.getElementById('messages-area');
                        if (messagesArea) {
                            const isNearBottom = messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight < 150;
                            if (isNearBottom || msg.is_outgoing) {
                                this.scrollToBottom(true);
                            }
                        }
                    } else {
                        existing.replaceWith(this.renderMessage(msg));
                        this._replaceStoredMessage(msg.id, msg);
                    }
                }

                if (!msg.is_outgoing) {
                    this.markChatReadIfNeeded(sessionName, chatId, 'new_message');
                }
            }

            // Also update dialog preview
            this._updateDialogPreview(msg);
        }
    }

    /**
     * Handle read-receipt updates for outgoing messages.
     * @param {object} data - WSEvent with event_type='messages_read'
     */
    onMessagesRead(data) {
        if (!data?.data || data.session_name !== this.app.state.currentAccount) {
            return;
        }

        const chatId = data.data.chat_id;
        const maxId = Number(data.data.max_id || 0);
        if (!chatId || !maxId) {
            return;
        }

        this._markMessagesAsRead(chatId, maxId);
    }

    /**
     * Mark the current chat as read when Ghost-mode allows it.
     * @param {string} reason
     * @returns {Promise<boolean>}
     */
    async markCurrentChatReadIfNeeded(reason = 'manual') {
        return this.markChatReadIfNeeded(
            this.app.state.currentAccount,
            this.app.state.currentChat,
            reason
        );
    }

    /**
     * Mark a chat as read unless Ghost-mode is enabled.
     * @param {string} sessionName
     * @param {string|number} entityId
     * @param {string} reason
     * @returns {Promise<boolean>}
     */
    async markChatReadIfNeeded(sessionName, entityId, reason = 'manual') {
        if (this.app.state.ghostModeEnabled) {
            return false;
        }

        return this.markChatAsRead(sessionName, entityId, reason);
    }

    /**
     * Send Telegram read acknowledgement and clear local unread counters.
     * @param {string} sessionName
     * @param {string|number} entityId
     * @param {string} reason
     * @returns {Promise<boolean>}
     */
    async markChatAsRead(sessionName, entityId, reason = 'manual') {
        if (!sessionName || !entityId) {
            return false;
        }

        if (
            String(this.app.state.currentAccount) !== String(sessionName)
            || String(this.app.state.currentChat) !== String(entityId)
        ) {
            return false;
        }

        const requestKey = `${sessionName}:${entityId}`;
        if (this.markReadRequests.has(requestKey)) {
            return false;
        }

        this.markReadRequests.add(requestKey);

        try {
            const data = await this.app.api(
                'POST',
                `/api/messages/${encodeURIComponent(sessionName)}/read/${encodeURIComponent(entityId)}`
            );

            if (!data?.ok) {
                return false;
            }

            this._clearUnreadForDialog(entityId);
            console.log('[ChatManager] Marked chat as read:', sessionName, entityId, reason);
            return true;
        } finally {
            this.markReadRequests.delete(requestKey);
        }
    }

    /**
     * Update dialog list item with latest message
     */
    _updateDialogPreview(msg) {
        const dialogItems = document.querySelectorAll('.dialog-item');
        dialogItems.forEach(item => {
            const entityId = item.dataset.entityId;
            if (entityId == msg.sender_id || entityId == msg.chat_id) {
                const preview = item.querySelector('.dialog-preview');
                const time = item.querySelector('.dialog-time');
                const previewText = msg.preview_text || msg.text || `[${this._getMediaLabel(msg)}]`;
                if (preview) preview.textContent = this._truncate(previewText, 50);
                if (time) time.textContent = this.formatTime(msg.date);
            }
        });
    }

    /**
     * Keep sidebar dialogs aligned with real-time messages.
     * Updates existing entries locally and refreshes from API when a chat is new.
     * @param {object} msg
     */
    _syncDialogsWithMessage(msg) {
        const dialogId = this._getDialogIdFromMessage(msg);
        if (!dialogId) return;

        const dialogs = Array.isArray(this.app.state.dialogs) ? [...this.app.state.dialogs] : [];
        const existingIndex = dialogs.findIndex(dialog => String(dialog.id) === String(dialogId));

        if (existingIndex === -1) {
            this._refreshDialogsForCurrentAccount();
            return;
        }

        const updatedDialog = { ...dialogs[existingIndex] };
        updatedDialog.last_message = msg.preview_text || msg.text || `[${this._getMediaLabel(msg)}]`;
        updatedDialog.last_message_date = msg.date || updatedDialog.last_message_date;
        updatedDialog.last_message_sender = msg.sender_name || updatedDialog.last_message_sender || '';

        if (String(this.app.state.currentChat) === String(dialogId)) {
            updatedDialog.unread_count = 0;
        } else if (!msg.is_outgoing) {
            updatedDialog.unread_count = (updatedDialog.unread_count || 0) + 1;
        }

        dialogs.splice(existingIndex, 1);
        dialogs.unshift(updatedDialog);
        this.app.state.dialogs = dialogs;
        this.renderDialogs(dialogs);
    }

    /**
     * Refresh dialogs only once at a time.
     * Used when a message arrives for a chat that is not yet in the sidebar.
     */
    _refreshDialogsForCurrentAccount() {
        const sessionName = this.app.state.currentAccount;
        if (!sessionName || this.isRefreshingDialogs) return;

        this.isRefreshingDialogs = true;
        this.loadDialogs(sessionName).finally(() => {
            this.isRefreshingDialogs = false;
        });
    }

    /**
     * Refresh contacts for the currently selected account.
     */
    refreshContactsForCurrentAccount() {
        const sessionName = this.app.state.currentAccount;
        if (!sessionName || this.isLoadingContacts) return;

        this.loadContacts(sessionName);
    }

    /**
     * Load current chat presence for private chats and update the header.
     */
    async loadCurrentChatPresence() {
        const sessionName = this.app.state.currentAccount;
        const entityId = this.app.state.currentChat;
        const dialog = this._getCurrentDialog();

        if (!sessionName || !entityId || (dialog && (dialog.is_group || dialog.is_channel))) {
            this._setChatHeaderPresence('', false);
            return;
        }

        const data = await this.app.api(
            'GET',
            `/api/messages/${encodeURIComponent(sessionName)}/user/${encodeURIComponent(entityId)}`
        );
        if (!data) {
            return;
        }

        if (String(this.app.state.currentChat) !== String(entityId)) {
            return;
        }

        this._setChatHeaderPresence(data.status || '', (data.status || '') === 'online');
    }

    /**
     * Handle typing events for the current private chat.
     * @param {object} data
     */
    onTyping(data) {
        if (!data?.data || data.session_name !== this.app.state.currentAccount) {
            return;
        }

        const entityId = data.data.entity_id ?? data.data.user_id;
        if (String(entityId) !== String(this.app.state.currentChat)) {
            return;
        }

        const statusEl = document.getElementById('chat-header-status');
        if (!statusEl) {
            return;
        }

        statusEl.textContent = 'typing...';
        if (this.typingResetTimer) {
            clearTimeout(this.typingResetTimer);
        }

        this.typingResetTimer = setTimeout(() => {
            this.typingResetTimer = null;
            if (String(this.app.state.currentChat) === String(entityId)) {
                statusEl.textContent = this.app.state.currentChatStatus || '';
            }
        }, 3000);
    }

    /**
     * Handle user presence updates from WebSocket.
     * @param {object} data
     */
    onUserPresence(data) {
        if (!data?.data || data.session_name !== this.app.state.currentAccount) {
            return;
        }

        const entityId = data.data.entity_id ?? data.data.user_id;
        if (String(entityId) !== String(this.app.state.currentChat)) {
            return;
        }

        this._setChatHeaderPresence(
            data.data.status || '',
            Boolean(data.data.is_online || data.data.status === 'online')
        );
    }

    /**
     * Update delete button visibility for the currently selected chat.
     */
    updateDeleteChatButton() {
        const button = document.getElementById('btn-delete-chat');
        if (!button) return;

        const dialog = this._getCurrentDialog();
        const isNonPrivateDialog = Boolean(dialog && (dialog.is_group || dialog.is_channel));
        const hasCurrentPrivateDialog = Boolean(this.app.state.currentChat && dialog && !isNonPrivateDialog);

        button.classList.toggle('hidden', !hasCurrentPrivateDialog);
        button.disabled = !hasCurrentPrivateDialog;
        button.title = isNonPrivateDialog
            ? 'Only private chats with users can be deleted for both participants'
            : 'Delete chat for both participants';
    }

    /**
     * Update header subtitle and online badge for the current chat.
     * @param {string} statusText
     * @param {boolean} isOnline
     */
    _setChatHeaderPresence(statusText, isOnline = false) {
        const normalizedStatus = String(statusText || '').trim();
        this.app.state.currentChatStatus = normalizedStatus;
        this.app.state.currentChatIsOnline = Boolean(isOnline);

        const statusEl = document.getElementById('chat-header-status');
        if (statusEl && statusEl.textContent !== 'typing...') {
            statusEl.textContent = normalizedStatus;
        }

        const presenceEl = document.getElementById('chat-header-presence');
        if (!presenceEl) {
            return;
        }

        if (Boolean(isOnline)) {
            presenceEl.textContent = 'online';
            presenceEl.classList.remove('hidden');
        } else {
            presenceEl.textContent = '';
            presenceEl.classList.add('hidden');
        }
    }

    /**
     * Render message media based on media kind and metadata
     * @param {object} msg
     * @returns {string}
     */
    _renderMediaHtml(msg) {
        const mediaKind = msg.media_kind || '';
        const mediaUrl = msg.media_url || '';
        const mimeType = String(msg.mime_type || '').toLowerCase();

        if (mediaKind === 'contact' && msg.contact) {
            return this._renderContactHtml(msg.contact);
        }

        if (!mediaUrl) {
            if (msg.media_type) {
                return `
                    <div class="message-media message-media-card message-media-empty-card">
                        <span class="message-media-type">Attachment</span>
                        <div class="message-media-title">${this._escapeHtml(this._getMediaLabel(msg))}</div>
                        <div class="message-media-caption">Preview is not available yet</div>
                    </div>
                `;
            }
            return '';
        }

        const safeUrl = this._escapeAttribute(mediaUrl);
        const rawMediaLabel = this._getMediaLabel(msg);
        const mediaLabel = this._escapeHtml(rawMediaLabel);
        const fileName = this._escapeHtml(msg.file_name || rawMediaLabel);
        const duration = msg.duration ? this._escapeHtml(this._formatDuration(msg.duration)) : '';
        const fileSize = msg.file_size ? this._escapeHtml(this._formatFileSize(msg.file_size)) : '';

        if (
            mediaKind === 'photo'
            || mediaKind === 'sticker'
            || this._isInlineRenderableImageMimeType(mimeType)
        ) {
            return `
                <div class="message-media message-media-photo-card">
                    <a class="message-media-link" href="${safeUrl}" target="_blank" rel="noopener">
                        <img class="message-photo" src="${safeUrl}" alt="${mediaLabel}" loading="lazy">
                    </a>
                </div>
            `;
        }

        if (mediaKind === 'audio' || mediaKind === 'voice') {
            const meta = [fileName, duration].filter(Boolean).join(' · ');
            return `
                <div class="message-media message-media-card message-media-audio-card">
                    <div class="message-media-head">
                        <span class="message-media-type">${mediaKind === 'voice' ? 'Voice' : 'Audio'}</span>
                        ${meta ? `<span class="message-media-caption">${meta}</span>` : ''}
                    </div>
                    <div class="message-media-title">${mediaLabel}</div>
                    <audio class="message-audio" controls preload="metadata" src="${safeUrl}"></audio>
                </div>
            `;
        }

        if (mediaKind === 'video' || (msg.mime_type || '').startsWith('video/')) {
            const meta = [fileName, duration].filter(Boolean).join(' · ');
            return `
                <div class="message-media message-media-video-card">
                    ${meta ? `<div class="message-media-caption">${meta}</div>` : ''}
                    <video class="message-video" controls preload="metadata" src="${safeUrl}"></video>
                </div>
            `;
        }

        const mimeLabel = mimeType ? this._escapeHtml(mimeType) : '';
        const meta = [fileSize, mimeLabel].filter(Boolean).join(' · ');
        return `
            <div class="message-media message-media-card message-media-file-card">
                <a class="message-file-link" href="${safeUrl}" target="_blank" rel="noopener" download>
                    <span class="message-file-icon" aria-hidden="true"></span>
                    <span class="message-file-body">
                        <span class="message-file-title">${fileName || mediaLabel}</span>
                        ${meta ? `<span class="message-file-meta">${meta}</span>` : ''}
                    </span>
                </a>
            </div>
        `;
    }

    /**
     * Render a contact card shared in Telegram chat
     * @param {object} contact
     * @returns {string}
     */
    _renderContactHtml(contact) {
        const displayName = this._escapeHtml(this._getContactDisplayName(contact));
        const phoneNumber = contact.phone_number ? this._escapeHtml(contact.phone_number) : '';
        const actionText = contact.can_open ? 'Open chat' : 'Contact card';
        const initials = this._escapeHtml(this.getInitials(this._getContactDisplayName(contact)));
        const userId = contact.user_id ? this._escapeHtml(String(contact.user_id)) : '';

        return `
            <div class="message-media message-media-card message-media-contact-card-wrap">
                <button
                    type="button"
                    class="message-contact-card${contact.can_open ? ' is-clickable' : ''}"
                    ${contact.can_open ? '' : 'disabled'}
                    title="${contact.can_open ? 'Open dialog with this contact' : 'Contact info only'}"
                    data-user-id="${userId}"
                >
                    <div class="message-contact-avatar">${initials}</div>
                    <div class="message-contact-body">
                        <div class="message-contact-name">${displayName}</div>
                        ${phoneNumber ? `<div class="message-contact-phone">${phoneNumber}</div>` : ''}
                        <div class="message-contact-action">${actionText}</div>
                    </div>
                </button>
            </div>
        `;
    }

    /**
     * Open a chat using contact info from MessageMediaContact
     * @param {object} contact
     */
    async openContactChat(contact) {
        const sessionName = this.app.state.currentAccount;
        if (!sessionName) {
            this.app.showToast('No account selected', 'warning');
            return;
        }

        const displayName = this._getContactDisplayName(contact);
        if (contact.user_id) {
            this.app.selectChat(contact.user_id, displayName);
            this._refreshDialogsForCurrentAccount();
            return;
        }

        if (!contact.phone_number) {
            this.app.showToast('This contact cannot be opened from Telegram data', 'warning');
            return;
        }

        const resolved = await this.app.api('POST', `/api/messages/${encodeURIComponent(sessionName)}/resolve`, {
            identifier: contact.phone_number
        });

        if (!resolved || !resolved.id) {
            this.app.showToast('Could not open this contact', 'warning');
            return;
        }

        const resolvedName = [resolved.first_name, resolved.last_name].filter(Boolean).join(' ')
            || resolved.username
            || displayName;

        this.app.selectChat(resolved.id, resolvedName);
        this._refreshDialogsForCurrentAccount();
    }

    /**
     * Resolve the dialog identifier represented by a message.
     * @param {object} msg
     * @returns {string|number|null}
     */
    _getDialogIdFromMessage(msg) {
        return msg.chat_id || msg.sender_id || null;
    }

    /**
     * Get current dialog metadata from the loaded sidebar list.
     * @returns {object|null}
     */
    _getCurrentDialog() {
        const dialogs = Array.isArray(this.app.state.dialogs) ? this.app.state.dialogs : [];
        return dialogs.find(dialog => String(dialog.id) === String(this.app.state.currentChat)) || null;
    }

    /**
     * Get current contact metadata from the loaded contacts list.
     * @returns {object|null}
     */
    _getCurrentContact() {
        const contacts = Array.isArray(this.app.state.contacts) ? this.app.state.contacts : [];
        return contacts.find(contact => String(contact.id) === String(this.app.state.currentChat)) || null;
    }

    /**
     * Get best known metadata for a selected chat.
     * @param {string|number} entityId
     * @returns {object|null}
     */
    _getCurrentChatContext(entityId = null) {
        const targetId = entityId ?? this.app.state.currentChat;
        const dialog = this._getCurrentDialog();
        if (dialog && String(dialog.id) === String(targetId)) {
            return dialog;
        }

        const contact = this._getCurrentContact();
        if (contact && String(contact.id) === String(targetId)) {
            return contact;
        }

        return null;
    }

    /**
     * Build display name for the chat header.
     * @param {object|null} context
     * @param {string} title
     * @param {string|number} entityId
     * @returns {string}
     */
    _getChatHeaderName(context, title, entityId) {
        return title
            || context?.name
            || context?.display_name
            || [context?.first_name, context?.last_name].filter(Boolean).join(' ')
            || context?.username
            || `Chat ${entityId || ''}`.trim()
            || 'Chat';
    }

    /**
     * Build compact metadata for the chat header subtitle.
     * @param {object|null} context
     * @param {string|number} entityId
     * @returns {string}
     */
    _getChatHeaderMeta(context, entityId) {
        const parts = [];
        const username = context?.username ? `@${context.username}` : '';
        const typeLabel = this._getChatHeaderType(context) || 'Private';

        if (username) {
            parts.push(username);
        }

        parts.push(typeLabel === 'Private' ? 'Private chat' : typeLabel);

        if (!username && entityId) {
            parts.push(`ID ${entityId}`);
        }

        return parts.join(' · ');
    }

    /**
     * Return the short chat type label used in the header.
     * @param {object|null} context
     * @returns {string}
     */
    _getChatHeaderType(context) {
        if (context?.is_channel) return 'Channel';
        if (context?.is_group) return 'Group';
        if (context?.is_bot) return 'Bot';
        return 'Private';
    }

    /**
     * Render delivery status for outgoing messages.
     * @param {object} msg
     * @returns {string}
     */
    _renderDeliveryStatusHtml(msg) {
        if (!msg?.is_outgoing) {
            return '';
        }

        if (msg.send_status === 'sending') {
            return '<span class="message-send-state is-sending" title="Sending" aria-label="Sending">sending</span>';
        }

        if (msg.send_status === 'failed') {
            return '<span class="message-send-state is-failed" title="Failed to send" aria-label="Failed to send">failed</span>';
        }

        return this._renderReadStatusHtml(msg);
    }

    /**
     * Render Telegram-like read ticks for outgoing messages.
     * @param {object} msg
     * @returns {string}
     */
    _renderReadStatusHtml(msg) {
        if (!msg?.is_outgoing) {
            return '';
        }

        const isRead = Boolean(msg.is_read);
        return `
            <span
                class="message-read-status${isRead ? ' is-read' : ''}"
                title="${isRead ? 'Read' : 'Sent'}"
                aria-label="${isRead ? 'Read' : 'Sent'}"
            >${isRead ? '✓✓' : '✓'}</span>
        `;
    }

    /**
     * Sync read-status DOM state for one rendered outgoing message.
     * @param {HTMLElement|null} element
     * @param {object} msg
     */
    _applyReadStatusToElement(element, msg) {
        if (!element || !msg?.is_outgoing) {
            return;
        }

        const readStatusEl = element.querySelector('.message-read-status');
        if (!readStatusEl) {
            return;
        }

        const isRead = Boolean(msg.is_read);
        readStatusEl.classList.toggle('is-read', isRead);
        readStatusEl.textContent = isRead ? '✓✓' : '✓';
        readStatusEl.title = isRead ? 'Read' : 'Sent';
        readStatusEl.setAttribute('aria-label', isRead ? 'Read' : 'Sent');
    }

    /**
     * Store or append a message in local chat state.
     * @param {object} msg
     */
    _storeIncomingMessage(msg) {
        const messages = Array.isArray(this.app.state.messages) ? [...this.app.state.messages] : [];
        const index = messages.findIndex(item => String(item.id) === String(msg.id));
        if (index === -1) {
            messages.push(msg);
        } else {
            messages[index] = msg;
        }
        this.app.state.messages = messages;
    }

    /**
     * Replace one message in local state, preserving order.
     * @param {string|number} oldId
     * @param {object} newMessage
     */
    _replaceStoredMessage(oldId, newMessage) {
        const messages = Array.isArray(this.app.state.messages) ? [...this.app.state.messages] : [];
        const index = messages.findIndex(item => String(item.id) === String(oldId));
        if (index === -1) {
            messages.push(newMessage);
        } else {
            messages[index] = newMessage;
        }
        this.app.state.messages = messages;
    }

    /**
     * Mark outgoing messages as read up to maxId for one chat.
     * @param {string|number} chatId
     * @param {number} maxId
     */
    _markMessagesAsRead(chatId, maxId) {
        const normalizedChatId = String(chatId);
        const numericMaxId = Number(maxId);
        if (!numericMaxId) {
            return;
        }

        const messages = Array.isArray(this.app.state.messages) ? [...this.app.state.messages] : [];
        this.app.state.messages = messages.map(message => {
            if (
                message
                && message.is_outgoing
                && !message.is_read
                && String(message.chat_id) === normalizedChatId
                && Number(message.id) <= numericMaxId
            ) {
                return { ...message, is_read: true };
            }
            return message;
        });

        if (String(this.app.state.currentChat) !== normalizedChatId) {
            return;
        }

        const container = document.getElementById('messages-container');
        if (!container) {
            return;
        }

        container.querySelectorAll('.message-outgoing[data-message-id]').forEach(element => {
            const messageId = Number(element.dataset.messageId);
            if (!Number.isFinite(messageId) || messageId > numericMaxId) {
                return;
            }

            const readStatusEl = element.querySelector('.message-read-status');
            if (!readStatusEl) {
                return;
            }

            readStatusEl.classList.add('is-read');
            readStatusEl.textContent = '✓✓';
            readStatusEl.title = 'Read';
            readStatusEl.setAttribute('aria-label', 'Read');
        });
    }

    /**
     * Remove a dialog from local state and rerender the sidebar.
     * @param {string|number} entityId
     */
    _removeDialogFromState(entityId) {
        const dialogs = Array.isArray(this.app.state.dialogs) ? this.app.state.dialogs : [];
        this.app.state.dialogs = dialogs.filter(dialog => String(dialog.id) !== String(entityId));
        this.renderDialogs(this.app.state.dialogs);
    }

    /**
     * Clear unread badge for a dialog in local state and DOM.
     * @param {string|number} entityId
     */
    _clearUnreadForDialog(entityId) {
        const dialogs = Array.isArray(this.app.state.dialogs) ? this.app.state.dialogs : [];
        let changed = false;

        const updatedDialogs = dialogs.map(dialog => {
            if (String(dialog.id) !== String(entityId)) {
                return dialog;
            }

            if (!dialog.unread_count) {
                return dialog;
            }

            changed = true;
            return { ...dialog, unread_count: 0 };
        });

        if (changed) {
            this.app.state.dialogs = updatedDialogs;
            this.renderDialogs(updatedDialogs);
            return;
        }

        document.querySelectorAll('.dialog-item').forEach(item => {
            if (String(item.dataset.entityId) !== String(entityId)) {
                return;
            }

            const unreadBadge = item.querySelector('.dialog-unread');
            if (unreadBadge) {
                unreadBadge.remove();
            }
        });
    }

    /**
     * Handle scroll events - load older messages on scroll to top
     */
    handleScroll() {
        const messagesArea = document.getElementById('messages-area');
        if (!messagesArea) return;

        // Load more when scrolled near top
        if (messagesArea.scrollTop < 100 && this.hasMoreMessages && !this.isLoadingHistory && this.oldestMessageId) {
            this._loadOlderMessages();
        }
    }

    /**
     * Load older messages and prepend them
     */
    async _loadOlderMessages() {
        if (this.isLoadingHistory || !this.hasMoreMessages) return;
        this.isLoadingHistory = true;

        const sessionName = this.app.state.currentAccount;
        const entityId = this.app.state.currentChat;
        if (!sessionName || !entityId) {
            this.isLoadingHistory = false;
            return;
        }

        const messagesArea = document.getElementById('messages-area');
        const prevScrollHeight = messagesArea ? messagesArea.scrollHeight : 0;

        const url = `/api/messages/${encodeURIComponent(sessionName)}/history/${encodeURIComponent(entityId)}?limit=30&offset_id=${this.oldestMessageId}`;
        const data = await this.app.api('GET', url);

        this.isLoadingHistory = false;

        if (!data || !Array.isArray(data) || data.length === 0) {
            this.hasMoreMessages = false;
            return;
        }

        if (data.length < 30) {
            this.hasMoreMessages = false;
        }

        // Update oldest message ID
        const sorted = [...data].sort((a, b) => new Date(a.date) - new Date(b.date));
        if (sorted.length > 0) {
            this.oldestMessageId = sorted[0].id;
        }

        // Prepend messages
        this.renderMessages(data, true);

        // Maintain scroll position
        if (messagesArea) {
            const newScrollHeight = messagesArea.scrollHeight;
            messagesArea.scrollTop = newScrollHeight - prevScrollHeight;
        }
    }

    /**
     * Scroll messages area to bottom
     * @param {boolean} smooth
     */
    scrollToBottom(smooth = false) {
        const messagesArea = document.getElementById('messages-area');
        if (!messagesArea) return;

        requestAnimationFrame(() => {
            messagesArea.scrollTo({
                top: messagesArea.scrollHeight,
                behavior: smooth ? 'smooth' : 'auto'
            });
        });
    }

    /**
     * Format a date string to time display
     * @param {string} dateStr
     * @returns {string}
     */
    formatTime(dateStr) {
        if (!dateStr) return '';
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

            if (diffDays === 0) {
                return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } else if (diffDays === 1) {
                return 'Yesterday';
            } else if (diffDays < 7) {
                return date.toLocaleDateString([], { weekday: 'short' });
            } else {
                return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
            }
        } catch {
            return '';
        }
    }

    /**
     * Format time for message bubbles (HH:MM)
     */
    _formatTime(dateStr) {
        if (!dateStr) return '';
        try {
            const date = new Date(dateStr);
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
            return '';
        }
    }

    /**
     * Format full date for date separators
     */
    _formatDate(dateStr) {
        if (!dateStr) return '';
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

            if (diffDays === 0) return 'Today';
            if (diffDays === 1) return 'Yesterday';
            return date.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
        } catch {
            return '';
        }
    }

    /**
     * Get initials from a name
     * @param {string} name
     * @returns {string}
     */
    getInitials(name) {
        if (!name) return '?';
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return (parts[0][0] || '?').toUpperCase();
    }

    /**
     * Truncate text to maxLen
     */
    _truncate(text, maxLen) {
        if (!text) return '';
        return text.length > maxLen ? text.substring(0, maxLen) + '…' : text;
    }

    /**
     * Get a small chat type label for the sidebar.
     * @param {object} dialog
     * @returns {string}
     */
    _getDialogTypeLabel(dialog) {
        if (dialog?.is_channel) return 'Channel';
        if (dialog?.is_group) return 'Group';
        return '';
    }

    /**
     * Extract media badge from preview text like "[Photo]".
     * @param {string} preview
     * @returns {string}
     */
    _getDialogPreviewBadge(preview) {
        const match = String(preview || '').match(/^\[([^\]]+)\]/);
        return match ? match[1] : '';
    }

    /**
     * Remove leading media marker from a dialog preview.
     * @param {string} preview
     * @returns {string}
     */
    _cleanDialogPreview(preview) {
        const cleaned = String(preview || '').replace(/^\[[^\]]+\]\s*/, '').trim();
        return cleaned || preview || 'No preview';
    }

    /**
     * Escape HTML
     */
    _escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Escape HTML for attribute values
     * @param {string} text
     * @returns {string}
     */
    _escapeAttribute(text) {
        return this._escapeHtml(text);
    }

    /**
     * Get a short media label for previews and badges
     * @param {object} msg
     * @returns {string}
     */
    _getMediaLabel(msg) {
        const labels = {
            audio: 'Audio',
            contact: 'Contact',
            document: 'File',
            gif: 'GIF',
            photo: 'Photo',
            sticker: 'Sticker',
            video: 'Video',
            voice: 'Voice message'
        };

        if (msg.media_kind && labels[msg.media_kind]) {
            return labels[msg.media_kind];
        }

        if (msg.file_name) {
            return msg.file_name;
        }

        return msg.media_type || 'Attachment';
    }

    /**
     * Return whether a browser can likely render this image MIME inline.
     * @param {string} mimeType
     * @returns {boolean}
     */
    _isInlineRenderableImageMimeType(mimeType) {
        const normalized = String(mimeType || '').toLowerCase();
        if (!normalized.startsWith('image/')) {
            return false;
        }

        return ![
            'image/heic',
            'image/heif',
            'image/heic-sequence',
            'image/heif-sequence'
        ].includes(normalized);
    }

    /**
     * Build display name for a contact card
     * @param {object} contact
     * @returns {string}
     */
    _getContactDisplayName(contact) {
        if (!contact) return 'Contact';
        return contact.display_name
            || [contact.first_name, contact.last_name].filter(Boolean).join(' ')
            || contact.phone_number
            || 'Contact';
    }

    /**
     * Build contact metadata line for the contacts sidebar.
     * @param {object} contact
     * @returns {string}
     */
    _getContactListMeta(contact) {
        const metaParts = [];

        if (contact.username) {
            metaParts.push(`@${contact.username}`);
        }

        if (contact.phone) {
            metaParts.push(contact.phone);
        }

        if (contact.is_bot) {
            metaParts.push('Telegram bot');
        } else if (contact.status && contact.status !== 'unknown') {
            metaParts.push(contact.status);
        }

        return metaParts.join(' · ') || 'Open chat';
    }

    /**
     * Build avatar HTML for dialog/contact sidebar items.
     * @param {string|null} photoUrl
     * @param {string} label
     * @param {string|number} seed
     * @returns {string}
     */
    _buildSidebarAvatarHtml(photoUrl, label, seed) {
        const colorIdx = Math.abs(this._hashCode(String(seed || label || ''))) % 8;
        const classes = `dialog-avatar avatar-color-${colorIdx}${photoUrl ? ' has-photo' : ''}`;

        if (photoUrl) {
            return `
                <div class="${classes}">
                    <img src="${this._escapeAttribute(photoUrl)}" alt="${this._escapeHtml(label)}">
                </div>
            `;
        }

        return `<div class="${classes}">${this._escapeHtml(this.getInitials(label))}</div>`;
    }

    /**
     * Format media file size for display
     * @param {number} bytes
     * @returns {string}
     */
    _formatFileSize(bytes) {
        if (!bytes || Number.isNaN(Number(bytes))) return '';
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = Number(bytes);
        let unitIdx = 0;

        while (size >= 1024 && unitIdx < units.length - 1) {
            size /= 1024;
            unitIdx += 1;
        }

        const precision = unitIdx === 0 ? 0 : 1;
        return `${size.toFixed(precision)} ${units[unitIdx]}`;
    }

    /**
     * Format media duration to mm:ss
     * @param {number} seconds
     * @returns {string}
     */
    _formatDuration(seconds) {
        const totalSeconds = Math.max(0, Math.round(Number(seconds)));
        const minutes = Math.floor(totalSeconds / 60);
        const remainingSeconds = String(totalSeconds % 60).padStart(2, '0');
        return `${minutes}:${remainingSeconds}`;
    }

    /**
     * Simple hash
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
