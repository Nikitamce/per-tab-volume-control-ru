/**
 * Volume Control Content Script - Entry Point & Popup Communication
 */

window.VolumeControl = window.VolumeControl || {};

(function() {
    const { log, warn, error, verbose, FRAME_DESCRIPTOR } = window.VolumeControl;
    const Protocol = globalThis.VCProtocol;
    const { Messages } = Protocol;
    const { PreferenceKeys } = Protocol;
    const { 
        MIN_VOLUME,
        MAX_VOLUME,
        DEFAULT_VOLUME,
        DEFAULT_MONO_ENABLED,
        DEFAULT_BALANCE,
        DEFAULT_COMPRESSOR_THRESHOLD,
        DEFAULT_COMPRESSOR_RATIO,
        DEFAULT_COMPRESSOR_KNEE
    } = window.VolumeControl;

    // Module getters
    const getMain = () => window.VolumeControl.Main;
    const getState = () => window.VolumeControl.State;
    const getElementStateManager = () => window.VolumeControl.elementStateManager;
    const getMediaDetector = () => window.VolumeControl.MediaDetector;

    // --- Helper Functions ---

    function getFrameMediaElements() {
        const MediaDetector = getMediaDetector();
        if (MediaDetector?.findAllMediaElements) {
            return MediaDetector.findAllMediaElements(document.body);
        }

        return Array.from(document.querySelectorAll('video, audio'));
    }

    function getRepresentativeMediaState(mediaElements) {
        if (!Array.isArray(mediaElements) || mediaElements.length === 0) {
            return null;
        }

        const candidate = mediaElements.find((element) => !element.paused && !element.ended) || mediaElements[0];
        if (!candidate) {
            return null;
        }

        const rawVolume = Number.isFinite(candidate.volume) ? candidate.volume : 1;
        return {
            volume: Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(rawVolume * DEFAULT_VOLUME))),
            muted: Boolean(candidate.muted)
        };
    }

    function getTrackedRepresentativeMediaState(stateManager) {
        if (!stateManager) {
            return null;
        }

        const candidates = [];
        const seen = new Set();
        const addCandidate = (element, stateData, priority) => {
            if (!element || seen.has(element) || element.isConnected === false) {
                return;
            }

            seen.add(element);
            candidates.push({
                element,
                priority,
                isPlaying: !element.paused && !element.ended,
                isVisible: stateData?.isIntersecting !== false,
                lastStateChangeAt: Number(stateData?.lastStateChangeAt) || 0,
                currentTime: Number.isFinite(element.currentTime) ? element.currentTime : -1
            });
        };

        const activeEntries = typeof stateManager.getActive === 'function'
            ? stateManager.getActive()
            : [];

        activeEntries.forEach((entry) => {
            addCandidate(entry?.element, entry?.stateData, 2);
        });

        if (stateManager.corsElements?.forEach) {
            stateManager.corsElements.forEach((element) => {
                addCandidate(element, stateManager.get?.(element) || null, 1);
            });
        }

        if (candidates.length === 0) {
            return null;
        }

        candidates.sort((left, right) =>
            Number(right.isPlaying) - Number(left.isPlaying) ||
            Number(right.isVisible) - Number(left.isVisible) ||
            right.lastStateChangeAt - left.lastStateChangeAt ||
            right.currentTime - left.currentTime ||
            right.priority - left.priority
        );

        const candidate = candidates[0]?.element;
        if (!candidate) {
            return null;
        }

        const rawVolume = Number.isFinite(candidate.volume) ? candidate.volume : 1;
        return {
            volume: Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(rawVolume * DEFAULT_VOLUME))),
            muted: Boolean(candidate.muted)
        };
    }

    function getPreferredLiveMediaState(mediaElements, stateManager) {
        return getTrackedRepresentativeMediaState(stateManager) || getRepresentativeMediaState(mediaElements);
    }

    // --- Status Reporting ---

    /**
     * Sends the current status to the popup via runtime messaging.
     * Uses getCurrentStatus() as single source of truth for consistency.
     */
    window.VolumeControl.notifyPopupOfStatusChange = function() {
        // Defer to getCurrentStatus for consistent status logic
        // Note: getCurrentStatus is defined below after this function
        const statusPayload = window.__volumeControlExtension__?.getCurrentStatus?.();
        
        if (!statusPayload) {
            // getCurrentStatus not initialized yet, build minimal payload
            const State = getState();
            const hasMediaElements = getFrameMediaElements().length > 0;
            
            const minimalPayload = {
                status: hasMediaElements ? 'inactive' : 'no-media',
                volume: State?.currentVolumePercent ?? DEFAULT_VOLUME,
                extensionEnabled: State?.extensionEnabled !== false,
                muted: Boolean(State?.currentMutedState),
                monoEnabled: State?.currentMonoEnabled ?? DEFAULT_MONO_ENABLED,
                balance: State?.currentBalance ?? DEFAULT_BALANCE,
                compressionEnabled: State?.currentCompressionEnabled ?? false,
                audioSettingsAvailable: true,
                audioSettingsReason: null,
                corsAffectedCount: 0
            };
            
            sendStatusUpdate(minimalPayload);
            return;
        }
        
        // Avoid status noise from empty iframes.
        // However, for iframe-hosted players (e.g., Twitch-like sites), allow frames to report
        // when they actually have media elements so the background can mark the tab as having media.
        const isTopLevel = window === window.top;
        const isActive = statusPayload.status === 'active';
        if (!isTopLevel && !isActive) {
            const hasMediaElements = statusPayload.status === 'inactive' || statusPayload.status === 'error' ||
                (statusPayload.elementCounts && statusPayload.elementCounts.total > 0) ||
                getFrameMediaElements().length > 0;
            if (!hasMediaElements) {
                return;
            }
        }
        
        sendStatusUpdate(statusPayload);
    };
    
    /**
     * Helper to send status update message
     */
    function sendStatusUpdate(statusPayload) {
        log(`[notifyPopup] Sending STATUS_UPDATE:`, statusPayload);
        
        browser.runtime.sendMessage({ type: Messages.STATUS_UPDATE, payload: statusPayload })
            .catch(e => {
                if (!e.message?.includes('Receiving end does not exist')) {
                    warn("Error sending status update:", e);
                }
            });
    }

    // --- Popup API ---

    if (!window.__volumeControlExtension__) {
        window.__volumeControlExtension__ = {};
    }

    /**
     * Get current status for popup
     * 
     * Status hierarchy (highest priority first):
     * - 'active': At least one element is being controlled (ACTIVE state or CORS-blocked but detected)
     * - 'inactive': Media elements exist but none are active yet (paused, setting up, or errored)
     * - 'no-media': No video/audio elements found on the page
     */
    window.__volumeControlExtension__.getCurrentStatus = () => {
        const State = getState();
        const stateManager = getElementStateManager();
        const Main = getMain();
        const ElementState = window.VolumeControl.ElementState;
        const mediaElements = getFrameMediaElements();
        const representativeMediaState = getPreferredLiveMediaState(mediaElements, stateManager);

        if (State.extensionEnabled === false) {
            return {
                status: 'disabled',
                statusDetail: 'manual-disabled',
                volume: representativeMediaState?.volume ?? State.currentVolumePercent,
                extensionEnabled: false,
                muted: representativeMediaState?.muted ?? Boolean(State.currentMutedState),
                monoEnabled: State.currentMonoEnabled,
                balance: State.currentBalance,
                compressionEnabled: State.currentCompressionEnabled,
                compressionThreshold: State.currentCompressionThreshold,
                compressionRatio: State.currentCompressionRatio,
                compressionKnee: State.currentCompressionKnee,
                audioSettingsAvailable: true,
                audioSettingsReason: null,
                corsAffectedCount: 0,
                elementCounts: {
                    active: 0,
                    settingUp: 0,
                    discovered: 0,
                    error: 0,
                    cors: 0,
                    total: mediaElements.length
                }
            };
        }

        const audioSettingsCapability = Main.getAudioSettingsAvailability();
        
        // Clean up stale CORS elements before counting
        if (stateManager) {
            stateManager.cleanupStaleCorsElements();
        }
        
        // Get detailed counts for accurate status
        const stateCounts = stateManager ? stateManager.getStateCounts() : {};
        const activeCount = stateCounts[ElementState?.ACTIVE] || 0;
        const settingUpCount = stateCounts[ElementState?.SETTING_UP] || 0;
        const discoveredCount = stateCounts[ElementState?.DISCOVERED] || 0;
        const errorCount = stateCounts[ElementState?.ERROR] || 0;
        const corsCount = stateManager ? stateManager.corsElements.size : 0;
        const isNativeOnlyCurrentMedia = audioSettingsCapability.available === false && audioSettingsCapability.reason === 'native-only-current-media';
        // Total tracked elements
        const totalTracked = activeCount + settingUpCount + discoveredCount + errorCount;
        
        // Determine status based on element states
        let status;
        let statusDetail = null;
        
        if (activeCount > 0) {
            // We have active audio control
            status = 'active';
        } else if (corsCount > 0) {
            // CORS-blocked elements are still considered "active" (we detected them, just can't control)
            status = 'active';
            statusDetail = isNativeOnlyCurrentMedia ? 'limited' : null;
        } else if (settingUpCount > 0) {
            // Setup in progress - show as active since we're working on it
            status = 'active';
            statusDetail = 'setting-up';
        } else if (discoveredCount > 0 || errorCount > 0) {
            // Media discovered but not playing yet, or had errors
            // Check if any media is actually playing
            const hasPlayingMedia = mediaElements.some(el => 
                !el.paused && !el.ended && el.readyState >= 2
            );
            
            if (hasPlayingMedia) {
                // Media is playing but we haven't captured it yet - trigger rescan
                Main.refreshDetectedMediaState?.(mediaElements, 'status-playing-recovery');
                status = 'active';
                statusDetail = 'connecting';
            } else {
                // Media exists but not playing
                status = 'inactive';
                statusDetail = errorCount > 0 ? 'error' : 'paused';
            }
        } else {
            // No tracked elements - check if any media exists at all
            if (mediaElements.length > 0) {
                // Media exists but not tracked yet
                // Check if any have a valid source and might be playable
                const hasValidMedia = mediaElements.some(el => {
                    const src = el.currentSrc || el.src;
                    const hasSource = src && src.length > 0;
                    const hasMediaSource = el.srcObject !== null;
                    return hasSource || hasMediaSource;
                });
                
                if (hasValidMedia) {
                    // Trigger scan to pick up the media
                    Main.refreshDetectedMediaState?.(mediaElements, 'status-detecting-recovery');
                    status = 'inactive';
                    statusDetail = 'detecting';
                } else {
                    // Media elements exist but no valid source (placeholder elements)
                    status = 'inactive';
                    statusDetail = 'no-source';
                }
            } else {
                status = 'no-media';
            }
        }

        const shouldUseLiveMediaState = Boolean(representativeMediaState) && (
            State.extensionEnabled === false ||
            (!State.volumeHasBeenSet && activeCount === 0) ||
            (activeCount === 0 && corsCount === 0 && status !== 'active')
        );

        const reportedVolume = shouldUseLiveMediaState
            ? representativeMediaState.volume
            : State.currentVolumePercent;
        const shouldUseLiveMuteState = Boolean(representativeMediaState) && (
            State.extensionEnabled === false ||
            !State.muteHasBeenSet ||
            shouldUseLiveMediaState
        );
        const reportedMuted = shouldUseLiveMuteState
            ? representativeMediaState.muted
            : Boolean(State.currentMutedState);
        
        return {
            status: status,
            statusDetail: statusDetail,
            volume: reportedVolume,
            extensionEnabled: State.extensionEnabled !== false,
            muted: reportedMuted,
            monoEnabled: State.currentMonoEnabled,
            balance: State.currentBalance,
            compressionEnabled: State.currentCompressionEnabled,
            compressionThreshold: State.currentCompressionThreshold,
            compressionRatio: State.currentCompressionRatio,
            compressionKnee: State.currentCompressionKnee,
            audioSettingsAvailable: audioSettingsCapability.available,
            audioSettingsReason: audioSettingsCapability.reason,
            corsAffectedCount: corsCount,
            // Additional diagnostic info for debugging
            elementCounts: {
                active: activeCount,
                settingUp: settingUpCount,
                discovered: discoveredCount,
                error: errorCount,
                cors: corsCount,
                total: totalTracked
            }
        };
    };

    /**
     * Set volume from popup
     */
    window.__volumeControlExtension__.setVolume = (volumePayload) => {
        const State = getState();
        const Main = getMain();
        
        const { requestedVolume, source, summary } = Protocol.parseVolumeCommandPayload(volumePayload);
        const seq = ++State.volumeCommandSequence;
        
        log(`[VOLUME CMD #${seq}] Request (source=${source}, frame=${FRAME_DESCRIPTOR}):`, summary);

        const normalizedRequest = Number.isFinite(requestedVolume) ? requestedVolume : State.currentVolumePercent;
        const clampedVolume = Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(normalizedRequest)));

        if (clampedVolume === State.currentVolumePercent) {
            log(`[VOLUME CMD #${seq}] No change (already at ${State.currentVolumePercent}%).`);
            return;
        }

        log(`[VOLUME CMD #${seq}] Applying ${clampedVolume}% (was ${State.currentVolumePercent}%).`);
        
        // Use Main module to update all elements
        Main.updateAllVolume(clampedVolume);
        
        // Notify popup
        window.VolumeControl.notifyPopupOfStatusChange();
    };

    /**
     * Set compression settings from popup
     */
    window.__volumeControlExtension__.setCompressionSettings = (settings) => {
        const State = getState();
        const Main = getMain();
        const rawSettings = (settings && typeof settings === 'object') ? settings : {};
        
        log(`[Compression] Setting:`, rawSettings);

        const parsedSettings = Protocol.normalizeCompressionSettings(rawSettings, { partial: true });
        
        // Use Main module to update all elements
        Main.updateAllCompression(parsedSettings);
        State.compressionHasBeenSet = true;
        
        // Notify popup
        window.VolumeControl.notifyPopupOfStatusChange();
    };

    /**
     * Set mono and balance settings from popup
     */
    window.__volumeControlExtension__.setAudioSettings = (settings) => {
        const Main = getMain();
        const State = getState();
        const rawSettings = (settings && typeof settings === 'object') ? settings : {};
        const parsedSettings = Protocol.normalizeAudioSettings(rawSettings, { partial: true });

        log(`[AudioSettings] Setting:`, rawSettings);
        Main.updateAllAudioSettings(parsedSettings);
        window.VolumeControl.notifyPopupOfStatusChange();
    };

    window.__volumeControlExtension__.setGlobalBalance = (settings) => {
        const Main = getMain();
        const rawSettings = (settings && typeof settings === 'object') ? settings : {};
        const parsedSettings = Protocol.normalizeGlobalBalanceSettings(rawSettings, { partial: true });

        log('[GlobalBalance] Setting:', rawSettings);
        Main.applyGlobalBalanceSettings(parsedSettings);
        window.VolumeControl.notifyPopupOfStatusChange();
    };

    window.__volumeControlExtension__.setMuteState = (muted) => {
        const Main = getMain();
        const nextMuted = Boolean(muted);

        log(`[Mute] Setting muted=${nextMuted}`);
        Main.updateAllMute(nextMuted);
        window.VolumeControl.notifyPopupOfStatusChange();
    };

    window.__volumeControlExtension__.setExtensionEnabled = (enabled) => {
        const Main = getMain();
        const nextEnabled = enabled !== false;

        log(`[ExtensionEnabled] Setting enabled=${nextEnabled}`);
        Main.setExtensionEnabled(nextEnabled);
        window.VolumeControl.notifyPopupOfStatusChange();
    };

    // --- Message Listener ---

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === Messages.GET_STATUS) {
            sendResponse(window.__volumeControlExtension__.getCurrentStatus());
        } else if (message.type === Messages.SET_VOLUME) {
            window.__volumeControlExtension__.setVolume(message.payload);
            sendResponse({ success: true });
        } else if (message.type === Messages.SET_COMPRESSION) {
            window.__volumeControlExtension__.setCompressionSettings(message.payload);
            sendResponse({ success: true });
        } else if (message.type === Messages.SET_AUDIO_SETTINGS) {
            window.__volumeControlExtension__.setAudioSettings(message.payload);
            sendResponse({ success: true });
        } else if (message.type === Messages.SET_GLOBAL_BALANCE) {
            window.__volumeControlExtension__.setGlobalBalance(message.payload);
            sendResponse({ success: true });
        } else if (message.type === Messages.SET_MUTE_STATE) {
            window.__volumeControlExtension__.setMuteState(message.payload?.muted);
            sendResponse({ success: true });
        } else if (message.type === Messages.SET_EXTENSION_ENABLED) {
            window.__volumeControlExtension__.setExtensionEnabled(message.payload?.enabled);
            sendResponse({ success: true });
        }
    });

    async function loadExtensionPreferences() {
        const State = getState();

        try {
            const result = await browser.storage.local.get(Object.values(PreferenceKeys));
            const preferences = Protocol.normalizeExtensionPreferences(result);
            const resolvedPageState = Protocol.resolveInitialPageState({
                session: {
                    monoEnabled: State.currentMonoEnabled,
                    monoWasStored: State.monoHasBeenSet,
                    balance: State.localBalance,
                    balanceWasStored: State.balanceHasBeenSet,
                    compressionEnabled: State.currentCompressionEnabled,
                    compressionWasStored: State.compressionHasBeenSet
                },
                preferences
            });

            State.extensionEnabled = resolvedPageState.extensionEnabled;
            State.defaultCompressionEnabled = preferences.defaultCompressionEnabled;
            State.defaultMonoEnabled = preferences.defaultMonoEnabled;
            State.defaultBalanceEnabled = preferences.defaultBalanceEnabled;
            State.defaultBalance = preferences.defaultBalance;

            State.currentCompressionEnabled = resolvedPageState.compressionEnabled;
            State.currentMonoEnabled = resolvedPageState.monoEnabled;
            State.localBalance = State.balanceHasBeenSet
                ? Protocol.normalizeBalance(State.localBalance, DEFAULT_BALANCE)
                : DEFAULT_BALANCE;
            State.currentBalance = resolvedPageState.balance;
            State.compressionHasBeenSet = resolvedPageState.compressionInitialised;
            State.monoHasBeenSet = resolvedPageState.monoInitialised;
            State.balanceHasBeenSet = resolvedPageState.balanceInitialised;
        } catch (e) {
            warn('[Preferences] Failed to load extension preferences:', e);
        }
    }

    // --- Cleanup ---

    /**
     * Set up cleanup handlers for page unload
     */
    function setupUnloadCleanup() {
        const State = getState();
        const stateManager = getElementStateManager();
        const Main = getMain();
        const MediaDetector = getMediaDetector();
        const Compressor = window.VolumeControl.Compressor;

        window.addEventListener('unload', () => {
            log("Page unloading, cleaning up...");
            
            // Flush pending storage writes immediately
            window.VolumeControl.flushStorageWrites();
            
            // Stop all compressor monitors
            if (Compressor?.monitor) {
                Compressor.monitor.stopAll();
            }
            
            // Stop media detection
            if (MediaDetector) {
                MediaDetector.stop();
                if (MediaDetector.visibility) {
                    MediaDetector.visibility.stop();
                }
            }
            
            // Clean up all tracked elements
            if (stateManager) {
                stateManager.elements.forEach((stateData, element) => {
                    Main.cleanupElement(element);
                });
                stateManager.cleanupAll();
            }
            
            // Close shared AudioContext
            if (State.sharedAudioContext && State.sharedAudioContext.state !== 'closed') {
                State.sharedAudioContext.close().catch(e => {
                    const isDeadObject = !e || 
                                        String(e).includes('DeadObject') || 
                                        String(e).includes('dead object');
                    if (!isDeadObject) {
                        error("Error closing AudioContext:", e);
                    }
                });
                State.sharedAudioContext = null;
            }
            
            log("Cleanup complete.");
        }, { once: true });
    }

    // --- Initialization ---

    /**
     * Main initialization function
     */
    (async function init() {
        const Main = getMain();
        
        log(`Content script executing... Location: ${window.location.href}, Top: ${window.self === window.top}`);
        
        // Load persisted settings from sessionStorage
        window.VolumeControl.loadSettingsFromStorage();
        await loadExtensionPreferences();
        
        // Initialize main module (handles detection, setup, etc.)
        Main.initialize();
        
        // Set up cleanup
        setupUnloadCleanup();

        // Mark as active
        window.volumeControlActive = true;
        window.__volumeControlExtension__.active = true;
        
        log("Content script loaded and ready.");
    })();
})();
