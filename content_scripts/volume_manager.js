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

    function isMediaPlaying(element) {
        return !element.paused && !element.ended;
    }

    // Muted autoplay previews are common next to the real player; the one the user
    // hears must represent the frame.
    function isMediaAudible(element) {
        return isMediaPlaying(element) && !element.muted && element.volume > 0;
    }

    function toRepresentativeMediaState(candidate) {
        const rawVolume = Number.isFinite(candidate.volume) ? candidate.volume : 1;
        return {
            volume: Protocol.nativeVolumeToPercent(rawVolume),
            muted: Boolean(candidate.muted),
            audible: isMediaAudible(candidate)
        };
    }

    function getRepresentativeMediaState(mediaElements) {
        if (!Array.isArray(mediaElements) || mediaElements.length === 0) {
            return null;
        }

        const candidate = mediaElements.find(isMediaAudible) ||
            mediaElements.find(isMediaPlaying) ||
            mediaElements[0];
        return candidate ? toRepresentativeMediaState(candidate) : null;
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
                isAudible: isMediaAudible(element),
                isPlaying: isMediaPlaying(element),
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
            Number(right.isAudible) - Number(left.isAudible) ||
            Number(right.isPlaying) - Number(left.isPlaying) ||
            Number(right.isVisible) - Number(left.isVisible) ||
            right.lastStateChangeAt - left.lastStateChangeAt ||
            right.currentTime - left.currentTime ||
            right.priority - left.priority
        );

        const candidate = candidates[0]?.element;
        return candidate ? toRepresentativeMediaState(candidate) : null;
    }

    function getPreferredLiveMediaState(mediaElements, stateManager) {
        return getTrackedRepresentativeMediaState(stateManager) || getRepresentativeMediaState(mediaElements);
    }

    // Capture state does not matter here: a player the user unmuted can still be setting
    // up or uncaptured while a muted preview is the representative element.
    function isFrameAudible(mediaElements, stateManager) {
        if (mediaElements.some(isMediaAudible)) {
            return true;
        }
        let audible = false;
        stateManager?.elements?.forEach?.((stateData, element) => {
            if (!audible && element && isMediaAudible(element)) {
                audible = true;
            }
        });
        return audible;
    }

    // --- Status Reporting ---

    // True from pagehide (or unload) until pageshow. The background dropped this frame's cached
    // status when FRAME_STATUS_REMOVED arrived, so a debounced push from the hidden frame
    // would put it back.
    let frameRemovalReported = false;

    /**
     * Sends the current status to the popup via runtime messaging.
     * Uses getCurrentStatus() as single source of truth for consistency.
     */
    window.VolumeControl.notifyPopupOfStatusChange = function() {
        if (frameRemovalReported) {
            return;
        }

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
            const hasMediaElements = statusPayload.status === 'inactive' ||
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
        
        // Counting is read-only for native-only elements: stale entries are pruned by the
        // lifecycle paths in Main (discovery, refresh, removal, setup), never by a status read.
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
        
        const recoveryTargets = (elements) => (elements || []).filter(
            (element) => stateManager?.isStickyNativeOnly?.(element) !== true
        );

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
                const targets = recoveryTargets(mediaElements);
                if (targets.length > 0) {
                    Main.refreshDetectedMediaState?.(targets, 'status-playing-recovery');
                }
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
                    const targets = recoveryTargets(mediaElements);
                    if (targets.length > 0) {
                        Main.refreshDetectedMediaState?.(targets, 'status-detecting-recovery');
                    }
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
            window.VolumeControl.VolumeOwnership?.shouldUseLiveObservedVolume?.() ||
            (activeCount === 0 && corsCount === 0 && status !== 'active')
        );

        const observedVolume = representativeMediaState
            ? representativeMediaState.volume
            : State.currentVolumePercent;
        const reportedVolume = window.VolumeControl.VolumeOwnership?.isManaged?.()
            ? State.currentVolumePercent
            : (shouldUseLiveMediaState ? observedVolume : State.currentVolumePercent);
        const shouldUseLiveMuteState = Boolean(representativeMediaState) && (
            State.extensionEnabled === false ||
            !State.muteHasBeenSet ||
            shouldUseLiveMediaState
        );
        // Extension mute sets element.muted, so audible media always means the frame
        // is not muted, including after the page's own player unmuted it.
        const frameAudible = isFrameAudible(mediaElements, stateManager);
        const reportedMuted = frameAudible
            ? false
            : (shouldUseLiveMuteState
                ? representativeMediaState.muted
                : Boolean(State.currentMutedState));
        
        return {
            status: status,
            statusDetail: statusDetail,
            volume: reportedVolume,
            observedVolume,
            extensionEnabled: State.extensionEnabled !== false,
            muted: reportedMuted,
            audible: frameAudible,
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
    window.__volumeControlExtension__.setVolume = async (volumePayload) => {
        const State = getState();
        const Main = getMain();
        const VolumeOwnership = window.VolumeControl.VolumeOwnership;
        
        const { requestedVolume, source, summary } = Protocol.parseVolumeCommandPayload(volumePayload);
        const seq = ++State.volumeCommandSequence;
        
        log(`[VOLUME CMD #${seq}] Request (source=${source}, frame=${FRAME_DESCRIPTOR}):`, summary);

        const normalizedRequest = Number.isFinite(requestedVolume) ? requestedVolume : State.currentVolumePercent;
        const clampedVolume = Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(normalizedRequest)));

        if (clampedVolume === State.currentVolumePercent && VolumeOwnership.isManaged()) {
            log(`[VOLUME CMD #${seq}] No change (already managed at ${State.currentVolumePercent}%).`);
            return;
        }

        log(`[VOLUME CMD #${seq}] Applying ${clampedVolume}% (was ${State.currentVolumePercent}%).`);

        const control = await VolumeOwnership.commitExtensionVolume(clampedVolume);
        Main.updateAllVolume(control?.targetVolume ?? clampedVolume);
        
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

    // A runtime `SET_EXTENSION_ENABLED` that arrives while `init` still awaits the stored
    // preferences is newer than what storage returns, so the stored value must not replace it.
    let runtimeExtensionEnabled = null;

    window.__volumeControlExtension__.setExtensionEnabled = (enabled) => {
        const Main = getMain();
        const nextEnabled = enabled !== false;
        runtimeExtensionEnabled = nextEnabled;

        log(`[ExtensionEnabled] Setting enabled=${nextEnabled}`);
        Main.setExtensionEnabled(nextEnabled);
        window.VolumeControl.notifyPopupOfStatusChange();
    };

    // --- Message Listener ---

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === Messages.GET_STATUS) {
            sendResponse(window.__volumeControlExtension__.getCurrentStatus());
        } else if (message.type === Messages.SET_VOLUME) {
            (async () => {
                try {
                    await window.__volumeControlExtension__.setVolume(message.payload);
                    sendResponse({ success: true });
                } catch (error) {
                    sendResponse({ success: false, error: error?.message || String(error) });
                }
            })();
            return true;
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

            // Applied after the rest of the state is in place, through the runtime path in both
            // directions: a status probe or the play hook can set an element up before the
            // preferences arrive, and only that path restores or resumes such an element. The
            // flag defaults to true, so an enabled preference is a no-op there and element
            // recovery still does not start before init has hydrated. A runtime command that
            // already arrived wins over the stored value (it is the newer of the two).
            const Main = getMain();
            if (runtimeExtensionEnabled !== null) {
                verbose('[Preferences] A runtime extension toggle arrived during init; keeping it');
            } else if (typeof Main?.setExtensionEnabled === 'function') {
                Main.setExtensionEnabled(resolvedPageState.extensionEnabled);
            } else {
                State.extensionEnabled = resolvedPageState.extensionEnabled;
            }
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
        const reportFrameRemoval = () => {
            if (frameRemovalReported) {
                return;
            }
            frameRemovalReported = true;
            try {
                void Promise.resolve(browser.runtime.sendMessage({
                    type: Messages.FRAME_STATUS_REMOVED
                })).catch(() => {});
            } catch {
                // Runtime may already be unavailable during final teardown.
            }
        };

        window.addEventListener('pagehide', reportFrameRemoval, { passive: true });
        window.addEventListener('pageshow', () => {
            if (!frameRemovalReported) {
                return;
            }
            frameRemovalReported = false;
            window.VolumeControl.notifyPopupOfStatusChange?.();
        }, { passive: true });

        window.addEventListener('unload', () => {
            reportFrameRemoval();
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
        let unloadCleanupInstalled = false;
        try {
            const Main = getMain();
            const State = getState();
            const VolumeOwnership = window.VolumeControl.VolumeOwnership;

            log(`Content script executing... Location: ${window.location.href}, Top: ${window.self === window.top}`);

            window.VolumeControl.loadSettingsFromStorage();
            await loadExtensionPreferences();
            if (VolumeOwnership?.hydrateFromBackground) {
                await VolumeOwnership.hydrateFromBackground();
            }

            if (VolumeOwnership && !VolumeOwnership.isManaged() && Number.isFinite(State.__legacyRestoredVolume)) {
                await VolumeOwnership.commitRestoredVolume(State.__legacyRestoredVolume);
                delete State.__legacyRestoredVolume;
            }

            Main.initialize();

            setupUnloadCleanup();
            unloadCleanupInstalled = true;

            window.volumeControlActive = true;
            window.__volumeControlExtension__.active = true;

            log("Content script loaded and ready.");
        } catch (initError) {
            // The frame stays half initialised: the page keeps its own audio, and the active
            // flags stay unset. Teardown is still wired so anything `Main.initialize` managed
            // to start is cleaned up and the background hears that the frame is gone.
            error('[Init] Content script initialisation failed:', initError);
            if (!unloadCleanupInstalled) {
                try {
                    setupUnloadCleanup();
                } catch (cleanupError) {
                    verbose('[Init] Unload cleanup could not be installed:', cleanupError);
                }
            }
        }
    })();
})();
