/**
 * Main Entry Point - Volume Control Extension
 * Orchestrates all modules and handles initialization.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.Main = {};

(function() {
    const { log, warn, error, verbose, logSourceChange, logVolumeApply, logDiagnostic, stateChange } = window.VolumeControl;
    const {
        SETUP_TIMEOUT_MS,
        DEFAULT_VOLUME,
        DEFAULT_MONO_ENABLED,
        DEFAULT_BALANCE,
        MIN_VOLUME,
        MAX_VOLUME
    } = window.VolumeControl;
    const Protocol = globalThis.VCProtocol;
    const ACTIVE_VERIFICATION_INTERVAL_MS = 4000;
    const ACTIVE_VERIFICATION_GRACE_MS = 3000;
    const ACTIVE_VERIFICATION_FAILURES_BEFORE_RESET = 3;
    const DETACHED_PLAYBACK_GRACE_MS = 15000;
    const CAPTURE_RECOVERY_MIN_INTERVAL_MS = 1000;
    const CAPTURE_RECOVERY_MAX_ATTEMPTS = 5;
    const CAPTURE_RECOVERY_DELAY_MS = 1500;
    const TEMP_SOURCE_MAX_RETRIES = 20;
    // After the fast chain (about 15 s) a source that is still not ready keeps a slow, bounded
    // tail, so a live stream that recreates its `<video>` on an ad, quality or channel change and
    // stays unready for a while is not left in ERROR until some unrelated event arrives.
    const TEMP_SOURCE_SLOW_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 10000, 30000, 60000]);

    function getTempSourceRetryDelay(retries) {
        if (retries < TEMP_SOURCE_MAX_RETRIES) {
            return Math.min(1000, 100 * Math.pow(1.5, retries));
        }
        const tailIndex = retries - TEMP_SOURCE_MAX_RETRIES;
        return tailIndex < TEMP_SOURCE_SLOW_RETRY_DELAYS_MS.length
            ? TEMP_SOURCE_SLOW_RETRY_DELAYS_MS[tailIndex]
            : null;
    }
    // A capture that was really lost (the element ended native-only through
    // `enterNativeOnlyAfterCaptureLoss`) is revisited on this schedule. The timer chain ends
    // after the last entry; a `playing` event keeps revisiting at the last entry's pace, so a
    // healthy page always finds its way back and a failing one never loops by itself.
    const NATIVE_ONLY_REVISIT_DELAYS_MS = Object.freeze([15000, 60000, 180000, 300000]);

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

    // Firefox allows createMediaElementSource only once per element, and a captured
    // element is audible only through that node. Keyed weakly so removed elements can
    // still be garbage collected.
    const retainedMediaElementSources = new WeakMap();

    /**
     * Keep a released MediaElementSource for the next setup of the same element.
     * With `audible`, route it straight to the destination until then.
     */
    function retainMediaElementSource(element, source, audioContext, options = {}) {
        if (!element || !source) {
            return;
        }
        retainedMediaElementSources.set(element, source);
        if (options.audible !== true) {
            return;
        }
        const destination = (source.context || audioContext)?.destination;
        if (!destination || typeof source.connect !== 'function') {
            return;
        }
        try {
            source.disconnect?.();
            source.connect(destination);
        } catch (e) {
            verbose(`[Main] Could not route retained MediaElementSource to destination: ${e?.message || e}`);
        }
    }

    function takeRetainedMediaElementSource(element, audioContext) {
        const source = retainedMediaElementSources.get(element);
        if (!source) {
            return null;
        }
        retainedMediaElementSources.delete(element);
        if (audioContext?.state === 'closed' || (source.context && audioContext && source.context !== audioContext)) {
            return null;
        }
        try {
            source.disconnect?.();
        } catch {
            // Already disconnected.
        }
        return source;
    }

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

    function nativeVolumePercentForDiagnostics(value) {
        return Number.isFinite(Number(value))
            ? Math.round(Number(value) * DEFAULT_VOLUME * 10) / 10
            : null;
    }

    function readPlayerVolumePercent(element) {
        const nativeVolume = Number.isFinite(element?.volume) ? element.volume : 1;
        return Protocol.nativeVolumeToPercent(nativeVolume);
    }

    // A page's own start volume is never claimed passively. Pages create media at 0, fade in
    // from 0, restore a remembered level or start an ad slot low, none of which the user chose.
    // Claiming such a value stored it per tab (so it followed the tab to the next site) and
    // blocked the page's own later writes. Until the user acts, the tab stays unowned: native
    // volume is untouched and status reports the element's live volume. Only a user gesture on
    // the player (the pre-active volumechange bridge) claims through this function.
    function claimGesturePlayerVolume(element, stateData) {
        const State = getState();
        const VolumeOwnership = window.VolumeControl.VolumeOwnership;
        const playerVolume = readPlayerVolumePercent(element);
        if (
            VolumeOwnership.isManaged() ||
            State.volumeHasBeenSet ||
            !element ||
            element.isConnected === false ||
            playerVolume === DEFAULT_VOLUME ||
            !canElementDriveSharedState(element)
        ) {
            return false;
        }

        const oldVolume = State.currentVolumePercent;
        void VolumeOwnership.commitManagedVolume(
            playerVolume,
            Protocol.VolumeControlSource.PLAYER_INITIAL,
            { immediatePersist: true }
        );

        if (stateData) {
            stateData.observedNativeVolume = element.volume;
            stateData.nativeVolumeSnapshot = element.volume;
            stateData.userOriginalVolume = element.volume;
        }

        window.VolumeControl.scheduleStorageWrite?.(
            window.VolumeControl.SESSION_STORAGE_KEY_VOLUME,
            playerVolume.toString()
        );
        log(`[Main] Adopted player gesture volume: ${playerVolume}% (was ${oldVolume}%)`);
        applyClaimedInitialVolume(element, stateData, playerVolume);
        return true;
    }

    function applyVolumeToOtherElements(sourceElement, volume, options = {}) {
        const fromPlayer = options.fromPlayer === true;
        const VolumeSyncManager = getVolumeSyncManager();
        const VolumeController = getVolumeController();
        const stateManager = getElementStateManager();
        if (!stateManager || !VolumeController) {
            return;
        }

        const lockEcho = (otherElement) => {
            if (fromPlayer) {
                VolumeSyncManager?.startApplyingVolumeFromPlayer?.(otherElement, volume);
            } else {
                VolumeSyncManager?.startApplyingVolume?.(otherElement, volume);
            }
        };

        stateManager.elements?.forEach?.((otherStateData, otherElement) => {
            if (otherElement === sourceElement || !otherStateData?.isActive?.()) {
                return;
            }
            lockEcho(otherElement);
            VolumeController.applyVolume?.(otherElement, otherStateData, volume);
        });

        stateManager.corsElements?.forEach?.((corsElement) => {
            if (corsElement === sourceElement) {
                return;
            }
            lockEcho(corsElement);
            VolumeController.applyNativeVolumeOnly?.(corsElement, volume);
        });
    }

    function applyClaimedInitialVolume(element, stateData, playerVolume) {
        const VolumeSyncManager = getVolumeSyncManager();
        const VolumeController = getVolumeController();
        const stateManager = getElementStateManager();

        if (stateData?.gainNode) {
            VolumeSyncManager?.startApplyingVolumeFromPlayer?.(element, playerVolume);
            VolumeController?.applyVolume?.(element, stateData, playerVolume, {
                force: true,
                source: 'initial-volume-observer'
            });
        } else if (stateManager?.isCorsBlocked?.(element)) {
            VolumeController?.applyNativeVolumeOnly?.(element, playerVolume);
        }

        applyVolumeToOtherElements(element, playerVolume, { fromPlayer: true });

        if (window.VolumeControl.notifyPopupOfStatusChange) {
            window.VolumeControl.notifyPopupOfStatusChange();
        }
    }

    function resolveFirstSetupVolume() {
        const State = getState();

        if (State.volumeHasBeenSet) {
            return {
                volumeToApply: State.currentVolumePercent,
                lockNativeApply: true
            };
        }

        return {
            volumeToApply: State.currentVolumePercent,
            lockNativeApply: false
        };
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

        // The manager registers the element and enters ERROR/cors in one step; a refused
        // transition registers nothing, so no native-only reason is recorded either.
        if (typeof stateManager?.markCorsBlocked === 'function') {
            if (stateManager.markCorsBlocked(element) === false) {
                warn(`[Main] ${elementInfo} could not enter native-only fallback from ${stateData?.state ?? 'untracked'}`);
                return null;
            }
        }

        if (stateData) {
            stateData.nativeOnlyReason = fallbackReason;
            stateData.nativeOnlySourceKey = sourceKey;
        }

        // A fallback reached while the extension is disabled records the element and nothing
        // else: no native write and no volume handler (the handler can reject and re-apply a
        // page write), exactly like `disableExtensionProcessing` leaves a native-only element.
        // Enabling attaches the handler and re-applies the owned volume.
        const extensionDisabled = State.extensionEnabled === false;
        const volumePlan = resolveFirstSetupVolume();
        if (!extensionDisabled && VolumeController?.applyNativeVolumeOnly && volumePlan.lockNativeApply) {
            if (VolumeSyncManager) {
                VolumeSyncManager.startApplyingVolume(element, volumePlan.volumeToApply);
            }
            VolumeController.applyNativeVolumeOnly(element, volumePlan.volumeToApply);
            log(`[Main] Applied native volume request ${volumePlan.volumeToApply}% to native-only ${elementInfo}`);
        }

        if (VolumeSyncManager && !extensionDisabled) {
            VolumeSyncManager.attachVolumeChangeHandler(element, stateData);
        }

        if (window.VolumeControl.notifyPopupOfStatusChange) {
            window.VolumeControl.notifyPopupOfStatusChange();
        }

        return null;
    }

    // Stale native-only entries (a source that became capturable, a stopped detached element)
    // are pruned from the lifecycle paths, never from a status getter.
    function pruneStaleNativeOnlyEntries() {
        getElementStateManager()?.cleanupStaleCorsElements?.();
    }

    /**
     * Whether the element is already native-only for the source it has now. Setup on such an
     * element has nothing left to decide; it would only re-commit the restore snapshot over
     * the volume the extension itself wrote and restart the volume handler.
     */
    function isNativeOnlyForCurrentSource(element, stateData) {
        ensureElementState();
        // Prune first: a source that became capturable must run setup again, not return early.
        pruneStaleNativeOnlyEntries();
        if (!getElementStateManager()?.isCorsBlocked?.(element) || !stateData.isState(ElementState.ERROR)) {
            return false;
        }
        const sourceKey = getElementSourceKey(element);
        return Boolean(sourceKey) && sourceKey === stateData.nativeOnlySourceKey;
    }

    /**
     * Idempotent re-apply for a native-only element that setup skipped. Only what the extension
     * owns is written (G1), and only when the page drifted away from it, so a settled element
     * receives no write and no volume guard.
     */
    function reapplyOwnedNativeOnlyState(element, elementInfo) {
        const State = getState();
        const VolumeController = getVolumeController();
        const VolumeSyncManager = getVolumeSyncManager();

        // Disabled means the page owns its native volume and mute; enabling runs setup again,
        // which re-applies what the extension owns.
        if (State.extensionEnabled === false) {
            return;
        }

        if (State.volumeHasBeenSet && VolumeController?.applyNativeVolumeOnly) {
            const epsilon = window.VolumeControl.NATIVE_VOLUME_EPSILON || 0.002;
            const expectedNative = Math.min(1, State.currentVolumePercent / DEFAULT_VOLUME);
            if (Math.abs(element.volume - expectedNative) > epsilon) {
                VolumeSyncManager?.startApplyingVolume(element, State.currentVolumePercent);
                VolumeController.applyNativeVolumeOnly(element, State.currentVolumePercent);
                log(`[Main] Re-applied native volume ${State.currentVolumePercent}% to native-only ${elementInfo}`);
            }
        }

        if (State.muteHasBeenSet && element.muted !== Boolean(State.currentMutedState)) {
            VolumeController?.applyMute(element, Boolean(State.currentMutedState));
        }
    }

    // The extension only ever dictates mute while it owns the tab mute (set from the
    // popup). Otherwise the page and the user own it, so the element itself is the truth;
    // a remembered per-element copy would go stale and re-mute what the user unmuted.
    function getDesiredMuteStateForElement(element) {
        const State = getState();
        return State.muteHasBeenSet
            ? Boolean(State.currentMutedState)
            : Boolean(element?.muted);
    }

    /**
     * Give up the extension mute because the user took control from the player, or
     * because the extension itself was unmuted. Elements keep their current native state.
     */
    function releaseMuteOwnership() {
        const State = getState();
        if (!State.muteHasBeenSet) {
            return;
        }

        State.muteHasBeenSet = false;
        const stateManager = getElementStateManager();
        const trackedElements = new Set();
        stateManager.elements.forEach((stateData, element) => {
            trackedElements.add(element);
            syncUnownedMuteStateFromElement(element, stateData, {
                updateSharedState: false,
                updateManagedState: true,
                commitToRestore: false
            });
        });
        stateManager.corsElements?.forEach?.((element) => trackedElements.add(element));

        // The shared projection must not outlive the ownership it described. A multi-media page
        // never lets one element drive it (`updateSharedState: false`), so it is rebuilt from the
        // elements themselves: muted only when media exist and every one of them is muted.
        if (trackedElements.size > 0) {
            State.currentMutedState = Array.from(trackedElements).every((element) => Boolean(element?.muted));
        }
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

        // `commitVolume` and `commitMute` default to `commitToRestore`; setup passes them apart
        // when the extension already owns one of the two natively.
        const { commitToRestore = false } = options;
        const commitVolume = options.commitVolume ?? commitToRestore;
        const commitMute = options.commitMute ?? commitToRestore;
        const commitsAny = commitVolume || commitMute;
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

        if (commitVolume) {
            stateData.nativeVolumeSnapshot = nextVolume;
            stateData.userOriginalVolume = nextVolume;
        }
        if (commitMute) {
            stateData.nativeMutedSnapshot = nextMuted;
            stateData.userOriginalMutedState = nextMuted;
        }

        const observedVolumeChanged = !Number.isFinite(previousObservedVolume) || Math.abs(previousObservedVolume - nextVolume) > 0.001;
        const snapshotVolumeChanged = !Number.isFinite(previousSnapshotVolume) || Math.abs(previousSnapshotVolume - nextVolume) > 0.001;
        if (logDiagnostic && (
            observedVolumeChanged ||
            previousObservedMutedState !== nextMuted ||
            (commitsAny && (snapshotVolumeChanged || previousSnapshotMutedState !== nextMuted))
        )) {
            logDiagnostic('native-state-observed', {
                elementInfo: `${element.tagName}#${element.id || 'no-id'}`,
                commitToRestore: commitsAny,
                commitVolume,
                commitMute,
                elementVolume: nativeVolumePercentForDiagnostics(element.volume),
                observedNativeVolume: nativeVolumePercentForDiagnostics(stateData.observedNativeVolume),
                previousObservedNativeVolume: nativeVolumePercentForDiagnostics(previousObservedVolume),
                elementMuted: nextMuted,
                previousObservedMutedState,
                observedNativeMutedState: stateData.observedNativeMutedState,
                previousSnapshotVolume: nativeVolumePercentForDiagnostics(previousSnapshotVolume),
                nativeVolumeSnapshot: nativeVolumePercentForDiagnostics(stateData.nativeVolumeSnapshot),
                previousSnapshotMutedState,
                nativeMutedSnapshot: stateData.nativeMutedSnapshot,
                managedMutedState: stateData.managedMutedState
            }, { threshold: 3 });
        }
    }

    /**
     * The page's original native state of an element the extension configured, kept by element
     * when a full cleanup drops its state record. A rediscovered element builds a fresh record
     * whose constructor snapshot is whatever the element holds now, which on an owned tab is the
     * extension's own write. The memory is used only while the source key is unchanged: a changed
     * key means the page set up the element again before the extension wrote to it, so what the
     * element holds then is the page's original (ISS-018, "source key changed before extension
     * write"). Entries leave with the element (WeakMap) and when they are consumed.
     */
    const restoreSnapshotMemory = new WeakMap();

    function rememberRestoreSnapshot(element, stateData) {
        if (!element || !stateData || stateData.setupStartedAt === null || stateData.setupStartedAt === undefined) {
            return;
        }
        restoreSnapshotMemory.set(element, {
            volume: stateData.nativeVolumeSnapshot,
            muted: stateData.nativeMutedSnapshot,
            sourceKey: stateData.lastKnownSrc || getElementSourceKey(element)
        });
    }

    function seedRestoreSnapshotFromMemory(element, stateData) {
        const remembered = restoreSnapshotMemory.get(element);
        if (!remembered || (stateData.setupStartedAt !== null && stateData.setupStartedAt !== undefined)) {
            return;
        }
        restoreSnapshotMemory.delete(element);
        const sourceKey = getElementSourceKey(element);
        if (!remembered.sourceKey || remembered.sourceKey !== sourceKey) {
            return;
        }
        if (Number.isFinite(remembered.volume)) {
            stateData.nativeVolumeSnapshot = remembered.volume;
            stateData.userOriginalVolume = remembered.volume;
        }
        if (typeof remembered.muted === 'boolean') {
            stateData.nativeMutedSnapshot = remembered.muted;
            stateData.userOriginalMutedState = remembered.muted;
        }
        stateData.restoreSnapshotSeeded = true;
    }

    /**
     * Which parts of the restore snapshot `setupElement` may take from the element right now.
     * The snapshot is the page's original native state, so it must never take a value the
     * extension wrote itself. The page owns native state while the extension is disabled or in
     * passthrough, and an element that never went through setup has had no extension write
     * yet, so everything is committed there. Afterwards the volume is the extension's once the
     * tab volume is owned, and the mute is the extension's whenever the tab mute is owned.
     */
    function resolveSetupRestoreCommit(stateData) {
        const State = getState();
        if (State.extensionEnabled === false || stateData.passthroughMode) {
            return { commitVolume: true, commitMute: true };
        }

        // `setupStartedAt` is null on a state record created after a full cleanup, so the
        // history of the element itself (`restoreSnapshotMemory`) counts as well.
        const hasBeenSetUp = (stateData.setupStartedAt !== null && stateData.setupStartedAt !== undefined) ||
            stateData.restoreSnapshotSeeded === true;
        return {
            commitVolume: !(hasBeenSetUp && State.volumeHasBeenSet),
            commitMute: !State.muteHasBeenSet
        };
    }

    /**
     * Forget everything tied to a graph that is being dropped: the page-write mask holds a
     * node of that graph, and the applied volume, mono state and balance describe it. Called
     * after the node references are replaced or nulled, so the mask is released without a
     * write to a node that is gone.
     */
    function resetRebuiltGraphState(stateData) {
        if (!stateData) {
            return;
        }

        getVolumeController()?.releasePageVolumeMask?.(stateData);
        stateData.resetAppliedGraphState?.();
    }

    // The element does not have to be connected: an off-DOM player (`new Audio()`) is a valid
    // capture target, and disabling the extension must reach it like any other element.
    /**
     * Null every reference to a graph that is being dropped and forget what was applied to it.
     * The caller has already retained the MediaElementSource (or never had one); a state that
     * keeps these references reads as a live graph (status counts, recovery gates, restore
     * paths) although nothing routes through it.
     */
    function dropGraphNodeReferences(stateData) {
        if (!stateData) {
            return;
        }

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
        resetRebuiltGraphState(stateData);
    }

    function restoreElementNativeState(element, stateData) {
        if (!element || !stateData) {
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
                nativeVolume: nativeVolumePercentForDiagnostics(nativeVolume),
                nativeMuted: Boolean(nativeMuted),
                snapshotVolume: nativeVolumePercentForDiagnostics(stateData.nativeVolumeSnapshot),
                snapshotMuted: stateData.nativeMutedSnapshot,
                managedMutedState: stateData.managedMutedState,
                observedNativeMutedState: stateData.observedNativeMutedState
            }, { threshold: 3 });
        }

        VolumeController.setNativeVolume(element, nativeVolume);
        VolumeController.applyMute(element, Boolean(nativeMuted));
    }

    function enterPassthroughMode(element, stateData) {
        if (!element || !stateData?.isActive() || !stateData.source || !stateData.audioContext) {
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
        if (!element || !stateData?.isActive() || !stateData.source || !stateData.audioContext) {
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

        if (State.volumeHasBeenSet) {
            if (VolumeSyncManager) {
                VolumeSyncManager.startApplyingVolume(element, State.currentVolumePercent);
            }
            VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true, source: 'extension-resume' });
        } else {
            VolumeController.applyGainOnly(stateData, DEFAULT_VOLUME);
        }
        VolumeController.applyMute(element, getDesiredMuteStateForElement(element));
        VolumeSyncManager?.attachVolumeChangeHandler(element, stateData);

        if (State.currentCompressionEnabled) {
            Compressor?.monitor.start(element, stateData);
        }

        resetActiveVerificationState(stateData, element.currentTime, false);
        scheduleActiveElementVerification(element, stateData, { force: true });

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
                } else if (stateManager.isCorsBlocked(element)) {
                    // Disabling removes the handler of a native-only element, and one that
                    // entered native-only while disabled never had it.
                    getVolumeSyncManager()?.attachVolumeChangeHandler(element, stateData);
                } else if (stateData?.isActive?.() && !stateData.passthroughMode) {
                    // A watchdog tick that ran while disabled cleared the timer. An element that
                    // is ACTIVE and routed (never entered passthrough) gets it back, or a
                    // detached player would stay unwatched until the next playing event.
                    scheduleActiveElementVerification(element, stateData);
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

    function isCurrentElementOperation(element, stateData, scope, epoch, options = {}) {
        const stateManager = getElementStateManager();
        const allowDisconnected = options.allowDisconnected === true;
        return Boolean(
            element &&
            (element.isConnected || allowDisconnected) &&
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

    /**
     * Attach a temporary once-listener owned by an operation scope: it leaves with the scope
     * (a superseding operation or a cleanup removes it). Listeners of other features, such as
     * the media event handlers and the volume hook confirmation, never go through here.
     * Without a tracking element state it is a plain once-listener.
     */
    function addScopedOnceListener(element, stateData, scope, key, type, handler) {
        if (typeof stateData?.registerOperationListener === 'function') {
            stateData.registerOperationListener(scope, key, element, type, handler);
            return;
        }
        element.addEventListener(type, handler, { once: true });
    }

    /**
     * A mozCaptureStream refresh found no tracks yet and the element was cleaned up with its
     * listeners kept: set it up again shortly. The attempt is epoch-scoped, so a newer cleanup,
     * setup or source change cancels it.
     */
    function scheduleResetupAfterTemporaryRefresh(element, stateData) {
        const retryEpoch = stateData.beginOperation('retry');
        scheduleElementTimeout(stateData, 'retry', 'refresh-resetup', 250, () => {
            // An off-DOM player is a valid target, so the attempt must not drop on `isConnected`.
            if (!isCurrentElementOperation(element, stateData, 'retry', retryEpoch, { allowDisconnected: true })) {
                return;
            }
            setupElement(element, {
                isResetup: true,
                fromPlayingEvent: false,
                allowDisconnected: !element.isConnected
            });
        });
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

    /**
     * A throw inside a watchdog tick must not end the watchdog or leave a half-dropped graph
     * behind: the recovery steps null node references before they rebuild them, so a throw in
     * between would otherwise leave an ACTIVE element without a graph and nothing watching it.
     */
    function handleVerificationThrow(element, stateData, verifyError) {
        error('[Main] Verification pass failed:', verifyError);
        try {
            if (getElementStateManager()?.get(element) !== stateData || !stateData.isActive?.()) {
                return;
            }
            if (!stateData.gainNode) {
                enterNativeOnlyAfterCaptureLoss(element, stateData, {
                    elementInfo: `${element.tagName}#${element.id || 'no-id'}`,
                    corsMessage: 'verification recovery failed',
                    captureError: verifyError || null,
                    captureMethod: stateData.sourceType || null
                });
                return;
            }
            scheduleActiveElementVerification(element, stateData, { force: true });
        } catch (recoveryError) {
            error('[Main] Recovering from a failed verification pass failed:', recoveryError);
        }
    }

    /**
     * Arm the watchdog. A pending timer is kept, so a stream of `playing` events cannot push
     * verification back forever; the first scheduling is never dropped. Callers that need a
     * fresh interval (after a recovery, after setup, after a source change) pass `force`.
     */
    function scheduleActiveElementVerification(element, stateData, options = {}) {
        if (!element || !stateData?.isActive?.()) {
            return;
        }

        const { delayMs = ACTIVE_VERIFICATION_INTERVAL_MS, force = false } = options;
        if (stateData.verificationTimer && !force) {
            return;
        }

        clearActiveElementVerification(stateData);
        stateData.verificationTimer = setTimeout(() => {
            stateData.verificationTimer = null;
            try {
                verifyActiveElementConnection(element, stateData, 'watchdog');
            } catch (verifyError) {
                handleVerificationThrow(element, stateData, verifyError);
            }
        }, delayMs);
    }

    /**
     * Claim one recovery of a graph that is ACTIVE but silent. The budget lives apart from
     * `consecutiveVerificationFailures` because every recovery calls
     * `resetActiveVerificationState`, which would otherwise hand the budget back on each
     * new baseline and let silent content loop forever. It is cleared only by confirmed
     * audible flow (`confirmAudibleFlowAfterRecovery`) or by a source key change.
     * @returns {boolean} false once the budget is spent
     */
    function claimSilentGraphRecovery(element, stateData) {
        const sourceKey = getElementSourceKey(element);
        if (stateData.silentGraphRecoverySourceKey !== sourceKey) {
            stateData.silentGraphRecoverySourceKey = sourceKey;
            stateData.silentGraphRecoveryAttempts = 0;
        }

        if ((stateData.silentGraphRecoveryAttempts || 0) >= CAPTURE_RECOVERY_MAX_ATTEMPTS) {
            return false;
        }

        stateData.silentGraphRecoveryAttempts = (stateData.silentGraphRecoveryAttempts || 0) + 1;
        return true;
    }

    /**
     * Audible flow after a recovery proves the recovery worked: the budgets start over and the
     * next flow sample is a baseline again.
     */
    function confirmAudibleFlowAfterRecovery(stateData) {
        if (
            !stateData.silentGraphRecoveryAttempts &&
            !stateData.captureRecoveryAttempts &&
            !stateData.nativeOnlyRevisitAttempts
        ) {
            return;
        }

        stateData.silentGraphRecoveryAttempts = 0;
        stateData.captureRecoveryAttempts = 0;
        stateData.nativeOnlyRevisitAttempts = 0;
        stateData.flowBaselineTaken = false;
    }

    /**
     * A silent graph that spent its recovery budget is not a lost capture: the graph is routed,
     * the content is simply quiet (a BRB scene, an ad gap, an intro). Rebuilding again would only
     * churn, and dropping to native-only would take the boost away from a healthy page. The
     * element stays ACTIVE with its watchdog sampling, so returning audio hands the budget back
     * (`confirmAudibleFlowAfterRecovery`), and a source key change starts a new budget.
     */
    function holdSilentGraphWithoutRecovery(element, stateData, elementInfo) {
        // EME-protected media is the one category where silence is a fact about the source, not
        // about the content: the browser withholds the audio from Web Audio, so a held graph
        // would leave the page silent for as long as it plays. It ends as a limited, native-only
        // element. 'capture-error' is sticky until the source key changes and is never revisited,
        // so a protected stream cannot churn.
        if (element.mediaKeys) {
            log(`[Main] Verification: ${elementInfo} is protected media with a silent graph; continuing native-only`);
            enterNativeOnlyAfterCaptureLoss(element, stateData, {
                elementInfo,
                fallbackReason: 'capture-error',
                corsMessage: 'protected media produced no audio through the graph',
                captureMethod: stateData.sourceType || null
            });
            return;
        }
        verbose(`[Main] Verification: ${elementInfo} stayed silent through ${CAPTURE_RECOVERY_MAX_ATTEMPTS} recoveries; keeping the graph and waiting for audio`);
        resetActiveVerificationState(stateData, element.currentTime, false);
        scheduleActiveElementVerification(element, stateData, { force: true });
    }

    function getNativeOnlyRevisitDelay(attempts) {
        return NATIVE_ONLY_REVISIT_DELAYS_MS[Math.min(attempts, NATIVE_ONLY_REVISIT_DELAYS_MS.length - 1)];
    }

    /**
     * Schedule the next revisit of a native-only element whose capture was lost. One timer per
     * element, on the retry scope, so a setup, a source change or a cleanup supersedes it. The
     * chain ends after the last delay of the schedule.
     */
    function scheduleNativeOnlyRevisit(element, stateData) {
        const attempts = stateData.nativeOnlyRevisitAttempts || 0;
        if (attempts >= NATIVE_ONLY_REVISIT_DELAYS_MS.length) {
            return;
        }

        const retryEpoch = stateData.beginOperation('retry');
        scheduleElementTimeout(stateData, 'retry', 'native-only-revisit', getNativeOnlyRevisitDelay(attempts), () => {
            if (!isCurrentElementOperation(element, stateData, 'retry', retryEpoch, { allowDisconnected: true })) {
                return;
            }
            reviveNativeOnlyAfterCaptureLoss(element, stateData, { requireElapsed: false });
        });
    }

    /**
     * Give a native-only element whose capture was lost another full setup. Only the capture-loss
     * state is revisited: a CORS block or a page-owned source is a fact about the source and stays
     * until the source key changes. The attempt counter is cleared by confirmed audible flow or a
     * source change; `requireElapsed` keeps event-driven revisits on the same backoff as the timer.
     * @returns {boolean} whether a new setup was started
     */
    function reviveNativeOnlyAfterCaptureLoss(element, stateData, options = {}) {
        const { requireElapsed = true } = options;
        const State = getState();
        const stateManager = getElementStateManager();

        if (
            !element ||
            !stateData ||
            State.extensionEnabled === false ||
            stateData.nativeOnlyReason !== 'capture-lost' ||
            !stateManager?.isCorsBlocked?.(element) ||
            stateManager.get(element) !== stateData ||
            stateData.isTransitioning()
        ) {
            return false;
        }

        const attempts = stateData.nativeOnlyRevisitAttempts || 0;
        const now = Date.now();
        if (requireElapsed && (now - (stateData.lastNativeOnlyRevisitAt || 0)) < getNativeOnlyRevisitDelay(attempts)) {
            return false;
        }

        if (!isElementPotentiallyPlaying(element) || !hasUsableMediaSource(element)) {
            return false;
        }

        // Re-capturing mid-drag would write native volume underneath the website slider.
        if (getVolumeSyncManager()?.isPlayerVolumeGestureActive?.(element)) {
            return false;
        }

        stateData.nativeOnlyRevisitAttempts = attempts + 1;
        stateData.lastNativeOnlyRevisitAt = now;
        // Each revisit gets a full recovery budget; the revisit schedule itself bounds the total.
        stateData.silentGraphRecoveryAttempts = 0;
        stateData.captureRecoveryAttempts = 0;
        stateManager.clearCorsBlocked(element);
        log(`[Main] Revisiting lost capture for ${stateData.elementInfo} (attempt ${stateData.nativeOnlyRevisitAttempts})`);
        void Promise.resolve()
            .then(() => setupElement(element, {
                isResetup: true,
                fromPlayingEvent: true,
                allowDisconnected: !element.isConnected
            }))
            .catch((revisitError) => {
                verbose(`[Main] Native-only revisit failed: ${revisitError?.message || revisitError}`);
            });
        if (window.VolumeControl.notifyPopupOfStatusChange) {
            window.VolumeControl.notifyPopupOfStatusChange();
        }
        return true;
    }

    /**
     * Terminal state for an ACTIVE element whose capture cannot be rebuilt: release what is
     * left of the graph, then continue as native-only (ERROR/cors) so the popup reports
     * limited control instead of an ACTIVE element with no gain. The ownership rules of
     * `activateNativeOnlyFallback` apply: an unowned tab never receives a native write (G1).
     * Both of its native writes (the fallback and the re-apply) are skipped while the
     * extension is disabled.
     */
    function enterNativeOnlyAfterCaptureLoss(element, stateData, options = {}) {
        ensureElementState();
        const elementInfo = options.elementInfo || `${element.tagName}#${element.id || 'no-id'}`;

        cleanupElement(element, { preserveListeners: true });
        // Cleanup lands in DISCOVERED, which only leads to SETTING_UP; setup reaches ERROR
        // through SETTING_UP in the same way when its capture fails.
        if (stateData.isState(ElementState.DISCOVERED)) {
            stateData.transition(ElementState.SETTING_UP, { reason: 'native-only-after-capture-loss' });
        }

        const result = activateNativeOnlyFallback(element, stateData, {
            fallbackReason: 'capture-lost',
            ...options,
            elementInfo
        });

        if (stateData.isState(ElementState.SETTING_UP)) {
            stateData.transition(ElementState.ERROR, {
                errorType: 'unknown',
                errorMessage: options.corsMessage || options.captureError?.message || 'Capture lost'
            });
        }
        reapplyOwnedNativeOnlyState(element, elementInfo);
        // Only a registered native-only element is revisited; a refused fallback left nothing to revisit.
        if (getElementStateManager()?.isCorsBlocked?.(element) && stateData.nativeOnlyReason === 'capture-lost') {
            // The backoff of event-driven revisits runs from the loss, not from page start.
            stateData.lastNativeOnlyRevisitAt = Date.now();
            scheduleNativeOnlyRevisit(element, stateData);
        }
        return result;
    }

    // A detached element only counts as stopped when it is paused or ended. A seek is not a
    // stop: `isElementPotentiallyPlaying` is false while seeking, yet nothing calls play()
    // again afterwards, so retiring the element then would leave it silent.
    function hasDetachedElementStopped(element) {
        return Boolean(element?.paused || element?.ended);
    }

    /**
     * Retire detached entries that have nothing left to protect: a stopped element that is
     * neither ACTIVE (the watchdog owns those) nor mid-transition. Without this, ERROR,
     * DISCOVERED and native-only entries of off-DOM elements stay in the strong
     * `stateManager.elements` map, because no timer visits a non-ACTIVE element.
     * Only called from detached-element paths, so a connected page pays nothing for it.
     */
    function sweepDetachedIdleEntries(exceptElement = null) {
        const stateManager = getElementStateManager();
        if (!stateManager?.elements) {
            return;
        }

        Array.from(stateManager.elements.entries()).forEach(([entryElement, entryState]) => {
            if (
                entryElement === exceptElement ||
                entryElement.isConnected ||
                entryState.isActive() ||
                entryState.isTransitioning() ||
                !hasDetachedElementStopped(entryElement)
            ) {
                return;
            }
            cleanupElement(entryElement);
        });
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

            // A detached element that is still playing keeps its graph and keeps being
            // re-verified. A full cleanup would leave its retained MediaElementSource
            // unrouted (silent) while the detector still tracks it. Only a stopped element
            // that has stayed detached past the grace period is retired, and the grace is
            // measured from the last tick that saw it playing, so a track gap never tears
            // down a long-running off-DOM player.
            if (!hasDetachedElementStopped(element)) {
                stateData.detachedSinceAt = Date.now();
            }
            if (!hasDetachedElementStopped(element) || (Date.now() - stateData.detachedSinceAt) < DETACHED_PLAYBACK_GRACE_MS) {
                sweepDetachedIdleEntries(element);
                scheduleActiveElementVerification(element, stateData, { force: true });
                return;
            }

            cleanupElement(element);
            sweepDetachedIdleEntries();
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
            if (isElementPotentiallyPlaying(element)) {
                scheduleActiveElementVerification(element, stateData, { force: true });
            }
            return;
        }

        const expectedNative = Math.min(DEFAULT_VOLUME, State.currentVolumePercent);
        const desiredMuteState = getDesiredMuteStateForElement(element);
        const playerVolume = Protocol.nativeVolumeToPercent(element.volume);
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
            scheduleActiveElementVerification(element, stateData, { force: true });
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
            scheduleActiveElementVerification(element, stateData, { force: true });
            return;
        }

        const canCheckFlow = Boolean(
            AudioPipeline?.checkAudioFlow &&
            stateData.analyser &&
            !document.hidden &&
            stateData.isIntersecting !== false &&
            !element.muted &&
            element.volume > 0 &&
            !(State.muteHasBeenSet && State.currentMutedState) &&
            State.currentVolumePercent > 0 &&
            (Date.now() - (stateData.lastStateChangeAt || 0)) > ACTIVE_VERIFICATION_GRACE_MS
        );

        if (!canCheckFlow) {
            resetActiveVerificationState(stateData, element.currentTime, false);
            scheduleActiveElementVerification(element, stateData, { force: true });
            return;
        }

        const flow = AudioPipeline.checkAudioFlow(stateData.analyser);
        const currentTime = Number.isFinite(Number(element.currentTime)) ? Number(element.currentTime) : 0;
        // The first flow sample of an element only records a baseline: a silent analyser right
        // after activation (quiet intro, very low volume) is not yet evidence of a dead graph.
        // Failures are counted from the second sample on, at most one extra interval of latency.
        const isFirstFlowSample = stateData.flowBaselineTaken !== true;
        stateData.flowBaselineTaken = true;
        const previousCurrentTime = Number.isFinite(Number(stateData.lastObservedCurrentTime)) ? Number(stateData.lastObservedCurrentTime) : 0;
        const timeAdvanced = !isFirstFlowSample && currentTime > (previousCurrentTime + 0.25);
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
            confirmAudibleFlowAfterRecovery(stateData);
            resetActiveVerificationState(stateData, currentTime, true);
            scheduleActiveElementVerification(element, stateData, { force: true });
            return;
        }

        if (!timeAdvanced) {
            scheduleActiveElementVerification(element, stateData, { force: true });
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
                if (!claimSilentGraphRecovery(element, stateData)) {
                    holdSilentGraphWithoutRecovery(element, stateData, elementInfo);
                    return;
                }
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
                resetRebuiltGraphState(stateData);

                // Re-capture: get a fresh mozCaptureStream from the element
                const freshResult = SourceCapture.refreshMozCaptureStream(
                    element, stateData.audioContext, elementInfo
                );

                if (freshResult.error || !freshResult.source) {
                    warn(`[Main] mozCaptureStream refresh FAILED for ${elementInfo}: ${freshResult.error?.message || 'no source'}`);
                    if (freshResult.isTemporary) {
                        verbose(`[Main] Refresh temporary (no tracks yet). Forcing full reset and polling retry...`);
                        cleanupElement(element, { preserveListeners: true });
                        scheduleResetupAfterTemporaryRefresh(element, stateData);
                    } else {
                        // Recapture failed permanently. The graph is gone, so the element
                        // must not stay ACTIVE: release what is left and continue native-only.
                        log(`[Main] Verification: ${elementInfo} native-only fallback (mozCaptureStream refresh failed)`);
                        enterNativeOnlyAfterCaptureLoss(element, stateData, {
                            elementInfo,
                            corsMessage: 'mozCaptureStream refresh failed',
                            captureError: freshResult.error || null,
                            captureMethod: 'mozCaptureStream'
                        });
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

                if (State.volumeHasBeenSet) {
                    VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true, source: 'verification-moz-reset' });
                } else {
                    VolumeController.applyGainOnly(stateData, DEFAULT_VOLUME);
                }
                VolumeController.applyMute(element, getDesiredMuteStateForElement(element));

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
                scheduleActiveElementVerification(element, stateData, { force: true });
                return;
            }

            scheduleActiveElementVerification(element, stateData, { force: true });
            return;
        }

        if (!claimSilentGraphRecovery(element, stateData)) {
            holdSilentGraphWithoutRecovery(element, stateData, elementInfo);
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
        if (stateData.sourceType === 'mediaElementSource') {
            verbose(`[Main] Verification: mediaElementSource silence is not a dead capture; refreshing graph for ${elementInfo}`);
            const AudioContextMgr = getAudioContext();
            // The context may take a while to resume. Whatever happened meanwhile (cleanup,
            // source change, setup, passthrough, disable) outranks this refresh, so the
            // continuation proves the element is the same one in the same state first. The
            // epoch check also confirms `stateManager.get(element) === stateData`.
            const setupEpoch = stateData.operationEpochs?.setup;
            const sourceChangeEpoch = stateData.operationEpochs?.sourceChange;
            const isRefreshStillCurrent = () => (
                isCurrentElementOperation(element, stateData, 'setup', setupEpoch, { allowDisconnected: true }) &&
                isCurrentElementOperation(element, stateData, 'sourceChange', sourceChangeEpoch, { allowDisconnected: true }) &&
                stateData.isActive() &&
                !stateData.passthroughMode &&
                getState().extensionEnabled !== false
            );
            void Promise.resolve()
                .then(() => AudioContextMgr?.ensureAudioContextRunning?.())
                .then(() => {
                    const ctx = AudioContextMgr?.getSharedAudioContext?.();
                    if (!ctx || !stateData.source || !isRefreshStillCurrent()) {
                        return;
                    }
                    AudioPipeline.connectGraph({
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
                    }, ctx, getEffectiveProcessingOptions());
                })
                .catch((error) => {
                    verbose(`[Main] mediaElementSource graph refresh failed: ${error?.message || error}`);
                });
            resetActiveVerificationState(stateData, element.currentTime, false);
            scheduleActiveElementVerification(element, stateData, { force: true });
            return;
        }

        // Only the two capture types exist today, and the moz path above resets its failure
        // counter before the threshold. A future source type must not lose its watchdog here.
        scheduleActiveElementVerification(element, stateData, { force: true });
    }

    /**
     * Set up audio graph for an element
     * This is the NEW simplified setup function using modular components
     * @param {HTMLMediaElement} element
     * @param {Object} options
     * @returns {Object|null} - Element state data or null
     */
    async function setupElement(element, options = {}) {
        // `preserveRetryScope` is set by the source-change re-setup chain: its attempts must not
        // cancel the chain that is making them. Nothing else passes it, so any other setup
        // still supersedes a pending chain.
        const {
            isResetup = false,
            fromPlayingEvent = false,
            allowDisconnected = false,
            preserveRetryScope = false
        } = options;
        // A temporary-source retry owns the retry scope once it is scheduled, and runs without the flag.
        const retryOptions = { ...options, preserveRetryScope: false };
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
        seedRestoreSnapshotFromMemory(element, stateData);

        // A native-only element on an unchanged source is settled. Returning before the
        // observation below keeps the restore snapshot from being overwritten by the volume
        // the extension itself wrote, and keeps the element out of SETTING_UP. While disabled
        // the full path runs, so the snapshot keeps tracking the page.
        if (State.extensionEnabled !== false && isNativeOnlyForCurrentSource(element, stateData)) {
            verbose(`[Main] ${elementInfo} is already native-only for this source; skipping setup`);
            reapplyOwnedNativeOnlyState(element, elementInfo);
            return null;
        }

        // Decided once, before this call changes anything: the restore snapshot is the page's
        // original, so an element the extension already configured must not re-commit the
        // value the extension wrote (a repeated `playing` event, a rebuild).
        const restoreCommit = resolveSetupRestoreCommit(stateData);
        observeElementNativeState(element, stateData, restoreCommit);

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
            VolumeController.applyMute(element, getDesiredMuteStateForElement(element));
            // A `playing` event must not push a pending verification back; a stuttering stream
            // would otherwise postpone the watchdog indefinitely.
            scheduleActiveElementVerification(element, stateData);
            return stateData;
        }
        
        if (stateData.isState(ElementState.SETTING_UP)) {
            verbose(`[Main] ${elementInfo} setup already in progress`);
            return null;
        }

        // Check if element is actually playing
        // When triggered by 'playing' event, we trust the event and don't require currentTime > 0
        // Some players fire `playing` before currentTime advances from zero.
        const isActuallyPlaying = !element.paused && !element.ended && !element.seeking && 
            (fromPlayingEvent || element.currentTime > 0);
        if (!isActuallyPlaying) {
            verbose(`[Main] ${elementInfo} not playing yet (paused=${element.paused}, ended=${element.ended}, seeking=${element.seeking}, currentTime=${element.currentTime})`);

            // If the element is seeking, attach a one-time 'playing' listener
            // to retry setup when seeking completes AND playback resumes.
            // This handles adaptive-stream players whose replacement media elements
            // are discovered mid-seek, and setupElement bails out.  The
            // 'playing' event fires after seek completes + play() is called.
            if (element.seeking) {
                verbose(`[Main] ${elementInfo} seeking — will retry setup on 'playing'`);
                addScopedOnceListener(element, stateData, 'setup', 'seeking-retry', 'playing', () => {
                    setupElement(element, { fromPlayingEvent: true });
                });
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
            invalidate: preserveRetryScope
                ? ['sourceChange', 'volumeSync']
                : ['retry', 'sourceChange', 'volumeSync']
        });
        const isSetupCurrent = () => isCurrentElementOperation(element, stateData, 'setup', setupEpoch, {
            allowDisconnected
        });
        const clearSetupTimeout = () => {
            stateData.clearOperationTimeout('setup', 'timeout');
            stateData.setupTimeoutId = null;
        };
        /**
         * Give up on this attempt without leaving the element parked in SETTING_UP.
         * A transitional element is skipped by refreshDetectedMediaState and by the
         * general volumechange bridge, so stranding it there silently removes the
         * media from the extension for the rest of the page's life.
         */
        const abandonSetup = (errorMessage, { spendRetry = true } = {}) => {
            clearSetupTimeout();
            // A newer setup may already own the element; that operation drives the
            // state from here and must not be overwritten.
            if (
                stateData.isState(ElementState.SETTING_UP) &&
                stateData.isOperationCurrent('setup', setupEpoch)
            ) {
                stateData.transition(ElementState.ERROR, {
                    errorType: 'invalid_source',
                    errorMessage,
                    retryCount: stateData.retryCount + (spendRetry ? 1 : 0)
                });
            }
            return null;
        };

        // Transition to SETTING_UP
        if (!stateData.transition(ElementState.SETTING_UP)) {
            warn(`[Main] Failed to transition ${elementInfo} to SETTING_UP`);
            return null;
        }

        stateData.setupStartedAt = Date.now();
        stateData.lastKnownSrc = sourceKey;
        observeElementNativeState(element, stateData, restoreCommit);

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

        // Declared outside the try so the catch can keep a captured source alive when a later
        // step throws before the source is stored on the element state.
        let audioContext = null;
        let captureResult = null;

        try {
            // Get/create AudioContext
            audioContext = AudioContextMgr.getSharedAudioContext();
            if (!audioContext) {
                clearSetupTimeout();
                throw new Error('Failed to get AudioContext');
            }

            // Check if we've already timed out
            if (setupTimedOut || !isSetupCurrent()) {
                return abandonSetup('Setup superseded before AudioContext resume');
            }

            // Ensure AudioContext is running
            if (audioContext.state !== 'running') {
                await AudioContextMgr.ensureAudioContextRunning();
            }
            if (audioContext.state !== 'running') {
                return abandonSetup('AudioContext not running');
            }

            // Covers both a superseded setup and an element that detached while the
            // resume was pending; isCurrentElementOperation() requires a connected,
            // still-tracked element.
            if (!isSetupCurrent()) {
                verbose(`[Main] ${elementInfo} setup released during AudioContext resume`);
                return abandonSetup('Element detached or superseded during AudioContext resume');
            }

            // Abort setup if the element disappeared while awaiting resume.
            // Skip this check for play-interception discoveries (off-DOM elements
            // like Bandcamp's `new Audio()` are valid capture targets and don't
            // need to be in the DOM for createMediaElementSource to work).
            if (!element.isConnected && !allowDisconnected) {
                verbose(`[Main] ${elementInfo} detached during AudioContext resume`);
                return abandonSetup('Element detached during AudioContext resume');
            }

            // Check if we've already timed out
            if (setupTimedOut || !isSetupCurrent()) {
                return abandonSetup('Setup timed out before capture');
            }

            // The extension may have been disabled while the resume was pending, and
            // `disableExtensionProcessing` skips SETTING_UP. Nothing is captured yet, so the
            // element simply stays with the page; enabling runs setup again from ERROR.
            if (State.extensionEnabled === false) {
                verbose(`[Main] ${elementInfo} setup abandoned before capture: extension sound control was disabled`);
                return abandonSetup('Extension sound control disabled during setup', { spendRetry: false });
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
                    const retries = stateData.retryCount || 0;
                    stateData.transition(ElementState.ERROR, {
                        errorType: 'invalid_source',
                        errorMessage: corsResult.message,
                        retryCount: retries + 1
                    });
                    const delay = getTempSourceRetryDelay(retries);
                    if (delay !== null) {
                        const retryEpoch = stateData.beginOperation('retry');
                        scheduleElementTimeout(stateData, 'retry', 'temp-source', delay, () => {
                            if (!isCurrentElementOperation(element, stateData, 'retry', retryEpoch, { allowDisconnected })) {
                                return;
                            }
                            setupElement(element, retryOptions);
                        });
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
            const retainedSource = takeRetainedMediaElementSource(element, audioContext);
            if (retainedSource) {
                captureResult = {
                    source: retainedSource,
                    stream: null,
                    sourceType: 'mediaElementSource'
                };
                verbose(`[Main] ${elementInfo} reusing retained MediaElementSource`);
            } else {
                captureResult = SourceCapture.createSource(element, audioContext);
            }
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
                    const retries = stateData.retryCount || 0;
                    stateData.transition(ElementState.ERROR, {
                        errorType: 'invalid_source',
                        errorMessage: captureResult.error.message,
                        errorName: captureResult.error.name || null,
                        retryCount: retries + 1
                    });
                    const delay = getTempSourceRetryDelay(retries);
                    if (delay !== null) {
                        const retryEpoch = stateData.beginOperation('retry');
                        scheduleElementTimeout(stateData, 'retry', 'temp-source', delay, () => {
                            if (!isCurrentElementOperation(element, stateData, 'retry', retryEpoch, { allowDisconnected })) {
                                return;
                            }
                            setupElement(element, retryOptions);
                        });
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

                if (captureResult.error.name === 'InvalidStateError') {
                    return activateNativeOnlyFallback(element, stateData, {
                        elementInfo,
                        sourceKey,
                        fallbackReason: 'page-owned-capture-conflict',
                        corsMessage: 'Page already owns this media element source',
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
                if (captureResult?.source && captureResult.sourceType === 'mediaElementSource') {
                    retainMediaElementSource(element, captureResult.source, audioContext, { audible: true });
                }
                clearSetupTimeout();
                return abandonSetup('Setup superseded after capture');
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
            // The nodes are new, so nothing applied to an earlier graph (a failed attempt can
            // leave one behind) may make the first apply below look unchanged. A mask on an old
            // node holds nothing of this graph and expires on its own failsafe.
            stateData.resetAppliedGraphState?.();

            const volumePlan = resolveFirstSetupVolume();
            const volumeToApply = volumePlan.volumeToApply;

            // The enabled flag is read once, before the capture (the check after the only await,
            // the AudioContext resume, abandons a disabled setup). Nothing awaits between that
            // check and this point, so the extension is enabled for the whole tail.
            // Connect graph
            AudioPipeline.connectGraph(nodes, audioContext, getEffectiveProcessingOptions());

            // Only lock native volume writes after we own the tab volume. An unowned tab never
            // touches the page's native volume (it is the page's own state until the user acts).
            if (VolumeSyncManager && volumePlan.lockNativeApply) {
                VolumeSyncManager.startApplyingVolume(element, volumeToApply);
            }

            if (volumePlan.lockNativeApply) {
                VolumeController.applyVolume(element, stateData, volumeToApply);
            } else {
                // Preserve the native player value while the page initializes.
                VolumeController.applyGainOnly(stateData, DEFAULT_VOLUME);
            }

            // Apply mute state
            syncUnownedMuteStateFromElement(element, stateData, {
                updateManagedState: true,
                commitToRestore: true
            });
            element.muted = getDesiredMuteStateForElement(element);

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

            if (!stateData.transition(ElementState.ACTIVE, { retryCount: 0 })) {
                clearSetupTimeout();
                warn(`[Main] ${elementInfo} could not enter ACTIVE from ${stateData.state}; connecting passthrough to keep the source node`);
                AudioPipeline.connectPassthrough(nodes, audioContext);
                stateData.passthroughMode = true;
                if (nodes.sourceType === 'mediaElementSource') {
                    retainMediaElementSource(element, nodes.source, audioContext);
                }
                return null;
            }

            
            // Start compressor monitoring if enabled.
            if (State.currentCompressionEnabled && Compressor) {
                Compressor.monitor.start(element, stateData, (el, data) => {
                    verbose(`[Compressor Monitor] ${elementInfo}: reduction=${data.reduction.toFixed(2)}dB`);
                });
            }

            resetActiveVerificationState(stateData, element.currentTime, false);
            scheduleActiveElementVerification(element, stateData, { force: true });

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
            // A throw between the capture and the assignment to the element state (building the
            // nodes) leaves the captured MediaElementSource referenced only by `captureResult`.
            // It exists once per element and is audible only through its node, so keep it.
            // Once the element is ACTIVE its graph is live and already routed; a throw from the
            // tail (monitor, visibility, notify) must not unroute it, and ACTIVE -> ERROR is refused.
            if (stateData.isActive()) {
                error(`[Main] Post-activation step failed for ${elementInfo}:`, err);
                return null;
            }
            const orphanedSource = captureResult?.sourceType === 'mediaElementSource' && captureResult.source
                ? captureResult.source
                : (stateData.sourceType === 'mediaElementSource' ? stateData.source : null);
            if (orphanedSource) {
                retainMediaElementSource(element, orphanedSource, stateData.audioContext || audioContext, { audible: true });
            }
            // The throw can come after `Object.assign(stateData, nodes)`. The source is retained
            // and routed on its own now, so the stale node references must not outlive it.
            if (stateData.gainNode || stateData.source || stateData.audioContext) {
                try {
                    Compressor?.monitor?.stop?.(element);
                    VolumeSyncManager?.removeVolumeChangeHandler(element, stateData);
                } catch (releaseError) {
                    verbose(`[Main] Releasing a half-built graph failed: ${releaseError?.message || releaseError}`);
                }
                dropGraphNodeReferences(stateData);
            }
            if (!isSetupCurrent()) {
                return null;
            }
            error(`[Main] Setup failed for ${elementInfo}:`, err);
            
            stateData.transition(ElementState.ERROR, {
                errorType: err.name === 'InvalidStateError' ? 'already_captured' : 'unknown',
                errorMessage: err.message,
                errorName: err?.name || null,
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
        if (!preserveListeners) {
            rememberRestoreSnapshot(element, stateData);
        }

        log(`[Main] Cleaning up ${elementInfo}`);

        if (!stateData.isState(ElementState.CLEANUP)) {
            stateData.transition(ElementState.CLEANUP, {
                reason: preserveListeners ? 'preserve-listeners-cleanup' : 'full-cleanup'
            });
        }

        const releasedMediaElementSource = stateData.sourceType === 'mediaElementSource'
            ? stateData.source
            : null;
        const releasedAudioContext = stateData.audioContext;

        // Leaving the element in CLEANUP would hide it from refresh and volume handling for the
        // rest of the page's life, and dropping its MediaElementSource would silence it. So the
        // finishing steps run even when a teardown step throws. The teardown error is never
        // swallowed: it keeps propagating, and a failure inside the finishing steps is only
        // logged while it is in flight, so it cannot replace it.
        let teardownFailed = true;
        try {
            // Stop compressor monitoring
            if (Compressor?.monitor?.stop) {
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
            teardownFailed = false;
        } finally {
            try {
                // A listener-preserving cleanup is followed by a re-setup, so keep the element
                // audible until then; a full cleanup only keeps the node for rediscovery.
                retainMediaElementSource(element, releasedMediaElementSource, releasedAudioContext, {
                    audible: preserveListeners
                });

                dropGraphNodeReferences(stateData);

                try {
                    stateData.cleanup();
                } finally {
                    // Transition to cleanup (or back to discovered if preserving)
                    if (preserveListeners) {
                        ensureElementState();
                        // Keep listeners and re-enter DISCOVERED so setup can run again safely.
                        if (stateData.isState(ElementState.CLEANUP)) {
                            stateData.transition(ElementState.DISCOVERED, { reason: 'preserve-listeners-resetup' });
                        }
                        verbose(`[Main] Preserved listeners for ${elementInfo}, state=DISCOVERED`);
                    } else {
                        // Remove media event listeners when fully cleaning up
                        removeMediaListeners(element);
                        stateManager.remove?.(element);
                        // The play hook skips tracked elements. Unmarking a retired off-DOM element lets a
                        // later play() rediscover it and reuse its retained MediaElementSource.
                        if (!element.isConnected) {
                            getMediaDetector()?.detector?.unmarkTracked?.(element);
                        }
                    }
                }
            } catch (finishError) {
                if (!teardownFailed) {
                    throw finishError;
                }
                error(`[Main] Cleanup of ${elementInfo} also failed while finishing:`, finishError);
            }
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
        if (handlers.pause) {
            element.removeEventListener('pause', handlers.pause);
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
     * Handle media source changes caused by stream switches or navigation
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
            // Off-DOM players (`new Audio()`) change source too; the watchdog owns retiring
            // a detached element that stopped, so a detached one keeps its re-apply here.
            return isCurrentElementOperation(element, stateData, 'sourceChange', sourceChangeEpoch, {
                allowDisconnected: true
            });
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
        if (stateData) {
            stateData.nativeOnlyReason = null;
            stateData.nativeOnlySourceKey = null;
            stateData.retryCount = 0;
            stateData.nativeOnlyRevisitAttempts = 0;
            stateData.lastNativeOnlyRevisitAt = 0;
        }
        
        // Notify popup if CORS status changed (to update the warning indicator)
        if (wasCorsBlocked && window.VolumeControl.notifyPopupOfStatusChange) {
            window.VolumeControl.notifyPopupOfStatusChange();
        }

        // CRITICAL FIX for Firefox mozCaptureStream:
        // When a media element's source changes during a track switch,
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
                
                // Guard against stale references captured before async reconnect. A detached
                // element is not stale: it keeps playing off-DOM and needs its graph back.
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
                    setupElement(element, { fromPlayingEvent: true, allowDisconnected: !element.isConnected });
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
                        scheduleResetupAfterTemporaryRefresh(element, stateData);
                    } else {
                        // Recapture failed permanently. The old nodes are released and the
                        // element must not stay ACTIVE with a stale gain node: release what is
                        // left and continue native-only.
                        enterNativeOnlyAfterCaptureLoss(element, stateData, {
                            elementInfo,
                            sourceKey: latestSourceKey || getElementSourceKey(element),
                            corsMessage: 'mozCaptureStream refresh failed',
                            captureError: freshResult.error || null,
                            captureMethod: 'mozCaptureStream'
                        });
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
                // The new nodes start fresh; the old gain node (and any mask on it) is gone.
                resetRebuiltGraphState(stateData);

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
                    VolumeController.applyMute(element, getDesiredMuteStateForElement(element));
                } else if (!stateData.passthroughMode && !State.volumeHasBeenSet) {
                    VolumeController.applyGainOnly(stateData, DEFAULT_VOLUME);
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
                // Allow dynamic players time to settle before final verification.
                scheduleSourceChangeTimeout('protection-end', 1000, () => {
                    if (VolumeSyncManager) {
                        VolumeSyncManager.endSourceChange(element, sourceChangeEpoch);
                    }

                    resetActiveVerificationState(stateData, element.currentTime, false);
                    scheduleActiveElementVerification(element, stateData, { force: true });
                });
            };
            
            // Reconnect once per source change. Every waiting trigger belongs to the source-change
            // scope, so the first one to fire removes its siblings: `playing` and `loadeddata`
            // can arrive more than 100 ms apart, and the reconnect timer only coalesces within that.
            const requestReconnect = (delayMs) => {
                if (!isSourceChangeCurrent()) {
                    return;
                }
                stateData.clearOperationListeners?.('sourceChange');
                scheduleSourceChangeTimeout('reconnect', delayMs, reconnectAudio);
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
                    requestReconnect(100);
                } else {
                    // Wait for loadeddata event
                    addScopedOnceListener(element, stateData, 'sourceChange', 'loadeddata-new-source', 'loadeddata', () => {
                        requestReconnect(50);
                    });
                }
            };
            
            // If already playing, reconnect now; otherwise wait
            if (!element.paused && element.currentTime > 0) {
                scheduleSourceChangeTimeout('reconnect', 100, reconnectAudio);
            } else {
                addScopedOnceListener(element, stateData, 'sourceChange', 'playing-reconnect', 'playing', () => {
                    requestReconnect(50);
                });
                
                // Also try on loadeddata in case playing doesn't fire
                addScopedOnceListener(element, stateData, 'sourceChange', 'loadeddata-reconnect', 'loadeddata', waitForNewSource);
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
                const currentState = stateManager.get(element);
                if (!currentState || currentState !== stateData) return;

                // Disabling the extension between the source change and this `playing` event leaves
                // the element in passthrough with its native state restored; writing volume or mute
                // now would undo that restore (G1/G12). Resuming control re-applies both.
                if (State.extensionEnabled === false || stateData.passthroughMode) {
                    VolumeSyncManager?.endSourceChange(element, sourceChangeEpoch);
                    return;
                }
                
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
                    VolumeController.applyMute(element, getDesiredMuteStateForElement(element));

                    if (window.VolumeControl.notifyPopupOfStatusChange) {
                        window.VolumeControl.notifyPopupOfStatusChange();
                    }
                    
                    // End source change protection after a delay
                    scheduleSourceChangeTimeout('reapply-end', 500, () => {
                        if (VolumeSyncManager) {
                            VolumeSyncManager.endSourceChange(element, sourceChangeEpoch);
                        }

                        resetActiveVerificationState(stateData, element.currentTime, false);
                        scheduleActiveElementVerification(element, stateData, { force: true });
                    });
                } else if (!State.volumeHasBeenSet) {
                    scheduleSourceChangeTimeout('observe-end', 0, () => {
                        VolumeSyncManager?.endSourceChange(element, sourceChangeEpoch);
                        resetActiveVerificationState(stateData, element.currentTime, false);
                        scheduleActiveElementVerification(element, stateData, { force: true });
                    });
                }
            };
            
            addScopedOnceListener(element, stateData, 'sourceChange', 'reapply-on-play', 'playing', reapplyOnPlay);
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
            return isCurrentElementOperation(element, stateData, 'retry', retryEpoch, {
                allowDisconnected: true
            });
        };
        const scheduleRetryTimeout = (key, delayMs, callback) => {
            if (!stateData || retryEpoch === null) {
                return setTimeout(callback, delayMs);
            }
            // A chain that was superseded while an attempt was awaited must not register
            // its timer, or it would replace the same key of the newer chain.
            if (!isRetryCurrent()) {
                return null;
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
            
            // A detached player keeps its retries; a stopped one is retired by the watchdog sweep.
            
            // Check if already re-setup
            const currentState = stateManager.get(element);
            if (currentState && currentState.isActive()) {
                return true;
            }

            // Never overlap another setup of this element; the next attempt tries again.
            if (currentState?.isTransitioning?.()) {
                return false;
            }

            // Check if ready
            
            // For re-setup, be more lenient - currentTime may be 0 if media just started
            // By the 3rd attempt, require currentTime > 0 for certainty
            const requireCurrentTime = attemptNumber >= 3;
            const isPlaying = !element.paused && !element.ended && 
                (!requireCurrentTime || element.currentTime > 0);
            if (isPlaying) {
                // The attempt keeps the retry scope, or its own setup would cancel attempts 2 and 3.
                const result = await setupElement(element, {
                    isResetup: true,
                    fromPlayingEvent: true,
                    preserveRetryScope: true,
                    allowDisconnected: !element.isConnected
                });
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

        pruneStaleNativeOnlyEntries();

        const stateManager = getElementStateManager();
        const stateData = stateManager.get(element);
        const sourceKey = getElementSourceKey(element);

        // Attach media event listeners (safe even for off-DOM elements;
        // they become active once the element is connected).
        attachMediaListeners(element);

        // A tab mute set from the popup also covers media that appears later.
        const discoveryState = getState();
        if (discoveryState.muteHasBeenSet && discoveryState.currentMutedState && discoveryState.extensionEnabled !== false) {
            getVolumeController().applyMute(element, true);
        }

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
            // Element is seeking (DASH quality switch / DOM replacement). The persistent
            // `playing` handler `attachMediaListeners` installed above runs setup when the seek
            // completes and playback resumes. A second, untracked once-listener per discovery
            // would pile up on an element that is rediscovered while it never plays.
            verbose(`[Main] ${elementInfo} discovered while seeking; setup follows the 'playing' handler`);
        }
    }

    /**
     * Re-attempt capture for media that is playing but has no working audio graph.
     *
     * Setup can fail for reasons that resolve shortly afterwards (audio tracks not
     * ready on a live stream, a slow capture that hits SETUP_TIMEOUT_MS). No media
     * event is guaranteed to fire again for media that is already playing, so
     * without this the element stays uncontrolled for the life of the page and only
     * a status probe from the popup would rescue it.
     *
     * @returns {boolean} whether a new setup attempt was started
     */
    function recoverStalledCapture(element, stateData, reason) {
        const State = getState();
        const stateManager = getElementStateManager();

        if (!element || !stateData || State?.extensionEnabled === false) {
            return false;
        }

        if (
            stateData.isActive?.() ||
            stateData.isTransitioning?.() ||
            stateData.gainNode ||
            stateData.source ||
            stateManager?.isCorsBlocked?.(element)
        ) {
            return false;
        }

        if (
            !element.isConnected ||
            !isElementPotentiallyPlaying(element) ||
            !hasUsableMediaSource(element)
        ) {
            return false;
        }

        // Re-capturing mid-drag would write native volume underneath the website
        // slider the user is still holding.
        if (getVolumeSyncManager()?.isPlayerVolumeGestureActive?.(element)) {
            return false;
        }

        const sourceKey = getElementSourceKey(element);
        if (stateData.captureRecoverySourceKey !== sourceKey) {
            stateData.captureRecoverySourceKey = sourceKey;
            stateData.captureRecoveryAttempts = 0;
            stateData.lastCaptureRecoveryAt = 0;
        }

        const now = Date.now();
        if (
            (stateData.captureRecoveryAttempts || 0) >= CAPTURE_RECOVERY_MAX_ATTEMPTS ||
            (now - (stateData.lastCaptureRecoveryAt || 0)) < CAPTURE_RECOVERY_MIN_INTERVAL_MS
        ) {
            return false;
        }

        stateData.captureRecoveryAttempts = (stateData.captureRecoveryAttempts || 0) + 1;
        stateData.lastCaptureRecoveryAt = now;

        verbose(`[Main] Re-attempting capture for ${stateData.elementInfo} (${reason}, attempt ${stateData.captureRecoveryAttempts})`);
        // A retry is best-effort by definition; a failure here must not surface as an
        // unhandled rejection, and the attempt budget already bounds how often we try.
        void Promise.resolve()
            .then(() => setupElement(element, { fromPlayingEvent: true }))
            .catch((error) => {
                verbose(`[Main] Capture recovery attempt failed: ${error?.message || error}`);
            });
        return true;
    }

    /**
     * Defer the retry until the current burst of volume changes settles, so a
     * re-capture never writes native volume underneath an in-progress drag.
     */
    function scheduleCaptureRecovery(element, stateData, reason) {
        if (!element || !stateData || stateData.captureRecoveryTimer) {
            return;
        }

        if (stateData.isActive?.() || stateData.gainNode || stateData.source) {
            return;
        }

        stateData.captureRecoveryTimer = setTimeout(() => {
            stateData.captureRecoveryTimer = null;
            recoverStalledCapture(element, getElementStateManager()?.get?.(element), reason);
        }, CAPTURE_RECOVERY_DELAY_MS);
    }

    function refreshDetectedMediaState(mediaElements = null, source = 'manual-refresh') {
        ensureElementState();

        pruneStaleNativeOnlyEntries();

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

        if (element.isConnected) {
            verbose(`[Main] Element reported removed but still connected (re-parent): ${elementInfo}`);
            return;
        }

        // A detached element that still plays keeps its native-only registration; this only
        // drops entries that stopped or whose source became capturable.
        pruneStaleNativeOnlyEntries();
        
        // Check if still playing (detached playback)
        const isPlaying = !element.paused && !element.ended && element.currentTime > 0;
        if (isPlaying) {
            verbose(`[Main] Element removed but still playing: ${elementInfo}`);
            return; // Keep audio graph active
        }

        cleanupElement(element);
        sweepDetachedIdleEntries();
    }

    // Which element represents the frame (and so the badge's mute color) changes when
    // media starts or stops; coalesce bursts from autoplaying previews into one push.
    const PLAYBACK_STATUS_NOTIFY_DELAY_MS = 150;
    let playbackStatusNotifyTimer = null;

    function schedulePlaybackStatusNotify() {
        if (playbackStatusNotifyTimer) {
            return;
        }
        playbackStatusNotifyTimer = setTimeout(() => {
            playbackStatusNotifyTimer = null;
            window.VolumeControl.notifyPopupOfStatusChange?.();
        }, PLAYBACK_STATUS_NOTIFY_DELAY_MS);
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
        let lastObservedMuted = Boolean(element.muted);

        const handlers = {
            playing: () => {
                verbose(`[Main] 'playing' event on ${element.tagName}#${element.id || 'no-id'}`);
                // A lost capture is revisited here too, on the timer's backoff. When it starts a
                // setup the call below finds the element already SETTING_UP.
                reviveNativeOnlyAfterCaptureLoss(element, stateManager.get(element));
                setupElement(element, { fromPlayingEvent: true });
                schedulePlaybackStatusNotify();
            },
            pause: () => {
                schedulePlaybackStatusNotify();
            },
            volumechange: (event) => {
                const currentStateData = stateManager.get(element);

                // Several branches below return without a status push (setting up,
                // unowned, already-desired state); a mute flip must still reach the badge.
                if (Boolean(element.muted) !== lastObservedMuted) {
                    lastObservedMuted = Boolean(element.muted);
                    schedulePlaybackStatusNotify();
                }

                // Queued so this event is still decided against the current state;
                // setupElement() would otherwise move the element into SETTING_UP and
                // suppress the very change that revealed the stalled capture.
                scheduleCaptureRecovery(element, currentStateData, 'volumechange');

                // Elements without a dedicated volume handler (still setting up, off-DOM,
                // passthrough) get the same mute arbitration as captured ones. It runs before
                // the setup/transition returns below so a user's unmute is never dropped
                // while a capture is in flight and then undone when setup finishes.
                if (!(currentStateData?.volumeSyncHandler && !currentStateData?.passthroughMode)) {
                    const muteDecision = VolumeSyncManager?.analyzeMuteChange?.(element, {
                        managedMuteState: VolumeSyncManager.getReferenceMuteState(element, currentStateData),
                        canDriveSharedState: canElementDriveSharedState(element),
                        protectsManagedMuteState: State.extensionEnabled !== false &&
                            !currentStateData?.passthroughMode
                    });
                    if (muteDecision && VolumeSyncManager.applyMuteDecision(element, currentStateData, muteDecision)) {
                        return;
                    }
                }

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

                // Node references alone are not enough to defer: a setup that never
                // reached ACTIVE can leave them behind without an attached handler,
                // and then nothing would react to the change at all.
                const hasDedicatedVolumeHandler = Boolean(currentStateData?.volumeSyncHandler);
                if (hasManagedNodes && hasDedicatedVolumeHandler && !isPassthrough) {
                    return;
                }

                if (!hasUsableMediaSource(element)) {
                    return;
                }

                const nextVolume = Protocol.nativeVolumeToPercent(element.volume);
                const nextMuted = Boolean(element.muted);
                const previousNativeVolume = currentStateData?.observedNativeVolume;
                const previousNativeMuted = currentStateData?.observedNativeMutedState;
                const canDriveSharedState = canElementDriveSharedState(element);

                if (VolumeSyncManager?.isApplyingVolume?.(element)) {
                    if (currentStateData) {
                        observeElementNativeState(element, currentStateData, { commitToRestore: false });
                    }
                    return;
                }

                const playerIntent = VolumeSyncManager?.getPlayerVolumeIntent?.(
                    element,
                    nextVolume
                ) || {
                    isSliderDrag: false,
                    interactedThisElement: false,
                    hasUserVolumeIntent: false
                };

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

                if (!canDriveSharedState && !playerIntent.hasUserVolumeIntent) {
                    if (currentStateData) {
                        observeElementNativeState(element, currentStateData, { commitToRestore: false });
                    }
                    // An unowned tab reports live element volume, so this ignored change
                    // still moves what the badge should show.
                    VolumeSyncManager?.reportUnownedNativeVolume?.(element, currentStateData);
                    return;
                }

                const volumeChanged = State.currentVolumePercent !== nextVolume;

                if (shouldProtectBoostedTarget && !playerIntent.hasUserVolumeIntent) {
                    if (currentStateData) {
                        observeElementNativeState(element, currentStateData, { commitToRestore: false });
                    }
                    return;
                }

                if (!volumeChanged && State.volumeHasBeenSet) {
                    if (currentStateData) {
                        observeElementNativeState(element, currentStateData, { commitToRestore: false });
                    }
                    return;
                }

                const VolumeOwnership = window.VolumeControl.VolumeOwnership;
                if (VolumeOwnership.isManaged()) {
                    if (
                        volumeChanged &&
                        playerIntent.hasUserVolumeIntent &&
                        !document.hidden &&
                        !VolumeSyncManager?.isSourceChangeActive?.(element)
                    ) {
                        VolumeSyncManager?.consumePlayerVolumeIntent?.(element, true);
                        const oldVolume = State.currentVolumePercent;
                        const commitWork = VolumeOwnership.commitPlayerUserVolume(nextVolume);

                        if (currentStateData) {
                            observeElementNativeState(element, currentStateData, {
                                commitToRestore: true
                            });
                        }
                        stateChange(
                            'currentVolumePercent',
                            oldVolume,
                            State.currentVolumePercent,
                            'pre-active native player'
                        );
                        if (window.VolumeControl.notifyPopupOfStatusChange) {
                            void Promise.resolve(commitWork).then(() => {
                                window.VolumeControl.notifyPopupOfStatusChange();
                            });
                        }
                        return;
                    }

                    if (currentStateData) {
                        observeElementNativeState(element, currentStateData, { commitToRestore: false });
                    }
                    const effectiveControl = VolumeOwnership.getEffectiveControl?.();
                    const shouldRepairPlayerOwnedDrift = Boolean(
                        volumeChanged &&
                        effectiveControl?.source === Protocol.VolumeControlSource.PLAYER_USER &&
                        currentStateData
                    );

                    if (shouldRepairPlayerOwnedDrift) {
                        VolumeSyncManager?.startApplyingVolume?.(
                            element,
                            State.currentVolumePercent
                        );
                        VolumeController?.applyNativeVolumeOnly?.(
                            element,
                            State.currentVolumePercent
                        );
                    }
                    return;
                }

                // Only the user's own gesture on the player claims an unowned tab. A passive
                // change (page init, fade-in, remembered level) keeps following the live volume.
                if (playerIntent.hasUserVolumeIntent && canDriveSharedState && claimGesturePlayerVolume(element, currentStateData)) {
                    if (window.VolumeControl.notifyPopupOfStatusChange) {
                        window.VolumeControl.notifyPopupOfStatusChange();
                    }
                    return;
                }

                VolumeOwnership.adoptObservedVolume(nextVolume);

                if (currentStateData) {
                    observeElementNativeState(element, currentStateData, { commitToRestore: false });
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
            // Players may try to restore their own volume after a seek.
            seeked: () => {
                const stateData = stateManager.get(element);
                if (stateData && stateData.isActive() && stateData.gainNode && State.volumeHasBeenSet) {
                    const desiredMuteState = getDesiredMuteStateForElement(element);
                    if (element.muted !== desiredMuteState) {
                        VolumeController.applyMute(element, desiredMuteState);
                    }

                    // Only re-apply if the element's volume has drifted from what we expect
                    // This prevents unnecessary conflicts with site players
                    const currentPlayerVolume = Protocol.nativeVolumeToPercent(element.volume);
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
        element.addEventListener('pause', handlers.pause);
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
    function updateAllVolume(volumePercent, options = {}) {
        const stateManager = getElementStateManager();
        const State = getState();
        const VolumeController = getVolumeController();
        const VolumeSyncManager = getVolumeSyncManager();

        // Every caller (`applyAdoptedWinner`, the broadcast listener, `volume_manager.js`) has
        // already put the control into State through the ownership module, so this only applies
        // the volume to the elements. It never commits ownership itself.
        State.currentVolumePercent = volumePercent;

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
                // An ACTIVE element always has a gain node: a lost capture ends in
                // native-only (ERROR), never in ACTIVE without a graph.
                VolumeController.applyVolume(element, stateData, volumePercent);
                activeCount++;
            }
        });
        
        // CRITICAL FIX: Also apply native volume to CORS-blocked elements
        // CORS-blocked elements can't use GainNode (no audio capture), but they CAN
        // still have their native element.volume adjusted directly.
        // HTMLMediaElement.volume is [0, 1], so requests above 100% clamp to full native volume.
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
        // Only a mute is defended against the page. An unmute is a one-off command;
        // afterwards the player and the page own the mute state again.
        State.muteHasBeenSet = State.currentMutedState;

        if (State.extensionEnabled === false) {
            log(`[Main] Saved mute state while extension sound control is disabled: muted=${State.currentMutedState}`);
            return;
        }

        // Native mute needs no audio graph, so every tracked element takes the command,
        // including autoplay media whose capture is still waiting for a user gesture.
        stateManager.elements.forEach((stateData, element) => {
            VolumeController.applyMute(element, State.currentMutedState);
            stateData.observedNativeMutedState = State.currentMutedState;
        });

        stateManager.corsElements.forEach((element) => {
            VolumeController.applyMute(element, State.currentMutedState);
        });

        log(`[Main] Updated mute state: muted=${State.currentMutedState}`);
    }

    /**
     * The one eligibility rule for every AudioContext repair path: an ACTIVE element that
     * the extension processes (not passthrough, extension enabled) and that is playing.
     */
    function isResumeRepairEligible(element, stateData) {
        if (!stateData?.isActive?.()) return false;
        if (stateData.passthroughMode || getState().extensionEnabled === false) return false;
        return !element.paused && !element.ended && element.currentTime > 0;
    }

    /**
     * Repair all elements after AudioContext resume
     * Called when AudioContext transitions from suspended to running
     * Volume is written only on an owned control (`volumeHasBeenSet`); otherwise only the
     * gain is repaired, so an unowned tab never gets a native volume write.
     * @param {Object} [options]
     * @param {boolean} [options.markEligible] - Flag every eligible element before repairing
     * @param {boolean} [options.repair] - Set to false to flag only, without repairing
     * @returns {number} - Number of elements repaired (or flagged when `repair` is false)
     */
    function repairAllElements(options = {}) {
        const { markEligible = false, repair = true } = options;
        const stateManager = getElementStateManager();
        const State = getState();
        const VolumeController = getVolumeController();
        const VolumeSyncManager = getVolumeSyncManager();
        const Compressor = getCompressor();
        const AudioPipeline = getAudioPipeline();
        
        let repairedCount = 0;
        
        stateManager.elements.forEach((stateData, element) => {
            if (!stateData.isActive()) return;
            if (!isResumeRepairEligible(element, stateData)) {
                // Passthrough and disabled elements are never repaired, and must not stay flagged.
                if (stateData.passthroughMode || State.extensionEnabled === false) {
                    stateData.needsConnectionVerification = false;
                }
                return;
            }
            if (markEligible) {
                stateData.needsConnectionVerification = true;
            }
            if (!repair) {
                if (markEligible) repairedCount++;
                return;
            }
            if (!stateData.needsConnectionVerification) return;
            
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
            
            if (State.volumeHasBeenSet) {
                // Guarded like every extension write, so the decision engine does not read it as page intent.
                VolumeSyncManager?.startApplyingVolume(element, State.currentVolumePercent);
                VolumeController.applyVolume(element, stateData, State.currentVolumePercent, { force: true, source: 'resume-repair' });
            } else {
                VolumeController.applyGainOnly(stateData, DEFAULT_VOLUME);
            }
            VolumeController.applyMute(element, getDesiredMuteStateForElement(element));
            AudioPipeline.updateAudioSettings({
                stereoPannerNode: stateData.stereoPannerNode
            }, stateData.audioContext, {
                balance: State.currentBalance
            });
            stateData.lastAppliedMonoEnabled = State.currentMonoEnabled;
            stateData.lastAppliedBalance = State.currentBalance;
            
            stateData.needsConnectionVerification = false;
            resetActiveVerificationState(stateData, element.currentTime, false);
            scheduleActiveElementVerification(element, stateData, { force: true });
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
                const stateData = stateManager.get(element);
                if (stateData) {
                    stateData.isIntersecting = isVisible;
                    verbose(`[Main] Visibility changed: ${element.tagName}#${element.id || 'no-id'} = ${isVisible}`);
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
        handleElementDiscovered,
        refreshDetectedMediaState,
        updateAllVolume,
        updateAllMute,
        releaseMuteOwnership,
        updateAllCompression,
        updateAllAudioSettings,
        applyGlobalBalanceSettings,
        getAudioSettingsAvailability,
        setExtensionEnabled,
        attachMediaListeners,
        repairAllElements,
        applyVolumeToOtherElements,
        handleElementRemoved,
        CAPTURE_RECOVERY_MAX_ATTEMPTS,
        TEMP_SOURCE_MAX_RETRIES,
        TEMP_SOURCE_SLOW_RETRY_DELAYS_MS,
        NATIVE_ONLY_REVISIT_DELAYS_MS
    };

})();
