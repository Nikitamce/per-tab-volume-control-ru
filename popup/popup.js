/**
 * Popup Script - Main Controller
 */

const Protocol = globalThis.VCProtocol;
const I18n = globalThis.VCI18n;
const PopupMessages = Protocol.Messages;
const PopupPreferenceKeys = Protocol.PreferenceKeys;

const { Constants, Utils, ThemeManager, UIManager, PanelTabManager, OtherTabsManager } = window.Popup;

function t(key, subs) {
    return I18n?.t?.(key, subs) ?? key;
}
const { 
    MIN_VOLUME, MAX_VOLUME, DEFAULT_VOLUME, 
    DEFAULT_MONO_ENABLED, DEFAULT_BALANCE,
    DEFAULT_COMPRESSION_THRESHOLD, DEFAULT_COMPRESSION_RATIO, DEFAULT_COMPRESSION_KNEE,
    RESET_COMPRESSION_THRESHOLD, RESET_COMPRESSION_RATIO,
    VOLUME_SEND_THROTTLE_MS, COMPRESSION_DEBOUNCE_MS, AUDIO_SETTINGS_DEBOUNCE_MS, SETTINGS_SAVE_DEBOUNCE_MS,
    VOLUME_SNAP_POINTS, VOLUME_SNAP_THRESHOLD, VOLUME_SNAP_THRESHOLD_STRICT,
    INITIAL_VOLUME_ADJUST_DELAY_MS, INITIAL_VOLUME_ADJUST_INTERVAL_MS,
    MIN_VOLUME_ADJUST_INTERVAL_MS, VOLUME_ADJUST_INTERVAL_DECREMENT, VOLUME_ADJUST_STEP,
    VIEW_MAIN, VIEW_SETTINGS, VIEW_SHORTCUTS, SHORTCUT_COMMAND_FALLBACKS
} = Constants;

// --- State Variables ---
let currentTabId = null;
let volumeSendThrottleTimer = null;
let lastVolumeSendAt = 0;
let pendingVolumeSend = null;
let isVolumeSliderDragging = false;
let volumeSendFailedDuringDragTabId = null;
let statusRefreshDebounceTimer = null;
// Epochs: only the newest status request and the newest mute toggle may touch the snapshot.
let statusRequestSeq = 0;
let muteRequestSeq = 0;
// Volume sends: only the newest send may report a failure, and the snapshot volume only moves
// forward to the newest confirmed send.
let volumeSendSeq = 0;
let confirmedVolumeSendSeq = 0;

// One debounce slot per setting kind, so one writer never cancels another's pending send.
const DebouncedSendKind = Object.freeze({
    MONO: 'mono',
    TAB_BALANCE: 'tab-balance',
    GLOBAL_BALANCE: 'global-balance',
    COMPRESSION: 'compression',
    PREFERENCES_SAVE: 'preferences-save'
});
const debouncedSends = new Map();

let volumeAdjustTimer = null;
let currentVolumeAdjustInterval = INITIAL_VOLUME_ADJUST_INTERVAL_MS;
let currentVolumeAdjustDirection = 0;
let popupListenersRegistered = false;
let popupCompact = false;
let extensionPreferences = Protocol.normalizeExtensionPreferences({});
let latestStatusSnapshot = Protocol.normalizeStatusPayload({});

// --- Logging Utility ---
// Unified DEBUG gate for popup log output.
const DEBUG = false;
const log = (...args) => { if (DEBUG) console.log("Popup:", ...args); };
const warn = (...args) => { if (DEBUG) console.warn("Popup:", ...args); };
const error = (...args) => { console.error("Popup:", ...args); };
// Global lock hints intentionally disabled (product decision pending).
const GLOBAL_LOCK_HINTS_ENABLED = false;

// --- Debounced setting sends ---
// Replaces any pending send of the same kind. Kinds that share a `send` function
// (mono and tab balance both write the whole audio settings pair) run it once.
function scheduleDebouncedSend(kind, delayMs, send) {
    cancelDebouncedSend(kind);
    debouncedSends.set(kind, {
        send,
        timer: setTimeout(() => runDebouncedSend(send), delayMs)
    });
}

function cancelDebouncedSend(kind) {
    const slot = debouncedSends.get(kind);
    if (!slot) {
        return;
    }
    clearTimeout(slot.timer);
    debouncedSends.delete(kind);
}

function runDebouncedSend(send) {
    for (const [kind, slot] of debouncedSends) {
        if (slot.send === send) {
            clearTimeout(slot.timer);
            debouncedSends.delete(kind);
        }
    }
    send();
}

function flushDebouncedSend(kind) {
    const slot = debouncedSends.get(kind);
    if (slot) {
        runDebouncedSend(slot.send);
    }
}

function flushAllDebouncedSends() {
    const pendingSenders = new Set(Array.from(debouncedSends.values(), (slot) => slot.send));
    pendingSenders.forEach(runDebouncedSend);
}

function buildPreferenceStoragePayload(preferences) {
    return {
        [PopupPreferenceKeys.EXTENSION_ENABLED]: preferences.extensionEnabled !== false,
        [PopupPreferenceKeys.DEFAULT_COMPRESSION_ENABLED]: Boolean(preferences.defaultCompressionEnabled),
        [PopupPreferenceKeys.DEFAULT_MONO_ENABLED]: Boolean(preferences.defaultMonoEnabled),
        [PopupPreferenceKeys.DEFAULT_BALANCE_ENABLED]: Boolean(preferences.defaultBalanceEnabled),
        [PopupPreferenceKeys.DEFAULT_BALANCE]: Protocol.normalizeBalance(preferences.defaultBalance, DEFAULT_BALANCE),
    };
}

function applyExtensionPreferencePatch(patch) {
    if (!patch || typeof patch !== 'object') {
        return extensionPreferences;
    }

    const nextPreferences = { ...extensionPreferences };

    if (Object.prototype.hasOwnProperty.call(patch, 'extensionEnabled')) {
        nextPreferences.extensionEnabled = patch.extensionEnabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'defaultCompressionEnabled')) {
        nextPreferences.defaultCompressionEnabled = Boolean(patch.defaultCompressionEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'defaultMonoEnabled')) {
        nextPreferences.defaultMonoEnabled = Boolean(patch.defaultMonoEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'defaultBalanceEnabled')) {
        nextPreferences.defaultBalanceEnabled = Boolean(patch.defaultBalanceEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'defaultBalance')) {
        nextPreferences.defaultBalance = Protocol.normalizeBalance(patch.defaultBalance, DEFAULT_BALANCE);
    }

    extensionPreferences = nextPreferences;
    UIManager.updateSettingsPreferencesUI(extensionPreferences);
    syncMainControlsWithPreferences();
    return extensionPreferences;
}

function getGlobalBalanceSettings() {
    return Protocol.normalizeGlobalBalanceSettings({
        enabled: extensionPreferences.defaultBalanceEnabled,
        balance: extensionPreferences.defaultBalance
    });
}

function isGlobalBalanceEnabled() {
    return getGlobalBalanceSettings().enabled;
}

function getMainBalanceDisplayValue() {
    return isGlobalBalanceEnabled()
        ? getGlobalBalanceSettings().balance
        : Protocol.normalizeBalance(latestStatusSnapshot.balance, DEFAULT_BALANCE);
}

function getGlobalDefaultInfoMessage() {
    return t('popup.globalDefaultInfo');
}

function areAdvancedAudioControlsAvailable(statusSnapshot = latestStatusSnapshot) {
    return statusSnapshot?.audioSettingsAvailable !== false;
}

// Advanced controls are usable only when the page supports them and the current
// status render (for example an error) has not disabled the controls.
function areAdvancedAudioControlsInteractive(statusSnapshot = latestStatusSnapshot) {
    return areAdvancedAudioControlsAvailable(statusSnapshot) && UIManager.controlsEnabled !== false;
}

function getAdvancedAudioUnavailableMessage(reason = latestStatusSnapshot.audioSettingsReason) {
    if (reason === 'native-only-current-media' || reason === 'blocked-by-cors') {
        return t('popup.unavailable.nativeOnly');
    }

    if (reason === 'legacy-firefox-capture') {
        return t('popup.unavailable.legacyCapture');
    }

    if (reason === 'page-unavailable') {
        return t('popup.unavailable.page');
    }

    return t('popup.unavailable.generic');
}

function showPopupCommandError(messageKey, fallbackStatus = 'error', messageParams = null) {
    UIManager.updateUI({
        ...latestStatusSnapshot,
        status: fallbackStatus,
        messageKey,
        messageParams,
        message: '',
        extensionEnabled: latestStatusSnapshot.extensionEnabled !== false
    });
    syncMainControlsWithPreferences();
}

function syncMonoLockUI(audioSettingsAvailable, monoLocked) {
    const showMonoHint = GLOBAL_LOCK_HINTS_ENABLED && Boolean(audioSettingsAvailable && monoLocked);

    const globalDefaultInfo = getGlobalDefaultInfoMessage();

    if (UIManager.uiElements.monoToggleLabel) {
        UIManager.uiElements.monoToggleLabel.classList.toggle('control-locked', showMonoHint);
        UIManager.uiElements.monoToggleLabel.title = showMonoHint ? globalDefaultInfo : '';
    }

    if (UIManager.uiElements.monoGlobalHint) {
        UIManager.uiElements.monoGlobalHint.hidden = !showMonoHint;
        UIManager.uiElements.monoGlobalHint.title = globalDefaultInfo;
        UIManager.uiElements.monoGlobalHint.setAttribute('aria-label', globalDefaultInfo);
    }
}

function syncMainControlsWithPreferences() {
    const advancedAudioAvailable = areAdvancedAudioControlsAvailable();
    const advancedAudioInteractive = areAdvancedAudioControlsInteractive();
    const advancedAudioUnavailableMessage = getAdvancedAudioUnavailableMessage();

    if (UIManager.uiElements.monoToggle) {
        UIManager.uiElements.monoToggle.disabled = !advancedAudioInteractive;
    }

    if (UIManager.uiElements.muteToggle) {
        UIManager.uiElements.muteToggle.checked = Boolean(latestStatusSnapshot.muted);
    }

    if (UIManager.uiElements.balanceSlider) {
        UIManager.uiElements.balanceSlider.disabled = !advancedAudioInteractive;
        UIManager.updateBalanceSliderUI(UIManager.uiElements.balanceSlider, getMainBalanceDisplayValue());
    }

    if (UIManager.uiElements.audioSettingsRow) {
        UIManager.uiElements.audioSettingsRow.classList.toggle('audio-settings-limited', !advancedAudioAvailable);
    }

    if (UIManager.uiElements.compressionToggle) {
        UIManager.uiElements.compressionToggle.disabled = !advancedAudioInteractive;
        UIManager.uiElements.compressionToggle.title = advancedAudioAvailable
            ? ''
            : advancedAudioUnavailableMessage;
    }

    const compressionControlsDisabled = !advancedAudioInteractive || !Boolean(UIManager.uiElements.compressionToggle?.checked);
    if (UIManager.uiElements.compressionThresholdSlider) {
        UIManager.uiElements.compressionThresholdSlider.disabled = compressionControlsDisabled;
    }
    if (UIManager.uiElements.compressionRatioSlider) {
        UIManager.uiElements.compressionRatioSlider.disabled = compressionControlsDisabled;
    }
    if (UIManager.uiElements.resetCompressorButton) {
        UIManager.uiElements.resetCompressorButton.disabled = !advancedAudioInteractive;
        UIManager.uiElements.resetCompressorButton.title = advancedAudioAvailable
            ? ''
            : advancedAudioUnavailableMessage;
    }
    if (UIManager.uiElements.compressionContainer) {
        UIManager.uiElements.compressionContainer.classList.toggle('disabled', !advancedAudioAvailable);
    }

    syncMonoLockUI(advancedAudioAvailable, false);
    reflectGlobalCompressionPreferenceInMainUI(extensionPreferences.defaultCompressionEnabled);

    if (UIManager.uiElements.audioSettingsNote) {
        UIManager.uiElements.audioSettingsNote.hidden = true;
        UIManager.uiElements.audioSettingsNote.textContent = '';
    }
}

function reflectGlobalCompressionPreferenceInMainUI(enabled) {
    if (!UIManager.uiElements.compressionToggle || !UIManager.uiElements.compressionParamsContainer || !UIManager.uiElements.resetCompressorButton) {
        return;
    }

    const advancedAudioAvailable = areAdvancedAudioControlsAvailable();
    const advancedAudioUnavailableMessage = getAdvancedAudioUnavailableMessage();
    const showCompressionLock = GLOBAL_LOCK_HINTS_ENABLED;
    UIManager.uiElements.compressionToggle.disabled = !areAdvancedAudioControlsInteractive();

    const globalDefaultInfo = getGlobalDefaultInfoMessage();

    if (UIManager.uiElements.compressionToggleShell) {
        UIManager.uiElements.compressionToggleShell.classList.toggle('is-locked', showCompressionLock);
        UIManager.uiElements.compressionToggleShell.title = !advancedAudioAvailable
            ? advancedAudioUnavailableMessage
            : showCompressionLock
            ? globalDefaultInfo
            : t('popup.compressor.toggleTitleShort');
    }

    if (UIManager.uiElements.compressionLabelGroup) {
        UIManager.uiElements.compressionLabelGroup.title = !advancedAudioAvailable
            ? advancedAudioUnavailableMessage
            : (showCompressionLock ? globalDefaultInfo : '');
    }

    if (UIManager.uiElements.compressionGlobalHint) {
        UIManager.uiElements.compressionGlobalHint.hidden = !showCompressionLock;
        UIManager.uiElements.compressionGlobalHint.title = globalDefaultInfo;
        UIManager.uiElements.compressionGlobalHint.setAttribute('aria-label', globalDefaultInfo);
    }
}

async function persistExtensionPreferencesImmediately() {
    await browser.storage.local.set(buildPreferenceStoragePayload(extensionPreferences));
}

async function saveExtensionPreferencesImmediately(patch) {
    cancelDebouncedSend(DebouncedSendKind.PREFERENCES_SAVE);
    applyExtensionPreferencePatch(patch);
    await persistExtensionPreferencesImmediately();
}

function persistPendingExtensionPreferences() {
    persistExtensionPreferencesImmediately().catch((err) => {
        log('Failed to persist extension preferences:', err.message);
    });
}

function scheduleExtensionPreferenceSave(patch) {
    applyExtensionPreferencePatch(patch);
    scheduleDebouncedSend(DebouncedSendKind.PREFERENCES_SAVE, SETTINGS_SAVE_DEBOUNCE_MS, persistPendingExtensionPreferences);
}

async function loadExtensionPreferences() {
    try {
        const result = await browser.storage.local.get(Object.values(PopupPreferenceKeys));
        extensionPreferences = Protocol.normalizeExtensionPreferences(result);
    } catch (err) {
        log('Failed to load extension preferences:', err.message);
        extensionPreferences = Protocol.normalizeExtensionPreferences({});
    }

    UIManager.updateSettingsPreferencesUI(extensionPreferences);
    syncMainControlsWithPreferences();
}

function setActiveView(viewId) {
    UIManager.setActiveView(viewId);

    if (viewId === VIEW_MAIN) {
        if (currentTabId) {
            requestStatusFromContentScript(currentTabId, { forceProbe: true });
        } else {
            syncMainControlsWithPreferences();
        }
    }
}

async function loadShortcutCommands() {
    try {
        if (!browser.commands || typeof browser.commands.getAll !== 'function') {
            UIManager.renderShortcuts(SHORTCUT_COMMAND_FALLBACKS.map((fallback) => ({
                ...fallback,
                shortcut: fallback.shortcut || t('popup.shortcuts.notAssigned')
            })));
            return;
        }

        const commands = await browser.commands.getAll();
        const shortcuts = SHORTCUT_COMMAND_FALLBACKS.map((fallback) => {
            const match = commands.find((command) => command.name === fallback.name);
            return {
                name: fallback.name,
                shortcut: match ? (match.shortcut || t('popup.shortcuts.notAssigned')) : fallback.shortcut,
                descriptionKey: fallback.descriptionKey
            };
        });

        UIManager.renderShortcuts(shortcuts);
    } catch (err) {
        log('Failed to load shortcuts:', err.message);
        UIManager.renderShortcuts(SHORTCUT_COMMAND_FALLBACKS);
    }
}

// --- Communication with Content Script ---

async function getActiveTab() {
    try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            UIManager.updateUI({ status: 'error', messageKey: 'error.noActiveTab' });
            return null;
        }
        const activeTab = tabs[0];
        // Same scheme allow-list as the background probe (background.js), so unsupported pages never look controllable.
        if (activeTab.url && !/^(https?|file):/i.test(activeTab.url)) {
            log("Cannot interact with this page:", activeTab.url);
            UIManager.updateUI({ status: 'error', messageKey: 'error.pageUnsupported' });
            return null;
        }
        return activeTab;
    } catch (err) {
        error("Error querying tabs:", err);
        UIManager.updateUI({ status: 'error', messageKey: 'error.tabAccess' });
        return null;
    }
}

async function executeInContentScript(tabId, func, args = []) {
    if (!tabId) throw new Error("No valid tab ID provided for execution.");
    try {
        const results = await browser.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            func: func,
            args: args
        });
        return results?.find(r => r.result !== undefined)?.result ?? null;
    } catch (err) {
        error(`Error executing script in tab ${tabId}:`, err);
        let errorMessageKey = 'error.communication';
        if (err.message?.includes("Missing host permission") || err.message?.includes("cannot be scripted")) {
            errorMessageKey = 'error.pageUnsupported';
        } else if (err.message?.includes("Could not establish connection")) {
            errorMessageKey = 'error.contentScriptUnresponsive';
        }
        UIManager.updateUI({
            volume: UIManager.uiElements.slider?.value ?? DEFAULT_VOLUME,
            status: 'error',
            messageKey: errorMessageKey,
            monoEnabled: UIManager.uiElements.monoToggle?.checked ?? DEFAULT_MONO_ENABLED,
            balance: parseInt(UIManager.uiElements.balanceSlider?.value ?? DEFAULT_BALANCE, 10),
            compressionEnabled: UIManager.uiElements.compressionToggle?.checked ?? false,
            compressionThreshold: UIManager.uiElements.compressionThresholdSlider?.value ?? DEFAULT_COMPRESSION_THRESHOLD,
            compressionRatio: UIManager.uiElements.compressionRatioSlider?.value ?? DEFAULT_COMPRESSION_RATIO,
            audioSettingsAvailable: false,
            audioSettingsReason: 'page-unavailable'
        });
        throw new Error(t(errorMessageKey));
    }
}

function scheduleStatusRefresh(options = {}) {
    clearTimeout(statusRefreshDebounceTimer);
    statusRefreshDebounceTimer = setTimeout(() => {
        statusRefreshDebounceTimer = null;
        if (currentTabId) {
            requestStatusFromContentScript(currentTabId, { forceProbe: options.forceProbe === true });
        }
    }, 60);
}

async function requestStatusFromContentScript(tabId, options = {}) {
    log("Requesting status from content script...");
    const requestId = ++statusRequestSeq;
    try {
        const response = await browser.runtime.sendMessage({
            type: PopupMessages.GET_TAB_STATUS,
            payload: {
                tabId,
                forceProbe: options.forceProbe !== false
            }
        });
        if (requestId !== statusRequestSeq) {
            return;
        }
        const finalStatus = Protocol.normalizeStatusPayload(response?.status, latestStatusSnapshot);

        latestStatusSnapshot = finalStatus;
        UIManager.updateUI(finalStatus, { preserveVolumeControls: isVolumeSliderDragging });
        syncMainControlsWithPreferences();

    } catch (err) {
        log("Failed to get status:", err.message);
        if (requestId === statusRequestSeq && options.reportFailure === true) {
            showPopupCommandError('error.communication', 'error');
        }
    }
}

// Return explicit success so callers can handle failed delivery paths.
async function sendVolumeToContentScript(tabId, volume, source = 'popup:unknown') {
    log(`Sending volume ${volume}% to tab ${tabId} (source=${source})`);

    try {
        const response = await browser.runtime.sendMessage({
            type: PopupMessages.SET_REMOTE_TAB_VOLUME,
            payload: {
                tabId,
                volume: Number(volume),
                source
            }
        });
        return Boolean(response?.success);
    } catch (err) {
        log("Failed to send volume through background:", err.message);
        return false;
    }
}

async function sendCompressionSettingsToContentScript(settings) {
    if (!currentTabId) return;
    const normalizedSettings = Protocol.normalizeCompressionSettings(settings);
    log("Sending compression settings:", normalizedSettings);
    try {
        await executeInContentScript(currentTabId, (newSettings) => {
            if (window.__volumeControlExtension__ && typeof window.__volumeControlExtension__.setCompressionSettings === 'function') {
                window.__volumeControlExtension__.setCompressionSettings(newSettings);
            } else {
                console.warn("Volume Control: window.__volumeControlExtension__.setCompressionSettings function not found in content script.");
            }
        }, [normalizedSettings]);
    } catch (err) {
        log("Failed to send compression settings:", err.message);
    }
}

async function sendAudioSettingsToContentScript(settings) {
    if (!currentTabId) return;
    const rawSettings = (settings && typeof settings === 'object') ? settings : {};
    const normalizedSettings = Protocol.normalizeAudioSettings({
        monoEnabled: Object.prototype.hasOwnProperty.call(rawSettings, 'monoEnabled')
            ? rawSettings.monoEnabled
            : Boolean(UIManager.uiElements.monoToggle?.checked ?? latestStatusSnapshot.monoEnabled),
        balance: Object.prototype.hasOwnProperty.call(rawSettings, 'balance')
            ? rawSettings.balance
            : Protocol.normalizeBalance(UIManager.uiElements.balanceSlider?.value ?? latestStatusSnapshot.balance ?? DEFAULT_BALANCE, DEFAULT_BALANCE)
    });
    log('Sending audio settings:', normalizedSettings);
    try {
        const results = await browser.scripting.executeScript({
            target: { tabId: currentTabId, allFrames: true },
            func: (newSettings) => {
                if (window.__volumeControlExtension__ && typeof window.__volumeControlExtension__.setAudioSettings === 'function') {
                    window.__volumeControlExtension__.setAudioSettings(newSettings);
                    return true;
                }
                return false;
            },
            args: [normalizedSettings]
        });

        const success = results?.some((result) => result.result === true);
        if (!success) {
            showPopupCommandError('error.pageControlsUnreachable', 'error');
            requestStatusFromContentScript(currentTabId, { forceProbe: true });
        }
        return success;
    } catch (err) {
        log('Failed to send audio settings:', err.message);
        showPopupCommandError('error.pageControlsUnreachable', 'error');
        requestStatusFromContentScript(currentTabId, { forceProbe: true });
        return false;
    }
}

async function sendGlobalExtensionEnabledPreference(enabled) {
    try {
        await browser.runtime.sendMessage({
            type: PopupMessages.SET_GLOBAL_EXTENSION_ENABLED,
            payload: { enabled: Boolean(enabled) }
        });
    } catch (err) {
        log('Failed to broadcast global extension enabled preference:', err.message);
    }
}

function getCurrentTabMuteReferenceVolume() {
    return Protocol.normalizeVolume(
        latestStatusSnapshot.volume ?? UIManager.uiElements.slider?.value ?? DEFAULT_VOLUME,
        DEFAULT_VOLUME
    );
}

async function sendMuteStateToCurrentTab(muted, volumeBeforeMute) {
    if (!currentTabId) {
        return false;
    }

    const requestId = ++muteRequestSeq;
    try {
        const response = await browser.runtime.sendMessage({
            type: PopupMessages.SET_TAB_MUTE_STATE,
            payload: {
                tabId: currentTabId,
                muted: Boolean(muted),
                volumeBeforeMute: Number.isFinite(Number(volumeBeforeMute))
                    ? Protocol.normalizeVolume(volumeBeforeMute, DEFAULT_VOLUME)
                    : undefined
            }
        });

        const success = response?.success !== false;
        if (requestId !== muteRequestSeq) {
            // A newer toggle is in flight and owns the snapshot and the error feedback.
            return success;
        }
        if (!success) {
            showPopupCommandError('error.muteUpdateFailed', 'error');
            requestStatusFromContentScript(currentTabId, { forceProbe: true });
            return false;
        }

        latestStatusSnapshot = {
            ...latestStatusSnapshot,
            muted: Boolean(muted)
        };
        UIManager.updateUI(latestStatusSnapshot, { preserveVolumeControls: isVolumeSliderDragging });
        syncMainControlsWithPreferences();
        return true;
    } catch (err) {
        log('Failed to send mute state:', err.message);
        if (requestId !== muteRequestSeq) {
            return false;
        }
        showPopupCommandError('error.muteUpdateFailed', 'error');
        requestStatusFromContentScript(currentTabId, { forceProbe: true });
        return false;
    }
}

async function sendGlobalBalancePreference(settings) {
    try {
        await browser.runtime.sendMessage({
            type: PopupMessages.SET_GLOBAL_BALANCE,
            payload: Protocol.normalizeGlobalBalanceSettings(settings)
        });
    } catch (err) {
        log('Failed to broadcast global balance preference:', err.message);
    }
}

function scheduleGlobalBalanceStatusRefresh() {
    if (currentTabId) {
        requestStatusFromContentScript(currentTabId, { forceProbe: true });
        return;
    }

    syncMainControlsWithPreferences();
}

async function saveAndBroadcastGlobalBalance(patch, options = {}) {
    const { immediate = true, refreshActiveTab = true } = options;
    const currentSettings = getGlobalBalanceSettings();
    const nextSettings = Protocol.normalizeGlobalBalanceSettings({
        ...currentSettings,
        ...patch
    });

    if (immediate) {
        await saveExtensionPreferencesImmediately({
            defaultBalanceEnabled: nextSettings.enabled,
            defaultBalance: nextSettings.balance
        });
        await sendGlobalBalancePreference(nextSettings);
    } else {
        scheduleExtensionPreferenceSave({
            defaultBalanceEnabled: nextSettings.enabled,
            defaultBalance: nextSettings.balance
        });
        await sendGlobalBalancePreference(nextSettings);
    }

    if (nextSettings.enabled) {
        latestStatusSnapshot = {
            ...latestStatusSnapshot,
            balance: nextSettings.balance
        };
        UIManager.updateUI({
            ...latestStatusSnapshot,
            balance: nextSettings.balance
        });
    }

    if (refreshActiveTab) {
        scheduleGlobalBalanceStatusRefresh();
    } else {
        syncMainControlsWithPreferences();
    }
}

// --- Event Handlers ---

function snapVolumeToNearest(value, threshold = VOLUME_SNAP_THRESHOLD) {
    const thresholdValue = (threshold / 100) * MAX_VOLUME;
    let nearestSnap = VOLUME_SNAP_POINTS[0];
    let minDistance = Math.abs(value - nearestSnap);
    
    for (const snapPoint of VOLUME_SNAP_POINTS) {
        const distance = Math.abs(value - snapPoint);
        if (distance < minDistance) {
            minDistance = distance;
            nearestSnap = snapPoint;
        }
    }
    
    if (minDistance <= thresholdValue) {
        return nearestSnap;
    }
    return value;
}

function handleVolumeChange(newValue, shouldSnap = true, source = 'popup:unknown') {
    let clampedVolume = Utils.normalizeVolume(newValue, DEFAULT_VOLUME);
    
    if (shouldSnap) {
        clampedVolume = snapVolumeToNearest(clampedVolume, VOLUME_SNAP_THRESHOLD);
    }
    setVolumeWidgets(clampedVolume);

    scheduleThrottledVolumeSend(clampedVolume, source);
}

function setVolumeWidgets(volume) {
    if (UIManager.uiElements.slider) UIManager.uiElements.slider.value = volume;
    if (UIManager.uiElements.volumeInput) UIManager.uiElements.volumeInput.value = volume;
    if (UIManager.uiElements.sliderProgress) {
        const progressPercent = (volume / MAX_VOLUME) * 100;
        UIManager.uiElements.sliderProgress.style.width = `${progressPercent}%`;
    }
}

// A send that the page never received leaves the widgets on a volume nothing applied. The snapshot
// holds the last confirmed volume, so show that and ask for a fresh status. Nothing is sent to the
// background: a failed command must not claim a volume there.
//
// While the user is still dragging the slider the widgets belong to the user: a failure is only
// remembered, and the revert, the error and the status probe happen once when the drag ends. A
// later send that succeeds cancels the remembered failure.
function reportVolumeSendFailure(tabId) {
    setVolumeWidgets(Protocol.normalizeVolume(latestStatusSnapshot.volume, DEFAULT_VOLUME));
    showPopupCommandError('error.pageControlsUnreachable', 'error');
    requestStatusFromContentScript(tabId, { forceProbe: true });
}

function handleVolumeSendResult(sendId, tabId, volume, applied) {
    if (applied) {
        if (sendId > confirmedVolumeSendSeq && tabId === currentTabId) {
            confirmedVolumeSendSeq = sendId;
            latestStatusSnapshot = {
                ...latestStatusSnapshot,
                volume: Protocol.normalizeVolume(volume, DEFAULT_VOLUME)
            };
        }
        if (sendId === volumeSendSeq && tabId === volumeSendFailedDuringDragTabId) {
            volumeSendFailedDuringDragTabId = null;
        }
        return;
    }
    if (sendId !== volumeSendSeq || tabId !== currentTabId) {
        return;
    }
    if (isVolumeSliderDragging) {
        volumeSendFailedDuringDragTabId = tabId;
        return;
    }
    reportVolumeSendFailure(tabId);
}

function dispatchPendingVolumeSend(pending) {
    if (!pending || !currentTabId) {
        return;
    }
    lastVolumeSendAt = Date.now();
    const sendId = ++volumeSendSeq;
    const tabId = currentTabId;
    // A newer send supersedes a failure remembered during the drag.
    volumeSendFailedDuringDragTabId = null;
    void sendVolumeToContentScript(tabId, pending.volume, pending.source).then((applied) => {
        handleVolumeSendResult(sendId, tabId, pending.volume, applied);
    });
}

function scheduleThrottledVolumeSend(volume, source) {
    pendingVolumeSend = { volume, source };
    const throttleMs = VOLUME_SEND_THROTTLE_MS || 100;
    const elapsed = Date.now() - lastVolumeSendAt;
    if (lastVolumeSendAt === 0 || elapsed >= throttleMs) {
        if (volumeSendThrottleTimer) {
            clearTimeout(volumeSendThrottleTimer);
            volumeSendThrottleTimer = null;
        }
        const pending = pendingVolumeSend;
        pendingVolumeSend = null;
        dispatchPendingVolumeSend(pending);
        return;
    }
    if (volumeSendThrottleTimer) {
        return;
    }
    volumeSendThrottleTimer = setTimeout(() => {
        volumeSendThrottleTimer = null;
        const pending = pendingVolumeSend;
        pendingVolumeSend = null;
        dispatchPendingVolumeSend(pending);
    }, throttleMs - elapsed);
}

function flushPendingSends() {
    if (volumeSendThrottleTimer) {
        clearTimeout(volumeSendThrottleTimer);
        volumeSendThrottleTimer = null;
    }
    if (pendingVolumeSend) {
        const pending = pendingVolumeSend;
        pendingVolumeSend = null;
        if (currentTabId) {
            void sendVolumeToContentScript(currentTabId, pending.volume, pending.source);
        }
    }
    flushAllDebouncedSends();
}

function handleVolumeSliderRelease() {
    const currentValue = parseInt(UIManager.uiElements.slider?.value ?? DEFAULT_VOLUME, 10);
    const snappedValue = snapVolumeToNearest(currentValue, VOLUME_SNAP_THRESHOLD_STRICT);
    
    if (snappedValue !== currentValue) {
        handleVolumeChange(snappedValue, false, 'popup:slider-release');
    }
}

function handleCompressionSliderChange() {
    const threshold = parseInt(UIManager.uiElements.compressionThresholdSlider.value, 10);
    const ratio = parseInt(UIManager.uiElements.compressionRatioSlider.value, 10);
    const knee = DEFAULT_COMPRESSION_KNEE;

    latestStatusSnapshot = {
        ...latestStatusSnapshot,
        compressionThreshold: threshold,
        compressionRatio: ratio,
        compressionKnee: knee
    };

    if (UIManager.uiElements.thresholdValueSpan) UIManager.uiElements.thresholdValueSpan.textContent = threshold;
    if (UIManager.uiElements.ratioValueSpan) UIManager.uiElements.ratioValueSpan.textContent = ratio;

    scheduleDebouncedSend(DebouncedSendKind.COMPRESSION, COMPRESSION_DEBOUNCE_MS, () => {
        // Gate on the live toggle so a flush after "off" can never re-enable the compressor.
        const enabled = Boolean(UIManager.uiElements.compressionToggle?.checked);
        if (currentTabId && enabled) {
            void sendCompressionSettingsToContentScript({ enabled, threshold, ratio, knee });
        }
    });
}

function handleCompressionToggleChange() {
    // The toggle (and the reset that routes through it) sends the full state itself, so a
    // pending slider send is stale.
    cancelDebouncedSend(DebouncedSendKind.COMPRESSION);
    const enabled = UIManager.uiElements.compressionToggle.checked;
    const threshold = parseInt(UIManager.uiElements.compressionThresholdSlider?.value ?? DEFAULT_COMPRESSION_THRESHOLD, 10);
    const ratio = parseInt(UIManager.uiElements.compressionRatioSlider?.value ?? DEFAULT_COMPRESSION_RATIO, 10);
    const knee = DEFAULT_COMPRESSION_KNEE;

    latestStatusSnapshot = {
        ...latestStatusSnapshot,
        compressionEnabled: enabled,
        compressionThreshold: threshold,
        compressionRatio: ratio,
        compressionKnee: knee
    };

    UIManager.updateUI({
        ...latestStatusSnapshot,
        volume: UIManager.uiElements.slider?.value ?? DEFAULT_VOLUME,
        compressionEnabled: enabled,
        compressionThreshold: threshold,
        compressionRatio: ratio,
        compressionKnee: knee
    });
    syncMainControlsWithPreferences();

    if (currentTabId) {
        sendCompressionSettingsToContentScript({ enabled, threshold, ratio, knee });
    }
}

// Stable reference shared by the mono and tab balance slots so one run covers both.
function sendCurrentAudioSettings() {
    void sendAudioSettingsToContentScript();
}

function handleMonoToggleChange() {
    latestStatusSnapshot = {
        ...latestStatusSnapshot,
        monoEnabled: Boolean(UIManager.uiElements.monoToggle?.checked)
    };

    scheduleDebouncedSend(DebouncedSendKind.MONO, AUDIO_SETTINGS_DEBOUNCE_MS, sendCurrentAudioSettings);
}

function handleMuteToggleChange() {
    const muted = Boolean(UIManager.uiElements.muteToggle?.checked);

    latestStatusSnapshot = {
        ...latestStatusSnapshot,
        muted
    };
    UIManager.updateUI(latestStatusSnapshot, { preserveVolumeControls: isVolumeSliderDragging });
    syncMainControlsWithPreferences();

    sendMuteStateToCurrentTab(muted, muted ? getCurrentTabMuteReferenceVolume() : undefined).catch((err) => {
        log('Failed to handle mute toggle:', err.message);
    });
}

function handleBalanceSliderChange(commitImmediately = false) {
    const balance = Protocol.normalizeBalance(UIManager.uiElements.balanceSlider?.value, DEFAULT_BALANCE);

    UIManager.updateBalanceSliderUI(UIManager.uiElements.balanceSlider, balance);
    if (isGlobalBalanceEnabled()) {
        const send = () => {
            saveAndBroadcastGlobalBalance({ balance }, {
                immediate: true,
                refreshActiveTab: true
            }).catch((err) => {
                log('Failed to update global balance from main slider:', err.message);
            });
        };

        if (commitImmediately) {
            cancelDebouncedSend(DebouncedSendKind.GLOBAL_BALANCE);
            send();
            return;
        }

        scheduleDebouncedSend(DebouncedSendKind.GLOBAL_BALANCE, AUDIO_SETTINGS_DEBOUNCE_MS, send);
        return;
    }

    latestStatusSnapshot = {
        ...latestStatusSnapshot,
        balance
    };

    if (commitImmediately) {
        // Sends mono and balance together, so a pending mono toggle is covered too.
        runDebouncedSend(sendCurrentAudioSettings);
        return;
    }
    scheduleDebouncedSend(DebouncedSendKind.TAB_BALANCE, AUDIO_SETTINGS_DEBOUNCE_MS, sendCurrentAudioSettings);
}

function handleBalanceSliderDoubleClick() {
    if (!UIManager.uiElements.balanceSlider || UIManager.uiElements.balanceSlider.disabled) {
        return;
    }

    UIManager.uiElements.balanceSlider.value = DEFAULT_BALANCE;
    handleBalanceSliderChange(true);
}

function handleDefaultBalanceSliderDoubleClick() {
    if (!UIManager.uiElements.settingsDefaultBalanceSlider || UIManager.uiElements.settingsDefaultBalanceSlider.disabled) {
        return;
    }

    UIManager.uiElements.settingsDefaultBalanceSlider.value = DEFAULT_BALANCE;
    handleDefaultBalancePreferenceChange(true);
}

function handleResetCompressor() {
    log("Resetting compressor settings to defaults.");
    if (UIManager.uiElements.compressionThresholdSlider) UIManager.uiElements.compressionThresholdSlider.value = RESET_COMPRESSION_THRESHOLD;
    if (UIManager.uiElements.compressionRatioSlider) UIManager.uiElements.compressionRatioSlider.value = RESET_COMPRESSION_RATIO;

    if (UIManager.uiElements.thresholdValueSpan) UIManager.uiElements.thresholdValueSpan.textContent = RESET_COMPRESSION_THRESHOLD;
    if (UIManager.uiElements.ratioValueSpan) UIManager.uiElements.ratioValueSpan.textContent = RESET_COMPRESSION_RATIO;

    handleCompressionToggleChange();
}

function handleResetVolume() {
    handleVolumeChange(DEFAULT_VOLUME, true, 'popup:reset');
}

async function handleDefaultCompressionPreferenceChange() {
    const enabled = Boolean(UIManager.uiElements.settingsDefaultCompressionToggle?.checked);
    try {
        await saveExtensionPreferencesImmediately({
            defaultCompressionEnabled: enabled
        });

        OtherTabsManager?.handleGlobalCompressionPreferenceChange?.(enabled);
        syncMainControlsWithPreferences();
    } catch (err) {
        log('Failed to save default compression preference:', err.message);
    }
}

async function handleDefaultMonoPreferenceChange() {
    const enabled = Boolean(UIManager.uiElements.settingsDefaultMonoToggle?.checked);
    try {
        await saveExtensionPreferencesImmediately({
            defaultMonoEnabled: enabled
        });
        syncMainControlsWithPreferences();
    } catch (err) {
        log('Failed to save default mono preference:', err.message);
    }
}

async function handleDefaultBalanceEnabledChange() {
    const enabled = Boolean(UIManager.uiElements.settingsDefaultBalanceToggle?.checked);
    try {
        await saveAndBroadcastGlobalBalance({ enabled }, {
            immediate: true,
            refreshActiveTab: true
        });
    } catch (err) {
        log('Failed to save default balance enabled preference:', err.message);
    }
}

function handleDefaultBalancePreferenceChange(commitImmediately = false) {
    const balance = Protocol.normalizeBalance(UIManager.uiElements.settingsDefaultBalanceSlider?.value, DEFAULT_BALANCE);
    UIManager.updateBalanceSliderUI(
        UIManager.uiElements.settingsDefaultBalanceSlider,
        balance,
        UIManager.uiElements.settingsDefaultBalanceValue
    );

    if (commitImmediately) {
        cancelDebouncedSend(DebouncedSendKind.GLOBAL_BALANCE);
        saveAndBroadcastGlobalBalance({ balance }, {
            immediate: true,
            refreshActiveTab: isGlobalBalanceEnabled()
        }).catch((err) => {
            log('Failed to save default balance preference:', err.message);
        });
        return;
    }

    if (isGlobalBalanceEnabled()) {
        scheduleDebouncedSend(DebouncedSendKind.GLOBAL_BALANCE, AUDIO_SETTINGS_DEBOUNCE_MS, () => {
            saveAndBroadcastGlobalBalance({ balance }, {
                immediate: true,
                refreshActiveTab: true
            }).catch((err) => {
                log('Failed to save live global balance preference:', err.message);
            });
        });
        return;
    }

    scheduleExtensionPreferenceSave({ defaultBalance: balance });
}

async function handleExtensionEnabledPreferenceChange() {
    const enabled = Boolean(UIManager.uiElements.settingsExtensionEnabledToggle?.checked);

    try {
        await saveExtensionPreferencesImmediately({ extensionEnabled: enabled });
        await sendGlobalExtensionEnabledPreference(enabled);

        if (!enabled) {
            latestStatusSnapshot = {
                ...latestStatusSnapshot,
                status: 'disabled',
                statusDetail: 'manual-disabled',
                extensionEnabled: false
            };
            UIManager.updateUI(latestStatusSnapshot);
            syncMainControlsWithPreferences();
            return;
        }

        if (currentTabId) {
            requestStatusFromContentScript(currentTabId, { forceProbe: true });
        }
    } catch (err) {
        log('Failed to save extension enabled preference:', err.message);
    }
}

function handleVolumeAdjustInitial(direction) {
    const currentValue = parseInt(UIManager.uiElements.slider?.value ?? DEFAULT_VOLUME, 10);
    handleVolumeChange(currentValue + (10 * direction), false, 'popup:button-initial');

    currentVolumeAdjustDirection = direction;
    currentVolumeAdjustInterval = INITIAL_VOLUME_ADJUST_INTERVAL_MS;

    clearTimeout(volumeAdjustTimer);

    const tickRepeat = () => {
        const currentVal = parseInt(UIManager.uiElements.slider?.value ?? DEFAULT_VOLUME, 10);
        handleVolumeChange(currentVal + (VOLUME_ADJUST_STEP * currentVolumeAdjustDirection), false, 'popup:button-repeat');
        currentVolumeAdjustInterval = Math.max(
            MIN_VOLUME_ADJUST_INTERVAL_MS,
            currentVolumeAdjustInterval - VOLUME_ADJUST_INTERVAL_DECREMENT
        );
        volumeAdjustTimer = setTimeout(tickRepeat, currentVolumeAdjustInterval);
    };

    volumeAdjustTimer = setTimeout(tickRepeat, INITIAL_VOLUME_ADJUST_DELAY_MS);
}

function stopVolumeAdjustment() {
    clearTimeout(volumeAdjustTimer);
    volumeAdjustTimer = null;
    currentVolumeAdjustDirection = 0;
    currentVolumeAdjustInterval = INITIAL_VOLUME_ADJUST_INTERVAL_MS;
}

async function loadPopupCompactPreference() {
    try {
        const result = await browser.storage.local.get('popupCompact');
        popupCompact = Boolean(result.popupCompact);
    } catch (err) {
        error('Failed to load popupCompact preference:', err);
        popupCompact = false;
    }
    UIManager.setCompactMode(popupCompact);
}

function handleCompactToggleClick() {
    popupCompact = !popupCompact;
    UIManager.setCompactMode(popupCompact);
    OtherTabsManager?.handleCompactModeChanged?.(popupCompact);
    browser.storage.local.set({ popupCompact }).catch((err) => {
        error('Failed to save popupCompact preference:', err);
    });
}

function handleThemeToggle() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    ThemeManager.applyTheme(newTheme);
}

function handleSettingsButtonClick() {
    setActiveView(VIEW_SETTINGS);
}

function handleSettingsBack() {
    setActiveView(VIEW_MAIN);
}

function handleShortcutsOpen() {
    setActiveView(VIEW_SHORTCUTS);
    loadShortcutCommands();
}

function handleShortcutsBack() {
    setActiveView(VIEW_SETTINGS);
}

async function handleLanguagePreferenceChange() {
    const nextPreference = UIManager.uiElements.settingsLanguageSelect?.value || I18n.DEFAULT_PREF;
    try {
        await I18n.setLanguage(nextPreference);
        UIManager.refreshLocalizedDynamicText();
        syncMainControlsWithPreferences();
        await loadShortcutCommands();
        OtherTabsManager?.refreshLocalizedCopy?.();
    } catch (err) {
        log('Failed to change language preference:', err.message);
    }
}

function handleRetryConnection() {
    if (currentTabId) {
        log("Retrying connection...");
        UIManager.updateConnectionStatusUI('inactive');
        requestStatusFromContentScript(currentTabId, { forceProbe: true, reportFailure: true });
    }
}

function handleRuntimeMessages(message, sender) {
    log("[handleRuntimeMessages] Received message:", {
        type: message.type,
        senderTabId: sender.tab?.id,
        currentTabId: currentTabId,
        senderUrl: sender.url,
        payload: message.payload
    });
    
    if (message.type === PopupMessages.STATUS_UPDATE && sender.tab && sender.tab.id === currentTabId) {
        const normalizedPayload = Protocol.normalizeStatusPayload(message.payload);
        log("Received STATUS_UPDATE from content script:", normalizedPayload);
        scheduleStatusRefresh({ forceProbe: false });
    } else if (message.type === PopupMessages.STATUS_UPDATE) {
        log("[handleRuntimeMessages] STATUS_UPDATE ignored - tab mismatch or no sender.tab");
    } else {
        // Keep a trace for unexpected message types during debug sessions.
        log("[handleRuntimeMessages] Unhandled message type:", message.type);
    }
}

// --- Setup Event Listeners ---

function setupEventListeners() {
    if (popupListenersRegistered) {
        return;
    }

    UIManager.uiElements.slider?.addEventListener('input', (e) => handleVolumeChange(e.target.value, true, 'popup:slider-input'));
    UIManager.uiElements.slider?.addEventListener('change', handleVolumeSliderRelease);
    UIManager.uiElements.slider?.addEventListener('pointerdown', () => {
        isVolumeSliderDragging = true;
    });
    const endVolumeSliderDrag = () => {
        if (!isVolumeSliderDragging) {
            return;
        }
        isVolumeSliderDragging = false;
        if (volumeSendFailedDuringDragTabId !== null && volumeSendFailedDuringDragTabId === currentTabId) {
            volumeSendFailedDuringDragTabId = null;
            reportVolumeSendFailure(currentTabId);
            return;
        }
        volumeSendFailedDuringDragTabId = null;
        // The snapshot holds the last confirmed volume; a newer send may still be in flight, so keep the widgets.
        UIManager.updateUI(latestStatusSnapshot, { preserveVolumeControls: true });
        syncMainControlsWithPreferences();
    };
    UIManager.uiElements.slider?.addEventListener('pointerup', endVolumeSliderDrag);
    UIManager.uiElements.slider?.addEventListener('pointercancel', endVolumeSliderDrag);
    window.addEventListener('pointerup', endVolumeSliderDrag);
    
    // Volume input - prevent non-numeric input and handle validation
    if (UIManager.uiElements.volumeInput) {
        Utils.bindVolumeInputWheel(UIManager.uiElements.volumeInput);

        // Prevent invalid characters from being typed (keydown for early prevention)
        UIManager.uiElements.volumeInput.addEventListener('keydown', (e) => {
            // Allow: backspace, delete, tab, escape, enter, arrows
            const allowedKeys = ['Backspace', 'Delete', 'Tab', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
            if (allowedKeys.includes(e.key)) {
                return; // Allow these keys
            }
            
            // Allow Ctrl/Cmd combinations (copy, paste, select all)
            if (e.ctrlKey || e.metaKey) {
                return;
            }
            
            // Block any non-digit key
            if (!/^\d$/.test(e.key)) {
                e.preventDefault();
            }
        });
        
        // Handle paste - sanitize pasted content
        UIManager.uiElements.volumeInput.addEventListener('paste', (e) => {
            e.preventDefault();
            const pastedText = (e.clipboardData || window.clipboardData).getData('text');
            const sanitized = Utils.sanitizeVolumeInput(pastedText);
            if (sanitized) {
                // Insert sanitized text at cursor position
                const input = e.target;
                const start = input.selectionStart;
                const end = input.selectionEnd;
                const currentValue = input.value;
                const newValue = currentValue.substring(0, start) + sanitized + currentValue.substring(end);
                const clampedValue = Utils.normalizeVolume(newValue, DEFAULT_VOLUME);
                input.value = clampedValue;
                handleVolumeChange(clampedValue, false, 'popup:text-input-paste');
            }
        });
        
        // Live input handling - only process if value is valid
        UIManager.uiElements.volumeInput.addEventListener('input', (e) => {
            const sanitized = Utils.sanitizeVolumeInput(e.target.value);
            
            // If input was sanitized (had non-digits), update the field
            if (sanitized !== e.target.value) {
                e.target.value = sanitized;
            }
            
            // Only process if we have digits (empty is allowed during typing)
            if (sanitized !== '') {
                handleVolumeChange(sanitized, false, 'popup:text-input-live');
            }
        });
        
        // On blur/change - ensure valid value and clamp to range
        UIManager.uiElements.volumeInput.addEventListener('change', (e) => {
            const sanitized = Utils.sanitizeVolumeInput(e.target.value);
            // Use current slider value as fallback if input is empty or invalid
            const fallback = parseInt(UIManager.uiElements.slider?.value, 10) || DEFAULT_VOLUME;
            const volume = sanitized === '' ? fallback : Utils.normalizeVolume(sanitized, fallback);
            handleVolumeChange(volume, false, 'popup:text-input-commit');
        });
    }
    
    UIManager.uiElements.resetVolumeButton?.addEventListener('click', handleResetVolume);
    
    if (UIManager.uiElements.incrementButton) {
        UIManager.uiElements.incrementButton.addEventListener('mousedown', (e) => {
            e.preventDefault();
            handleVolumeAdjustInitial(1);
        });
        UIManager.uiElements.incrementButton.addEventListener('mouseup', stopVolumeAdjustment);
        UIManager.uiElements.incrementButton.addEventListener('mouseleave', stopVolumeAdjustment);
        UIManager.uiElements.incrementButton.addEventListener('touchstart', (e) => {
            e.preventDefault();
            handleVolumeAdjustInitial(1);
        });
        UIManager.uiElements.incrementButton.addEventListener('touchend', (e) => {
            e.preventDefault();
            stopVolumeAdjustment();
        });
        UIManager.uiElements.incrementButton.addEventListener('touchcancel', stopVolumeAdjustment);
    }
    
    if (UIManager.uiElements.decrementButton) {
        UIManager.uiElements.decrementButton.addEventListener('mousedown', (e) => {
            e.preventDefault();
            handleVolumeAdjustInitial(-1);
        });
        UIManager.uiElements.decrementButton.addEventListener('mouseup', stopVolumeAdjustment);
        UIManager.uiElements.decrementButton.addEventListener('mouseleave', stopVolumeAdjustment);
        UIManager.uiElements.decrementButton.addEventListener('touchstart', (e) => {
            e.preventDefault();
            handleVolumeAdjustInitial(-1);
        });
        UIManager.uiElements.decrementButton.addEventListener('touchend', (e) => {
            e.preventDefault();
            stopVolumeAdjustment();
        });
        UIManager.uiElements.decrementButton.addEventListener('touchcancel', stopVolumeAdjustment);
    }

    UIManager.uiElements.compressionToggle?.addEventListener('change', handleCompressionToggleChange);
    UIManager.uiElements.compressionThresholdSlider?.addEventListener('input', handleCompressionSliderChange);
    UIManager.uiElements.compressionRatioSlider?.addEventListener('input', handleCompressionSliderChange);
    UIManager.uiElements.resetCompressorButton?.addEventListener('click', handleResetCompressor);
    UIManager.uiElements.muteToggle?.addEventListener('change', handleMuteToggleChange);
    UIManager.uiElements.monoToggle?.addEventListener('change', handleMonoToggleChange);
    UIManager.uiElements.balanceSlider?.addEventListener('input', () => handleBalanceSliderChange(false));
    UIManager.uiElements.balanceSlider?.addEventListener('change', () => handleBalanceSliderChange(true));
    UIManager.uiElements.balanceSlider?.addEventListener('dblclick', handleBalanceSliderDoubleClick);
    UIManager.uiElements.balanceLabel?.addEventListener('dblclick', handleBalanceSliderDoubleClick);

    UIManager.uiElements.themeButton?.addEventListener('click', handleThemeToggle);
    UIManager.uiElements.compactToggle?.addEventListener('click', handleCompactToggleClick);
    UIManager.uiElements.settingsButton?.addEventListener('click', handleSettingsButtonClick);
    UIManager.uiElements.settingsBackButton?.addEventListener('click', handleSettingsBack);
    UIManager.uiElements.shortcutsBackButton?.addEventListener('click', handleShortcutsBack);
    UIManager.uiElements.openShortcutsButton?.addEventListener('click', handleShortcutsOpen);
    UIManager.uiElements.settingsLanguageSelect?.addEventListener('change', handleLanguagePreferenceChange);
    UIManager.uiElements.settingsExtensionEnabledToggle?.addEventListener('change', handleExtensionEnabledPreferenceChange);
    UIManager.uiElements.settingsDefaultCompressionToggle?.addEventListener('change', handleDefaultCompressionPreferenceChange);
    UIManager.uiElements.settingsDefaultMonoToggle?.addEventListener('change', handleDefaultMonoPreferenceChange);
    UIManager.uiElements.settingsDefaultBalanceToggle?.addEventListener('change', handleDefaultBalanceEnabledChange);
    UIManager.uiElements.settingsDefaultBalanceSlider?.addEventListener('input', () => handleDefaultBalancePreferenceChange(false));
    UIManager.uiElements.settingsDefaultBalanceSlider?.addEventListener('change', () => handleDefaultBalancePreferenceChange(true));
    UIManager.uiElements.settingsDefaultBalanceSlider?.addEventListener('dblclick', handleDefaultBalanceSliderDoubleClick);

    browser.runtime.onMessage.addListener(handleRuntimeMessages);
    
    // Listen for retry event from UIManager
    document.addEventListener('retry-connection', handleRetryConnection);
    popupListenersRegistered = true;
}

// --- Initialization ---

async function init() {
    document.body?.classList.add('i18n-pending');

    try {
        await I18n.init();
        I18n.applyToDocument(document);
        I18n.startStorageSync();
        I18n.subscribe(() => {
            UIManager.refreshLocalizedDynamicText();
            syncMainControlsWithPreferences();
            loadShortcutCommands().catch(() => {});
            OtherTabsManager?.refreshLocalizedCopy?.();
        });
    } catch (err) {
        log('Failed to initialize i18n:', err.message);
    } finally {
        document.body?.classList.remove('i18n-pending');
    }

    UIManager.initializeUIElements();
    UIManager.populateLanguageSelect(I18n.getPreference());
    
    await ThemeManager.loadTheme();
    await loadPopupCompactPreference();
    await loadExtensionPreferences();
    PanelTabManager.initialize();
    setupEventListeners();
    setActiveView(VIEW_MAIN);
    UIManager.updateUI({ status: 'inactive' });
    reflectGlobalCompressionPreferenceInMainUI(extensionPreferences.defaultCompressionEnabled);
    syncMainControlsWithPreferences();
    await loadShortcutCommands();

    const activeTab = await getActiveTab();
    if (activeTab) {
        currentTabId = activeTab.id;
        requestStatusFromContentScript(currentTabId, { forceProbe: true });
    } else {
        log("Initialization failed: No suitable active tab found.");
        // currentTabId remains null for error pages
    }
    
    // Always initialize Other Tabs Manager, even if currentTabId is null
    // This ensures Other Tabs panel works on all pages including about: pages
    OtherTabsManager.initialize(currentTabId);
}

// Cleanup on popup close
window.addEventListener('unload', () => {
    clearTimeout(statusRefreshDebounceTimer);
    flushDebouncedSend(DebouncedSendKind.PREFERENCES_SAVE);
    if (popupListenersRegistered) {
        browser.runtime.onMessage.removeListener(handleRuntimeMessages);
        document.removeEventListener('retry-connection', handleRetryConnection);
        popupListenersRegistered = false;
    }

    if (OtherTabsManager) {
        OtherTabsManager.cleanup();
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden || document.visibilityState === 'hidden') {
        flushPendingSends();
        OtherTabsManager?.flushPendingSends?.();
    }
});
window.addEventListener('pagehide', () => {
    flushPendingSends();
    OtherTabsManager?.flushPendingSends?.();
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
