(function() {
    'use strict';

    const Protocol = globalThis.VCProtocol;
    const {
        Messages,
        VolumeControlSource,
        createManagedVolumeControl,
        createUnmanagedVolumeControl,
        isManagedVolumeControl,
        normalizeVolumeControl,
        shouldAcceptVolumeControlUpdate,
        volumeControlToOwnership
    } = Protocol;

    function getState() {
        return window.VolumeControl?.State;
    }

    function getMain() {
        return window.VolumeControl?.Main;
    }

    function getStorageSync() {
        return window.VolumeControl?.storageSync;
    }

    function applyControlToState(control) {
        const State = getState();
        if (!State || !control) {
            return null;
        }

        State.volumeControl = control;
        State.volumeOwnership = volumeControlToOwnership(control);

        if (isManagedVolumeControl(control)) {
            State.currentVolumePercent = control.targetVolume;
            State.volumeHasBeenSet = true;
        } else {
            State.volumeHasBeenSet = false;
        }

        return control;
    }

    function getEffectiveControl() {
        const State = getState();
        if (State?.volumeControl) {
            return State.volumeControl;
        }
        return null;
    }

    function isManaged() {
        return isManagedVolumeControl(getEffectiveControl());
    }

    function getManagedTarget() {
        const control = getEffectiveControl();
        return isManagedVolumeControl(control) ? control.targetVolume : null;
    }

    async function hydrateFromBackground() {
        if (window.VolumeControl.__volumeControlHydrated) {
            return getEffectiveControl();
        }

        if (!window.VolumeControl.__volumeControlHydrationPromise) {
            window.VolumeControl.__volumeControlHydrationPromise = (async () => {
                try {
                    const response = await browser.runtime.sendMessage({
                        type: Messages.GET_TAB_VOLUME_CONTROL
                    });
                    if (response?.control) {
                        const incoming = normalizeVolumeControl(response.control);
                        const current = getEffectiveControl();
                        // A cold frame (no control, or a revision 0 telemetry mirror) takes
                        // the background control as is. Anything newer locally outranks a
                        // response that was in flight while a commit or broadcast landed.
                        const isCold = !current || !(Math.floor(Number(current.revision) || 0) > 0);
                        if (
                            isCold ||
                            shouldAcceptVolumeControlUpdate(current, incoming, { allowEqualDifferent: false })
                        ) {
                            applyControlToState(incoming);
                        }
                    }
                    window.VolumeControl.__volumeControlHydrated = true;
                } catch (error) {
                    window.VolumeControl?.verbose?.('[VolumeOwnership] hydrate failed', error);
                    window.VolumeControl.__volumeControlHydrationPromise = null;
                }
                return getEffectiveControl();
            })();
        }

        return window.VolumeControl.__volumeControlHydrationPromise;
    }

    // Whether a player slider gesture is held on any tracked element, local or from a sibling
    // frame. Uses the decision engine's per-element predicate so there is one definition of "held".
    function isPlayerSliderGestureHeld() {
        const manager = window.VolumeControl?.volumeSyncManager;
        if (typeof manager?.isPlayerVolumeGestureActive !== 'function') {
            return false;
        }
        const stateManager = window.VolumeControl?.elementStateManager;
        const elements = new Set();
        stateManager?.elements?.forEach?.((stateData, element) => elements.add(element));
        stateManager?.corsElements?.forEach?.((element) => elements.add(element));
        return Array.from(elements).some((element) => manager.isPlayerVolumeGestureActive(element));
    }

    // The page owns native volume for the length of a held slider gesture, so a confirmed target
    // must not be written underneath it. The target is already in State (the ownership module put
    // it there before this runs); every element queues one apply that the gesture engine flushes
    // on release, reading the latest State then. Returns whether the apply was deferred.
    function deferTargetUntilGestureEnds() {
        const manager = window.VolumeControl?.volumeSyncManager;
        const stateManager = window.VolumeControl?.elementStateManager;
        if (typeof manager?.deferPlayerGestureApply !== 'function' || !stateManager) {
            return false;
        }
        stateManager.elements?.forEach?.((stateData, element) => {
            if (stateData?.isActive?.()) {
                manager.deferPlayerGestureApply(element, stateData, false);
            }
        });
        stateManager.corsElements?.forEach?.((element) => {
            const stateData = stateManager.get?.(element);
            if (stateData) {
                manager.deferPlayerGestureApply(element, stateData, true);
            }
        });
        return true;
    }

    // The single path for a confirmed managed target that did not come from this frame's own
    // optimistic apply: the winner of a rejected commit and the cross-frame broadcast. Both
    // used to differ (one skipped a held gesture and never reconciled, the other wrote under it).
    // An unmanaged control never reaches it, so it never writes native volume.
    function applyConfirmedManagedTarget(control) {
        if (!isManagedVolumeControl(control)) {
            return;
        }
        if (isPlayerSliderGestureHeld() && deferTargetUntilGestureEnds()) {
            return;
        }
        getMain()?.updateAllVolume?.(control.targetVolume);
    }

    // The background answered a commit with a different winner. Elements still sit at the
    // optimistic target, so the winner goes to every graph and native-only element, as the
    // broadcast listener does. While a slider gesture is held the apply waits for the release.
    function applyAdoptedWinner(winner) {
        if (!isManagedVolumeControl(winner)) {
            return;
        }
        applyConfirmedManagedTarget(winner);
        window.VolumeControl?.notifyPopupOfStatusChange?.();
    }

    async function commitManagedVolume(targetVolume, source, options = {}) {
        const State = getState();
        if (!State) {
            return null;
        }

        const current = getEffectiveControl() || createUnmanagedVolumeControl(State.currentVolumePercent);
        const nextRevision = Math.max(1, Math.floor(Number(current.revision) || 0) + 1);
        const optimisticControl = createManagedVolumeControl(targetVolume, source, nextRevision);
        let nextControl = optimisticControl;
        applyControlToState(nextControl);

        if (options.skipBackground !== true) {
            try {
                const response = await browser.runtime.sendMessage({
                    type: Messages.COMMIT_TAB_VOLUME_CONTROL,
                    payload: { control: nextControl }
                });
                if (response?.control && shouldAcceptVolumeControlUpdate(getEffectiveControl(), response.control)) {
                    nextControl = normalizeVolumeControl(response.control);
                    applyControlToState(nextControl);
                    if (!controlsMatch(optimisticControl, nextControl)) {
                        applyAdoptedWinner(nextControl);
                    }
                } else if (response?.accepted === false) {
                    const latestControl = getEffectiveControl();
                    const latestRevision = Math.floor(Number(latestControl?.revision) || 0);
                    const completedRevision = Math.floor(Number(nextControl?.revision) || 0);
                    if (latestControl && latestRevision > completedRevision) {
                        return latestControl;
                    }
                    if (response.control) {
                        nextControl = normalizeVolumeControl(
                            response.control,
                            getState()?.currentVolumePercent
                        );
                        applyControlToState(nextControl);
                        applyAdoptedWinner(nextControl);
                    }
                    return getEffectiveControl();
                }
            } catch (error) {
                window.VolumeControl?.verbose?.('[VolumeOwnership] background commit failed', error);
            }
        }

        const latestControl = getEffectiveControl();
        const latestRevision = Math.floor(Number(latestControl?.revision) || 0);
        const completedRevision = Math.floor(Number(nextControl?.revision) || 0);
        if (latestControl && latestRevision > completedRevision) {
            return latestControl;
        }

        const storageSync = getStorageSync();
        if (storageSync?.scheduleVolumePersist) {
            storageSync.scheduleVolumePersist(nextControl.targetVolume, { immediate: options.immediatePersist === true });
        } else if (window.VolumeControl?.scheduleStorageWrite) {
            window.VolumeControl.scheduleStorageWrite(
                window.VolumeControl.SESSION_STORAGE_KEY_VOLUME,
                String(nextControl.targetVolume)
            );
        }

        return nextControl;
    }

    async function commitExtensionVolume(targetVolume) {
        return commitManagedVolume(targetVolume, VolumeControlSource.EXTENSION, { immediatePersist: true });
    }

    async function commitPlayerUserVolume(targetVolume) {
        return commitManagedVolume(targetVolume, VolumeControlSource.PLAYER_USER, { immediatePersist: true });
    }

    async function commitRestoredVolume(targetVolume) {
        return commitManagedVolume(targetVolume, VolumeControlSource.RESTORED, { immediatePersist: true });
    }

    function adoptObservedVolume(observedVolume) {
        const State = getState();
        if (!State || isManaged()) {
            return { adopted: false, reason: 'managed' };
        }

        const normalized = Protocol.normalizeVolume(observedVolume, State.currentVolumePercent);
        State.currentVolumePercent = normalized;
        State.volumeHasBeenSet = false;
        State.volumeOwnership = 'unowned';
        State.volumeControl = createUnmanagedVolumeControl(normalized);
        return { adopted: true, observedVolume: normalized };
    }

    function rejectNativeVolumeChange() {
        return {
            rejected: true,
            targetVolume: getManagedTarget()
        };
    }

    function shouldUseLiveObservedVolume() {
        return !isManaged();
    }

    function controlsMatch(left, right) {
        return Boolean(
            left &&
            right &&
            left.mode === right.mode &&
            left.targetVolume === right.targetVolume &&
            left.source === right.source &&
            left.revision === right.revision
        );
    }

    globalThis.browser?.runtime?.onMessage?.addListener?.((message) => {
        if (message?.type !== Messages.TAB_VOLUME_CONTROL_UPDATED || !message.payload?.control) {
            return;
        }

        const current = getEffectiveControl();
        const incoming = normalizeVolumeControl(
            message.payload.control,
            getState()?.currentVolumePercent
        );
        if (!shouldAcceptVolumeControlUpdate(current, incoming) || controlsMatch(current, incoming)) {
            return;
        }

        applyControlToState(incoming);
        applyConfirmedManagedTarget(incoming);
        window.VolumeControl?.notifyPopupOfStatusChange?.();
    });

    window.VolumeControl = window.VolumeControl || {};
    window.VolumeControl.VolumeOwnership = {
        hydrateFromBackground,
        commitManagedVolume,
        commitExtensionVolume,
        commitPlayerUserVolume,
        commitRestoredVolume,
        adoptObservedVolume,
        rejectNativeVolumeChange,
        applyControlToState,
        getEffectiveControl,
        getManagedTarget,
        isManaged,
        shouldUseLiveObservedVolume
    };
})();
