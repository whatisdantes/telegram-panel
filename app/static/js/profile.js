/**
 * Profile Manager - handles profile viewing, editing, avatar management
 */
class ProfileManager {
    constructor(app) {
        this.app = app;
        this.loadedProfile = null;
        this.loadedChatProfile = null;
        this.loadedPrivacySettings = {};
        this.avatarUploadQueue = [];
        this.isAvatarUploadInProgress = false;
        this.hasLocalAvatarBatchRequest = false;
        this.avatarUploadProgress = null;
        this._bindEvents();
    }

    /**
     * Bind profile modal events
     */
    _bindEvents() {
        // Save profile button
        const btnSave = document.getElementById('btn-save-profile');
        if (btnSave) {
            btnSave.addEventListener('click', () => {
                this._handleSaveProfile();
            });
        }

        // Avatar upload
        const inputAvatar = document.getElementById('input-avatar-upload');
        if (inputAvatar) {
            inputAvatar.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    this._handleAvatarUpload(file);
                }
                // Reset input so same file can be selected again
                inputAvatar.value = '';
            });
        }

        const inputAvatarQueue = document.getElementById('input-avatar-upload-queue');
        if (inputAvatarQueue) {
            inputAvatarQueue.addEventListener('change', (e) => {
                this._handleAvatarQueueSelection(e.target.files);
                inputAvatarQueue.value = '';
            });
        }

        // Delete avatar
        const btnDeleteAvatar = document.getElementById('btn-delete-avatar');
        if (btnDeleteAvatar) {
            btnDeleteAvatar.addEventListener('click', () => {
                this._handleDeleteAvatar();
            });
        }

        const btnUploadQueue = document.getElementById('btn-upload-avatar-queue');
        if (btnUploadQueue) {
            btnUploadQueue.addEventListener('click', () => {
                this._handleQueuedAvatarUpload();
            });
        }

        const btnClearQueue = document.getElementById('btn-clear-avatar-queue');
        if (btnClearQueue) {
            btnClearQueue.addEventListener('click', () => {
                this._clearAvatarQueue();
            });
        }

        // Chat header user info button
        const btnUserInfo = document.getElementById('btn-chat-user-info');
        if (btnUserInfo) {
            btnUserInfo.addEventListener('click', () => {
                this._showChatUserInfo();
            });
        }

        const profileTrigger = document.getElementById('chat-profile-trigger');
        if (profileTrigger) {
            profileTrigger.addEventListener('click', () => {
                if (this._isCurrentChatProfileAvailable()) {
                    this._showChatUserInfo();
                }
            });
        }

        const btnAccountInfoPrimary = document.getElementById('btn-account-info-primary');
        if (btnAccountInfoPrimary) {
            btnAccountInfoPrimary.addEventListener('click', () => {
                this._handleAddChatUserToContacts();
            });
        }

        const btnAccountInfoOpenChat = document.getElementById('btn-account-info-open-chat');
        if (btnAccountInfoOpenChat) {
            btnAccountInfoOpenChat.addEventListener('click', () => {
                this._handleOpenChatFromProfile();
            });
        }

        const btnAccountInfoDeleteChat = document.getElementById('btn-account-info-delete-chat');
        if (btnAccountInfoDeleteChat) {
            btnAccountInfoDeleteChat.addEventListener('click', () => {
                this._handleDeleteChatFromProfile();
            });
        }
    }

    /**
     * Load profile data for the current account
     * @param {string} sessionName
     */
    async loadProfile(sessionName) {
        const data = await this.app.api('GET', `/api/accounts/${encodeURIComponent(sessionName)}/me`);
        if (!data) return null;

        this.loadedProfile = {
            first_name: data.first_name || '',
            last_name: data.last_name || '',
            username: data.username || '',
            phone: data.phone || '',
            photo_url: data.photo_url || null,
            id: data.id || null
        };

        // Populate form fields
        const firstName = document.getElementById('profile-first-name');
        const lastName = document.getElementById('profile-last-name');
        const username = document.getElementById('profile-username');
        const phone = document.getElementById('profile-phone');
        const avatar = document.getElementById('profile-avatar');
        const btnDeleteAvatar = document.getElementById('btn-delete-avatar');
        const errorEl = document.getElementById('profile-error');

        if (firstName) firstName.value = data.first_name || '';
        if (lastName) lastName.value = data.last_name || '';
        if (username) username.value = data.username || '';
        if (phone) phone.value = data.phone || '';
        if (errorEl) errorEl.classList.add('hidden');
        if (btnDeleteAvatar) btnDeleteAvatar.disabled = !data.photo_url;

        this._applyAvatarToElement(
            avatar,
            data.photo_url,
            data.first_name,
            data.last_name,
            data.id,
            'avatar large'
        );

        return data;
    }

    /**
     * Show the profile editing modal
     */
    async showProfileModal() {
        const sessionName = this.app.state.currentAccount;
        if (!sessionName) {
            this.app.showToast('No account selected', 'warning');
            return;
        }

        this.app.showModal('modal-profile');

        // Show loading state
        const btnSave = document.getElementById('btn-save-profile');
        if (btnSave) btnSave.disabled = true;

        await Promise.all([
            this.loadProfile(sessionName),
            this.showPrivacyInfo(sessionName)
        ]);

        this._renderAvatarQueue();

        if (btnSave) btnSave.disabled = false;
    }

    /**
     * Handle save profile button click
     */
    async _handleSaveProfile() {
        const sessionName = this.app.state.currentAccount;
        if (!sessionName) return;

        const firstName = document.getElementById('profile-first-name');
        const lastName = document.getElementById('profile-last-name');
        const username = document.getElementById('profile-username');
        const errorEl = document.getElementById('profile-error');

        if (errorEl) errorEl.classList.add('hidden');

        const profileData = {
            first_name: firstName ? firstName.value.trim() : '',
            last_name: lastName ? lastName.value.trim() : '',
            username: username ? username.value.trim() : ''
        };

        if (!profileData.first_name) {
            if (errorEl) {
                errorEl.textContent = 'First name is required';
                errorEl.classList.remove('hidden');
            }
            return;
        }

        const privacyChanges = this._collectPrivacyChanges();
        const hasProfileChanges = this._hasProfileChanges(profileData);
        const hasPrivacyChanges = Object.keys(privacyChanges).length > 0;

        if (!hasProfileChanges && !hasPrivacyChanges) {
            this.app.showToast('No changes to save', 'info');
            return;
        }

        const btnSave = document.getElementById('btn-save-profile');
        if (btnSave) btnSave.disabled = true;

        let profileResult = null;
        let privacyResult = null;

        if (hasProfileChanges) {
            profileResult = await this.updateProfile(sessionName, profileData);
            if (!profileResult) {
                if (btnSave) btnSave.disabled = false;
                if (errorEl) {
                    errorEl.textContent = 'Failed to update profile';
                    errorEl.classList.remove('hidden');
                }
                return;
            }
        }

        if (hasPrivacyChanges) {
            privacyResult = await this.updatePrivacySettings(sessionName, privacyChanges);
            if (!privacyResult) {
                if (btnSave) btnSave.disabled = false;
                if (errorEl) {
                    errorEl.textContent = hasProfileChanges
                        ? 'Profile was updated, but privacy settings could not be saved'
                        : 'Failed to update privacy settings';
                    errorEl.classList.remove('hidden');
                }
                if (hasProfileChanges) {
                    await this.app.accountManager.loadAccounts();
                }
                return;
            }
        }

        if (profileResult) {
            this.loadedProfile = {
                ...this.loadedProfile,
                first_name: profileResult.first_name || '',
                last_name: profileResult.last_name || '',
                username: profileResult.username || '',
                phone: profileResult.phone || '',
                photo_url: profileResult.photo_url || null,
                id: profileResult.id || this.loadedProfile?.id || null
            };
        }

        if (privacyResult?.settings) {
            this.loadedPrivacySettings = this._snapshotPrivacySettings(privacyResult.settings);
            this._renderPrivacySettings(privacyResult.settings);
        }

        if (btnSave) btnSave.disabled = false;

        this.app.showToast('Profile settings updated', 'success');
        this.app.hideModal('modal-profile');
        await this.app.accountManager.loadAccounts();
    }

    /**
     * Update profile via API
     * @param {string} sessionName
     * @param {object} data - {first_name, last_name, username}
     */
    async updateProfile(sessionName, data) {
        const result = await this.app.api('PUT', `/api/profile/${encodeURIComponent(sessionName)}/update`, data);
        return result;
    }

    /**
     * Handle avatar upload
     * @param {File} file
     */
    async _handleAvatarUpload(file) {
        const sessionName = this.app.state.currentAccount;
        if (!sessionName) return;
        if (this.isAvatarUploadInProgress) {
            this._showAvatarUploadBusyToast();
            return;
        }

        const validationError = this._validateAvatarFile(file);
        if (validationError) {
            this.app.showToast(validationError, 'warning');
            return;
        }

        await this.uploadAvatar(sessionName, file);
    }

    /**
     * Upload avatar via API
     * @param {string} sessionName
     * @param {File} file
     */
    async uploadAvatar(sessionName, file) {
        const formData = new FormData();
        formData.append('file', file);

        this.app.showToast('Uploading avatar...', 'info', 2000);

        const result = await this.app.api('POST', `/api/profile/${encodeURIComponent(sessionName)}/avatar`, formData);

        if (result) {
            this.app.showToast(result.message || 'Avatar updated', 'success');
            await this.loadProfile(sessionName);
            await this.app.accountManager.loadAccounts();
        }
    }

    /**
     * Add multiple images to the ordered upload queue.
     * @param {FileList|Array<File>} files
     */
    _handleAvatarQueueSelection(files) {
        if (this.isAvatarUploadInProgress) {
            this._showAvatarUploadBusyToast();
            return;
        }

        const selectedFiles = Array.from(files || []);
        if (!selectedFiles.length) return;

        let addedCount = 0;
        selectedFiles.forEach(file => {
            const validationError = this._validateAvatarFile(file);
            if (validationError) {
                this.app.showToast(`${file.name}: ${validationError}`, 'warning', 5000);
                return;
            }

            this.avatarUploadQueue.push(this._createAvatarQueueEntry(file));
            addedCount += 1;
        });

        this._renderAvatarQueue();

        if (addedCount > 0) {
            this.app.showToast(
                addedCount === 1
                    ? '1 photo added to upload queue'
                    : `${addedCount} photos added to upload queue`,
                'info',
                2500
            );
        }
    }

    /**
     * Upload queued profile photos in the selected order.
     */
    async _handleQueuedAvatarUpload() {
        const sessionName = this.app.state.currentAccount;
        if (!sessionName || !this.avatarUploadQueue.length) return;
        if (this.isAvatarUploadInProgress) {
            this._showAvatarUploadBusyToast();
            return;
        }

        await this.uploadAvatarBatch(
            sessionName,
            this.avatarUploadQueue.map(entry => entry.file)
        );
    }

    /**
     * Upload multiple profile photos via API in the current queue order.
     * @param {string} sessionName
     * @param {Array<File>} files
     */
    async uploadAvatarBatch(sessionName, files) {
        const formData = new FormData();
        files.forEach(file => {
            formData.append('files', file);
        });

        this.isAvatarUploadInProgress = true;
        this.hasLocalAvatarBatchRequest = true;
        this.avatarUploadProgress = {
            phase: 'started',
            current: 0,
            total: files.length,
            file_name: '',
            progress: 0,
            message: files.length === 1
                ? 'Preparing to upload 1 queued photo...'
                : `Preparing to upload ${files.length} queued photos...`
        };
        this._renderAvatarQueue();

        this.app.showToast(
            files.length === 1
                ? 'Uploading 1 queued photo...'
                : `Uploading ${files.length} queued photos...`,
            'info',
            2500
        );

        try {
            const result = await this.app.api('POST', `/api/profile/${encodeURIComponent(sessionName)}/avatar/batch`, formData);

            if (result) {
                this._disposeAvatarQueue();
                this.app.showToast(result.message || 'Profile photos uploaded', 'success');
                await this.loadProfile(sessionName);
                await this.app.accountManager.loadAccounts();
            }
        } finally {
            this.hasLocalAvatarBatchRequest = false;
            this.isAvatarUploadInProgress = false;
            this.avatarUploadProgress = null;
            this._renderAvatarQueue();
        }
    }

    /**
     * Handle delete avatar
     */
    async _handleDeleteAvatar() {
        const sessionName = this.app.state.currentAccount;
        if (!sessionName) return;
        if (this.isAvatarUploadInProgress) {
            this._showAvatarUploadBusyToast();
            return;
        }

        const confirmed = window.confirm(
            'Удалить все фото профиля?\n\nЭто действие удалит весь набор фотографий аккаунта в Telegram.'
        );
        if (!confirmed) {
            return;
        }

        await this.deleteAvatar(sessionName);
    }

    /**
     * Delete avatar via API
     * @param {string} sessionName
     */
    async deleteAvatar(sessionName) {
        const btnDeleteAvatar = document.getElementById('btn-delete-avatar');
        const originalText = btnDeleteAvatar ? btnDeleteAvatar.textContent : '';

        if (btnDeleteAvatar) {
            btnDeleteAvatar.disabled = true;
            btnDeleteAvatar.textContent = 'Removing...';
        }

        this.app.showToast('Removing profile photos...', 'warning', 2500);

        try {
            const result = await this.app.api('DELETE', `/api/profile/${encodeURIComponent(sessionName)}/avatar`);

            if (result) {
                this.app.showToast(result.message || 'Profile photos removed', 'success');
                await this.loadProfile(sessionName);
                await this.app.accountManager.loadAccounts();
            }
        } finally {
            if (btnDeleteAvatar) {
                btnDeleteAvatar.textContent = originalText || 'Remove All Photos';
                btnDeleteAvatar.disabled = !this.loadedProfile?.photo_url;
            }
        }
    }

    /**
     * Render the queued profile-photo uploads and controls.
     */
    _renderAvatarQueue() {
        const queueEl = document.getElementById('profile-avatar-queue');
        const listEl = document.getElementById('profile-avatar-queue-list');
        const uploadBtn = document.getElementById('btn-upload-avatar-queue');
        const clearBtn = document.getElementById('btn-clear-avatar-queue');
        const statusEl = document.getElementById('profile-avatar-upload-status');
        const statusMessageEl = document.getElementById('profile-avatar-upload-message');
        const statusCountEl = document.getElementById('profile-avatar-upload-count');
        const statusFileEl = document.getElementById('profile-avatar-upload-file');
        const statusBarEl = document.getElementById('profile-avatar-upload-bar-fill');
        const inputAvatar = document.getElementById('input-avatar-upload');
        const inputAvatarQueue = document.getElementById('input-avatar-upload-queue');
        const uploadAvatarLabel = document.getElementById('btn-upload-avatar-label');
        const uploadQueueLabel = document.getElementById('btn-upload-avatar-queue-label');
        const deleteBtn = document.getElementById('btn-delete-avatar');
        const isUploading = this.isAvatarUploadInProgress;

        if (
            !queueEl
            || !listEl
            || !uploadBtn
            || !clearBtn
            || !statusEl
            || !statusMessageEl
            || !statusCountEl
            || !statusFileEl
            || !statusBarEl
        ) {
            return;
        }

        if (inputAvatar) inputAvatar.disabled = isUploading;
        if (inputAvatarQueue) inputAvatarQueue.disabled = isUploading;
        if (uploadAvatarLabel) uploadAvatarLabel.classList.toggle('is-disabled', isUploading);
        if (uploadQueueLabel) uploadQueueLabel.classList.toggle('is-disabled', isUploading);
        if (deleteBtn) deleteBtn.disabled = isUploading || !this.loadedProfile?.photo_url;

        if (!this.avatarUploadQueue.length) {
            queueEl.classList.add('hidden');
            listEl.innerHTML = '';
            uploadBtn.disabled = true;
            clearBtn.disabled = true;
            uploadBtn.textContent = 'Upload queued photos';
            statusEl.classList.add('hidden');
            return;
        }

        queueEl.classList.remove('hidden');
        listEl.innerHTML = '';

        this._renderAvatarUploadProgress(statusEl, statusMessageEl, statusCountEl, statusFileEl, statusBarEl);

        this.avatarUploadQueue.forEach((entry, index) => {
            const item = document.createElement('div');
            item.className = 'avatar-queue-item';
            item.innerHTML = `
                <div class="avatar-queue-order">${index + 1}</div>
                <div class="avatar-queue-preview-wrap">
                    <img
                        class="avatar-queue-preview"
                        src="${this._escapeHtml(entry.previewUrl)}"
                        alt="${this._escapeHtml(entry.file.name || `Queued photo ${index + 1}`)}"
                    >
                </div>
                <div class="avatar-queue-info">
                    <div class="avatar-queue-name">${this._escapeHtml(entry.file.name || `Photo ${index + 1}`)}</div>
                    <div class="avatar-queue-meta">${this._escapeHtml(this._formatFileSize(entry.file.size))}</div>
                </div>
                <div class="avatar-queue-actions">
                    <button class="action-btn" type="button" title="Move up" ${(index === 0 || isUploading) ? 'disabled' : ''} data-action="up">↑</button>
                    <button class="action-btn" type="button" title="Move down" ${(index === this.avatarUploadQueue.length - 1 || isUploading) ? 'disabled' : ''} data-action="down">↓</button>
                    <button class="action-btn disconnect-btn" type="button" title="Remove from queue" ${isUploading ? 'disabled' : ''} data-action="remove">✕</button>
                </div>
            `;

            item.querySelectorAll('[data-action]').forEach(button => {
                button.addEventListener('click', () => {
                    const action = button.dataset.action;
                    if (action === 'up') {
                        this._moveAvatarQueueItem(index, -1);
                    } else if (action === 'down') {
                        this._moveAvatarQueueItem(index, 1);
                    } else if (action === 'remove') {
                        this._removeAvatarQueueItem(index);
                    }
                });
            });

            listEl.appendChild(item);
        });

        uploadBtn.disabled = isUploading;
        clearBtn.disabled = isUploading;
        if (isUploading) {
            const progress = this.avatarUploadProgress || {};
            if (progress.current && progress.total) {
                uploadBtn.textContent = `Uploading ${progress.current} / ${progress.total}...`;
            } else {
                uploadBtn.textContent = 'Uploading...';
            }
        } else {
            uploadBtn.textContent = this.avatarUploadQueue.length === 1
                ? 'Upload 1 queued photo'
                : `Upload ${this.avatarUploadQueue.length} queued photos`;
        }
    }

    /**
     * Render queue-upload progress UI.
     * @param {HTMLElement} statusEl
     * @param {HTMLElement} statusMessageEl
     * @param {HTMLElement} statusCountEl
     * @param {HTMLElement} statusFileEl
     * @param {HTMLElement} statusBarEl
     */
    _renderAvatarUploadProgress(statusEl, statusMessageEl, statusCountEl, statusFileEl, statusBarEl) {
        const progress = this.avatarUploadProgress;
        if (!progress) {
            statusEl.classList.add('hidden');
            statusBarEl.style.width = '0%';
            statusMessageEl.textContent = '';
            statusCountEl.textContent = '';
            statusFileEl.textContent = '';
            return;
        }

        const total = Number(progress.total) || 0;
        const current = Number(progress.current) || 0;
        const ratio = total > 0 ? Math.max(0, Math.min(100, Number(progress.progress) || Math.round((current / total) * 100))) : 0;

        statusEl.classList.remove('hidden');
        statusMessageEl.textContent = progress.message || 'Uploading profile photos...';
        statusCountEl.textContent = total > 0 ? `${Math.min(current, total)} / ${total}` : '';
        statusFileEl.textContent = progress.file_name || (this.isAvatarUploadInProgress ? 'Do not close the page until the upload finishes.' : '');
        statusBarEl.style.width = `${ratio}%`;
        statusEl.classList.toggle('is-error', progress.phase === 'failed');
    }

    /**
     * Receive avatar upload progress from WebSocket events.
     * @param {string} sessionName
     * @param {object} data
     */
    handleAvatarUploadProgress(sessionName, data) {
        if (sessionName !== this.app.state.currentAccount || !data) {
            return;
        }

        this.avatarUploadProgress = data;
        if (this.hasLocalAvatarBatchRequest) {
            this.isAvatarUploadInProgress = true;
        } else {
            this.isAvatarUploadInProgress = data.phase === 'started' || data.phase === 'uploading';
        }

        this._renderAvatarQueue();
    }

    /**
     * Notify the user that another avatar operation is already running.
     */
    _showAvatarUploadBusyToast() {
        this.app.showToast(
            'Profile photo upload is already in progress. Please wait until it finishes.',
            'warning',
            4000
        );
    }

    /**
     * Move a queued photo up or down.
     * @param {number} index
     * @param {number} direction
     */
    _moveAvatarQueueItem(index, direction) {
        if (this.isAvatarUploadInProgress) {
            this._showAvatarUploadBusyToast();
            return;
        }

        const nextIndex = index + direction;
        if (
            index < 0
            || nextIndex < 0
            || index >= this.avatarUploadQueue.length
            || nextIndex >= this.avatarUploadQueue.length
        ) {
            return;
        }

        const updated = [...this.avatarUploadQueue];
        const [item] = updated.splice(index, 1);
        updated.splice(nextIndex, 0, item);
        this.avatarUploadQueue = updated;
        this._renderAvatarQueue();
    }

    /**
     * Remove one queued photo.
     * @param {number} index
     */
    _removeAvatarQueueItem(index) {
        if (this.isAvatarUploadInProgress) {
            this._showAvatarUploadBusyToast();
            return;
        }

        const removedEntry = this.avatarUploadQueue[index];
        if (removedEntry) {
            this._revokeAvatarQueueEntry(removedEntry);
        }
        this.avatarUploadQueue = this.avatarUploadQueue.filter((_, itemIndex) => itemIndex !== index);
        this._renderAvatarQueue();
    }

    /**
     * Clear the queued profile-photo uploads.
     */
    _clearAvatarQueue() {
        if (!this.avatarUploadQueue.length) return;
        if (this.isAvatarUploadInProgress) {
            this._showAvatarUploadBusyToast();
            return;
        }
        this._disposeAvatarQueue();
        this._renderAvatarQueue();
    }

    /**
     * Load and display privacy info
     * @param {string} sessionName
     */
    async showPrivacyInfo(sessionName) {
        const noteEl = document.getElementById('profile-privacy-note');
        const settingsEl = document.getElementById('profile-privacy-settings');
        if (!noteEl || !settingsEl) return null;

        const data = await this.app.api('GET', `/api/profile/${encodeURIComponent(sessionName)}/privacy`);

        if (data?.note) {
            noteEl.textContent = data.note;
            noteEl.classList.remove('hidden');
        } else {
            noteEl.classList.add('hidden');
        }

        if (!data?.settings) {
            this.loadedPrivacySettings = {};
            settingsEl.innerHTML = '';
            settingsEl.classList.add('hidden');
            return null;
        }

        this.loadedPrivacySettings = this._snapshotPrivacySettings(data.settings);
        this._renderPrivacySettings(data.settings);
        return data;
    }

    /**
     * Show info about the currently selected chat user
     */
    async _showChatUserInfo() {
        const sessionName = this.app.state.currentAccount;
        const entityId = this.app.state.currentChat;
        if (!sessionName || !entityId || !this._isCurrentChatProfileAvailable()) {
            this.app.showToast('This profile is only available in private chats', 'warning');
            return;
        }

        this.app.showModal('modal-account-info');
        const body = document.getElementById('account-info-body');
        const titleEl = document.getElementById('account-info-title');
        const primaryBtn = document.getElementById('btn-account-info-primary');
        const openChatBtn = document.getElementById('btn-account-info-open-chat');
        const deleteChatBtn = document.getElementById('btn-account-info-delete-chat');
        this.app.showLoading(body);
        if (titleEl) titleEl.textContent = 'User Profile';
        if (primaryBtn) {
            primaryBtn.classList.add('hidden');
            primaryBtn.disabled = false;
            primaryBtn.textContent = '';
        }
        if (openChatBtn) openChatBtn.classList.add('hidden');
        if (deleteChatBtn) deleteChatBtn.classList.add('hidden');

        const data = await this.app.api('GET', `/api/messages/${encodeURIComponent(sessionName)}/user/${encodeURIComponent(entityId)}`);

        if (!data) {
            body.innerHTML = '<div class="empty-state">Failed to load user info</div>';
            return;
        }

        this.loadedChatProfile = data;
        this._renderChatUserInfo(data);
    }

    /**
     * Add the currently opened chat user to contacts.
     */
    async _handleAddChatUserToContacts() {
        if (!this.loadedChatProfile || !this.app.chatManager) {
            return;
        }

        this.app.chatManager.openContactNamingModal({
            entity: this.loadedChatProfile,
            entityId: this.loadedChatProfile.id,
            identifier: this.loadedChatProfile.username
                ? `@${this.loadedChatProfile.username}`
                : (this.loadedChatProfile.phone || `ID: ${this.loadedChatProfile.id}`),
            sourceLabel: 'chat profile',
            initialFirstName: this.loadedChatProfile.first_name || '',
            initialLastName: this.loadedChatProfile.last_name || ''
        });
    }

    /**
     * Return from the user-profile modal back to the open chat.
     */
    _handleOpenChatFromProfile() {
        if (!this.loadedChatProfile?.id) {
            return;
        }

        const fullName = [this.loadedChatProfile.first_name, this.loadedChatProfile.last_name]
            .filter(Boolean)
            .join(' ')
            || this.loadedChatProfile.username
            || String(this.loadedChatProfile.id);

        this.app.hideModal('modal-account-info');
        this.app.selectChat(this.loadedChatProfile.id, fullName);
    }

    /**
     * Start the existing delete-chat flow from the user-profile modal.
     */
    _handleDeleteChatFromProfile() {
        if (!this.app.chatManager || !this.loadedChatProfile?.id) {
            return;
        }

        this.app.hideModal('modal-account-info');
        this.app.chatManager.deleteCurrentChat();
    }

    /**
     * Update privacy settings via API
     * @param {string} sessionName
     * @param {object} data
     * @returns {Promise<object|null>}
     */
    async updatePrivacySettings(sessionName, data) {
        return this.app.api('PUT', `/api/profile/${encodeURIComponent(sessionName)}/privacy`, data);
    }

    /**
     * Update chat-profile controls in the chat header.
     */
    updateChatProfileButton() {
        const btnUserInfo = document.getElementById('btn-chat-user-info');
        const profileTrigger = document.getElementById('chat-profile-trigger');
        const isAvailable = this._isCurrentChatProfileAvailable();

        if (btnUserInfo) {
            btnUserInfo.classList.toggle('hidden', !isAvailable);
            btnUserInfo.disabled = !isAvailable;
            btnUserInfo.title = isAvailable
                ? 'Open user profile'
                : 'Profile is available only in private chats';
        }

        if (profileTrigger) {
            profileTrigger.classList.toggle('is-clickable', isAvailable);
            profileTrigger.title = isAvailable ? 'Open user profile' : '';
        }
    }

    /**
     * Render privacy controls into the profile modal
     * @param {object} settings
     */
    _renderPrivacySettings(settings) {
        const settingsEl = document.getElementById('profile-privacy-settings');
        if (!settingsEl) return;

        const entries = Object.entries(settings || {});
        if (!entries.length) {
            settingsEl.innerHTML = '';
            settingsEl.classList.add('hidden');
            return;
        }

        settingsEl.innerHTML = entries.map(([fieldName, config]) => {
            const description = this._getPrivacyDescription(fieldName);
            const currentLabel = this._getPrivacyOptionLabel(config, config.value);
            const isLimited = this._isLimitedPrivacyField(fieldName, config);

            return `
                <div class="privacy-item ${isLimited ? 'privacy-item-limited' : ''}" data-privacy-card="${this._escapeHtml(fieldName)}">
                    <div class="privacy-item-header">
                        <div class="privacy-item-heading">
                            <div class="privacy-item-title">${this._escapeHtml(config.label || fieldName)}</div>
                            <div class="privacy-item-description">${this._escapeHtml(description)}</div>
                        </div>
                        <div class="privacy-item-badges">
                            <span class="privacy-item-current">${this._escapeHtml(currentLabel)}</span>
                            ${config.has_exceptions ? '<span class="privacy-item-badge">Exceptions</span>' : ''}
                            ${isLimited ? '<span class="privacy-item-badge privacy-item-badge-muted">Telegram limit</span>' : ''}
                        </div>
                    </div>
                    <select data-privacy-field="${this._escapeHtml(fieldName)}" aria-label="${this._escapeHtml(config.label || fieldName)}">
                        ${(config.options || []).map(option => `
                            <option value="${this._escapeHtml(option.value)}" ${option.value === config.value ? 'selected' : ''}>
                                ${this._escapeHtml(option.label)}
                            </option>
                        `).join('')}
                    </select>
                    ${this._buildPrivacyNote(config, fieldName)}
                </div>
            `;
        }).join('');

        settingsEl.classList.remove('hidden');
        settingsEl.querySelectorAll('[data-privacy-field]').forEach(select => {
            select.addEventListener('change', () => {
                this._updatePrivacyCardState(select);
            });
        });
    }

    /**
     * Build a short explanation for a privacy field
     * @param {object} config
     * @param {string} fieldName
     * @returns {string}
     */
    _buildPrivacyNote(config, fieldName) {
        const notes = [];
        if (config.has_exceptions) {
            const allowCount = Number(config.allow_exceptions || 0);
            const disallowCount = Number(config.disallow_exceptions || 0);
            const parts = [];
            if (allowCount) parts.push(`${allowCount} allowed`);
            if (disallowCount) parts.push(`${disallowCount} blocked`);
            notes.push(
                parts.length
                    ? `${parts.join(', ')} exceptions will be replaced on save`
                    : 'Custom exceptions will be replaced on save'
            );
        }
        const optionValues = (config.options || []).map(option => option.value);
        if (fieldName === 'no_paid_messages' || optionValues.includes('contacts_premium')) {
            notes.push('This Telegram setting has only two choices: Everybody, or Contacts and Premium subscribers');
        } else if ((config.options || []).length === 2) {
            notes.push('Telegram only allows Everybody or My Contacts here');
        }

        if (!notes.length) return '';
        return `<div class="privacy-item-note">${this._escapeHtml(notes.join('. '))}</div>`;
    }

    /**
     * Update the privacy card badge after the user changes a select.
     * @param {HTMLSelectElement} select
     */
    _updatePrivacyCardState(select) {
        const fieldName = select.dataset.privacyField;
        const card = select.closest('.privacy-item');
        const currentBadge = card ? card.querySelector('.privacy-item-current') : null;
        const selectedOption = select.options[select.selectedIndex];
        const originalValue = this.loadedPrivacySettings[fieldName];
        const isChanged = originalValue !== select.value;

        if (card) {
            card.classList.toggle('is-changed', isChanged);
        }
        if (currentBadge) {
            currentBadge.textContent = isChanged
                ? `Changed to ${selectedOption ? selectedOption.textContent.trim() : select.value}`
                : (selectedOption ? selectedOption.textContent.trim() : select.value);
        }
    }

    /**
     * Get a concise explanation for a privacy field.
     * @param {string} fieldName
     * @returns {string}
     */
    _getPrivacyDescription(fieldName) {
        const descriptions = {
            status_timestamp: 'Controls who can see online and last-seen status.',
            phone_number: 'Controls who can see this account phone number.',
            profile_photo: 'Controls who can see profile photos.',
            forwards: 'Controls whether forwards can link back to this account.',
            chat_invite: 'Controls who can add this account to groups and channels.',
            phone_call: 'Controls who can call this account.',
            no_paid_messages: 'Controls who can start direct messages with this account.'
        };

        return descriptions[fieldName] || 'Base Telegram visibility rule for this account.';
    }

    /**
     * Return the label for the current privacy option.
     * @param {object} config
     * @param {string} value
     * @returns {string}
     */
    _getPrivacyOptionLabel(config, value) {
        const option = (config.options || []).find(item => item.value === value);
        return option?.label || value || 'Unknown';
    }

    /**
     * Detect privacy fields where Telegram exposes a reduced option set.
     * @param {string} fieldName
     * @param {object} config
     * @returns {boolean}
     */
    _isLimitedPrivacyField(fieldName, config) {
        const optionValues = (config.options || []).map(option => option.value);
        return fieldName === 'no_paid_messages'
            || optionValues.includes('contacts_premium')
            || optionValues.length < 3;
    }

    /**
     * Collect changed privacy settings from the modal form
     * @returns {object}
     */
    _collectPrivacyChanges() {
        const fields = document.querySelectorAll('#profile-privacy-settings [data-privacy-field]');
        const payload = {};

        fields.forEach(field => {
            const settingName = field.dataset.privacyField;
            const currentValue = field.value;
            if (settingName && this.loadedPrivacySettings[settingName] !== currentValue) {
                payload[settingName] = currentValue;
            }
        });

        return payload;
    }

    /**
     * Compare current form values with the last loaded profile
     * @param {object} profileData
     * @returns {boolean}
     */
    _hasProfileChanges(profileData) {
        if (!this.loadedProfile) return true;

        return (
            (this.loadedProfile.first_name || '') !== (profileData.first_name || '') ||
            (this.loadedProfile.last_name || '') !== (profileData.last_name || '') ||
            (this.loadedProfile.username || '') !== (profileData.username || '')
        );
    }

    /**
     * Store only privacy values for change detection
     * @param {object} settings
     * @returns {object}
     */
    _snapshotPrivacySettings(settings) {
        return Object.fromEntries(
            Object.entries(settings || {}).map(([fieldName, config]) => [fieldName, config.value])
        );
    }

    /**
     * Apply a user avatar or fallback initials to an element
     * @param {HTMLElement|null} element
     * @param {string|null} photoUrl
     * @param {string} firstName
     * @param {string} lastName
     * @param {string|number|null} seed
     * @param {string} className
     */
    _applyAvatarToElement(element, photoUrl, firstName, lastName, seed, className = 'avatar') {
        if (!element) return;

        const initials = this._getInitials(firstName, lastName);
        const colorIdx = Math.abs(this._hashCode(String(seed || firstName || lastName || initials))) % 8;
        element.className = `${className} avatar-color-${colorIdx}`;
        element.textContent = '';
        element.innerHTML = '';

        if (photoUrl) {
            element.classList.add('has-photo');
            const img = document.createElement('img');
            img.src = photoUrl;
            img.alt = [firstName, lastName].filter(Boolean).join(' ') || 'Profile photo';
            element.appendChild(img);
            return;
        }

        element.classList.remove('has-photo');
        element.textContent = initials;
    }

    /**
     * Build avatar markup for dynamic HTML blocks
     * @param {string|null} photoUrl
     * @param {string} firstName
     * @param {string} lastName
     * @param {string|number|null} seed
     * @param {string} className
     * @returns {string}
     */
    _buildAvatarHtml(photoUrl, firstName, lastName, seed, className = 'avatar') {
        const initials = this._getInitials(firstName, lastName);
        const colorIdx = Math.abs(this._hashCode(String(seed || firstName || lastName || initials))) % 8;
        const classes = `${className} avatar-color-${colorIdx}${photoUrl ? ' has-photo' : ''}`;
        if (photoUrl) {
            return `
                <div class="${classes}">
                    <img src="${this._escapeHtml(photoUrl)}" alt="${this._escapeHtml([firstName, lastName].filter(Boolean).join(' ') || 'Profile photo')}">
                </div>
            `;
        }

        return `<div class="${classes}">${this._escapeHtml(initials)}</div>`;
    }

    /**
     * Get initials from first and last name
     */
    _getInitials(firstName, lastName) {
        const f = (firstName || '').trim();
        const l = (lastName || '').trim();
        if (f && l) return (f[0] + l[0]).toUpperCase();
        if (f) return f[0].toUpperCase();
        return '?';
    }

    /**
     * Validate a profile-photo file before upload or queueing.
     * @param {File} file
     * @returns {string}
     */
    _validateAvatarFile(file) {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            return 'Please select an image file';
        }

        if (file.size > 10 * 1024 * 1024) {
            return 'Image must be less than 10MB';
        }

        return '';
    }

    /**
     * Format a file size for the upload queue.
     * @param {number} bytes
     * @returns {string}
     */
    _formatFileSize(bytes) {
        if (!bytes || Number.isNaN(Number(bytes))) return 'Unknown size';

        const units = ['B', 'KB', 'MB', 'GB'];
        let size = Number(bytes);
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex += 1;
        }

        const precision = unitIndex === 0 ? 0 : 1;
        return `${size.toFixed(precision)} ${units[unitIndex]}`;
    }

    /**
     * Create a queue entry with a local preview URL.
     * @param {File} file
     * @returns {object}
     */
    _createAvatarQueueEntry(file) {
        return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            file,
            previewUrl: URL.createObjectURL(file)
        };
    }

    /**
     * Revoke a preview URL for one queued avatar entry.
     * @param {object} entry
     */
    _revokeAvatarQueueEntry(entry) {
        if (entry?.previewUrl) {
            URL.revokeObjectURL(entry.previewUrl);
        }
    }

    /**
     * Clear the queue and revoke all object URLs.
     */
    _disposeAvatarQueue() {
        this.avatarUploadQueue.forEach(entry => {
            this._revokeAvatarQueueEntry(entry);
        });
        this.avatarUploadQueue = [];
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
     * Render the chat user profile modal content and action button.
     * @param {object} data
     */
    _renderChatUserInfo(data) {
        const body = document.getElementById('account-info-body');
        const primaryBtn = document.getElementById('btn-account-info-primary');
        const openChatBtn = document.getElementById('btn-account-info-open-chat');
        const deleteChatBtn = document.getElementById('btn-account-info-delete-chat');
        if (!body) return;

        const fullName = [data.first_name, data.last_name].filter(Boolean).join(' ')
            || data.username
            || 'Unknown';
        const statusText = data.status || 'unknown';
        const commonChats = Number.isFinite(Number(data.common_chats_count))
            ? String(data.common_chats_count)
            : 'N/A';
        const badges = [
            data.is_contact ? '<span class="profile-badge">In contacts</span>' : '',
            data.is_bot ? '<span class="profile-badge profile-badge-muted">Bot</span>' : ''
        ].filter(Boolean).join('');
        const canAdd = Boolean(data.can_add_to_contacts);
        const isContact = Boolean(data.is_contact);
        const canDeleteChat = this._isCurrentChatProfileAvailable();
        const contactActionLabel = isContact
            ? 'Edit saved name'
            : (canAdd ? 'Save to contacts' : 'Contact action unavailable');

        body.innerHTML = `
            <div class="chat-profile-summary">
                ${this._buildAvatarHtml(
                    data.photo_url,
                    data.first_name,
                    data.last_name,
                    data.id,
                    'avatar large'
                )}
                <div class="chat-profile-main">
                    <div class="chat-profile-name-row">
                        <div class="chat-profile-name">${this._escapeHtml(fullName)}</div>
                        ${badges}
                    </div>
                    ${data.username ? `<div class="chat-profile-handle">@${this._escapeHtml(data.username)}</div>` : ''}
                    <div class="chat-profile-status">${this._escapeHtml(statusText)}</div>
                </div>
            </div>
            ${data.about ? `<div class="chat-profile-about">${this._escapeHtml(data.about)}</div>` : ''}
            <div class="chat-profile-action-strip">
                <div class="chat-profile-action-card">
                    <div class="chat-profile-action-title">Open chat</div>
                    <div class="chat-profile-action-text">Return to the dialog without losing context.</div>
                </div>
                <div class="chat-profile-action-card">
                    <div class="chat-profile-action-title">${this._escapeHtml(contactActionLabel)}</div>
                    <div class="chat-profile-action-text">Set first and last name, or keep Telegram display name.</div>
                </div>
                <div class="chat-profile-action-card danger">
                    <div class="chat-profile-action-title">Delete chat</div>
                    <div class="chat-profile-action-text">Uses the same confirmation as the header delete button.</div>
                </div>
            </div>
            <div class="account-info-grid">
                <div class="label">User ID</div>
                <div class="value">${data.id || 'N/A'}</div>
                <div class="label">Phone</div>
                <div class="value">${this._escapeHtml(data.phone || 'Hidden')}</div>
                <div class="label">Username</div>
                <div class="value">${data.username ? '@' + this._escapeHtml(data.username) : 'N/A'}</div>
                <div class="label">Status</div>
                <div class="value">${this._escapeHtml(statusText)}</div>
                <div class="label">Common chats</div>
                <div class="value">${this._escapeHtml(commonChats)}</div>
            </div>
        `;

        if (!primaryBtn) {
            return;
        }

        if (canAdd || isContact) {
            primaryBtn.classList.remove('hidden');
            primaryBtn.textContent = isContact ? 'Edit contact name' : 'Add to contacts';
            primaryBtn.disabled = false;
        } else {
            primaryBtn.classList.add('hidden');
            primaryBtn.disabled = false;
            primaryBtn.textContent = '';
        }

        if (openChatBtn) {
            openChatBtn.classList.remove('hidden');
            openChatBtn.disabled = false;
        }

        if (deleteChatBtn) {
            deleteChatBtn.classList.toggle('hidden', !canDeleteChat);
            deleteChatBtn.disabled = !canDeleteChat;
        }
    }

    /**
     * Check whether the current chat supports a user profile view.
     * @returns {boolean}
     */
    _isCurrentChatProfileAvailable() {
        if (!this.app.state.currentChat) {
            return false;
        }

        const dialog = this._getCurrentDialog();
        if (!dialog) {
            return true;
        }

        return !dialog.is_group && !dialog.is_channel;
    }

    /**
     * Find the current dialog in sidebar state.
     * @returns {object|null}
     */
    _getCurrentDialog() {
        const dialogs = Array.isArray(this.app.state.dialogs) ? this.app.state.dialogs : [];
        return dialogs.find(dialog => String(dialog.id) === String(this.app.state.currentChat)) || null;
    }
}
