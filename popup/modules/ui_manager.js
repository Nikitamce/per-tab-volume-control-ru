/**
 * UI Manager for Popup
 */

window.Popup = window.Popup || {};

window.Popup.UIManager = {
    uiElements: {},
    lastStatusRenderArgs: null,
    // Whether the last status render left the main controls live (false for error and checking).
    controlsEnabled: true,

    t: function(key, subs) {
        return globalThis.VCI18n?.t?.(key, subs) ?? key;
    },

    tPlural: function(baseKey, count, subs) {
        return globalThis.VCI18n?.tPlural?.(baseKey, count, subs) ?? `${baseKey}.other`;
    },

    initializeUIElements: function() {
        this.uiElements.mainView = document.getElementById('main-view');
        this.uiElements.settingsView = document.getElementById('settings-view');
        this.uiElements.shortcutsView = document.getElementById('shortcuts-view');

        this.uiElements.slider = document.getElementById('slider');
        this.uiElements.sliderProgress = document.querySelector('.slider-progress');
        this.uiElements.volumeInput = document.querySelector('.volume-input');
        this.uiElements.incrementButton = document.querySelector('.volume-button[data-action="increment"]');
        this.uiElements.decrementButton = document.querySelector('.volume-button[data-action="decrement"]');
        this.uiElements.resetVolumeButton = document.getElementById('reset-volume');
        this.uiElements.volumeContainer = document.querySelector('.volume-container');
        this.uiElements.audioSettingsRow = document.getElementById('audio-settings-row');
        this.uiElements.audioSettingsNote = document.getElementById('audio-settings-note');
        this.uiElements.compactToggle = document.getElementById('compact-toggle');
        this.uiElements.monoToggleLabel = document.getElementById('mono-toggle-label');
        this.uiElements.monoGlobalHint = document.getElementById('mono-global-hint');
        this.uiElements.monoToggle = document.getElementById('mono-toggle');
        this.uiElements.muteToggleLabel = document.getElementById('mute-toggle-label');
        this.uiElements.muteToggle = document.getElementById('mute-toggle');
        this.uiElements.balanceLabel = document.getElementById('balance-label');
        this.uiElements.balanceSlider = document.getElementById('balance-slider');
        
        this.uiElements.compressionContainer = document.querySelector('.compression-container');
        this.uiElements.compressionLabelGroup = document.getElementById('compression-label-group');
        this.uiElements.compressionGlobalHint = document.getElementById('compression-global-hint');
        this.uiElements.compressionToggleShell = document.getElementById('compression-toggle-shell');
        this.uiElements.compressionToggle = document.getElementById('compression-toggle');
        this.uiElements.compressionParamsContainer = document.getElementById('compression-params-container');
        this.uiElements.compressionThresholdSlider = document.getElementById('compression-threshold');
        this.uiElements.thresholdValueSpan = document.getElementById('threshold-value');
        this.uiElements.compressionRatioSlider = document.getElementById('compression-ratio');
        this.uiElements.ratioValueSpan = document.getElementById('ratio-value');
        this.uiElements.resetCompressorButton = document.getElementById('reset-compressor');

        this.uiElements.settingsButton = document.getElementById('settings-button');
        this.uiElements.settingsBackButton = document.getElementById('settings-back-button');
        this.uiElements.shortcutsBackButton = document.getElementById('shortcuts-back-button');
        this.uiElements.openShortcutsButton = document.getElementById('open-shortcuts-button');
        this.uiElements.settingsLanguageSelect = document.getElementById('settings-language-select');
        this.uiElements.settingsSiteEnabledToggle = document.getElementById('settings-site-enabled-toggle');
        this.uiElements.settingsSiteEnabledSubtitle = document.getElementById('settings-site-enabled-subtitle');
        this.uiElements.settingsExtensionEnabledToggle = document.getElementById('settings-extension-enabled-toggle');
        this.uiElements.settingsDefaultCompressionToggle = document.getElementById('settings-default-compression-toggle');
        this.uiElements.settingsDefaultMonoToggle = document.getElementById('settings-default-mono-toggle');
        this.uiElements.settingsDefaultBalanceToggle = document.getElementById('settings-default-balance-toggle');
        this.uiElements.settingsDefaultBalanceContent = document.getElementById('settings-default-balance-content');
        this.uiElements.settingsDefaultBalanceSlider = document.getElementById('settings-default-balance-slider');
        this.uiElements.settingsDefaultBalanceValue = document.getElementById('settings-default-balance-value');
        this.uiElements.shortcutsList = document.getElementById('shortcuts-list');
        
        this.uiElements.themeButton = document.getElementById('theme-button');
        this.uiElements.connectionStatusDiv = document.getElementById('connection-status');
        this.uiElements.statusIndicator = document.getElementById('connection-status')?.querySelector('.status-indicator');
        this.uiElements.statusText = document.getElementById('connection-status')?.querySelector('.status-text');
        this.uiElements.tooltip = document.getElementById('connection-status')?.querySelector('.tooltip');
        this.uiElements.globalControls = document.querySelectorAll('[data-global-control="true"]');
    },

    populateLanguageSelect: function(preference) {
        const select = this.uiElements.settingsLanguageSelect;
        const i18n = globalThis.VCI18n;
        if (!select || !i18n) {
            return;
        }

        const preferred = preference ?? i18n.getPreference?.() ?? i18n.DEFAULT_PREF;
        select.replaceChildren();

        const autoOption = document.createElement('option');
        autoOption.value = i18n.DEFAULT_PREF;
        autoOption.textContent = this.t('popup.settings.language.auto');
        select.appendChild(autoOption);

        (i18n.SUPPORTED_LANGUAGES || []).forEach((entry) => {
            const option = document.createElement('option');
            option.value = entry.code;
            option.textContent = entry.nativeLabel;
            select.appendChild(option);
        });

        select.value = preferred;
    },

    formatBalanceValue: function(balance) {
        const safeBalance = Number.isFinite(Number(balance)) ? Math.round(Number(balance)) : 0;
        if (safeBalance === 0) {
            return this.t('popup.balance.centre');
        }

        return safeBalance < 0
            ? this.t('popup.balance.formatLeft', { value: Math.abs(safeBalance) })
            : this.t('popup.balance.formatRight', { value: Math.abs(safeBalance) });
    },

    updateBalanceSliderUI: function(slider, balance, valueElement = null) {
        if (!slider) {
            return;
        }

        const nextBalance = Number.isFinite(Number(balance)) ? Math.round(Number(balance)) : 0;
        slider.value = nextBalance;
        slider.setAttribute('aria-valuetext', this.formatBalanceValue(nextBalance));

        if (valueElement) {
            valueElement.textContent = this.formatBalanceValue(nextBalance);
        }
    },

    updateSettingsPreferencesUI: function(preferences, currentSiteKey = this.lastSiteKey || '') {
        if (!preferences) {
            return;
        }

        this.lastSiteKey = currentSiteKey || '';

        if (this.uiElements.settingsSiteEnabledToggle) {
            const hasSite = Boolean(this.lastSiteKey);
            const globalEnabled = preferences.extensionEnabled !== false;
            const siteDisabled = hasSite && Boolean(
                globalThis.VCProtocol?.isSiteDisabled?.(this.lastSiteKey, preferences.disabledSites)
            );
            this.uiElements.settingsSiteEnabledToggle.checked = hasSite && !siteDisabled;
            this.uiElements.settingsSiteEnabledToggle.disabled = !hasSite || !globalEnabled;
        }
        if (this.uiElements.settingsSiteEnabledSubtitle) {
            this.uiElements.settingsSiteEnabledSubtitle.textContent = this.lastSiteKey
                ? `(${this.lastSiteKey})`
                : this.t('popup.settings.siteEnabled.unavailable');
        }

        if (this.uiElements.settingsExtensionEnabledToggle) {
            this.uiElements.settingsExtensionEnabledToggle.checked = preferences.extensionEnabled !== false;
        }
        if (this.uiElements.settingsDefaultCompressionToggle) {
            this.uiElements.settingsDefaultCompressionToggle.checked = Boolean(preferences.defaultCompressionEnabled);
        }
        if (this.uiElements.settingsDefaultMonoToggle) {
            this.uiElements.settingsDefaultMonoToggle.checked = Boolean(preferences.defaultMonoEnabled);
        }
        if (this.uiElements.settingsDefaultBalanceToggle) {
            this.uiElements.settingsDefaultBalanceToggle.checked = Boolean(preferences.defaultBalanceEnabled);
        }
        this.updateBalanceSliderUI(
            this.uiElements.settingsDefaultBalanceSlider,
            preferences.defaultBalance,
            this.uiElements.settingsDefaultBalanceValue
        );
        if (this.uiElements.settingsDefaultBalanceSlider) {
            this.uiElements.settingsDefaultBalanceSlider.disabled = !preferences.defaultBalanceEnabled;
        }
        if (this.uiElements.settingsDefaultBalanceContent) {
            this.uiElements.settingsDefaultBalanceContent.classList.toggle('disabled', !preferences.defaultBalanceEnabled);
        }
    },

    setActiveView: function(viewId) {
        const views = [
            this.uiElements.mainView,
            this.uiElements.settingsView,
            this.uiElements.shortcutsView
        ];

        views.forEach(view => {
            if (!view) {
                return;
            }

            const isActive = view.id === viewId;
            view.classList.toggle('active', isActive);
            view.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        });
    },

    isCompactMode: function() {
        return Boolean(this.uiElements.mainView?.classList.contains('compact'));
    },

    setCompactMode: function(isCompact) {
        const compact = Boolean(isCompact);
        this.uiElements.mainView?.classList.toggle('compact', compact);

        const toggle = this.uiElements.compactToggle;
        if (!toggle) {
            return compact;
        }

        const titleKey = compact ? 'popup.compact.expandTitle' : 'popup.compact.collapseTitle';
        const ariaKey = compact ? 'popup.compact.expandAria' : 'popup.compact.collapseAria';
        const title = this.t(titleKey);
        const ariaLabel = this.t(ariaKey);

        toggle.setAttribute('aria-expanded', compact ? 'false' : 'true');
        toggle.setAttribute('data-i18n-title', titleKey);
        toggle.setAttribute('data-i18n-aria-label', ariaKey);
        toggle.title = title;
        toggle.setAttribute('aria-label', ariaLabel);

        return compact;
    },

    renderShortcuts: function(commands = []) {
        if (!this.uiElements.shortcutsList) {
            return;
        }

        const items = Array.isArray(commands) ? commands : [];
        const shortcutsFragment = document.createDocumentFragment();

        this.uiElements.shortcutsList.replaceChildren();

        items.forEach((command) => {
            const shortcutCard = document.createElement('div');
            shortcutCard.className = 'shortcut-card';

            const shortcutKey = document.createElement('span');
            shortcutKey.className = 'shortcut-key';
            shortcutKey.textContent = command?.shortcut || this.t('popup.shortcuts.notAssigned');

            const shortcutDescription = document.createElement('p');
            shortcutDescription.className = 'shortcut-description';
            const description = command?.descriptionKey
                ? this.t(command.descriptionKey)
                : (command?.description || this.t('popup.shortcuts.noDescription'));
            shortcutDescription.textContent = description;

            shortcutCard.append(shortcutKey, shortcutDescription);
            shortcutsFragment.appendChild(shortcutCard);
        });

        this.uiElements.shortcutsList.appendChild(shortcutsFragment);
    },

    updateUI: function(statusObject, options = {}) {
        const Constants = window.Popup?.Constants || {};
        const Utils = window.Popup?.Utils;
        const {
            MIN_VOLUME = 0, 
            MAX_VOLUME = 500, 
            DEFAULT_VOLUME = 100,
            DEFAULT_MONO_ENABLED = false,
            DEFAULT_BALANCE = 0,
            DEFAULT_COMPRESSION_THRESHOLD = -18,
            DEFAULT_COMPRESSION_RATIO = 6
        } = Constants;
        
        const {
            volume = DEFAULT_VOLUME,
            status = 'inactive',
            message = "",
            messageKey = null,
            messageParams = null,
            extensionEnabled = true,
            muted = false,
            monoEnabled = DEFAULT_MONO_ENABLED,
            balance = DEFAULT_BALANCE,
            compressionEnabled = false,
            compressionThreshold = DEFAULT_COMPRESSION_THRESHOLD,
            compressionRatio = DEFAULT_COMPRESSION_RATIO,
            audioSettingsAvailable = true,
            audioSettingsReason = null,
            corsAffectedCount = 0
        } = statusObject || {};
        const preserveVolumeControls = options.preserveVolumeControls === true;

        const clampedVolume = Utils 
            ? Utils.normalizeVolume(volume, DEFAULT_VOLUME)
            : Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(volume)));

        // While the volume field is focused (typed or wheel edits in flight),
        // incoming status must not yank the controls back to the stale tab
        // value mid-gesture. Same effect as preserveVolumeControls during drags.
        const volumeInputFocused = Boolean(this.uiElements.volumeInput)
            && typeof document !== 'undefined' && Boolean(document)
            && document.activeElement === this.uiElements.volumeInput;

        if (!preserveVolumeControls && !volumeInputFocused) {
            if (this.uiElements.slider) this.uiElements.slider.value = clampedVolume;
            if (this.uiElements.volumeInput) this.uiElements.volumeInput.value = clampedVolume;
            if (this.uiElements.sliderProgress) {
                const progressPercent = (clampedVolume / MAX_VOLUME) * 100;
                this.uiElements.sliderProgress.style.width = `${progressPercent}%`;
            }
        }

        if (this.uiElements.muteToggle) this.uiElements.muteToggle.checked = Boolean(muted);
        if (this.uiElements.monoToggle) this.uiElements.monoToggle.checked = Boolean(monoEnabled);
        this.updateBalanceSliderUI(this.uiElements.balanceSlider, balance);

        if (this.uiElements.compressionToggle) this.uiElements.compressionToggle.checked = compressionEnabled;
        if (this.uiElements.compressionThresholdSlider) this.uiElements.compressionThresholdSlider.value = compressionThreshold;
        if (this.uiElements.thresholdValueSpan) this.uiElements.thresholdValueSpan.textContent = compressionThreshold;
        if (this.uiElements.compressionRatioSlider) this.uiElements.compressionRatioSlider.value = compressionRatio;
        if (this.uiElements.ratioValueSpan) this.uiElements.ratioValueSpan.textContent = compressionRatio;

        if (this.uiElements.compressionParamsContainer && this.uiElements.resetCompressorButton) {
            if (compressionEnabled) {
                this.uiElements.compressionParamsContainer.classList.remove('hidden');
                this.uiElements.resetCompressorButton.style.display = 'block';
            } else {
                this.uiElements.compressionParamsContainer.classList.add('hidden');
                this.uiElements.resetCompressorButton.style.display = 'none';
            }
        }

        this.updateConnectionStatusUI(
            status,
            message,
            corsAffectedCount,
            statusObject?.statusDetail,
            extensionEnabled,
            audioSettingsAvailable,
            audioSettingsReason,
            messageKey,
            messageParams
        );
        // The status render decides whether controls are live at all (an error disables them),
        // so page capability can only narrow that, never re-enable mono and balance.
        this.updateAudioSettingsAvailabilityUI(audioSettingsAvailable, audioSettingsReason, this.controlsEnabled !== false);
    },

    updateAudioSettingsAvailabilityUI: function(available, reason = null, controlsEnabled = true) {
        if (!this.uiElements.audioSettingsRow || !this.uiElements.monoToggle || !this.uiElements.balanceSlider) {
            return;
        }

        this.uiElements.monoToggle.disabled = !available || !controlsEnabled;
        this.uiElements.balanceSlider.disabled = !available || !controlsEnabled;
        this.uiElements.audioSettingsRow.classList.toggle('audio-settings-limited', !available);

        if (this.uiElements.audioSettingsNote) {
            this.uiElements.audioSettingsNote.hidden = true;
            this.uiElements.audioSettingsNote.textContent = '';
        }
    },

    updateConnectionStatusUI: function(status, message = "", corsAffectedCount = 0, statusDetail = null, extensionEnabled = true, audioSettingsAvailable = true, audioSettingsReason = null, messageKey = null, messageParams = null) {
        if (!this.uiElements.connectionStatusDiv || !this.uiElements.statusIndicator || !this.uiElements.statusText || !this.uiElements.tooltip) {
            return;
        }

        this.lastStatusRenderArgs = {
            status,
            message,
            corsAffectedCount,
            statusDetail,
            extensionEnabled,
            audioSettingsAvailable,
            audioSettingsReason,
            messageKey,
            messageParams
        };

        this.uiElements.connectionStatusDiv.classList.remove('connected', 'disconnected', 'disabled', 'warning', 'limited');
        this.uiElements.statusIndicator.style.background = '';

        let statusMessage = "";
        let tooltipText = "";
        let controlsEnabled = false;
        let permanentlyDisabled = false;
        const resolvedMessage = messageKey
            ? this.t(messageKey, messageParams || undefined)
            : message;
        const isNativeOnlyLimited = audioSettingsAvailable === false && (
            audioSettingsReason === 'native-only-current-media' ||
            audioSettingsReason === 'blocked-by-cors'
        );

        switch (status) {
            case 'disabled':
                this.uiElements.connectionStatusDiv.classList.add('disabled');
                statusMessage = this.t('status.disabled');
                tooltipText = extensionEnabled === false
                    ? this.t('status.disabled.tooltipGlobal')
                    : this.t('status.disabled.tooltipTab');
                controlsEnabled = true;
                break;
            case 'active':
                if (statusDetail === 'setting-up') {
                    this.uiElements.connectionStatusDiv.classList.add('connected');
                    statusMessage = this.t('status.connecting');
                    tooltipText = this.t('status.connecting.tooltipSetup');
                } else if (statusDetail === 'connecting') {
                    this.uiElements.connectionStatusDiv.classList.add('connected');
                    statusMessage = this.t('status.connecting');
                    tooltipText = this.t('status.connecting.tooltipDetecting');
                } else if (isNativeOnlyLimited) {
                    this.uiElements.connectionStatusDiv.classList.add('limited');
                    statusMessage = this.t('status.connectedLimited');
                    tooltipText = this.t('status.connectedLimited.tooltip');
                } else {
                    this.uiElements.connectionStatusDiv.classList.add('connected');
                    statusMessage = this.t('status.connected');

                    if (corsAffectedCount > 0) {
                        tooltipText = this.tPlural('status.connected.corsNote', corsAffectedCount, {
                            count: corsAffectedCount
                        });
                    } else {
                        tooltipText = this.t('status.connected.tooltip');
                    }
                }

                controlsEnabled = true;
                break;
            case 'inactive':
                this.uiElements.connectionStatusDiv.classList.add('disconnected');
                this.uiElements.statusIndicator.style.background = 'var(--warning)';

                if (statusDetail === 'paused') {
                    statusMessage = this.t('status.mediaPaused');
                    tooltipText = this.t('status.mediaPaused.tooltip');
                } else if (statusDetail === 'error') {
                    statusMessage = this.t('status.setupError');
                    tooltipText = this.t('status.setupError.tooltip');
                } else if (statusDetail === 'detecting') {
                    statusMessage = this.t('status.detecting');
                    tooltipText = this.t('status.detecting.tooltip');
                } else if (statusDetail === 'no-source') {
                    statusMessage = this.t('status.noSource');
                    tooltipText = this.t('status.noSource.tooltip');
                } else {
                    statusMessage = this.t('status.waiting');
                    tooltipText = this.t('status.waiting.tooltip');
                }
                controlsEnabled = true;
                break;
            case 'no-media':
                this.uiElements.connectionStatusDiv.classList.add('disconnected');
                this.uiElements.statusIndicator.style.background = 'var(--border)';
                statusMessage = this.t('status.noMedia');
                tooltipText = this.t('status.noMedia.tooltip');
                controlsEnabled = true;
                break;
            case 'error':
                this.uiElements.connectionStatusDiv.classList.add('disconnected');
                statusMessage = this.t('status.disconnected');
                tooltipText = resolvedMessage || this.t('status.disconnected.tooltipFallback');
                permanentlyDisabled = messageKey === 'error.pageUnsupported';
                controlsEnabled = false;
                break;
            default:
                this.uiElements.connectionStatusDiv.classList.add('disconnected');
                this.uiElements.statusIndicator.style.background = 'var(--border)';
                statusMessage = this.t('status.checking');
                tooltipText = this.t('status.checking.tooltip');
                controlsEnabled = false;
                break;
        }

        this.uiElements.statusText.textContent = statusMessage;
        this.uiElements.tooltip.setAttribute('data-tooltip', tooltipText);

        this.controlsEnabled = controlsEnabled;
        if (controlsEnabled) {
            this.enableControls();
        } else {
            this.disableControls(permanentlyDisabled);
        }
    },

    refreshLocalizedDynamicText: function() {
        if (this.lastStatusRenderArgs) {
            const args = this.lastStatusRenderArgs;
            this.updateConnectionStatusUI(
                args.status,
                args.message,
                args.corsAffectedCount,
                args.statusDetail,
                args.extensionEnabled,
                args.audioSettingsAvailable,
                args.audioSettingsReason,
                args.messageKey,
                args.messageParams
            );
        }

        if (this.uiElements.settingsDefaultBalanceSlider && this.uiElements.settingsDefaultBalanceValue) {
            this.updateBalanceSliderUI(
                this.uiElements.settingsDefaultBalanceSlider,
                this.uiElements.settingsDefaultBalanceSlider.value,
                this.uiElements.settingsDefaultBalanceValue
            );
        }

        if (this.uiElements.balanceSlider) {
            this.updateBalanceSliderUI(
                this.uiElements.balanceSlider,
                this.uiElements.balanceSlider.value
            );
        }

        this.setCompactMode(this.isCompactMode());
        this.populateLanguageSelect(globalThis.VCI18n?.getPreference?.());
    },

    disableControls: function(permanently = false) {
        Object.values(this.uiElements).forEach(el => {
            if (el && typeof el.disabled !== 'undefined') {
                if (el !== this.uiElements.incrementButton && 
                    el !== this.uiElements.decrementButton &&
                    el.dataset?.globalControl !== 'true') {
                    el.disabled = true;
                }
            }
        });
        this.uiElements.volumeContainer?.classList.add('disabled');
        this.uiElements.audioSettingsRow?.classList.add('disabled');
        this.uiElements.compressionContainer?.classList.add('disabled');

        if (this.uiElements.connectionStatusDiv) {
            if (permanently) {
                this.uiElements.connectionStatusDiv.style.cursor = 'not-allowed';
                this.uiElements.connectionStatusDiv.onclick = null;
                this.uiElements.connectionStatusDiv.onkeydown = null;
                this.uiElements.connectionStatusDiv.removeAttribute?.('role');
                this.uiElements.connectionStatusDiv.removeAttribute?.('tabindex');
                this.uiElements.connectionStatusDiv.removeAttribute?.('aria-label');
            } else {
                this.uiElements.connectionStatusDiv.style.cursor = 'pointer';
                this.uiElements.connectionStatusDiv.tabIndex = 0;
                this.uiElements.connectionStatusDiv.setAttribute?.('role', 'button');
                this.uiElements.connectionStatusDiv.setAttribute?.(
                    'aria-label',
                    (window.VCI18n?.t?.('popup.status.reconnectTooltip')) || 'Click to reconnect'
                );
                this.uiElements.connectionStatusDiv.onclick = () => {
                    document.dispatchEvent(new CustomEvent('retry-connection'));
                };
                this.uiElements.connectionStatusDiv.onkeydown = (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        document.dispatchEvent(new CustomEvent('retry-connection'));
                    }
                };
            }
        }
    },

    enableControls: function() {
        Object.values(this.uiElements).forEach(el => {
            if (el && typeof el.disabled !== 'undefined') {
                if (el.dataset?.globalControl !== 'true') {
                    el.disabled = false;
                }
            }
        });
        this.uiElements.volumeContainer?.classList.remove('disabled');
        this.uiElements.audioSettingsRow?.classList.remove('disabled');
        this.uiElements.compressionContainer?.classList.remove('disabled');
        if (this.uiElements.incrementButton) this.uiElements.incrementButton.disabled = false;
        if (this.uiElements.decrementButton) this.uiElements.decrementButton.disabled = false;

        if (this.uiElements.connectionStatusDiv) {
            this.uiElements.connectionStatusDiv.style.cursor = 'help';
            this.uiElements.connectionStatusDiv.onclick = null;
            this.uiElements.connectionStatusDiv.onkeydown = null;
            this.uiElements.connectionStatusDiv.removeAttribute?.('role');
            this.uiElements.connectionStatusDiv.removeAttribute?.('tabindex');
            this.uiElements.connectionStatusDiv.removeAttribute?.('aria-label');
        }
    }
};
