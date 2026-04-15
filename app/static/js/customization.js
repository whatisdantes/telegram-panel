/**
 * Customization Manager - handles theme and global background settings
 */
class CustomizationManager {
    constructor(app) {
        this.app = app;
        this.settings = this._normalizeSettings(null);
        this.draftTheme = this.settings.theme;
        this.draftBackgroundFile = null;
        this.draftBackgroundPreviewUrl = null;
        this.isSaving = false;
        this.isRemovingBackground = false;

        this._bindEvents();
    }

    /**
     * Bind customization UI events
     */
    _bindEvents() {
        const btnCustomization = document.getElementById('btn-customization');
        if (btnCustomization) {
            btnCustomization.addEventListener('click', () => {
                this.openModal();
            });
        }

        document.querySelectorAll('[data-theme-option]').forEach(button => {
            button.addEventListener('click', () => {
                if (this.isSaving || this.isRemovingBackground) return;
                this.draftTheme = button.dataset.themeOption === 'light' ? 'light' : 'dark';
                this._renderModal();
            });
        });

        const inputBackground = document.getElementById('input-customization-background');
        if (inputBackground) {
            inputBackground.addEventListener('change', (event) => {
                const file = event.target.files && event.target.files[0];
                if (file) {
                    this._handleBackgroundSelection(file);
                }
                inputBackground.value = '';
            });
        }

        const btnSave = document.getElementById('btn-save-customization');
        if (btnSave) {
            btnSave.addEventListener('click', () => {
                this.saveCustomization();
            });
        }

        const btnRemoveBackground = document.getElementById('btn-remove-customization-background');
        if (btnRemoveBackground) {
            btnRemoveBackground.addEventListener('click', () => {
                this.removeBackground();
            });
        }
    }

    /**
     * Load customization settings from backend and apply them.
     * This uses a direct fetch to avoid noisy startup toasts.
     */
    async loadSettings() {
        try {
            const response = await fetch('/api/customization');
            if (!response.ok) {
                throw new Error(`Customization settings request failed with ${response.status}`);
            }

            const data = await response.json();
            this.settings = this._normalizeSettings(data);
        } catch (error) {
            console.error('[Customization] Failed to load settings:', error);
            this.settings = this._normalizeSettings(null);
        }

        this.draftTheme = this.settings.theme;
        this._applySettings(this.settings);
        this._renderModal();
        return this.settings;
    }

    /**
     * Open the customization modal with a fresh draft.
     */
    openModal() {
        this.draftTheme = this.settings.theme;
        this._clearPendingBackgroundSelection();
        this._clearError();
        this._renderModal();
        this.app.showModal('modal-customization');
    }

    /**
     * Reset transient modal state after the modal is hidden.
     */
    handleModalHidden() {
        this.draftTheme = this.settings.theme;
        this._clearPendingBackgroundSelection();
        this._clearError();
        this._renderModal();
    }

    /**
     * Save theme and selected background to the backend.
     */
    async saveCustomization() {
        if (this.isSaving || this.isRemovingBackground) return;

        const hasThemeChange = this.draftTheme !== this.settings.theme;
        const hasBackgroundChange = Boolean(this.draftBackgroundFile);
        if (!hasThemeChange && !hasBackgroundChange) {
            this.app.showToast('No customization changes to save', 'info');
            return;
        }

        this.isSaving = true;
        this._clearError();
        this._renderModal();

        let updatedSettings = this.settings;

        try {
            if (hasThemeChange) {
                const themeResult = await this.app.api('PUT', '/api/customization', {
                    theme: this.draftTheme
                });

                if (!themeResult?.settings) {
                    this._setError('Failed to save the selected theme.');
                    return;
                }

                updatedSettings = this._normalizeSettings(themeResult.settings);
                this.settings = updatedSettings;
                this._applySettings(this.settings);
            }

            if (hasBackgroundChange) {
                const formData = new FormData();
                formData.append('file', this.draftBackgroundFile);
                formData.append('viewport_width', String(this._getViewportWidth()));
                formData.append('viewport_height', String(this._getViewportHeight()));
                formData.append('device_pixel_ratio', String(this._getViewportPixelRatio()));
                const backgroundResult = await this.app.api('POST', '/api/customization/background', formData);

                if (!backgroundResult?.settings) {
                    if (hasThemeChange) {
                        this._setError('Theme was saved, but the background could not be uploaded.');
                    } else {
                        this._setError('Failed to upload the selected background.');
                    }
                    return;
                }

                updatedSettings = this._normalizeSettings(backgroundResult.settings);
            }

            this.settings = updatedSettings;
            this.draftTheme = this.settings.theme;
            this._applySettings(this.settings);
            this._clearPendingBackgroundSelection();
            this._renderModal();
            this.app.showToast('Interface customization saved', 'success');
            this.app.hideModal('modal-customization');
        } finally {
            this.isSaving = false;
            this._renderModal();
        }
    }

    /**
     * Remove the saved background, or clear the pending background selection.
     */
    async removeBackground() {
        if (this.isSaving || this.isRemovingBackground) return;

        if (this.draftBackgroundFile) {
            this._clearPendingBackgroundSelection();
            this._renderModal();
            this.app.showToast('Selected background removed from draft', 'info');
            return;
        }

        if (!this.settings.background_url) {
            this.app.showToast('No background is currently set', 'info');
            return;
        }

        this.isRemovingBackground = true;
        this._clearError();
        this._renderModal();

        const draftTheme = this.draftTheme;

        try {
            const result = await this.app.api('DELETE', '/api/customization/background');
            if (!result?.settings) {
                return;
            }

            this.settings = this._normalizeSettings(result.settings);
            this._applySettings(this.settings);
            this.draftTheme = draftTheme;
            this._renderModal();
            this.app.showToast(result.message || 'Background removed', 'success');
        } finally {
            this.isRemovingBackground = false;
            this._renderModal();
        }
    }

    /**
     * Handle local selection of a background file before upload.
     * @param {File} file
     */
    _handleBackgroundSelection(file) {
        const error = this._validateBackgroundFile(file);
        if (error) {
            this._setError(error);
            return;
        }

        this._clearError();
        this._clearPendingBackgroundSelection();
        this.draftBackgroundFile = file;
        this.draftBackgroundPreviewUrl = URL.createObjectURL(file);
        this._renderModal();
    }

    /**
     * Apply customization settings to the live interface.
     * @param {object} settings
     */
    _applySettings(settings) {
        const normalized = this._normalizeSettings(settings);
        this.settings = normalized;
        this.app.state.customization = normalized;

        document.body.classList.toggle('theme-light', normalized.theme === 'light');
        document.body.classList.toggle('theme-dark', normalized.theme !== 'light');
        document.body.dataset.theme = normalized.theme;

        this._renderBackgroundLayer(normalized);
    }

    /**
     * Render the fixed full-screen background layer.
     * @param {object} settings
     */
    _renderBackgroundLayer(settings) {
        const layer = document.getElementById('ui-background-layer');
        if (!layer) return;

        layer.innerHTML = '';
        document.body.classList.toggle('has-custom-background', Boolean(settings.background_url));

        if (!settings.background_url) {
            layer.classList.add('hidden');
            return;
        }

        layer.classList.remove('hidden');

        let mediaElement;
        if (settings.background_type === 'video') {
            mediaElement = document.createElement('video');
            mediaElement.autoplay = true;
            mediaElement.loop = true;
            mediaElement.muted = true;
            mediaElement.defaultMuted = true;
            mediaElement.playsInline = true;
            mediaElement.setAttribute('muted', '');
            mediaElement.setAttribute('playsinline', '');
            mediaElement.src = settings.background_url;
            mediaElement.className = 'ui-background-media';
            mediaElement.addEventListener('loadedmetadata', () => {
                const playPromise = mediaElement.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => {});
                }
            });
        } else {
            mediaElement = document.createElement('img');
            mediaElement.src = settings.background_url;
            mediaElement.alt = 'Interface background';
            mediaElement.className = 'ui-background-media';
        }

        const overlay = document.createElement('div');
        overlay.className = 'ui-background-overlay';

        layer.appendChild(mediaElement);
        layer.appendChild(overlay);
    }

    /**
     * Render the modal state.
     */
    _renderModal() {
        const btnSave = document.getElementById('btn-save-customization');
        const btnRemove = document.getElementById('btn-remove-customization-background');
        const btnBackgroundLabel = document.getElementById('btn-customization-background-label');
        const previewEl = document.getElementById('customization-background-preview');
        const nameEl = document.getElementById('customization-background-name');
        const noteEl = document.getElementById('customization-background-note');
        const inputBackground = document.getElementById('input-customization-background');

        this._updateThemeButtons();
        this._renderCustomizationSummary();

        if (previewEl) {
            const background = this._getPreviewBackground();
            previewEl.innerHTML = this._buildBackgroundPreviewHtml(background);
        }

        if (nameEl) {
            const background = this._getPreviewBackground();
            if (background?.label) {
                nameEl.textContent = background.pending
                    ? `${background.label} (ready to upload)`
                    : background.label;
            } else {
                nameEl.textContent = 'Nothing uploaded yet';
            }
        }

        if (noteEl) {
            noteEl.textContent = this._getBackgroundNote(this._getPreviewBackground());
        }

        this._renderStatus();

        if (btnSave) {
            btnSave.disabled = this.isSaving || this.isRemovingBackground;
            btnSave.textContent = this.isSaving ? 'Saving...' : 'Save Changes';
        }

        if (btnRemove) {
            btnRemove.disabled = this.isSaving || this.isRemovingBackground || !this._canRemoveBackground();
            btnRemove.textContent = this.draftBackgroundFile
                ? 'Clear Selection'
                : (this.isRemovingBackground ? 'Removing...' : 'Remove Background');
        }

        if (btnBackgroundLabel) {
            btnBackgroundLabel.classList.toggle('is-disabled', this.isSaving || this.isRemovingBackground);
        }

        if (inputBackground) {
            inputBackground.disabled = this.isSaving || this.isRemovingBackground;
        }
    }

    /**
     * Update active state for theme buttons.
     */
    _updateThemeButtons() {
        document.querySelectorAll('[data-theme-option]').forEach(button => {
            const isActive = button.dataset.themeOption === this.draftTheme;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });
    }

    /**
     * Build modal preview HTML for the background media.
     * @param {object|null} background
     * @returns {string}
     */
    _buildBackgroundPreviewHtml(background) {
        if (!background?.url) {
            return '<div class="customization-background-empty">No background selected</div>';
        }

        const badge = background.pending ? 'Pending upload' : 'Saved background';
        const media = background.type === 'video'
            ? `
                <video
                    class="customization-background-media"
                    src="${this._escapeHtml(background.url)}"
                    autoplay
                    loop
                    muted
                    playsinline
                ></video>
            `
            : `
                <img
                    class="customization-background-media"
                    src="${this._escapeHtml(background.url)}"
                    alt="Background preview"
                >
            `;

        return `
            ${media}
            <div class="customization-background-badge">${this._escapeHtml(badge)}</div>
            <div class="customization-background-fit-label">Cropped to fill the browser frame</div>
        `;
    }

    /**
     * Render the top summary for the customization modal.
     */
    _renderCustomizationSummary() {
        const themeEl = document.getElementById('customization-summary-theme');
        const backgroundEl = document.getElementById('customization-summary-background');
        const background = this._getPreviewBackground();
        const themeLabel = this.draftTheme === 'light' ? 'Light' : 'Dark';
        const themeSuffix = this.draftTheme !== this.settings.theme ? ' (unsaved)' : '';

        if (themeEl) {
            themeEl.textContent = `Theme: ${themeLabel}${themeSuffix}`;
        }

        if (backgroundEl) {
            if (!background?.label) {
                backgroundEl.textContent = 'Background: none';
            } else {
                const typeLabel = background.type === 'video' ? 'MP4 video' : 'image';
                const suffix = background.pending ? ' (ready to upload)' : '';
                backgroundEl.textContent = `Background: ${background.label} - ${typeLabel}${suffix}`;
            }
        }
    }

    /**
     * Render a compact status pill for save/remove/draft state.
     */
    _renderStatus() {
        const statusEl = document.getElementById('customization-status');
        if (!statusEl) return;

        const hasThemeChange = this.draftTheme !== this.settings.theme;
        const hasBackgroundChange = Boolean(this.draftBackgroundFile);
        let message = 'Current settings are active.';
        let statusClass = 'is-idle';

        if (this.isSaving) {
            message = 'Saving customization...';
            statusClass = 'is-busy';
        } else if (this.isRemovingBackground) {
            message = 'Removing background...';
            statusClass = 'is-busy';
        } else if (hasThemeChange || hasBackgroundChange) {
            message = 'Unsaved changes. Click Save Changes.';
            statusClass = 'is-draft';
        }

        statusEl.textContent = message;
        statusEl.className = `customization-status ${statusClass}`;
    }

    /**
     * Explain how the selected or saved background will be applied.
     * @param {object|null} background
     * @returns {string}
     */
    _getBackgroundNote(background) {
        if (!background?.url) {
            return 'Choose PNG/JPG for compressed still backgrounds, or MP4 for a muted video background.';
        }

        const sizeText = background.width && background.height
            ? ` Saved target: ${background.width}x${background.height}.`
            : '';

        if (background.type === 'video') {
            return `MP4 backgrounds are fitted to the browser frame and always play muted.${sizeText}`;
        }

        return `PNG/JPG backgrounds are resized and compressed for the current browser size.${sizeText}`;
    }

    /**
     * Return the background currently visible in the modal.
     * @returns {object|null}
     */
    _getPreviewBackground() {
        if (this.draftBackgroundFile && this.draftBackgroundPreviewUrl) {
            return {
                url: this.draftBackgroundPreviewUrl,
                type: this._getBackgroundTypeFromFile(this.draftBackgroundFile),
                label: this.draftBackgroundFile.name || 'Selected background',
                width: this._getViewportWidth(),
                height: this._getViewportHeight(),
                pending: true
            };
        }

        if (this.settings.background_url) {
            return {
                url: this.settings.background_url,
                type: this.settings.background_type,
                label: this.settings.background_name || 'Saved background',
                width: this.settings.background_width,
                height: this.settings.background_height,
                pending: false
            };
        }

        return null;
    }

    /**
     * Check whether a background can currently be removed.
     * @returns {boolean}
     */
    _canRemoveBackground() {
        return Boolean(this.draftBackgroundFile || this.settings.background_url);
    }

    /**
     * Reset the pending background file and preview URL.
     */
    _clearPendingBackgroundSelection() {
        if (this.draftBackgroundPreviewUrl) {
            URL.revokeObjectURL(this.draftBackgroundPreviewUrl);
        }

        this.draftBackgroundFile = null;
        this.draftBackgroundPreviewUrl = null;
    }

    /**
     * Validate a selected background file before upload.
     * @param {File} file
     * @returns {string}
     */
    _validateBackgroundFile(file) {
        if (!file) {
            return 'Please choose a PNG, JPG, or MP4 file.';
        }

        const type = this._getBackgroundTypeFromFile(file);
        if (!type) {
            return 'Background must be a PNG, JPG, or MP4 file.';
        }

        if (file.size > 80 * 1024 * 1024) {
            return 'Background file must be 80MB or smaller.';
        }

        return '';
    }

    /**
     * Infer background type from a browser File object.
     * @param {File} file
     * @returns {string}
     */
    _getBackgroundTypeFromFile(file) {
        const mimeType = String(file?.type || '').toLowerCase();
        const name = String(file?.name || '').toLowerCase();

        if (mimeType === 'video/mp4' || name.endsWith('.mp4')) {
            return 'video';
        }

        if (
            mimeType === 'image/png'
            || mimeType === 'image/jpeg'
            || name.endsWith('.png')
            || name.endsWith('.jpg')
            || name.endsWith('.jpeg')
        ) {
            return 'image';
        }

        return '';
    }

    /**
     * Normalize backend settings payload.
     * @param {object|null} settings
     * @returns {object}
     */
    _normalizeSettings(settings) {
        const normalized = {
            theme: 'dark',
            background_url: null,
            background_type: null,
            background_name: null,
            background_muted: false,
            background_width: null,
            background_height: null
        };

        if (settings && typeof settings === 'object') {
            normalized.theme = settings.theme === 'light' ? 'light' : 'dark';
            normalized.background_url = settings.background_url || null;
            normalized.background_type = settings.background_type || null;
            normalized.background_name = settings.background_name || null;
            normalized.background_muted = Boolean(settings.background_muted);
            normalized.background_width = Number(settings.background_width) > 0
                ? Number(settings.background_width)
                : null;
            normalized.background_height = Number(settings.background_height) > 0
                ? Number(settings.background_height)
                : null;
        }

        return normalized;
    }

    /**
     * Get current viewport width for background optimization.
     * @returns {number}
     */
    _getViewportWidth() {
        return Math.max(
            320,
            Math.round(window.innerWidth || document.documentElement.clientWidth || 0)
        );
    }

    /**
     * Get current viewport height for background optimization.
     * @returns {number}
     */
    _getViewportHeight() {
        return Math.max(
            320,
            Math.round(window.innerHeight || document.documentElement.clientHeight || 0)
        );
    }

    /**
     * Get current device pixel ratio with a sane lower bound.
     * @returns {number}
     */
    _getViewportPixelRatio() {
        const ratio = Number(window.devicePixelRatio || 1);
        return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    }

    /**
     * Show an inline modal error.
     * @param {string} message
     */
    _setError(message) {
        const errorEl = document.getElementById('customization-error');
        if (!errorEl) return;

        errorEl.textContent = message || 'Customization error';
        errorEl.classList.remove('hidden');
    }

    /**
     * Clear inline modal error.
     */
    _clearError() {
        const errorEl = document.getElementById('customization-error');
        if (!errorEl) return;

        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }

    /**
     * Escape HTML for safe string interpolation.
     * @param {string} text
     * @returns {string}
     */
    _escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
