/**
 * UI Manager for Popup
 */

window.Popup = window.Popup || {};

window.Popup.UIManager = {
    uiElements: {},

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
        this.uiElements.settingsExtensionEnabledToggle = document.getElementById('settings-extension-enabled-toggle');
        this.uiElements.settingsDefaultCompressionToggle = document.getElementById('settings-default-compression-toggle');
        this.uiElements.settingsDefaultMonoToggle = document.getElementById('settings-default-mono-toggle');
        this.uiElements.settingsDefaultBalanceToggle = document.getElementById('settings-default-balance-toggle');
        this.uiElements.settingsDefaultBalanceContent = document.getElementById('settings-default-balance-content');
        this.uiElements.settingsDefaultBalanceSlider = document.getElementById('settings-default-balance-slider');
        this.uiElements.settingsDefaultBalanceValue = document.getElementById('settings-default-balance-value');
        this.uiElements.shortcutsList = document.getElementById('shortcuts-list');
        
        this.uiElements.themeButton = document.getElementById('theme-button');
        this.uiElements.themeIcon = document.getElementById('theme-button')?.querySelector('.theme-icon');
        this.uiElements.connectionStatusDiv = document.getElementById('connection-status');
        this.uiElements.statusIndicator = document.getElementById('connection-status')?.querySelector('.status-indicator');
        this.uiElements.statusText = document.getElementById('connection-status')?.querySelector('.status-text');
        this.uiElements.tooltip = document.getElementById('connection-status')?.querySelector('.tooltip');
        this.uiElements.globalControls = document.querySelectorAll('[data-global-control="true"]');
    },

    formatBalanceValue: function(balance) {
        const safeBalance = Number.isFinite(Number(balance)) ? Math.round(Number(balance)) : 0;
        if (safeBalance === 0) {
            return 'Центр';
        }

        return `${safeBalance < 0 ? 'Л' : 'П'} ${Math.abs(safeBalance)}%`;
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

    updateSettingsPreferencesUI: function(preferences) {
        if (!preferences) {
            return;
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
            shortcutKey.textContent = command?.shortcut || 'Не назначено';

            const shortcutDescription = document.createElement('p');
            shortcutDescription.className = 'shortcut-description';
            shortcutDescription.textContent = command?.description || 'Описание недоступно.';

            shortcutCard.append(shortcutKey, shortcutDescription);
            shortcutsFragment.appendChild(shortcutCard);
        });

        this.uiElements.shortcutsList.appendChild(shortcutsFragment);
    },

    updateUI: function(statusObject) {
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

        const clampedVolume = Utils 
            ? Utils.normalizeVolume(volume, DEFAULT_VOLUME)
            : Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(volume)));
            
        if (this.uiElements.slider) this.uiElements.slider.value = clampedVolume;
        if (this.uiElements.volumeInput) this.uiElements.volumeInput.value = clampedVolume;
        if (this.uiElements.sliderProgress) {
            const progressPercent = (clampedVolume / MAX_VOLUME) * 100;
            this.uiElements.sliderProgress.style.width = `${progressPercent}%`;
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
            statusObject.statusDetail,
            extensionEnabled,
            audioSettingsAvailable,
            audioSettingsReason
        );
        this.updateAudioSettingsAvailabilityUI(audioSettingsAvailable, audioSettingsReason);
    },

    updateAudioSettingsAvailabilityUI: function(available, reason = null) {
        if (!this.uiElements.audioSettingsRow || !this.uiElements.monoToggle || !this.uiElements.balanceSlider) {
            return;
        }

        const reasonText = reason === 'blocked-by-cors'
            ? 'Моно и баланс недоступны: для этого медиа используется упрощённый режим из‑за CORS.'
            : reason === 'native-only-current-media'
                ? 'Моно и баланс недоступны: для этого медиа используется упрощённый режим.'
                : reason === 'legacy-firefox-capture'
                    ? 'Моно и баланс недоступны на устаревших путях захвата Firefox.'
                    : reason === 'page-unavailable'
                        ? 'Моно и баланс недоступны на этой странице.'
                        : '';

        this.uiElements.monoToggle.disabled = !available;
        this.uiElements.balanceSlider.disabled = !available;
        this.uiElements.audioSettingsRow.classList.toggle('audio-settings-limited', !available);

        if (this.uiElements.audioSettingsNote) {
            this.uiElements.audioSettingsNote.hidden = true;
            this.uiElements.audioSettingsNote.textContent = '';
        }
    },

    updateConnectionStatusUI: function(status, message = "", corsAffectedCount = 0, statusDetail = null, extensionEnabled = true, audioSettingsAvailable = true, audioSettingsReason = null) {
        if (!this.uiElements.connectionStatusDiv || !this.uiElements.statusIndicator || !this.uiElements.statusText || !this.uiElements.tooltip) {
            return;
        }

        this.uiElements.connectionStatusDiv.classList.remove('connected', 'disconnected', 'disabled', 'warning', 'limited');
        this.uiElements.statusIndicator.style.background = '';

        let statusMessage = "";
        let tooltipText = "";
        let controlsEnabled = false;
        let permanentlyDisabled = false;
        const isNativeOnlyLimited = audioSettingsAvailable === false && (
            audioSettingsReason === 'native-only-current-media' ||
            audioSettingsReason === 'blocked-by-cors'
        );

        switch (status) {
            case 'disabled':
                this.uiElements.connectionStatusDiv.classList.add('disabled');
                statusMessage = 'Отключено вручную';
                tooltipText = extensionEnabled === false
                    ? 'Управление звуком расширением отключено глобально. Сохранённые настройки вкладок не удалены.'
                    : 'Управление звуком расширением отключено для этой вкладки.';
                controlsEnabled = true;
                break;
            case 'active':
                if (statusDetail === 'setting-up') {
                    this.uiElements.connectionStatusDiv.classList.add('connected');
                    statusMessage = 'Подключение...';
                    tooltipText = 'Настройка управления звуком для медиа на этой странице';
                } else if (statusDetail === 'connecting') {
                    this.uiElements.connectionStatusDiv.classList.add('connected');
                    statusMessage = 'Подключение...';
                    tooltipText = 'Поиск воспроизводимого медиа на этой странице';
                } else if (isNativeOnlyLimited) {
                    this.uiElements.connectionStatusDiv.classList.add('limited');
                    statusMessage = 'Подключено [ограничено]';
                    tooltipText = 'Подключено. Для этого медиа используется упрощённый режим: компрессор, моно и баланс недоступны. Громкость и беззвучный режим работают через плеер.';
                } else {
                    this.uiElements.connectionStatusDiv.classList.add('connected');
                    statusMessage = 'Подключено';

                    if (corsAffectedCount > 0) {
                        const elementWord = corsAffectedCount === 1
                            ? 'элемент использует'
                            : (corsAffectedCount >= 2 && corsAffectedCount <= 4)
                                ? 'элемента используют'
                                : 'элементов используют';
                        tooltipText = `Управление звуком на этой странице.\n\nПримечание: ${corsAffectedCount} ${elementWord} упрощённый режим, потому что расширенная обработка недоступна.`;
                    } else {
                        tooltipText = 'Управление звуком на этой странице';
                    }
                }

                controlsEnabled = true;
                break;
            case 'inactive':
                // Media exists but not actively controlled
                this.uiElements.connectionStatusDiv.classList.add('disconnected');
                this.uiElements.statusIndicator.style.background = 'var(--warning)';

                if (statusDetail === 'paused') {
                    statusMessage = "Медиа на паузе";
                    tooltipText = "Медиа обнаружено, но не воспроизводится. Запустите воспроизведение, чтобы управлять громкостью.";
                } else if (statusDetail === 'error') {
                    statusMessage = "Ошибка настройки";
                    tooltipText = "Медиа обнаружено, но настройка не удалась. Попробуйте обновить страницу.";
                } else if (statusDetail === 'detecting') {
                    statusMessage = "Обнаружение...";
                    tooltipText = "Медиа обнаружено, ожидание начала воспроизведения.";
                } else if (statusDetail === 'no-source') {
                    statusMessage = "Нет источника";
                    tooltipText = "Элементы медиа найдены, но источник аудио/видео не загружен.";
                } else {
                    statusMessage = "Ожидание...";
                    tooltipText = "Медиа обнаружено, ожидание подключения. Попробуйте запустить воспроизведение.";
                }
                // Enable controls even when inactive - user can still set desired volume
                controlsEnabled = true;
                break;
            case 'no-media':
                this.uiElements.connectionStatusDiv.classList.add('disconnected');
                this.uiElements.statusIndicator.style.background = 'var(--border)';
                statusMessage = "Медиа не найдено";
                tooltipText = "На этой странице не обнаружено HTML5 audio/video";
                // Enable controls - volume will be applied when media appears
                controlsEnabled = true;
                break;
            case 'error':
                this.uiElements.connectionStatusDiv.classList.add('disconnected');
                statusMessage = "Отключено";
                tooltipText = message || "Ошибка связи со страницей.";
                permanentlyDisabled = message.includes("Нельзя обнаружить/управлять звуком на этой странице")
                    || message.includes("Cannot detect/control audio on this page");
                controlsEnabled = false;
                break;
            default:
                this.uiElements.connectionStatusDiv.classList.add('disconnected');
                this.uiElements.statusIndicator.style.background = 'var(--border)';
                statusMessage = "Проверка...";
                tooltipText = "Попытка подключения к странице...";
                controlsEnabled = false;
                break;
        }

        this.uiElements.statusText.textContent = statusMessage;
        this.uiElements.tooltip.setAttribute('data-tooltip', tooltipText);

        if (controlsEnabled) {
            this.enableControls();
        } else {
            this.disableControls(permanentlyDisabled);
        }
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
            } else {
                this.uiElements.connectionStatusDiv.style.cursor = 'pointer';
                // handleRetryConnection needs to be passed or assigned later
                // For now, we'll assume the controller assigns it or we dispatch an event
                this.uiElements.connectionStatusDiv.onclick = () => {
                    document.dispatchEvent(new CustomEvent('retry-connection'));
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
        }
    }
};
