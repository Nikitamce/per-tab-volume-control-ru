/**
 * Main Entry Point - Volume Control Extension
 * Orchestrates all modules and handles initialization.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.Main = {};

(function() {
    const { log, warn, error, verbose, logSourceChange, logVolumeApply, logDiagnostic } = window.VolumeControl;
    const { SETUP_TIMEOUT_MS, DEFAULT_VOLUME, DEFAULT_MONO_ENABLED, DEFAULT_BALANCE, MIN_VOLUME, MAX_VOLUME } = window.VolumeControl;
    const Protocol = globalThis.VCProtocol;
    const ACTIVE_VERIFICATION_INTERVAL_MS = 4000;
    const ACTIVE_VERIFICATION_GRACE_MS = 3000;
    const ACTIVE_VERIFICATION_FAILURES_BEFORE_RESET = 3;
    const DETACHED_PLAYBACK_GRACE_MS = 15000;

    // Module references (lazy loaded to handle load order)
    const getState = () => window.VolumeControl.State;
    const getElementStateManager = () => window.VolumeControl.elementStateManager;
    const getAudioContext = () => window.VolumeControl.AudioContext;
    const getSourceCapture = () => window.VolumeControl.SourceCapture;
    const getAudioPipeline = () => window.VolumeControl.AudioPipeline;
    const getVolumeController = () => window.VolumeControl.VolumeController;
    const getVolumeSyncManager = () => window.VolumeControl.volumeSyncManager;
    const getMediaDetector = () => window.VolumeControl.MediaDetector;
    const getCompressor = () => window.VolumeControl.Compressor;

    function getElementSourceKey(element) {
        const sourceCapture = getSourceCapture();
        if (sourceCapture?.getElementSourceKey) {
            return sourceCapture.getElementSourceKey(element);
        }

        return element?.currentSrc || element?.src || (element?.srcObject ? 'srcObject:attached' : '');
    }

    function hasUsableMediaSource(element) {
        return Boolean(getSourceCapture()?.hasUsableMediaSource?.(element) ?? getElementSourceKey(element));
    }

    function isElementPotentiallyPlaying(element) {
        return Boolean(element && !element.paused && !element.ended && !element.seeking);
    }

    function getDetectableMediaElements() {
        const MediaDetector = getMediaDetector();
        if (MediaDetector?.findAllMediaElements) {
            return MediaDetector.findAllMediaElements(document.body);
        }

        return Array.from(document.querySelectorAll('video, audio'));
    }

    function canElementDriveSharedState(element) {
        const stateManager = getElementStateManager();
        if (!stateManager) {
            return true;
        }

        const controllableElements = new Set();
        const activeEntries = typeof stateManager.getActive === 'function'
            ? stateManager.getActive()
            : [];

        activeEntries.forEach((entry) => {
            const activeElement = entry?.element;
            if (activeElement?.isConnected) {
                controllableElements.add(activeElement);
            }
        });

        if (stateManager.corsElements?.forEach) {
            stateManager.corsElements.forEach((corsElement) => {
                if (corsElement?.isConnected) {
                    controllableElements.add(corsElement);
                }
            });
        }

        return controllableElements.size === 0 ||
            (controllableElements.size === 1 && controllableElements.has(element));
    }

    function getCurrentProcessingOptions() {
        const State = getState();
        return {
            compressionEnabled: State.currentCompressionEnabled,
            monoEnabled: State.currentMonoEnabled,
            balance: State.currentBalance
        };
    }

    function getEffectiveProcessingOptions() {
        const State = getState();
        if (State.extensionEnabled === false) {
            return {
                compressionEnabled: false,
                monoEnabled: DEFAULT_MONO_ENABLED,
                balance: DEFAULT_BALANCE
            };
        }

        return getCurrentProcessingOptions();
    }

    function toNativeVolumePercent(value) {
        return Number.isFinite(Number(value))
            ? Math.round(Number(value) * DEFAULT_VOLUME * 10) / 10
            : null;
    }

    function activateNativeOnlyFallback(element, stateData, options = {}) {
        const State = getState();
        const stateManager = getElementStateManager();
        const VolumeController = getVolumeController();
        const VolumeSyncManager = getVolumeSyncManager();
        const {
            elementInfo = `${element.tagName}#${element.id || 'no-id'}`,
            sourceKey = getElementSourceKey(element),
            fallbackReason = 'capture-error',
            corsMessage = null,
            captureError = null,
            captureMethod = null
        } = options;

        if (logDiagnostic) {
            logDiagnostic('setup-cors-native-only', {
                elementInfo,
                sourceKey,
                fallbackReason,
                corsMessage,
                captureMethod,
                captureErrorName: captureError?.name || null,
                captureErrorMessage: captureError?.message || null,
                requestedVolume: State.currentVolumePercent,
                nativeAppliedVolumeRequest: State.currentVolumePercent,
                elementMuted: element.muted,
                managedMutedState: stateData?.managedMutedState
            }, { threshold: 3 });
        }

        log(`[Main] ${elementInfo} using native-only fallback: ${captureError?.message || corsMessage || fallbackReason}`);

        if (typeof stateManager?.markCorsBlocked === 'function') {
            stateManager.markCorsBlocked(element);
        } else {
            stateData?.transition?.(ElementState.ERROR, {
                errorType: 'cors',
                errorMessage: corsMessage || captureError?.message || 'Cross-origin media without CORS headers'
            });
        }

        if (VolumeController?.applyNativeVolumeOnly) {
            if (VolumeSyncManager) {
                VolumeSyncManager.startApplyingVolume(element, State.currentVolumePercent);
            }
            VolumeController.applyNativeVolumeOnly(element, State.currentVolumePercent);
            log(`[Main] Applied native volume request ${State.currentVolumePercent}% to native-only ${elementInfo}`);
        }

        if (VolumeSyncManager) {
            VolumeSyncManager.attachVolumeChangeHandler(element, stateData);
        }

        if (window.VolumeControl.notifyPopupOfStatusChange) {
            window.VolumeControl.notifyPopupOfStatusChange();
        }

        return null;
    }

    function getDesiredMuteStateForElement(element, stateData) {
        const State = getState();

        if (State.muteHasBeenSet) {
            return Boolean(State.currentMutedState);
        }

        if (stateData) {
            if (typeof stateData.managedMutedState === 'boolean') {
                return stateData.managedMutedState;
            }

            if (typeof stateData.observedNativeMutedState === 'boolean') {
                return stateData.observedNativeMutedState;
            }

            if (typeof stateData.nativeMutedSnapshot === 'boolean') {
                return stateData.nativeMutedSnapshot;
            }
        }

        return Boolean(element?.muted);
    }

    function syncUnownedMuteStateFromElement(element, stateData, options = {}) {
        const State = getState();
        const {
            updateSharedState = true,
            updateManagedState = false,
            commitToRestore = false
        } = options;

        if (State.muteHasBeenSet || !element || !stateData) {
            return;
        }

        const previousObservedMutedState = stateData.observedNativeMutedState;
        const previousManagedMutedState = stateData.managedMutedState;
        const previousSnapshotMutedState = stateData.nativeMutedSnapshot;
        const previousSharedMutedState = State.currentMutedState;
        const nextMuted = Boolean(element.muted);
        const canDriveSharedState = canElementDriveSharedState(element);
        stateData.observedNativeMutedState = nextMuted;

        if (updateManagedState || typeof stateData.managedMutedState !== 'boolean') {
            stateData.managedMutedState = nextMuted;
        }

        if (commitToRestore) {
            stateData.nativeMutedSnapshot = nextMuted;
            stateData.userOriginalMutedState = nextMuted;
        }

        if (updateSharedState && canDriveSharedState) {
            State.currentMutedState = Boolean(
                typeof stateData.managedMutedState === 'boolean'
                    ? stateData.managedMutedState
                    : nextMuted
            );
        }

        if (logDiagnostic && (
            previousObservedMutedState !== nextMuted ||
            previousManagedMutedState !== stateData.managedMutedState ||
            previousSnapshotMutedState !== stateData.nativeMutedSnapshot ||
            previousSharedMutedState !== State.currentMutedState ||
            updateManagedState ||
            commitToRestore
        )) {
            logDiagnostic('unowned-mute-sync', {
                elementInfo: `${element.tagName}#${element.id || 'no-id'}`,
                nextMuted,
                updateSharedState,
                updateManagedState,
                commitToRestore,
                canDriveSharedState,
                previousObservedMutedState,
                observedNativeMutedState: stateData.observedNativeMutedState,
                previousManagedMutedState,
                managedMutedState: stateData.managedMutedState,
                previousSnapshotMutedState,
                nativeMutedSnapshot: stateData.nativeMutedSnapshot,
                previousSharedMutedState,
                currentMutedState: State.currentMutedState
            }, { threshold: 3 });
        }
    }

    function observeElementNativeState(element, stateData, options = {}) {
        if (!element || !stateData) {
            return;
        }

        const { commitToRestore = false } = options;
        const previousObservedVolume = stateData.observedNativeVolume;
        const previousObservedMutedState = stateData.observedNativeMutedState;
        const previousSnapshotVolume = stateData.nativeVolumeSnapshot;
        const previousSnapshotMutedState = stateData.nativeMutedSnapshot;
        const nextVolume = Number.isFinite(element.volume)
            ? element.volume
            : (Number.isFinite(stateData.observedNativeVolume) ? stateData.observedNativeVolume : element.volume);
        const nextMuted = Boolean(element.muted);

        stateData.observedNativeVolume = nextVolume;
        stateData.observedNativeMutedState = nextMuted;

        if (commitToRestore) {
            stateData.nativeVolumeSnapshot = nextVolume;
            stateData.nativeMutedSnapshot = nextMuted;
            stateData.userOriginalVolume = nextVolume;
            stateData.userOriginalMutedState = nextMuted;
        }

        const observedVolumeChanged = !Number.isFinite(previousObservedVolume) || Math.abs(previousObservedVolume - nextVolume) > 0.001;
        const snapshotVolumeChanged = !Number.isFinite(previousSnapshotVolume) || Math.abs(previousSnapshotVolume - nextVolume) > 0.001;
        if (logDiagnostic && (
            observedVolumeChanged ||
            previousObservedMutedState !== nextMuted ||
            (commitToRestore && (snapshotVolumeChanged || previousSnapshotMutedState !== nextMuted))
        )) {
            logDiagnostic('native-state-observed', {
                elementInfo: `${element.tagName}#${element.id || 'no-id'}`,
                commitToRestore,
                elementVolume: toNativeVolumePercent(element.volume),
                observedNativeVolume: toNativeVolumePercent(stateData.observedNativeVolume),
                previousObservedNativeVolume: toNativeVolumePercent(previousObservedVolume),
                elementMuted: nextMuted,
                previousObservedMutedState,
                observedNativeMutedState: stateData.observedNativeMutedState,
                previousSnapshotVolume: toNativeVolumePercent(previousSnapshotVolume),
                nativeVolumeSnapshot: toNativeVolumePercent(stateData.nativeVolumeSnapshot),
                previousSnapshotMutedState,
                nativeMutedSnapshot: stateData.nativeMutedSnapshot,
                managedMutedState: stateData.managedMutedState
            }, { threshold: 3 });
        }
    }

    function restoreElementNativeState(element, stateData) {
        if (!element?.isConnected || !stateData) {
            return;
        }

        const VolumeController = getVolumeController();
        if (!VolumeController) {
            return;
        }

        const nativeVolume = Number.isFinite(stateData.nativeVolumeSnapshot)
            ? stateData.nativeVolumeSnapshot
            : Number.isFinite(stateData.userOriginalVolume)
            ? stateData.userOriginalVolume
            : element.volume;
        const nativeMuted = stateData.nativeMutedSnapshot ?? stateData.userOriginalMutedState;

        if (logDiagnostic) {
            logDiagnostic('native-state-restore', {
                elementInfo: `${element.tagName}#${element.id || 'no-id'}`,
                nativeVolume: toNativeVolumePercent(nativeVolume),
                nativeMuted: Boolean(nativeMuted),
                snapshotVolume: toNativeVolumePercent(stateData.nativeVolumeSnapshot),
                snapshotMuted: stateData.nativeMutedSnapshot,
                managedMutedState: stateData.managedMutedState,
                observedNativeMutedState: stateData.observedNativeMutedState
            }, { threshold: 3 });
        }

        VolumeController.setNativeVolume(element, nativeVolume);
        VolumeController.applyMute(element, Boolean(nativeMuted));
    }

    function enterPassthroughMode(element, stateData) {
        if (!element?.isConnected || !stateData?.isActive() || !stateData.source || !stateData.audioContext) {
            return;
        }

        const AudioPipeline = getAudioPipeline();
        const VolumeSyncManager = getVolumeSyncManager();
        const Compressor = getCompressor();

        clearActiveElementVerification(stateData);
        Compressor?.monitor.stop(element);
        VolumeSyncManager?.removeVolumeChangeHandler(element, stateData);
        VolumeSyncManager?.cleanup(element);

        restoreElementNativeState(element, stateData);
        AudioPipeline.connectPassthrough({
            source: stateData.source,
            gainNode: stateData.gainNode,
            compressorNode: stateData.compressorNode,
            preCompressorGainNode: stateData.preCompressorGainNode,
            makeupGainNode: stateData.makeupGainNode,
            monoSplitterNode: stateData.monoSplitterNode,
            monoLeftGainNode: stateData.monoLeftGainNode,
            monoRightGainNode: stateData.monoRightGainNode,
            monoMergerNode: stateData.monoMergerNode,
            stereoPannerNode: stateData.stereoPannerNode,
            analyser: stateData.analyser
        }, stateData.audioContext);
        stateData.passthroughMode = true;
    }

    function resumeExtensionControl(element, stateData) {
        if (!element?.isConnected || !stateData?.isActive() || !stateData.source || !stateData.audioContext) {
            return false;
        }

        const State = getState();
        const AudioPipeline = getAudioPipeline();
        const VolumeController = getVolumeController();
        const VolumeSyncManager = getVolumeSyncManager();
        const Compressor = getCompressor();

        observeElementNativeState(element, stateData, { commitToRestore: true });

        AudioPipeline.connectGraph({
            source: stateData.source,
            gainNode: stateData.gainNode,
            compressorNode: stateData.compressorNode,
            preCompressorGainNode: stateData.preCompressorGainNode,
            makeupGainNode: stateData.makeupGainNode,
            monoSplitterNode: stateData.monoSplitterNode,
            monoLeftGainNode: stateData.monoLeftGainNode,
            monoRightGainNode: stateData.monoRightGainNode,
            monoMergerNode: stateData.monoMergerNode,
            stereoPannerNode: stateData.stereoPannerNode,
            analyser: stateData.analyser
        }, stateData.audioContext, getCurrentProcessingOptions());

        AudioPipeline.updateAudioSettings({
            stereoPannerNode: stateData.stereoPannerNode
        }, stateData.audioContext, {
            balance: State.currentBalance
        });

        stateData.lastAppliedMonoEnabled = State.currentMonoEnabled;
        stateData.lastAppliedBalance = State.currentBalance;
        stateData.passthroughMode = false;

        if (VolumeSyncManager) {
            VolumeSyncManager.startApplyingVolume(element, State.currentVolumePercent);
        }
        VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true, source: 'extension-resume' });
        VolumeController.applyMute(element, getDesiredMuteStateForElement(element, stateData));
        VolumeSyncManager?.attachVolumeChangeHandler(element, stateData);

        if (State.currentCompressionEnabled) {
            Compressor?.monitor.start(element, stateData);
        }

        resetActiveVerificationState(stateData, element.currentTime, false);
        scheduleActiveElementVerification(element, stateData);

        return true;
    }

    function disableExtensionProcessing() {
        const stateManager = getElementStateManager();
        if (!stateManager) {
            return;
        }

        Array.from(stateManager.elements.entries()).forEach(([element, stateData]) => {
            if (stateData.isActive()) {
                enterPassthroughMode(element, stateData);
            } else if (stateManager.isCorsBlocked(element)) {
                const VolumeSyncManager = getVolumeSyncManager();
                restoreElementNativeState(element, stateData);
                VolumeSyncManager?.removeVolumeChangeHandler(element, stateData);
                VolumeSyncManager?.cleanup(element);
            }
        });
    }

    function enableExtensionProcessing() {
        const stateManager = getElementStateManager();
        let resumedCount = 0;

        if (stateManager) {
            Array.from(stateManager.elements.entries()).forEach(([element, stateData]) => {
                if (stateData?.passthroughMode && resumeExtensionControl(element, stateData)) {
                    resumedCount += 1;
                }
            });
        }

        refreshDetectedMediaState(getDetectableMediaElements(), resumedCount > 0 ? 'extension-reenabled-resume' : 'extension-reenabled');
    }

    function setExtensionEnabled(enabled) {
        const State = getState();
        const nextEnabled = enabled !== false;

        if (State.extensionEnabled === nextEnabled) {
            return;
        }

        State.extensionEnabled = nextEnabled;

        if (!nextEnabled) {
            disableExtensionProcessing();
            log('[Main] Extension sound control disabled');
            return;
        }

        enableExtensionProcessing();
        log('[Main] Extension sound control enabled');
    }

    function persistCompressionSettings() {
        const State = getState();
        window.VolumeControl.storageSync?.saveCompressionSettings?.({
            enabled: State.currentCompressionEnabled,
            threshold: State.currentCompressionThreshold,
            ratio: State.currentCompressionRatio,
            knee: State.currentCompressionKnee
        });
    }

    function persistAudioSettings() {
        const State = getState();
        window.VolumeControl.storageSync?.saveAudioSettings?.({
            monoEnabled: State.currentMonoEnabled,
            balance: State.localBalance
        });
    }

    function resolveEffectiveBalance() {
        const State = getState();

        if (State.defaultBalanceEnabled) {
            return Protocol.normalizeBalance(State.defaultBalance, DEFAULT_BALANCE);
        }

        if (State.balanceHasBeenSet) {
            return Protocol.normalizeBalance(State.localBalance, DEFAULT_BALANCE);
        }

        return DEFAULT_BALANCE;
    }

    function applyResolvedAudioSettings(options = {}) {
        const stateManager = getElementStateManager();
        const State = getState();
        const AudioPipeline = getAudioPipeline();
        const nextMonoEnabled = Object.prototype.hasOwnProperty.call(options, 'monoEnabled')
            ? Boolean(options.monoEnabled)
            : State.currentMonoEnabled;
        const nextBalance = Object.prototype.hasOwnProperty.call(options, 'balance')
            ? Protocol.normalizeBalance(options.balance, DEFAULT_BALANCE)
            : State.currentBalance;
        const monoChanged = nextMonoEnabled !== State.currentMonoEnabled;
        const balanceChanged = nextBalance !== State.currentBalance;

        if (!monoChanged && !balanceChanged) {
            return { monoChanged, balanceChanged, nextMonoEnabled, nextBalance };
        }

        State.currentMonoEnabled = nextMonoEnabled;
        State.currentBalance = nextBalance;

        if (State.extensionEnabled === false) {
            log(`[Main] Saved audio settings while extension sound control is disabled`);
            return { monoChanged, balanceChanged, nextMonoEnabled, nextBalance };
        }

        stateManager.elements.forEach((stateData) => {
            if (!stateData.isActive() || !stateData.audioContext) {
                return;
            }

            if (monoChanged) {
                AudioPipeline.connectGraph({
                    source: stateData.source,
                    gainNode: stateData.gainNode,
                    compressorNode: stateData.compressorNode,
                    preCompressorGainNode: stateData.preCompressorGainNode,
                    makeupGainNode: stateData.makeupGainNode,
                    monoSplitterNode: stateData.monoSplitterNode,
                    monoLeftGainNode: stateData.monoLeftGainNode,
                    monoRightGainNode: stateData.monoRightGainNode,
                    monoMergerNode: stateData.monoMergerNode,
                    stereoPannerNode: stateData.stereoPannerNode,
                    analyser: stateData.analyser
                }, stateData.audioContext, {
                    compressionEnabled: State.currentCompressionEnabled,
                    monoEnabled: nextMonoEnabled,
                    balance: nextBalance
                });
            }

            AudioPipeline.updateAudioSettings({
                stereoPannerNode: stateData.stereoPannerNode
            }, stateData.audioContext, {
                balance: nextBalance
            });
            stateData.lastAppliedMonoEnabled = nextMonoEnabled;
            stateData.lastAppliedBalance = nextBalance;
        });

        log(`[Main] Updated audio settings: mono=${nextMonoEnabled}, balance=${nextBalance}`);
        return { monoChanged, balanceChanged, nextMonoEnabled, nextBalance };
    }

    function applyGlobalBalanceSettings(settings) {
        const State = getState();
        const normalizedSettings = Protocol.normalizeGlobalBalanceSettings(settings, { partial: true });

        if (Object.prototype.hasOwnProperty.call(normalizedSettings, 'enabled')) {
            State.defaultBalanceEnabled = normalizedSettings.enabled;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedSettings, 'balance')) {
            State.defaultBalance = normalizedSettings.balance;
        }

        const nextBalance = resolveEffectiveBalance();
        applyResolvedAudioSettings({ balance: nextBalance });
    }

    function getAudioSettingsAvailability() {
        const stateManager = getElementStateManager();
        if (!stateManager) {
            return {
                available: true,
                reason: null
            };
        }

        stateManager.cleanupStaleCorsElements?.();

        const activeEntries = stateManager.getActive();
        const corsCount = stateManager.corsElements.size;

        if (activeEntries.length > 0) {
            return {
                available: true,
                reason: null
            };
        }

        if (corsCount > 0 && activeEntries.length === 0) {
            return {
                available: false,
                reason: 'native-only-current-media'
            };
        }

        return {
            available: true,
            reason: null
        };
    }

    // Import ElementState enum
    let ElementState;
    const ensureElementState = () => {
        if (!ElementState) {
            ElementState = window.VolumeControl.ElementState;
        }
        return ElementState;
    };

    function isCurrentElementOperation(element, stateData, scope, epoch) {
        const stateManager = getElementStateManager();
        return Boolean(
            element?.isConnected &&
            stateManager?.get(element) === stateData &&
            stateData?.isOperationCurrent?.(scope, epoch)
        );
    }

    function scheduleElementTimeout(stateData, scope, key, delayMs, callback) {
        const timeoutId = setTimeout(() => {
            stateData.operationTimeouts?.[scope]?.delete(key);
            callback();
        }, delayMs);

        return stateData.registerOperationTimeout(scope, key, timeoutId);
    }

    function clearActiveElementVerification(stateData) {
        if (!stateData?.verificationTimer) {
            return;
        }

        clearTimeout(stateData.verificationTimer);
        stateData.verificationTimer = null;
    }

    function resetActiveVerificationState(stateData, currentTime = null, sawAudio = false) {
        if (!stateData) {
            return;
        }

        stateData.consecutiveVerificationFailures = 0;
        stateData.needsConnectionVerification = false;
        stateData.detachedSinceAt = null;

        if (Number.isFinite(Number(currentTime))) {
            stateData.lastObservedCurrentTime = Number(currentTime);
        }

        if (sawAudio) {
            stateData.lastVerifiedAudioAt = Date.now();
        }
    }

    function scheduleActiveElementVerification(element, stateData, delayMs = ACTIVE_VERIFICATION_INTERVAL_MS) {
        if (!element || !stateData?.isActive?.()) {
            return;
        }

        clearActiveElementVerification(stateData);
        stateData.verificationTimer = setTimeout(() => {
            stateData.verificationTimer = null;
            verifyActiveElementConnection(element, stateData, 'watchdog');
        }, delayMs);
    }

    function verifyActiveElementConnection(element, stateData, trigger = 'manual') {
        const stateManager = getElementStateManager();
        const State = getState();
        const AudioPipeline = getAudioPipeline();
        const SourceCapture = getSourceCapture();
        const VolumeController = getVolumeController();
        const VolumeSyncManager = getVolumeSyncManager();
        const elementInfo = `${element?.tagName || 'UNKNOWN'}#${element?.id || 'no-id'}`;

        // Log every verification cycle with full state
        logDiagnostic?.('verification-run', {
            elementInfo,
            trigger,
            isActive: Boolean(stateData?.isActive?.()),
            isTransitioning: Boolean(stateData?.isTransitioning?.()),
            isConnected: element?.isConnected,
            paused: element?.paused,
            ended: element?.ended,
            seeking: element?.seeking,
            currentTime: element?.currentTime,
            readyState: element?.readyState,
            volume: element?.volume,
            muted: element?.muted,
            hasGainNode: Boolean(stateData?.gainNode),
            hasSource: Boolean(stateData?.source),
            hasAnalyser: Boolean(stateData?.analyser),
            hasStream: Boolean(stateData?.sourceStream),
            streamTrackCount: stateData?.sourceStream?.getAudioTracks?.()?.length ?? -1,
            streamTrackStates: stateData?.sourceStream?.getAudioTracks?.()?.map(t => ({
                id: t.id, label: t.label, kind: t.kind,
                enabled: t.enabled, readyState: t.readyState
            })),
            passthroughMode: Boolean(stateData?.passthroughMode),
            extensionEnabled: State.extensionEnabled,
            detachedSinceAt: stateData?.detachedSinceAt,
            detachedAgeMs: stateData?.detachedSinceAt ? Date.now() - stateData?.detachedSinceAt : null,
            consecutiveFailures: stateData?.consecutiveVerificationFailures,
            needsVerification: Boolean(stateData?.needsConnectionVerification),
            lastKnownSrc: stateData?.lastKnownSrc,
            currentSrc: element?.currentSrc || element?.src || 'none',
            audioContextState: stateData?.audioContext?.state ?? 'no-ctx'
        }, { threshold: 3 });

        if (!element || !stateData || stateManager?.get(element) !== stateData) {
            return;
        }

        if (!stateData.isActive() || stateData.isTransitioning()) {
            clearActiveElementVerification(stateData);
            return;
        }

        if (State.extensionEnabled === false || stateData.passthroughMode) {
            clearActiveElementVerification(stateData);
            resetActiveVerificationState(stateData, element.currentTime, false);
            return;
        }

        if (!element.isConnected) {
            if (!stateData.detachedSinceAt) {
                stateData.detachedSinceAt = Date.now();
            }

            if (isElementPotentiallyPlaying(element) && (Date.now() - stateData.detachedSinceAt) < DETACHED_PLAYBACK_GRACE_MS) {
                scheduleActiveElementVerification(element, stateData);
                return;
            }

            cleanupElement(element);
            return;
        }

        stateData.detachedSinceAt = null;

        const latestSourceKey = getElementSourceKey(element);
        if (stateData.lastKnownSrc && latestSourceKey && stateData.lastKnownSrc !== latestSourceKey) {
            if (logDiagnostic) {
                logDiagnostic('verification-source-change', {
                    elementInfo,
                    trigger,
                    previousSourceKey: stateData.lastKnownSrc,
                    latestSourceKey
                }, { threshold: 3 });
            }
            log(`[Main] Verification detected missed source change for ${elementInfo} (${trigger})`);
            handleSourceChange(element);
            return;
        }

        const isPlaying = isElementPotentiallyPlaying(element) && element.currentTime > 0;
        if (!isPlaying) {
            resetActiveVerificationState(stateData, element.currentTime, false);
            return;
        }

        const expectedNative = Math.min(DEFAULT_VOLUME, State.currentVolumePercent);
        const desiredMuteState = getDesiredMuteStateForElement(element, stateData);
        const playerVolume = Math.round((Number.isFinite(element.volume) ? element.volume : 1) * DEFAULT_VOLUME);
        const volumeDiff = Math.abs(playerVolume - expectedNative);
        if (
            State.volumeHasBeenSet &&
            volumeDiff > 2 &&
            !VolumeSyncManager?.isApplyingVolume(element) &&
            !VolumeSyncManager?.isSourceChanging(element)
        ) {
            if (logDiagnostic) {
                logDiagnostic('verification-volume-repair', {
                    elementInfo,
                    trigger,
                    playerVolume,
                    expectedNative,
                    extensionVolume: State.currentVolumePercent,
                    volumeDiff,
                    elementMuted: element.muted,
                    desiredMuteState,
                    managedMutedState: stateData.managedMutedState,
                    observedNativeMutedState: stateData.observedNativeMutedState,
                    nativeMutedSnapshot: stateData.nativeMutedSnapshot,
                    muteHasBeenSet: State.muteHasBeenSet
                }, { threshold: 3 });
            }
            verbose(`[Main] Verification repairing native volume drift on ${elementInfo}: ${playerVolume}% -> ${expectedNative}%`);
            VolumeSyncManager?.startApplyingVolume(element, State.currentVolumePercent);
            VolumeController?.applyVolume(element, stateData, State.currentVolumePercent, { force: true, source: 'verification-drift' });
            resetActiveVerificationState(stateData, element.currentTime, false);
            scheduleActiveElementVerification(element, stateData);
            return;
        }

        if (element.muted !== desiredMuteState) {
            if (logDiagnostic) {
                logDiagnostic('verification-mute-repair', {
                    elementInfo,
                    trigger,
                    elementMuted: element.muted,
                    desiredMuteState,
                    currentMutedState: State.currentMutedState,
                    muteHasBeenSet: State.muteHasBeenSet,
                    managedMutedState: stateData.managedMutedState,
                    observedNativeMutedState: stateData.observedNativeMutedState,
                    nativeMutedSnapshot: stateData.nativeMutedSnapshot,
                    playerVolume,
                    expectedNative
                }, { threshold: 3 });
            }
            verbose(`[Main] Verification repairing mute drift on ${elementInfo}: ${element.muted} -> ${desiredMuteState}`);
            VolumeController?.applyMute(element, desiredMuteState);
            resetActiveVerificationState(stateData, element.currentTime, false);
            scheduleActiveElementVerification(element, stateData);
            return;
        }

        const canCheckFlow = Boolean(
            AudioPipeline?.checkAudioFlow &&
            stateData.analyser &&
            !document.hidden &&
            stateData.isIntersecting !== false &&
            !element.muted &&
            State.currentMutedState !== true &&
            State.currentVolumePercent > 0 &&
            (Date.now() - (stateData.lastStateChangeAt || 0)) > ACTIVE_VERIFICATION_GRACE_MS
        );

        if (!canCheckFlow) {
            resetActiveVerificationState(stateData, element.currentTime, false);
            scheduleActiveElementVerification(element, stateData);
            return;
        }

        const flow = AudioPipeline.checkAudioFlow(stateData.analyser);
        const currentTime = Number.isFinite(Number(element.currentTime)) ? Number(element.currentTime) : 0;
        const previousCurrentTime = Number.isFinite(Number(stateData.lastObservedCurrentTime)) ? Number(stateData.lastObservedCurrentTime) : 0;
        const timeAdvanced = currentTime > (previousCurrentTime + 0.25);
        stateData.lastObservedCurrentTime = currentTime;

        logDiagnostic?.('verification-flow-check', {
            elementInfo,
            trigger,
            hasAudio: flow.hasAudio,
            avgAmplitude: flow.avgAmplitude,
            peakAmplitude: flow.peakAmplitude,
            currentTime,
            previousCurrentTime,
            timeAdvanced,
            isPlaying,
            documentHidden: document.hidden,
            isIntersecting: stateData.isIntersecting
        }, { threshold: 3 });

        if (flow.hasAudio) {
            resetActiveVerificationState(stateData, currentTime, true);
            scheduleActiveElementVerification(element, stateData);
            return;
        }

        if (!timeAdvanced) {
            scheduleActiveElementVerification(element, stateData);
            return;
        }

        stateData.consecutiveVerificationFailures = (stateData.consecutiveVerificationFailures || 0) + 1;
        stateData.needsConnectionVerification = true;

        if (logDiagnostic) {
            logDiagnostic('verification-silent-graph', {
                elementInfo,
                trigger,
                currentTime,
                previousCurrentTime,
                timeAdvanced,
                avgAmplitude: flow.avgAmplitude,
                peakAmplitude: flow.peakAmplitude,
                consecutiveVerificationFailures: stateData.consecutiveVerificationFailures,
                failureThreshold: ACTIVE_VERIFICATION_FAILURES_BEFORE_RESET,
                playerVolume,
                expectedNative,
                extensionVolume: State.currentVolumePercent,
                elementMuted: element.muted,
                desiredMuteState,
                managedMutedState: stateData.managedMutedState,
                observedNativeMutedState: stateData.observedNativeMutedState,
                nativeMutedSnapshot: stateData.nativeMutedSnapshot
            }, { threshold: 3 });
        }

        if (stateData.consecutiveVerificationFailures < ACTIVE_VERIFICATION_FAILURES_BEFORE_RESET) {
            verbose(`[Main] Verification found silent active graph on ${elementInfo} (${stateData.consecutiveVerificationFailures}/${ACTIVE_VERIFICATION_FAILURES_BEFORE_RESET})`);

            // === mozCaptureStream: Scorched-earth reset ===
            // Firefox permanently mutes mozCaptureStream tracks when the
            // underlying <video> element switches DASH segments (emptied
            // event).  The dead tracks CANNOT be revived — any attempt to
            // recreate an audio source from the same (now-closed) stream
            // will produce silence.  The only working recovery is to:
            //   1. Release the dead stream (track.stop()) so Firefox frees
            //      the element's internal capture slot.
            //   2. Call element.mozCaptureStream() again for a FRESH stream.
            //   3. Build a new audio graph from the fresh stream.
            if (stateData.sourceType === 'mozCaptureStream') {
                verbose(`[Main] Verification: resetting silent mozCaptureStream for ${elementInfo}`);

                // Disconnect the dead graph with full stream release
                AudioPipeline.disconnectGraph({
                    source: stateData.source,
                    sourceStream: stateData.sourceStream,
                    sourceType: stateData.sourceType,
                    gainNode: stateData.gainNode,
                    compressorNode: stateData.compressorNode,
                    preCompressorGainNode: stateData.preCompressorGainNode,
                    makeupGainNode: stateData.makeupGainNode,
                    monoSplitterNode: stateData.monoSplitterNode,
                    monoLeftGainNode: stateData.monoLeftGainNode,
                    monoRightGainNode: stateData.monoRightGainNode,
                    monoMergerNode: stateData.monoMergerNode,
                    stereoPannerNode: stateData.stereoPannerNode,
                    analyser: stateData.analyser
                }, elementInfo, { releaseStream: true });

                // Clear stale node references on stateData so the graph
                // is not double-disconnected or double-released later.
                stateData.sourceStream = null;
                stateData.source = null;
                stateData.gainNode = null;
                stateData.analyser = null;

                // Re-capture: get a fresh mozCaptureStream from the element
                const freshResult = SourceCapture.refreshMozCaptureStream(
                    element, stateData.audioContext, elementInfo
                );

                if (freshResult.error || !freshResult.source) {
                    warn(`[Main] mozCaptureStream refresh FAILED for ${elementInfo}: ${freshResult.error?.message || 'no source'}`);
                    if (freshResult.isTemporary) {
                        verbose(`[Main] Refresh temporary (no tracks yet). Forcing full reset and polling retry...`);
                        cleanupElement(element, { preserveListeners: true });
                        setTimeout(() => {
                            if (element.isConnected) setupElement(element, { isResetup: true, fromPlayingEvent: false });
                        }, 250);
                    } else {
                        // Recapture failed permanently — fall back to native-only volume control.
                        VolumeController.applyNativeVolumeOnly(element, State.currentVolumePercent);
                        VolumeController.applyMute(element, getDesiredMuteStateForElement(element, stateData));
                        log(`[Main] Verification: ${elementInfo} native-only fallback (mozCaptureStream refresh failed)`);
                    }
                    return;
                }

                // Build fresh audio nodes from the new stream
                const freshNodes = AudioPipeline.createAudioNodes(stateData.audioContext, freshResult, {
                    threshold: State.currentCompressionThreshold,
                    ratio: State.currentCompressionRatio,
                    knee: State.currentCompressionKnee
                });

                // Store new nodes in state
                Object.assign(stateData, {
                    source: freshNodes.source,
                    sourceStream: freshNodes.sourceStream,
                    sourceType: freshNodes.sourceType,
                    gainNode: freshNodes.gainNode,
                    compressorNode: freshNodes.compressorNode,
                    preCompressorGainNode: freshNodes.preCompressorGainNode,
                    makeupGainNode: freshNodes.makeupGainNode,
                    monoSplitterNode: freshNodes.monoSplitterNode,
                    monoLeftGainNode: freshNodes.monoLeftGainNode,
                    monoRightGainNode: freshNodes.monoRightGainNode,
                    monoMergerNode: freshNodes.monoMergerNode,
                    stereoPannerNode: freshNodes.stereoPannerNode,
                    analyser: freshNodes.analyser,
                    passthroughMode: false
                });

                // Reconnect the audio graph
                AudioPipeline.connectGraph(freshNodes, stateData.audioContext, getEffectiveProcessingOptions());

                // Re-apply full extension volume state
                VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true, source: 'verification-moz-reset' });
                VolumeController.applyMute(element, getDesiredMuteStateForElement(element, stateData));

                logDiagnostic?.('verification-moz-reset', {
                    elementInfo,
                    success: true,
                    freshStreamTrackCount: freshNodes.sourceStream?.getAudioTracks?.()?.length ?? -1,
                    freshStreamTrackStates: freshNodes.sourceStream?.getAudioTracks?.()?.map(t => ({
                        id: t.id, label: t.label, kind: t.kind,
                        enabled: t.enabled, readyState: t.readyState
                    })),
                    volumePercent: State.currentVolumePercent,
                    muted: State.currentMutedState
                }, { threshold: 3 });

                log(`[Main] Verification: mozCaptureStream successfully refreshed for ${elementInfo}`);

                // Schedule next verification cycle
                resetActiveVerificationState(stateData, element.currentTime, false);
                scheduleActiveElementVerification(element, stateData);
                return;
            }

            scheduleActiveElementVerification(element, stateData);
            return;
        }

        if (logDiagnostic) {
            logDiagnostic('verification-resetup', {
                elementInfo,
                trigger,
                consecutiveVerificationFailures: stateData.consecutiveVerificationFailures,
                failureThreshold: ACTIVE_VERIFICATION_FAILURES_BEFORE_RESET,
                currentTime,
                previousCurrentTime,
                avgAmplitude: flow.avgAmplitude,
                peakAmplitude: flow.peakAmplitude,
                desiredMuteState,
                elementMuted: element.muted,
                playerVolume,
                expectedNative,
                managedMutedState: stateData.managedMutedState,
                observedNativeMutedState: stateData.observedNativeMutedState,
                nativeMutedSnapshot: stateData.nativeMutedSnapshot
            }, { threshold: 3 });
        }
        warn(`[Main] Verification re-setting up stale active graph for ${elementInfo} after repeated silent checks`);
        cleanupElement(element, { preserveListeners: true });

        queueMicrotask(() => {
            if (element?.isConnected) {
                setupElement(element, { isResetup: true, fromPlayingEvent: true });
            }
        });
    }

    /**
     * Set up audio graph for an element
     * This is the NEW simplified setup function using modular components
     * @param {HTMLMediaElement} element
     * @param {Object} options
     * @returns {Object|null} - Element state data or null
     */
    async function setupElement(element, options = {}) {
        const { isResetup = false, fromPlayingEvent = false, allowDisconnected = false } = options;
        const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
        
        ensureElementState();
        const stateManager = getElementStateManager();
        const State = getState();
        const AudioContextMgr = getAudioContext();
        const SourceCapture = getSourceCapture();
        const AudioPipeline = getAudioPipeline();
        const VolumeController = getVolumeController();
        const VolumeSyncManager = getVolumeSyncManager();
        const Compressor = getCompressor();

        // Get or create element state
        const stateData = stateManager.getOrCreate(element);
        observeElementNativeState(element, stateData, { commitToRestore: true });

        if (State.extensionEnabled === false) {
            verbose(`[Main] Skipping setup for ${elementInfo} because extension sound control is disabled`);
            return null;
        }
        
        // Check if already active or setting up
        if (stateData.isActive()) {
            const latestSourceKey = getElementSourceKey(element);
            if (stateData.lastKnownSrc && latestSourceKey && stateData.lastKnownSrc !== latestSourceKey) {
                verbose(`[Main] ${elementInfo} active element source changed before reapply; routing through source change handling`);
                handleSourceChange(element);
                return stateManager.get(element);
            }

            // Already active - but if volume has been set by user/storage, ensure it's applied
            // This handles cases where site tries to change volume on track change without
            // the element going through 'emptied' state
            if (State.volumeHasBeenSet && stateData.gainNode) {
                verbose(`[Main] ${elementInfo} already active - re-applying extension volume ${State.currentVolumePercent}%`);
                if (VolumeSyncManager) {
                    VolumeSyncManager.startApplyingVolume(element, State.currentVolumePercent);
                }
                VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true });
            }
            syncUnownedMuteStateFromElement(element, stateData, {
                updateManagedState: true,
                commitToRestore: false
            });
            VolumeController.applyMute(element, getDesiredMuteStateForElement(element, stateData));
            scheduleActiveElementVerification(element, stateData);
            return stateData;
        }
        
        if (stateData.isState(ElementState.SETTING_UP)) {
            verbose(`[Main] ${elementInfo} setup already in progress`);
            return null;
        }

        // Check if element is actually playing
        // When triggered by 'playing' event, we trust the event and don't require currentTime > 0
        // (YouTube Music starts with currentTime=0 and the playing event fires before time advances)
        const isActuallyPlaying = !element.paused && !element.ended && !element.seeking && 
            (fromPlayingEvent || element.currentTime > 0);
        if (!isActuallyPlaying) {
            verbose(`[Main] ${elementInfo} not playing yet (paused=${element.paused}, ended=${element.ended}, seeking=${element.seeking}, currentTime=${element.currentTime})`);

            // If the element is seeking, attach a one-time 'playing' listener
            // to retry setup when seeking completes AND playback resumes.
            // This handles Reddit's DASH player: replacement <video> elements
            // are discovered mid-seek, and setupElement bails out.  The
            // 'playing' event fires after seek completes + play() is called.
            if (element.seeking) {
                verbose(`[Main] ${elementInfo} seeking — will retry setup on 'playing'`);
                const retryOnPlay = () => {
                    element.removeEventListener('playing', retryOnPlay);
                    setupElement(element, { fromPlayingEvent: true });
                };
                element.addEventListener('playing', retryOnPlay, { once: true });
            }

            return null;
        }

        // Check source
        const sourceKey = getElementSourceKey(element);
        if (!hasUsableMediaSource(element)) {
            verbose(`[Main] ${elementInfo} has no valid source`);
            return null;
        }

        const setupEpoch = stateData.beginOperation('setup', {
            invalidate: ['retry', 'sourceChange', 'volumeSync']
        });
        const isSetupCurrent = () => isCurrentElementOperation(element, stateData, 'setup', setupEpoch);
        const clearSetupTimeout = () => {
            stateData.clearOperationTimeout('setup', 'timeout');
            stateData.setupTimeoutId = null;
        };

        // Transition to SETTING_UP
        if (!stateData.transition(ElementState.SETTING_UP)) {
            warn(`[Main] Failed to transition ${elementInfo} to SETTING_UP`);
            return null;
        }

        stateData.setupStartedAt = Date.now();
        stateData.lastKnownSrc = sourceKey;
    observeElementNativeState(element, stateData, { commitToRestore: true });

        log(`[Main] Setting up ${elementInfo}${isResetup ? ' (re-setup)' : ''}`);

        // Setup timeout (5 seconds max to prevent hanging on slow media loads)
        let setupTimedOut = false;
        const setupTimeoutId = scheduleElementTimeout(stateData, 'setup', 'timeout', SETUP_TIMEOUT_MS, () => {
            if (!isSetupCurrent()) {
                return;
            }
            setupTimedOut = true;
            if (stateData.isState(ElementState.SETTING_UP)) {
                warn(`[Main] Setup timeout for ${elementInfo} after ${SETUP_TIMEOUT_MS}ms`);
                stateData.transition(ElementState.ERROR, {
                    errorType: 'timeout',
                    errorMessage: `Setup timed out after ${SETUP_TIMEOUT_MS}ms`,
                    retryCount: stateData.retryCount + 1
                });
            }
        });
        stateData.setupTimeoutId = setupTimeoutId;

        try {
            // Get/create AudioContext
            const audioContext = AudioContextMgr.getSharedAudioContext();
            if (!audioContext) {
                clearSetupTimeout();
                throw new Error('Failed to get AudioContext');
            }

            // Check if we've already timed out
            if (setupTimedOut || !isSetupCurrent()) {
                return null;
            }

            // Ensure AudioContext is running
            if (audioContext.state !== 'running') {
                await AudioContextMgr.ensureAudioContextRunning();
            }

            if (!isSetupCurrent()) {
                clearSetupTimeout();
                return null;
            }

            // Abort setup if the element disappeared while awaiting resume.
            // Skip this check for play-interception discoveries (off-DOM elements
            // like Bandcamp's `new Audio()` are valid capture targets and don't
            // need to be in the DOM for createMediaElementSource to work).
            if (!element.isConnected && !allowDisconnected) {
                clearSetupTimeout();
                verbose(`[Main] ${elementInfo} detached during AudioContext resume`);
                return null;
            }

            // Check if we've already timed out
            if (setupTimedOut || !isSetupCurrent()) {
                return null;
            }

            // Check CORS before attempting capture
            const corsResult = SourceCapture.checkCorsStatus(element);
            const captureMethod = SourceCapture?.determineCaptureMethod?.(element) || null;
            const isFirefoxBrowser = Boolean(SourceCapture?.isFirefoxBrowser?.());
            let shouldConfirmCorsViaCapture = false;
            if (!corsResult.allowed) {
                // If this is a temporary issue (source not ready), don't mark as CORS-blocked.
                // Transition to ERROR state with retry capability - it will retry on next playing event.
                if (corsResult.isTemporary) {
                    clearSetupTimeout();
                    verbose(`[Main] ${elementInfo} source not ready yet: ${corsResult.message}`);
                    const retries = stateData.metadata?.retryCount || 0;
                    stateData.transition(ElementState.ERROR, {
                        errorType: 'invalid_source',
                        errorMessage: corsResult.message,
                        retryCount: retries + 1
                    });
                    if (retries < 20) {
                        setTimeout(() => {
                            if (element.isConnected) setupElement(element, options);
                        }, Math.min(1000, 100 * Math.pow(1.5, retries)));
                    }
                    return null;
                }

                if (isFirefoxBrowser) {
                    return activateNativeOnlyFallback(element, stateData, {
                        elementInfo,
                        sourceKey,
                        fallbackReason: 'firefox-cors-preflight-blocked',
                        corsMessage: corsResult.message,
                        captureMethod
                    });
                } else {
                    shouldConfirmCorsViaCapture = true;
                    verbose(`[Main] ${elementInfo} CORS preflight warning: ${corsResult.message}. Attempting capture to confirm.`);
                }
            }

            // Create source - this is where the ACTUAL CORS error would occur
            const captureResult = SourceCapture.createSource(element, audioContext);
            if (captureResult.error) {
                clearSetupTimeout();

                if (captureResult.isTemporary) {
                    if (logDiagnostic) {
                        logDiagnostic('setup-awaiting-audio-tracks', {
                            elementInfo,
                            sourceKey,
                            captureMethod,
                            captureErrorName: captureResult.error.name,
                            captureErrorMessage: captureResult.error.message,
                            isResetup
                        }, { threshold: 3 });
                    }
                    verbose(`[Main] ${elementInfo} source capture not ready yet: ${captureResult.error.message}`);
                    const retries = stateData.metadata?.retryCount || 0;
                    stateData.transition(ElementState.ERROR, {
                        errorType: 'invalid_source',
                        errorMessage: captureResult.error.message,
                        retryCount: retries + 1
                    });
                    if (retries < 20) {
                        setTimeout(() => {
                            if (element.isConnected) setupElement(element, options);
                        }, Math.min(1000, 100 * Math.pow(1.5, retries)));
                    }
                    return null;
                }
                
                // Check if this is a CORS-related error
                // SecurityError is thrown when CORS policy prevents capture
                if (captureResult.error.name === 'SecurityError' || 
                    captureResult.error.message?.includes('CORS') ||
                    captureResult.error.message?.includes('cross-origin')) {
                    return activateNativeOnlyFallback(element, stateData, {
                        elementInfo,
                        sourceKey,
                        fallbackReason: shouldConfirmCorsViaCapture ? 'capture-confirmed-cors-block' : 'capture-error',
                        corsMessage: corsResult.message,
                        captureError: captureResult.error,
                        captureMethod
                    });
                }
                
                throw captureResult.error;
            }

            if (shouldConfirmCorsViaCapture) {
                verbose(`[Main] ${elementInfo} capture succeeded despite CORS preflight warning; continuing with full audio graph.`);
            }

            if (!isSetupCurrent()) {
                clearSetupTimeout();
                return null;
            }

            // Create audio nodes
            const nodes = AudioPipeline.createAudioNodes(audioContext, captureResult, {
                threshold: State.currentCompressionThreshold,
                ratio: State.currentCompressionRatio,
                knee: State.currentCompressionKnee
            });

            // Store references in state data
            Object.assign(stateData, {
                audioContext,
                source: nodes.source,
                sourceStream: nodes.sourceStream,
                sourceType: nodes.sourceType,
                gainNode: nodes.gainNode,
                compressorNode: nodes.compressorNode,
                preCompressorGainNode: nodes.preCompressorGainNode,
                makeupGainNode: nodes.makeupGainNode,
                monoSplitterNode: nodes.monoSplitterNode,
                monoLeftGainNode: nodes.monoLeftGainNode,
                monoRightGainNode: nodes.monoRightGainNode,
                monoMergerNode: nodes.monoMergerNode,
                stereoPannerNode: nodes.stereoPannerNode,
                analyser: nodes.analyser,
                passthroughMode: false
            });

            // Connect graph
            AudioPipeline.connectGraph(nodes, audioContext, getEffectiveProcessingOptions());

            // Determine volume to apply
            let volumeToApply = State.currentVolumePercent;
            
            // Only consider adopting player volume on FIRST ever setup for this page
            // Once volume has been set (by user, storage, or previous adoption), never adopt again
            // This prevents track-switch volume resets on YouTube Music, Spotify, etc.
            if (!isResetup && !State.volumeHasBeenSet) {
                const playerVolume = Math.round(element.volume * DEFAULT_VOLUME);
                const isPlayerVolumeDifferent = playerVolume !== DEFAULT_VOLUME;
                const isElementUnmuted = !element.muted;
                
                if (isPlayerVolumeDifferent && isElementUnmuted) {
                    volumeToApply = playerVolume;
                    State.currentVolumePercent = volumeToApply;
                    log(`[Main] Adopted player volume: ${volumeToApply}%`);
                }
                
                // Mark that volume has been set (either adopted or defaulted to 100%)
                State.volumeHasBeenSet = true;
            }

            // CRITICAL: Mark that we're applying volume BEFORE setting it
            // This prevents volumechange events from being misinterpreted during setup
            if (VolumeSyncManager) {
                VolumeSyncManager.startApplyingVolume(element, volumeToApply);
            }

            // Apply volume
            VolumeController.applyVolume(element, stateData, volumeToApply);

            // Apply mute state
            syncUnownedMuteStateFromElement(element, stateData, {
                updateManagedState: true,
                commitToRestore: true
            });
            element.muted = getDesiredMuteStateForElement(element, stateData);

            // Attach volume sync handler
            if (VolumeSyncManager) {
                VolumeSyncManager.attachVolumeChangeHandler(element, stateData);
            }

            AudioPipeline.updateAudioSettings(nodes, audioContext, {
                balance: State.currentBalance
            });
            stateData.lastAppliedMonoEnabled = State.currentMonoEnabled;
            stateData.lastAppliedBalance = State.currentBalance;

            // Transition to ACTIVE
            if (!isSetupCurrent()) {
                clearSetupTimeout();
                return null;
            }
            stateData.transition(ElementState.ACTIVE);
            
            // Start compressor monitoring if enabled
            if (State.currentCompressionEnabled && Compressor) {
                Compressor.monitor.start(element, stateData, (el, data) => {
                    verbose(`[Compressor Monitor] ${elementInfo}: reduction=${data.reduction.toFixed(2)}dB`);
                });
            }

            resetActiveVerificationState(stateData, element.currentTime, false);
            scheduleActiveElementVerification(element, stateData);

            // Track visibility
            if (window.VolumeControl.MediaDetector?.visibility) {
                window.VolumeControl.MediaDetector.visibility.observe(element);
            }

            // Clear timeout on success
            clearSetupTimeout();

            log(`[Main] Setup complete for ${elementInfo}: ${volumeToApply}%, muted=${element.muted}`);

            // Log full graph state for diagnostics
            logDiagnostic?.('setup-success', {
                elementInfo,
                sourceType: stateData.sourceType,
                volumePercent: volumeToApply,
                gainValue: stateData.gainNode?.gain?.value ?? null,
                nativeVolume: element.volume,
                muted: element.muted,
                streamHasTracks: stateData.sourceStream?.getAudioTracks?.()?.length ?? -1,
                streamTrackStates: stateData.sourceStream?.getAudioTracks?.()?.map(t => ({
                    id: t.id, label: t.label, kind: t.kind,
                    enabled: t.enabled, readyState: t.readyState
                })),
                audioContextState: audioContext?.state ?? 'none',
                isConnected: element.isConnected,
                paused: element.paused,
                currentTime: element.currentTime,
                readyState: element.readyState,
                src: element.currentSrc || element.src || 'none',
                compressionEnabled: State.currentCompressionEnabled,
                monoEnabled: State.currentMonoEnabled,
                balance: State.currentBalance
            }, { threshold: 3 });

            // Notify popup
            if (window.VolumeControl.notifyPopupOfStatusChange) {
                window.VolumeControl.notifyPopupOfStatusChange();
            }

            return stateData;

        } catch (err) {
            clearSetupTimeout();
            if (!isSetupCurrent()) {
                return null;
            }
            error(`[Main] Setup failed for ${elementInfo}:`, err);
            
            stateData.transition(ElementState.ERROR, {
                errorType: err.name === 'InvalidStateError' ? 'already_captured' : 'unknown',
                errorMessage: err.message,
                retryCount: stateData.retryCount + 1
            });
            
            return null;
        }
    }

    /**
     * Clean up an element
     * @param {HTMLMediaElement} element
     * @param {Object} options
     */
    function cleanupElement(element, options = {}) {
        const { preserveListeners = false } = options;
        const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
        
        const stateManager = getElementStateManager();
        const AudioPipeline = getAudioPipeline();
        const VolumeSyncManager = getVolumeSyncManager();
        const Compressor = getCompressor();
        
        const stateData = stateManager.get(element);
        if (!stateData) {
            verbose(`[Main] No state data for ${elementInfo}, nothing to clean up`);
            return;
        }

        clearActiveElementVerification(stateData);

        log(`[Main] Cleaning up ${elementInfo}`);

        if (!stateData.isState(ElementState.CLEANUP)) {
            stateData.transition(ElementState.CLEANUP, {
                reason: preserveListeners ? 'preserve-listeners-cleanup' : 'full-cleanup'
            });
        }

        // Stop compressor monitoring
        if (Compressor) {
            Compressor.monitor.stop(element);
        }

        // Stop visibility tracking
        if (window.VolumeControl.MediaDetector?.visibility) {
            window.VolumeControl.MediaDetector.visibility.unobserve(element);
        }

        // Remove volume sync handler
        if (VolumeSyncManager) {
            VolumeSyncManager.removeVolumeChangeHandler(element, stateData);
            VolumeSyncManager.cleanup(element);
        }

        // Disconnect audio graph
        AudioPipeline.disconnectGraph({
            source: stateData.source,
            sourceStream: stateData.sourceStream,
            sourceType: stateData.sourceType,
            gainNode: stateData.gainNode,
            compressorNode: stateData.compressorNode,
            preCompressorGainNode: stateData.preCompressorGainNode,
            makeupGainNode: stateData.makeupGainNode,
            monoSplitterNode: stateData.monoSplitterNode,
            monoLeftGainNode: stateData.monoLeftGainNode,
            monoRightGainNode: stateData.monoRightGainNode,
            monoMergerNode: stateData.monoMergerNode,
            stereoPannerNode: stateData.stereoPannerNode,
            analyser: stateData.analyser
        }, elementInfo);

        // Clean up state data
        stateData.cleanup();

        // Transition to cleanup (or back to discovered if preserving)
        if (preserveListeners) {
            ensureElementState();
            // Keep listeners and re-enter DISCOVERED so setup can run again safely.
            stateData.audioContext = null;
            stateData.source = null;
            stateData.sourceStream = null;
            stateData.gainNode = null;
            stateData.compressorNode = null;
            stateData.preCompressorGainNode = null;
            stateData.makeupGainNode = null;
            stateData.monoSplitterNode = null;
            stateData.monoLeftGainNode = null;
            stateData.monoRightGainNode = null;
            stateData.monoMergerNode = null;
            stateData.stereoPannerNode = null;
            stateData.analyser = null;
            if (stateData.isState(ElementState.CLEANUP)) {
                stateData.transition(ElementState.DISCOVERED, { reason: 'preserve-listeners-resetup' });
            }
            verbose(`[Main] Preserved listeners for ${elementInfo}, state=DISCOVERED`);
        } else {
            // Remove media event listeners when fully cleaning up
            removeMediaListeners(element);
            stateManager.remove(element);
        }
    }

    /**
     * Remove media event listeners from element
     * @param {HTMLMediaElement} element
     */
    function removeMediaListeners(element) {
        if (!element._vcListenersAttached || !element._vcHandlers) {
            return;
        }

        const handlers = element._vcHandlers;
        
        if (handlers.playing) {
            element.removeEventListener('playing', handlers.playing);
        }
        if (handlers.volumechange) {
            element.removeEventListener('volumechange', handlers.volumechange);
        }
        if (handlers.loadedmetadata) {
            element.removeEventListener('loadedmetadata', handlers.loadedmetadata);
        }
        if (handlers.emptied) {
            element.removeEventListener('emptied', handlers.emptied);
        }
        if (handlers.seeked) {
            element.removeEventListener('seeked', handlers.seeked);
        }

        delete element._vcListenersAttached;
        delete element._vcHandlers;
        
        verbose(`[Main] Removed media listeners from ${element.tagName}#${element.id || 'no-id'}`);
    }

    /**
     * Handle source change (stream switch on Twitch, navigation on YouTube)
     * @param {HTMLMediaElement} element
     */
    function handleSourceChange(element) {
        const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
        log(`[Main] Source change detected for ${elementInfo}`);
        const latestSourceKey = getElementSourceKey(element);

        const stateManager = getElementStateManager();
        const stateData = stateManager.get(element);
        const State = getState();
        const VolumeController = getVolumeController();
        const VolumeSyncManager = getVolumeSyncManager();
        const AudioPipeline = getAudioPipeline();
        const SourceCapture = window.VolumeControl.SourceCapture;

        // Log full state at entry
        logDiagnostic?.('source-change-entry', {
            elementInfo,
            sourceKey: latestSourceKey,
            hasStateData: Boolean(stateData),
            state: stateData?.state ?? null,
            isActive: Boolean(stateData?.isActive?.()),
            isConnected: element.isConnected,
            paused: element.paused,
            ended: element.ended,
            seeking: element.seeking,
            currentTime: element.currentTime,
            readyState: element.readyState,
            src: element.currentSrc || element.src || 'none',
            sourceStreamPresent: Boolean(stateData?.sourceStream),
            sourceType: stateData?.sourceType ?? null,
            streamTrackCount: stateData?.sourceStream?.getAudioTracks?.()?.length ?? -1,
            streamTrackStates: stateData?.sourceStream?.getAudioTracks?.()?.map(t => ({
                id: t.id, label: t.label, kind: t.kind,
                enabled: t.enabled, readyState: t.readyState
            })),
            volume: element.volume,
            muted: element.muted,
            lastKnownSrc: stateData?.lastKnownSrc ?? null,
            corsBlocked: stateManager.isCorsBlocked(element)
        }, { threshold: 3 });

        clearActiveElementVerification(stateData);
        if (stateData && latestSourceKey) {
            stateData.lastKnownSrc = latestSourceKey;
        }
        const sourceChangeEpoch = stateData?.beginOperation?.('sourceChange', {
            invalidate: ['retry']
        }) ?? null;
        const isSourceChangeCurrent = () => {
            if (!stateData || sourceChangeEpoch === null) {
                return element.isConnected;
            }
            return isCurrentElementOperation(element, stateData, 'sourceChange', sourceChangeEpoch);
        };
        const scheduleSourceChangeTimeout = (key, delayMs, callback) => {
            if (!stateData || sourceChangeEpoch === null) {
                return setTimeout(callback, delayMs);
            }

            return scheduleElementTimeout(stateData, 'sourceChange', key, delayMs, () => {
                if (!isSourceChangeCurrent()) {
                    return;
                }
                callback();
            });
        };

        // CRITICAL: Clear any previous CORS-blocked status
        // The new source might be from a different origin or have different CORS headers
        const wasCorsBlocked = stateManager.isCorsBlocked(element);
        stateManager.clearCorsBlocked(element);
        
        // Notify popup if CORS status changed (to update the warning indicator)
        if (wasCorsBlocked && window.VolumeControl.notifyPopupOfStatusChange) {
            window.VolumeControl.notifyPopupOfStatusChange();
        }

        // CRITICAL FIX for Firefox mozCaptureStream:
        // When the video element's source changes (like track switch on YouTube Music),
        // the mozCaptureStream() itself remains valid, but we need to recreate the
        // MediaStreamAudioSourceNode because the old one may be connected to ended tracks.
        //
        // The key insight: We can create a NEW MediaStreamAudioSourceNode from the SAME stream.
        // We don't need to call mozCaptureStream() again (which would fail with InvalidStateError).
        
        if (stateData && stateData.isActive() && stateData.sourceStream && stateData.sourceType === 'mozCaptureStream') {
            log(`[Main] Firefox mozCaptureStream: recreating source node for ${elementInfo}`);
            
            // Enhanced logging
            if (logSourceChange) {
                logSourceChange({
                    phase: 'DETECTED',
                    elementInfo,
                    trigger: 'handleSourceChange for mozCaptureStream',
                    extensionVolume: State.currentVolumePercent,
                    playerVolume: (element.volume * 100).toFixed(1),
                    sourceType: stateData.sourceType
                });
            }
            
            // CRITICAL: Mark source as changing to reject all volume changes during switch
            if (VolumeSyncManager) {
                VolumeSyncManager.startSourceChange(element, sourceChangeEpoch);
            }
            
            const reconnectAudio = () => {
                log(`[Main] reconnectAudio() called for ${elementInfo}`);
                if (!isSourceChangeCurrent()) {
                    return;
                }
                
                // Guard against stale references captured before async reconnect.
                if (!element.isConnected) {
                    verbose(`[Main] ${elementInfo} detached before reconnect, aborting`);
                    if (VolumeSyncManager) {
                        VolumeSyncManager.endSourceChange(element, sourceChangeEpoch);
                    }
                    return;
                }
                const currentState = stateManager.get(element);
                if (!currentState || currentState !== stateData) {
                    verbose(`[Main] ${elementInfo} state changed before reconnect, aborting`);
                    if (VolumeSyncManager) {
                        VolumeSyncManager.endSourceChange(element, sourceChangeEpoch);
                    }
                    return;
                }
                
                // If context is gone, do a full reset instead of partial reconnect.
                if (!stateData.audioContext || stateData.audioContext.state === 'closed') {
                    warn(`[Main] ${elementInfo} AudioContext closed, triggering full reset`);
                    if (VolumeSyncManager) {
                        VolumeSyncManager.endSourceChange(element, sourceChangeEpoch);
                    }
                    cleanupElement(element);
                    setupElement(element, { fromPlayingEvent: true });
                    return;
                }
                
                // === Release dead stream + get a FRESH mozCaptureStream ===
                // Firefox permanently mutes mozCaptureStream tracks when the
                // element switches sources.  The old stream is dead — we must
                // release it (track.stop()) and then call mozCaptureStream()
                // again for a brand-new stream with live audio.
                if (stateData.sourceStream) {
                    SourceCapture.releaseSource(stateData.sourceStream, stateData.sourceType, elementInfo);
                    stateData.sourceStream = null;
                }
                if (stateData.source) {
                    try {
                        stateData.source.disconnect();
                    } catch (e) { /* ignore */ }
                    stateData.source = null;
                }

                const freshResult = SourceCapture.refreshMozCaptureStream(
                    element,
                    stateData.audioContext,
                    elementInfo
                );

                if (freshResult.error || !freshResult.source) {
                    warn(`[Main] Failed to refresh mozCaptureStream for ${elementInfo}: ${freshResult.error?.message || 'no source'}`);
                    if (VolumeSyncManager) {
                        VolumeSyncManager.endSourceChange(element, sourceChangeEpoch);
                    }
                    if (freshResult.isTemporary) {
                        verbose(`[Main] Refresh temporary (no tracks yet). Forcing full reset and polling retry...`);
                        cleanupElement(element, { preserveListeners: true });
                        setTimeout(() => {
                            if (element.isConnected) setupElement(element, { isResetup: true, fromPlayingEvent: false });
                        }, 250);
                    } else {
                        // Fall back to native-only
                        VolumeController.applyNativeVolumeOnly(element, State.currentVolumePercent);
                        VolumeController.applyMute(element, getDesiredMuteStateForElement(element, stateData));
                    }
                    return;
                }

                // Build fresh audio nodes from the new stream
                const freshNodes = AudioPipeline.createAudioNodes(stateData.audioContext, freshResult, {
                    threshold: State.currentCompressionThreshold,
                    ratio: State.currentCompressionRatio,
                    knee: State.currentCompressionKnee
                });

                // Store all new node references in state
                Object.assign(stateData, {
                    source: freshNodes.source,
                    sourceStream: freshNodes.sourceStream,
                    sourceType: freshNodes.sourceType,
                    gainNode: freshNodes.gainNode,
                    compressorNode: freshNodes.compressorNode,
                    preCompressorGainNode: freshNodes.preCompressorGainNode,
                    makeupGainNode: freshNodes.makeupGainNode,
                    monoSplitterNode: freshNodes.monoSplitterNode,
                    monoLeftGainNode: freshNodes.monoLeftGainNode,
                    monoRightGainNode: freshNodes.monoRightGainNode,
                    monoMergerNode: freshNodes.monoMergerNode,
                    stereoPannerNode: freshNodes.stereoPannerNode,
                    analyser: freshNodes.analyser,
                    passthroughMode: false
                });

                logDiagnostic?.('source-change-refresh', {
                    elementInfo,
                    success: true,
                    freshStreamTrackCount: freshNodes.sourceStream?.getAudioTracks?.()?.length ?? -1,
                    freshStreamTrackStates: freshNodes.sourceStream?.getAudioTracks?.()?.map(t => ({
                        id: t.id, label: t.label, kind: t.kind,
                        enabled: t.enabled, readyState: t.readyState
                    })),
                    audioContextState: stateData.audioContext?.state ?? 'none'
                }, { threshold: 3 });

                stateData.lastKnownSrc = latestSourceKey || stateData.lastKnownSrc;
                
                // Reconnect the audio graph
                const reconnectNodes = {
                    source: stateData.source,
                    gainNode: stateData.gainNode,
                    compressorNode: stateData.compressorNode,
                    preCompressorGainNode: stateData.preCompressorGainNode,
                    makeupGainNode: stateData.makeupGainNode,
                    monoSplitterNode: stateData.monoSplitterNode,
                    monoLeftGainNode: stateData.monoLeftGainNode,
                    monoRightGainNode: stateData.monoRightGainNode,
                    monoMergerNode: stateData.monoMergerNode,
                    stereoPannerNode: stateData.stereoPannerNode,
                    analyser: stateData.analyser
                };

                if (State.extensionEnabled === false || stateData.passthroughMode) {
                    syncUnownedMuteStateFromElement(element, stateData, {
                        updateManagedState: true,
                        commitToRestore: true
                    });
                    AudioPipeline.connectPassthrough(reconnectNodes, stateData.audioContext);
                    restoreElementNativeState(element, stateData);
                    stateData.passthroughMode = true;
                } else {
                    AudioPipeline.connectGraph(reconnectNodes, stateData.audioContext, getEffectiveProcessingOptions());
                    stateData.passthroughMode = false;
                }

                if (!stateData.passthroughMode) {
                    AudioPipeline.updateAudioSettings({
                        stereoPannerNode: stateData.stereoPannerNode
                    }, stateData.audioContext, {
                        balance: State.currentBalance
                    });
                    stateData.lastAppliedMonoEnabled = State.currentMonoEnabled;
                    stateData.lastAppliedBalance = State.currentBalance;
                }
                
                // Re-apply the full effective extension volume state after reconnect.
                // Gain-only restore can leave sub-100 and 0-to-non-zero recovery broken.
                if (!stateData.passthroughMode && State.volumeHasBeenSet && stateData.gainNode) {
                    log(`[Main] Re-applying full volume state ${State.currentVolumePercent}% after source reconnect`);
                    
                    if (logVolumeApply) {
                        logVolumeApply({
                            source: 'handleSourceChange/reconnectAudio',
                            elementInfo,
                            targetVolume: State.currentVolumePercent,
                            previousVolume: 'N/A (reconnect)',
                            method: 'applyVolume',
                            willSetNativeVolume: true,
                            gainMultiplier: State.currentVolumePercent <= 100 ? 1.0 : State.currentVolumePercent / 100
                        });
                    }
                    
                    if (VolumeSyncManager) {
                        VolumeSyncManager.startApplyingVolume(element, State.currentVolumePercent);
                    }
                    VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true, source: 'source-reconnect' });
                    syncUnownedMuteStateFromElement(element, stateData, {
                        updateManagedState: true,
                        commitToRestore: true
                    });
                    VolumeController.applyMute(element, getDesiredMuteStateForElement(element, stateData));
                }

                if (window.VolumeControl.notifyPopupOfStatusChange) {
                    window.VolumeControl.notifyPopupOfStatusChange();
                }
                
                log(`[Main] Successfully reconnected audio for ${elementInfo}`);
                
                // Enhanced logging
                if (logSourceChange) {
                    logSourceChange({
                        phase: 'RECONNECTED',
                        elementInfo,
                        trigger: 'Audio graph reconnected',
                        extensionVolume: State.currentVolumePercent,
                        playerVolume: (element.volume * 100).toFixed(1),
                        protectionEndsIn: '1000ms'
                    });
                }
                
                // End source change protection after a delay to catch any late volume changes
                // Use 1000ms to give YouTube Music and similar sites time to settle
                scheduleSourceChangeTimeout('protection-end', 1000, () => {
                    if (VolumeSyncManager) {
                        VolumeSyncManager.endSourceChange(element, sourceChangeEpoch);
                    }

                    resetActiveVerificationState(stateData, element.currentTime, false);
                    scheduleActiveElementVerification(element, stateData);
                });
            };
            
            // Wait for the new media to be ready, then reconnect
            // Using a small delay to let the new source settle
            const waitForNewSource = () => {
                if (!isSourceChangeCurrent()) {
                    return;
                }
                // Check if element has a new valid source
                const newSrc = getElementSourceKey(element);
                if (newSrc) {
                    scheduleSourceChangeTimeout('reconnect', 100, reconnectAudio);
                } else {
                    // Wait for loadeddata event
                    element.addEventListener('loadeddata', () => {
                        if (!isSourceChangeCurrent()) {
                            return;
                        }
                        scheduleSourceChangeTimeout('reconnect', 50, reconnectAudio);
                    }, { once: true });
                }
            };
            
            // If already playing, reconnect now; otherwise wait
            if (!element.paused && element.currentTime > 0) {
                scheduleSourceChangeTimeout('reconnect', 100, reconnectAudio);
            } else {
                element.addEventListener('playing', () => {
                    if (!isSourceChangeCurrent()) {
                        return;
                    }
                    scheduleSourceChangeTimeout('reconnect', 50, reconnectAudio);
                }, { once: true });
                
                // Also try on loadeddata in case playing doesn't fire
                element.addEventListener('loadeddata', waitForNewSource, { once: true });
            }
            return;
        }
        
        // For non-Firefox or elements without active mozCaptureStream pipeline
        if (stateData && stateData.isActive() && stateData.gainNode) {
            if (State.extensionEnabled === false || stateData.passthroughMode) {
                syncUnownedMuteStateFromElement(element, stateData, {
                    updateManagedState: true,
                    commitToRestore: true
                });
                restoreElementNativeState(element, stateData);
                if (window.VolumeControl.notifyPopupOfStatusChange) {
                    window.VolumeControl.notifyPopupOfStatusChange();
                }
                return;
            }

            log(`[Main] Keeping audio pipeline alive for ${elementInfo}, will re-apply volume on play`);
            
            // CRITICAL: Mark source as changing to reject all volume changes during switch
            if (VolumeSyncManager) {
                VolumeSyncManager.startSourceChange(element, sourceChangeEpoch);
            }
            
            // Schedule volume re-application when playing starts
            const reapplyOnPlay = () => {
                if (!isSourceChangeCurrent()) {
                    return;
                }
                // Guard against stale element/state references before applying.
                if (!element.isConnected) return;
                const currentState = stateManager.get(element);
                if (!currentState || currentState !== stateData) return;
                
                if (State.volumeHasBeenSet && stateData.gainNode) {
                    log(`[Main] Re-applying volume ${State.currentVolumePercent}% after source change`);
                    if (VolumeSyncManager) {
                        VolumeSyncManager.startApplyingVolume(element, State.currentVolumePercent);
                    }
                    VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true });
                    syncUnownedMuteStateFromElement(element, stateData, {
                        updateManagedState: true,
                        commitToRestore: true
                    });
                    VolumeController.applyMute(element, getDesiredMuteStateForElement(element, stateData));

                    if (window.VolumeControl.notifyPopupOfStatusChange) {
                        window.VolumeControl.notifyPopupOfStatusChange();
                    }
                    
                    // End source change protection after a delay
                    scheduleSourceChangeTimeout('reapply-end', 500, () => {
                        if (VolumeSyncManager) {
                            VolumeSyncManager.endSourceChange(element, sourceChangeEpoch);
                        }

                        resetActiveVerificationState(stateData, element.currentTime, false);
                        scheduleActiveElementVerification(element, stateData);
                    });
                }
                element.removeEventListener('playing', reapplyOnPlay);
            };
            
            element.addEventListener('playing', reapplyOnPlay, { once: true });
            return;
        }

        // If no active pipeline, do full cleanup and re-setup
        cleanupElement(element, { preserveListeners: true });
        if (stateData && latestSourceKey) {
            stateData.lastKnownSrc = latestSourceKey;
        }
        const retryEpoch = stateData?.beginOperation?.('retry') ?? null;
        const isRetryCurrent = () => {
            if (!stateData || retryEpoch === null) {
                return element.isConnected;
            }
            return isCurrentElementOperation(element, stateData, 'retry', retryEpoch);
        };
        const scheduleRetryTimeout = (key, delayMs, callback) => {
            if (!stateData || retryEpoch === null) {
                return setTimeout(callback, delayMs);
            }

            return scheduleElementTimeout(stateData, 'retry', key, delayMs, () => {
                if (!isRetryCurrent()) {
                    return;
                }
                callback();
            });
        };

        // Schedule re-setup attempts
        const attemptResetup = async (attemptNumber = 1) => {
            const stateManager = getElementStateManager();
            if (!isRetryCurrent()) return false;
            
            // Abort retries if the element has already been detached.
            if (!element.isConnected) return false;
            
            // Check if already re-setup
            const currentState = stateManager.get(element);
            if (currentState && currentState.isActive()) {
                return true;
            }

            // Check if ready
            
            // For re-setup, be more lenient - currentTime may be 0 if media just started
            // By the 3rd attempt, require currentTime > 0 for certainty
            const requireCurrentTime = attemptNumber >= 3;
            const isPlaying = !element.paused && !element.ended && 
                (!requireCurrentTime || element.currentTime > 0);
            if (isPlaying) {
                const result = await setupElement(element, { isResetup: true, fromPlayingEvent: true });
                return !!result;
            }
            return false;
        };

        // Try immediately
        queueMicrotask(async () => {
            if (!isRetryCurrent()) {
                return;
            }
            if (await attemptResetup(1)) {
                log(`[Main] Immediate re-setup successful for ${elementInfo}`);
                return;
            }

            // Retry after 200ms
            scheduleRetryTimeout('attempt-2', 200, async () => {
                if (await attemptResetup(2)) {
                    log(`[Main] Delayed re-setup (200ms) successful for ${elementInfo}`);
                    return;
                }

                // Retry after 800ms more
                scheduleRetryTimeout('attempt-3', 600, async () => {
                    if (await attemptResetup(3)) {
                        log(`[Main] Delayed re-setup (800ms) successful for ${elementInfo}`);
                    }
                });
            });
        });
    }

    /**
     * Handle element discovered by detector
     * @param {HTMLMediaElement} element
     * @param {string} source
     */
    function handleElementDiscovered(element, source) {
        const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
        verbose(`[Main] Element discovered: ${elementInfo} (via ${source})`);

        const stateManager = getElementStateManager();
        const stateData = stateManager.get(element);
        const sourceKey = getElementSourceKey(element);

        // Attach media event listeners (safe even for off-DOM elements;
        // they become active once the element is connected).
        attachMediaListeners(element);

        // === play-interception: Best-effort setup for off-DOM elements ===
        // When discovered via the play() monkey-patch, the element IS in a
        // playing state even though it may be disconnected from the DOM
        // (e.g. Bandcamp's `new Audio(url)` + play()).  We call setupElement
        // immediately — it will bail out early if the element has no valid
        // source, is not actually playing, or is not connected and has no
        // source.  This path is harmless for already-connected elements.
        if (source === 'play-interception') {
            verbose(`[Main] ${elementInfo}: play-interception detected, attempting setup`);
            setupElement(element, { fromPlayingEvent: true, allowDisconnected: true });
            return;
        }

        // Skip short-lived elements that are already detached.
        if (!element.isConnected) {
            verbose(`[Main] ${elementInfo} already detached on discovery, skipping`);
            return;
        }

        if (source === 'attribute-change' && stateData && stateData.lastKnownSrc && sourceKey && stateData.lastKnownSrc !== sourceKey) {
            verbose(`[Main] Source mutation detected for ${elementInfo}, reconnecting`);
            handleSourceChange(element);
            return;
        }

        // Try setup immediately for elements that are already in playback state.
        const isPlaying = isElementPotentiallyPlaying(element);
        if (isPlaying) {
            setupElement(element, { fromPlayingEvent: true });
        } else if (element.seeking && hasUsableMediaSource(element)) {
            // Element is seeking (DASH quality switch / DOM replacement).
            // Attach one-time 'playing' listener so setup runs when seek
            // completes AND the element resumes playback.
            verbose(`[Main] ${elementInfo} discovered while seeking — will retry on 'playing'`);
            const retryOnPlay = () => {
                element.removeEventListener('playing', retryOnPlay);
                setupElement(element, { fromPlayingEvent: true });
            };
            element.addEventListener('playing', retryOnPlay, { once: true });
        }
    }

    function refreshDetectedMediaState(mediaElements = null, source = 'manual-refresh') {
        ensureElementState();

        const stateManager = getElementStateManager();
        const elements = Array.isArray(mediaElements) ? mediaElements : getDetectableMediaElements();

        elements.forEach((element) => {
            if (!element?.isConnected) {
                return;
            }

            const stateData = stateManager.get(element);
            if (!stateData) {
                handleElementDiscovered(element, source);
                return;
            }

            if (stateData.isState(ElementState.SETTING_UP) || stateData.isState(ElementState.CLEANUP)) {
                return;
            }

            const latestSourceKey = getElementSourceKey(element);
            if (stateData.lastKnownSrc && latestSourceKey && stateData.lastKnownSrc !== latestSourceKey) {
                handleSourceChange(element);
                return;
            }

            if (hasUsableMediaSource(element) && isElementPotentiallyPlaying(element)) {
                setupElement(element, { fromPlayingEvent: true });
            }
        });
    }

    /**
     * Handle element removed
     * @param {HTMLMediaElement} element
     * @param {string} source
     */
    function handleElementRemoved(element, source) {
        const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
        
        // Check if still playing (detached playback)
        const isPlaying = !element.paused && !element.ended && element.currentTime > 0;
        if (isPlaying) {
            verbose(`[Main] Element removed but still playing: ${elementInfo}`);
            return; // Keep audio graph active
        }

        cleanupElement(element);
    }

    /**
     * Attach media event listeners to element
     * @param {HTMLMediaElement} element
     */
    function attachMediaListeners(element) {
        if (element._vcListenersAttached) return;

        const State = getState();
        const VolumeController = getVolumeController();
        const stateManager = getElementStateManager();
        const VolumeSyncManager = getVolumeSyncManager();

        const handlers = {
            playing: () => {
                verbose(`[Main] 'playing' event on ${element.tagName}#${element.id || 'no-id'}`);
                setupElement(element, { fromPlayingEvent: true });
            },
            volumechange: () => {
                const currentStateData = stateManager.get(element);
                const isCorsBlocked = stateManager.isCorsBlocked(element);
                const isPassthrough = Boolean(currentStateData?.passthroughMode);
                const hasManagedNodes = Boolean(currentStateData?.gainNode || currentStateData?.source);
                const shouldPassivelyTrackNativeOnly = State.extensionEnabled === false || isPassthrough;
                const shouldProtectBoostedTarget = State.extensionEnabled !== false &&
                    !shouldPassivelyTrackNativeOnly &&
                    State.volumeHasBeenSet &&
                    State.currentVolumePercent > DEFAULT_VOLUME;

                if (currentStateData?.isTransitioning?.()) {
                    return;
                }

                if (isCorsBlocked && !shouldPassivelyTrackNativeOnly) {
                    return;
                }

                if (currentStateData?.isActive?.() && !isPassthrough) {
                    return;
                }

                if (hasManagedNodes && !isPassthrough) {
                    return;
                }

                if (!hasUsableMediaSource(element)) {
                    return;
                }

                const nextVolume = Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round((Number.isFinite(element.volume) ? element.volume : 1) * DEFAULT_VOLUME)));
                const nextMuted = Boolean(element.muted);
                const previousNativeVolume = currentStateData?.observedNativeVolume;
                const previousNativeMuted = currentStateData?.observedNativeMutedState;
                const canDriveSharedState = canElementDriveSharedState(element);

                if (shouldPassivelyTrackNativeOnly) {
                    if (currentStateData) {
                        observeElementNativeState(element, currentStateData, { commitToRestore: true });
                    }

                    const nativeVolumeChanged = !Number.isFinite(previousNativeVolume) || Math.abs(previousNativeVolume - element.volume) > 0.001;
                    const nativeMuteChanged = previousNativeMuted !== nextMuted;

                    if ((nativeVolumeChanged || nativeMuteChanged) && window.VolumeControl.notifyPopupOfStatusChange) {
                        window.VolumeControl.notifyPopupOfStatusChange();
                    }
                    return;
                }

                if (!canDriveSharedState) {
                    if (currentStateData) {
                        observeElementNativeState(element, currentStateData, { commitToRestore: false });
                    }
                    return;
                }

                const volumeChanged = State.currentVolumePercent !== nextVolume;
                const desiredMuteState = getDesiredMuteStateForElement(element, currentStateData);
                const muteChanged = desiredMuteState !== nextMuted;

                if (shouldProtectBoostedTarget) {
                    if (currentStateData) {
                        observeElementNativeState(element, currentStateData, { commitToRestore: false });
                    }

                    if (muteChanged) {
                        State.currentMutedState = nextMuted;

                        if (currentStateData) {
                            currentStateData.nativeMutedSnapshot = nextMuted;
                            currentStateData.userOriginalMutedState = nextMuted;
                        }

                        if (window.VolumeControl.notifyPopupOfStatusChange) {
                            window.VolumeControl.notifyPopupOfStatusChange();
                        }
                    }
                    return;
                }

                if (!volumeChanged && !muteChanged && State.volumeHasBeenSet) {
                    if (currentStateData) {
                        observeElementNativeState(element, currentStateData, { commitToRestore: false });
                    }
                    return;
                }

                State.currentVolumePercent = nextVolume;
                State.currentMutedState = nextMuted;
                State.volumeHasBeenSet = true;

                if (currentStateData) {
                    observeElementNativeState(element, currentStateData, { commitToRestore: true });
                }

                if (window.VolumeControl.notifyPopupOfStatusChange) {
                    window.VolumeControl.notifyPopupOfStatusChange();
                }
            },
            loadedmetadata: () => {
                const stateData = stateManager.get(element);
                const latestSourceKey = getElementSourceKey(element);

                if (stateData?.isActive?.() && hasUsableMediaSource(element)) {
                    verbose(`[Main] 'loadedmetadata' refreshing active media on ${element.tagName}#${element.id || 'no-id'}`);
                    handleSourceChange(element);
                    return;
                }

                if (stateData?.lastKnownSrc && latestSourceKey && stateData.lastKnownSrc !== latestSourceKey) {
                    verbose(`[Main] 'loadedmetadata' detected source change on ${element.tagName}#${element.id || 'no-id'}`);
                    handleSourceChange(element);
                    return;
                }

                if (hasUsableMediaSource(element)) {
                    setupElement(element, { fromPlayingEvent: isElementPotentiallyPlaying(element) });
                }
            },
            emptied: () => {
                verbose(`[Main] 'emptied' event on ${element.tagName}#${element.id || 'no-id'}`);
                const sd = stateManager.get(element);
                if (sd && sd.isActive()) {
                    logDiagnostic?.('emptied-state', {
                        elementInfo: `${element.tagName}#${element.id || 'no-id'}`,
                        state: sd.state,
                        sourceType: sd.sourceType,
                        hasStream: Boolean(sd.sourceStream),
                        hasSource: Boolean(sd.source),
                        streamHasTracks: sd.sourceStream?.getAudioTracks?.()?.length ?? -1,
                        isConnected: element.isConnected,
                        paused: element.paused,
                        currentTime: element.currentTime,
                        readyState: element.readyState,
                        src: element.currentSrc || element.src || 'none',
                        elementExists: Boolean(element)
                    });
                } else {
                    logDiagnostic?.('emptied-no-state', {
                        elementInfo: `${element.tagName}#${element.id || 'no-id'}`,
                        isConnected: element.isConnected,
                        paused: element.paused,
                        currentTime: element.currentTime,
                        readyState: element.readyState,
                        src: element.currentSrc || element.src || 'none'
                    });
                }
                handleSourceChange(element);
            },
            // Re-apply extension volume after seek completes - but only if needed
            // Sites like YouTube may try to restore their volume on seek
            seeked: () => {
                const stateData = stateManager.get(element);
                if (stateData && stateData.isActive() && stateData.gainNode && State.volumeHasBeenSet) {
                    const desiredMuteState = getDesiredMuteStateForElement(element, stateData);
                    if (element.muted !== desiredMuteState) {
                        VolumeController.applyMute(element, desiredMuteState);
                    }

                    // Only re-apply if the element's volume has drifted from what we expect
                    // This prevents unnecessary conflicts with site players
                    const currentPlayerVolume = Math.round(element.volume * 100);
                    const expectedNative = Math.min(100, State.currentVolumePercent);
                    const volumeDiff = Math.abs(currentPlayerVolume - expectedNative);
                    
                    // Only re-apply if volume has actually changed (>2% difference)
                    if (volumeDiff > 2) {
                        verbose(`[Main] 'seeked' event - volume drift detected (${currentPlayerVolume}% vs expected ${expectedNative}%), re-applying ${State.currentVolumePercent}%`);
                        // Mark that we're applying to prevent feedback loop
                        if (VolumeSyncManager) {
                            VolumeSyncManager.startApplyingVolume(element, State.currentVolumePercent);
                        }
                        VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true });
                    } else {
                        verbose(`[Main] 'seeked' event - volume unchanged (${currentPlayerVolume}%), no re-apply needed`);
                    }
                }
            }
        };

        element.addEventListener('playing', handlers.playing);
        element.addEventListener('volumechange', handlers.volumechange);
        element.addEventListener('loadedmetadata', handlers.loadedmetadata);
        element.addEventListener('emptied', handlers.emptied);
        element.addEventListener('seeked', handlers.seeked);
        
        element._vcListenersAttached = true;
        element._vcHandlers = handlers;
    }

    /**
     * Update volume for all active elements
     * @param {number} volumePercent
     */
    function updateAllVolume(volumePercent) {
        const stateManager = getElementStateManager();
        const State = getState();
        const VolumeController = getVolumeController();
        const VolumeSyncManager = getVolumeSyncManager();

        State.currentVolumePercent = volumePercent;
        
        // Mark that user has explicitly set a volume
        // This prevents future track changes from adopting player volume
        State.volumeHasBeenSet = true;

        window.VolumeControl.scheduleStorageWrite(
            window.VolumeControl.SESSION_STORAGE_KEY_VOLUME,
            volumePercent.toString()
        );

        if (State.extensionEnabled === false) {
            log(`[Main] Saved volume ${volumePercent}% while extension sound control is disabled`);
            return;
        }
        
        let activeCount = 0;
        let corsCount = 0;
        
        // Apply to all ACTIVE elements (with full audio graph)
        stateManager.elements.forEach((stateData, element) => {
            if (stateData.isActive()) {
                // CRITICAL: Mark that we're applying volume BEFORE setting it
                // This prevents the volumechange event from being misinterpreted
                // as a user action (especially when going from <100% to >100%)
                if (VolumeSyncManager) {
                    VolumeSyncManager.startApplyingVolume(element, volumePercent);
                }
                // If the element has a gain node, use the full audio graph.
                // Otherwise (native-only fallback after mozCaptureStream died),
                // use the native-volume-only path.
                if (stateData.gainNode) {
                    VolumeController.applyVolume(element, stateData, volumePercent);
                } else {
                    VolumeController.applyNativeVolumeOnly(element, volumePercent);
                }
                activeCount++;
            }
        });
        
        // CRITICAL FIX: Also apply native volume to CORS-blocked elements
        // CORS-blocked elements can't use GainNode (no audio capture), but they CAN
        // still have their native element.volume adjusted directly.
        // The underlying player/browser decides whether values above 100% are honoured or clamped.
        stateManager.corsElements.forEach(element => {
            // applyNativeVolumeOnly works on both connected and disconnected
            // elements (it sets element.volume, which is independent of DOM).
            if (VolumeSyncManager) {
                VolumeSyncManager.startApplyingVolume(element, volumePercent);
            }
            VolumeController.applyNativeVolumeOnly(element, volumePercent);
            corsCount++;
        });

        log(`[Main] Updated volume to ${volumePercent}% on ${activeCount} active + ${corsCount} CORS-blocked elements`);
    }

    /**
     * Update compression settings for all active elements
     * @param {Object} settings
     */
    function updateAllCompression(settings) {
        const stateManager = getElementStateManager();
        const State = getState();
        const AudioPipeline = getAudioPipeline();
        const Compressor = getCompressor();
        const mergedSettings = {
            enabled: State.currentCompressionEnabled,
            threshold: State.currentCompressionThreshold,
            ratio: State.currentCompressionRatio,
            knee: State.currentCompressionKnee,
            ...(settings || {})
        };
        const validatedSettings = Compressor?.validateSettings
            ? Compressor.validateSettings(mergedSettings)
            : mergedSettings;

        // Update state
        State.currentCompressionEnabled = validatedSettings.enabled;
        State.currentCompressionThreshold = validatedSettings.threshold;
        State.currentCompressionRatio = validatedSettings.ratio;
        State.currentCompressionKnee = validatedSettings.knee;
        State.compressionHasBeenSet = true;

        persistCompressionSettings();

        if (State.extensionEnabled === false) {
            log(`[Main] Saved compression settings while extension sound control is disabled`);
            return;
        }

        // Apply to all active elements
        stateManager.elements.forEach((stateData, element) => {
            if (stateData.isActive() && stateData.audioContext) {
                // Update compressor settings
                if (Compressor) {
                    Compressor.applySettings(
                        stateData.compressorNode,
                        stateData.makeupGainNode,
                        stateData.audioContext,
                        validatedSettings
                    );
                }

                // Reconnect graph with new enabled state
                AudioPipeline.connectGraph({
                    source: stateData.source,
                    gainNode: stateData.gainNode,
                    compressorNode: stateData.compressorNode,
                    preCompressorGainNode: stateData.preCompressorGainNode,
                    makeupGainNode: stateData.makeupGainNode,
                    monoSplitterNode: stateData.monoSplitterNode,
                    monoLeftGainNode: stateData.monoLeftGainNode,
                    monoRightGainNode: stateData.monoRightGainNode,
                    monoMergerNode: stateData.monoMergerNode,
                    stereoPannerNode: stateData.stereoPannerNode,
                    analyser: stateData.analyser
                }, stateData.audioContext, {
                    compressionEnabled: validatedSettings.enabled,
                    monoEnabled: State.currentMonoEnabled,
                    balance: State.currentBalance
                });

                AudioPipeline.updateAudioSettings({
                    stereoPannerNode: stateData.stereoPannerNode
                }, stateData.audioContext, {
                    balance: State.currentBalance
                });

                // Start/stop monitoring
                if (validatedSettings.enabled) {
                    Compressor?.monitor.start(element, stateData);
                } else {
                    Compressor?.monitor.stop(element);
                }
            }
        });

        log(`[Main] Updated compression: enabled=${validatedSettings.enabled}`);
    }

    /**
     * Update mono and balance settings for all active elements
     * @param {Object} settings
     */
    function updateAllAudioSettings(settings) {
        const State = getState();
        const normalizedSettings = Protocol.normalizeAudioSettings(settings, { partial: true });
        const nextMonoEnabled = Object.prototype.hasOwnProperty.call(normalizedSettings, 'monoEnabled')
            ? normalizedSettings.monoEnabled
            : State.currentMonoEnabled;
        if (Object.prototype.hasOwnProperty.call(normalizedSettings, 'monoEnabled')) {
            State.monoHasBeenSet = true;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedSettings, 'balance')) {
            State.localBalance = normalizedSettings.balance;
            State.balanceHasBeenSet = true;
        }

        const nextBalance = resolveEffectiveBalance();
        const result = applyResolvedAudioSettings({
            monoEnabled: nextMonoEnabled,
            balance: nextBalance
        });

        persistAudioSettings();
        return result;
    }

    function updateAllMute(muted) {
        const stateManager = getElementStateManager();
        const State = getState();
        const VolumeController = getVolumeController();

        State.currentMutedState = Boolean(muted);
        State.muteHasBeenSet = true;

        if (State.extensionEnabled === false) {
            log(`[Main] Saved mute state while extension sound control is disabled: muted=${State.currentMutedState}`);
            return;
        }

        stateManager.elements.forEach((stateData, element) => {
            if (stateData.isActive()) {
                VolumeController.applyMute(element, State.currentMutedState);
            }
        });

        stateManager.corsElements.forEach((element) => {
            VolumeController.applyMute(element, State.currentMutedState);
        });

        log(`[Main] Updated mute state: muted=${State.currentMutedState}`);
    }

    /**
     * Repair all elements after AudioContext resume
     * Called when AudioContext transitions from suspended to running
     * @returns {number} - Number of elements repaired
     */
    function repairAllElements() {
        const stateManager = getElementStateManager();
        const State = getState();
        const VolumeController = getVolumeController();
        const Compressor = getCompressor();
        const AudioPipeline = getAudioPipeline();
        
        let repairedCount = 0;
        
        stateManager.elements.forEach((stateData, element) => {
            if (!stateData.isActive()) return;
            if (!stateData.needsConnectionVerification) return;
            
            const isPlaying = !element.paused && !element.ended && element.currentTime > 0;
            if (!isPlaying) return;
            
            const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
            log(`[Main] Repairing element after AudioContext resume: ${elementInfo}`);
            if (logDiagnostic) {
                logDiagnostic('resume-repair', {
                    elementInfo,
                    currentVolumePercent: State.currentVolumePercent,
                    currentMutedState: State.currentMutedState,
                    muteHasBeenSet: State.muteHasBeenSet,
                    managedMutedState: stateData.managedMutedState,
                    needsConnectionVerification: stateData.needsConnectionVerification,
                    consecutiveVerificationFailures: stateData.consecutiveVerificationFailures
                }, { threshold: 3 });
            }
            
            // Re-apply compression settings
            if (Compressor && stateData.compressorNode) {
                Compressor.applySettings(
                    stateData.compressorNode,
                    stateData.makeupGainNode,
                    stateData.audioContext,
                    {
                        enabled: State.currentCompressionEnabled,
                        threshold: State.currentCompressionThreshold,
                        ratio: State.currentCompressionRatio,
                        knee: State.currentCompressionKnee
                    }
                );
            }
            
            // Re-apply volume
            VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true });
            VolumeController.applyMute(element, getDesiredMuteStateForElement(element, stateData));
            AudioPipeline.updateAudioSettings({
                stereoPannerNode: stateData.stereoPannerNode
            }, stateData.audioContext, {
                balance: State.currentBalance
            });
            stateData.lastAppliedMonoEnabled = State.currentMonoEnabled;
            stateData.lastAppliedBalance = State.currentBalance;
            
            stateData.needsConnectionVerification = false;
            resetActiveVerificationState(stateData, element.currentTime, false);
            scheduleActiveElementVerification(element, stateData);
            repairedCount++;
        });
        
        return repairedCount;
    }

    /**
     * Initialize the extension
     */
    function initialize() {
        log('[Main] Initializing Volume Control Extension');

        const MediaDetector = getMediaDetector();
        const State = getState();

        // Start media detection
        if (MediaDetector) {
            MediaDetector.start(handleElementDiscovered, handleElementRemoved);
        }

        // Start visibility tracking
        if (MediaDetector?.visibility) {
            MediaDetector.visibility.start((element, isVisible) => {
                const stateManager = getElementStateManager();
                const VolumeSyncManager = getVolumeSyncManager();
                const stateData = stateManager.get(element);
                if (stateData) {
                    stateData.isIntersecting = isVisible;
                    verbose(`[Main] Visibility changed: ${element.tagName}#${element.id || 'no-id'} = ${isVisible}`);
                    
                    // Mark visibility change for grace period handling
                    // This allows sites to restore volume after user scrolls back
                    if (VolumeSyncManager) {
                        VolumeSyncManager.markVisibilityChange(element, isVisible);
                    }
                }
            });
        }

        log('[Main] Initialization complete');
        
        // Send initial status update to update the badge with loaded volume
        // Use a small delay to ensure storage is loaded and state is ready
        setTimeout(() => {
            if (window.VolumeControl.notifyPopupOfStatusChange) {
                window.VolumeControl.notifyPopupOfStatusChange();
            }
        }, 100);
    }

    // Export Main API
    window.VolumeControl.Main = {
        initialize,
        setupElement,
        cleanupElement,
        handleSourceChange,
        refreshDetectedMediaState,
        updateAllVolume,
        updateAllMute,
        updateAllCompression,
        updateAllAudioSettings,
        applyGlobalBalanceSettings,
        getAudioSettingsAvailability,
        setExtensionEnabled,
        attachMediaListeners,
        repairAllElements
    };

})();
