/**
 * Volume Sync Module - Bidirectional volume synchronization between extension and player.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.VolumeSyncManager = {};

(function() {
    const Protocol = globalThis.VCProtocol;
    const { 
        log, warn, verbose, decision, stateChange, 
        logVolumeEvent, logSourceChange, logDiagnostic,
        EXTENSION_VOLUME_LOCK_TIMEOUT_MS,
        DEFAULT_VOLUME,
        MIN_VOLUME,
        MAX_VOLUME,
        VOLUME_HOOK_EVENT
    } = window.VolumeControl;

    // Timing constants
    const SYNC_DEBOUNCE_MS = 100;
    const MIN_CHANGE_PERCENT = 2;
    const PLAYER_ECHO_TIMEOUT_MS = 150;
    const HIJACK_PROTECTION_MS = 3000;
    const MUTE_TOGGLE_SUPPRESSION_MS = 750;  // Ignore immediate follow-up volume resets after a mute toggle
    const UNMUTE_ANSWER_MS = 2000;           // Player unmute volume may arrive after control UI rebuilds
    const SOURCE_CHANGE_PROTECTION_MS = 2000;
    
    // Track only direct media-intent interactions to strengthen hijack detection.
    const INTERACTION_TIMEOUT_MS = 500;      // Window to consider user as "recently interacted"
    const SLIDER_DRAG_WINDOW_MS = 300;       // Window for the rapid-change drag counters to read as a drag
    const RAPID_CHANGE_DRAG_COUNT = 3;       // Successive rapid changes that read as a slider drag
    const CROSS_FRAME_INTENT_GRACE_MS = 100; // Lets a top-frame gesture reach a media iframe first
    const CROSS_FRAME_MOVE_REPORT_INTERVAL_MS = 50;
    const ACTIVE_GESTURE_FAILSAFE_MS = 30000;
    const CONTROL_POSITION_TOLERANCE = 0.02;
    let lastInteractionAt = 0;               // Timestamp of last user interaction
    let lastPointerActivityAt = 0;           // Last press or pressed move; keys and wheel never refresh it
    let pressedPointerType = null;           // 'mouse' | 'touch' | 'pen' of the press that is held
    let isMouseDown = false;                 // Is mouse currently held down?
    let isPointerDown = false;               // Is pointer (mouse/touch/pen) currently down?
    let lastInteractedMediaElement = null;   // Most recently interacted media element within the interaction window
    let localPlayerVolumeIntentElement = null;
    let lastVolumeControlInteractionAt = 0;
    let lastInteractionTargetsVolumeControl = false; // Last gesture hit a slider, not e.g. a mute button
    let lastInteractionTargetsMuteChrome = false;    // Last gesture hit a mute/volume control, not the media itself
    let pointerInteractionMediaElements = new Set();
    let lastPointerMediaInteractionAt = 0;
    let crossFramePlayerPointerActive = false;
    let crossFramePlayerGestureId = null;
    let crossFramePlayerGestureCounter = 0;
    let crossFramePlayerIntentSequence = 0;
    let lastCrossFrameIntentReportAt = 0;
    const crossFrameIntentWaiters = new Set();

    /**
     * Whether a local pointer is still held. A press that is held still (a slider the user has
     * not moved) stays a gesture for as long as it lasts, so there is no short expiry. Only a
     * press with no pointer activity for ACTIVE_GESTURE_FAILSAFE_MS (`lastPointerActivityAt` is
     * refreshed by the press and by every pressed move, never by a key or the wheel, which
     * are not evidence that the pointer is still down) is treated as a release that no
     * document ever reported, the same read-time bound that limits a cross-frame gesture.
     * When the bound trips, the element the gesture was bound to is forgotten, so the next
     * gesture can bind to any element. The press flags stay: a pressed move after a long still
     * hold refreshes the stamp and the gesture is held again.
     */
    function isLocalPointerHeld(now = Date.now()) {
        if (!(isMouseDown || isPointerDown)) {
            return false;
        }
        if ((now - lastPointerActivityAt) < ACTIVE_GESTURE_FAILSAFE_MS) {
            return true;
        }
        localPlayerVolumeIntentElement = null;
        return false;
    }

    function notePointerPress(pointerType) {
        lastPointerActivityAt = Date.now();
        pressedPointerType = pointerType || pressedPointerType || 'mouse';
    }

    // Which pointer a move belongs to. A move without a type is a mouse move.
    function isMouseMoveEvent(event) {
        const type = event?.pointerType || 'mouse';
        return type === 'mouse';
    }

    function isMediaElement(node) {
        return Boolean(node && typeof node.tagName === 'string' && /^(VIDEO|AUDIO)$/i.test(node.tagName));
    }

    function getInteractedMediaElement(event) {
        if (typeof event?.composedPath === 'function') {
            const mediaInPath = event.composedPath().find(isMediaElement);
            if (mediaInPath) {
                return mediaInPath;
            }
        }

        let currentNode = event?.target || null;
        while (currentNode) {
            if (isMediaElement(currentNode)) {
                return currentNode;
            }

            if (typeof currentNode.closest === 'function') {
                const mediaAncestor = currentNode.closest('video, audio');
                if (mediaAncestor) {
                    return mediaAncestor;
                }
            }

            currentNode = currentNode.parentElement || currentNode.parentNode || null;
        }

        return null;
    }

    function isVolumeControlElement(node) {
        if (!node || typeof node.matches !== 'function') {
            return false;
        }

        return node.matches(
            'input[type="range"], [role="slider"], [aria-valuenow][aria-valuemin][aria-valuemax]'
        );
    }

    function readControlNumber(node, propertyName, attributeName, fallback = null) {
        const propertyValue = node?.[propertyName];
        if (propertyValue !== undefined && propertyValue !== null && propertyValue !== '') {
            const numericPropertyValue = Number(propertyValue);
            if (Number.isFinite(numericPropertyValue)) {
                return numericPropertyValue;
            }
        }

        const attributeValue = node?.getAttribute?.(attributeName);
        if (attributeValue !== undefined && attributeValue !== null && attributeValue !== '') {
            const numericAttributeValue = Number(attributeValue);
            if (Number.isFinite(numericAttributeValue)) {
                return numericAttributeValue;
            }
        }

        return fallback;
    }

    function isTimelineTransportControlElement(node, mediaElements) {
        if (!isVolumeControlElement(node) || !mediaElements?.size) {
            return false;
        }

        const minimum = readControlNumber(node, 'min', 'aria-valuemin', 0);
        const maximum = readControlNumber(node, 'max', 'aria-valuemax');
        const value = readControlNumber(node, 'value', 'aria-valuenow');
        if (
            !Number.isFinite(minimum) ||
            !Number.isFinite(maximum) ||
            !Number.isFinite(value) ||
            maximum <= minimum
        ) {
            return false;
        }

        const controlPosition = (value - minimum) / (maximum - minimum);
        if (
            controlPosition < -CONTROL_POSITION_TOLERANCE ||
            controlPosition > 1 + CONTROL_POSITION_TOLERANCE
        ) {
            return false;
        }

        const trackedElements = Array.from(mediaElements);
        const matchesNativeVolume = trackedElements.some((element) => {
            const nativeVolume = Number(element?.volume);
            return Number.isFinite(nativeVolume) &&
                Math.abs(controlPosition - nativeVolume) <= CONTROL_POSITION_TOLERANCE;
        });
        if (matchesNativeVolume) {
            return false;
        }

        return trackedElements.some((element) => {
            const duration = Number(element?.duration);
            const currentTime = Number(element?.currentTime);
            if (
                !Number.isFinite(duration) ||
                duration <= 0 ||
                !Number.isFinite(currentTime) ||
                currentTime < 0
            ) {
                return false;
            }

            const mediaPosition = currentTime / duration;
            return Math.abs(controlPosition - mediaPosition) <= CONTROL_POSITION_TOLERANCE;
        });
    }

    function eventTargetsTimelineTransportControl(event, mediaElements) {
        const matchesTimelineControl = (node) => (
            isTimelineTransportControlElement(node, mediaElements)
        );
        if (typeof event?.composedPath === 'function') {
            return event.composedPath().some(matchesTimelineControl);
        }

        let currentNode = event?.target || null;
        while (currentNode) {
            if (matchesTimelineControl(currentNode)) {
                return true;
            }
            currentNode = currentNode.parentElement || currentNode.parentNode || null;
        }
        return false;
    }

    function eventTargetsVolumeControl(event) {
        if (typeof event?.composedPath === 'function') {
            return event.composedPath().some(isVolumeControlElement);
        }

        let currentNode = event?.target || null;
        while (currentNode) {
            if (isVolumeControlElement(currentNode)) {
                return true;
            }
            currentNode = currentNode.parentElement || currentNode.parentNode || null;
        }
        return false;
    }

    function isPlayerMuteChrome(node) {
        if (!node) {
            return false;
        }
        const tag = String(node.tagName || '').toUpperCase();
        const role = String(node.getAttribute?.('role') || node.role || '').toLowerCase();
        const name = `${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''} ${node.getAttribute?.('aria-description') || ''}`;
        if (/\b(un)?mute\b|\bvolume\b|\bsound\b|\bspeaker\b/i.test(name)) {
            return true;
        }
        const buttonLike = tag === 'BUTTON' || tag === 'INPUT' || role === 'button' || role === 'switch';
        if (!buttonLike) {
            return false;
        }
        const cls = typeof node.className === 'string'
            ? node.className
            : String(node.className?.baseVal || node.getAttribute?.('class') || '');
        return /\b(un)?mute\b|\bvolume\b/i.test(cls);
    }

    function eventTargetsPlayerMuteChrome(event) {
        if (typeof event?.composedPath === 'function') {
            return event.composedPath().some(isPlayerMuteChrome);
        }

        let currentNode = event?.target || null;
        while (currentNode) {
            if (isPlayerMuteChrome(currentNode)) {
                return true;
            }
            currentNode = currentNode.parentElement || currentNode.parentNode || null;
        }
        return false;
    }

    function getTrackedMediaElements() {
        const stateManager = window.VolumeControl?.elementStateManager;
        const mediaElements = new Set();
        stateManager?.getActive?.().forEach((entry) => {
            if (entry?.element?.isConnected !== false) {
                mediaElements.add(entry.element);
            }
        });
        stateManager?.corsElements?.forEach?.((element) => {
            if (element?.isConnected !== false) {
                mediaElements.add(element);
            }
        });
        stateManager?.elements?.forEach?.((stateData, trackedElement) => {
            if (trackedElement?.isConnected !== false) {
                mediaElements.add(trackedElement);
            }
        });
        return mediaElements;
    }

    function getTrackedMediaNearEvent(event, mediaElements = getTrackedMediaElements(), options = {}) {
        const pointer = event?.touches?.[0] || event?.changedTouches?.[0] || event;
        const clientX = Number(pointer?.clientX);
        const clientY = Number(pointer?.clientY);
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
            return new Set();
        }
        const forChrome = options.forChrome === true;

        return new Set(Array.from(mediaElements).filter((element) => {
            if (typeof element?.getBoundingClientRect !== 'function') {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const width = Number(rect.width) || 0;
            const height = Number(rect.height) || 0;
            const horizontalPadding = Math.min(forChrome ? 96 : 48, Math.max(forChrome ? 24 : 12, width * (forChrome ? 0.1 : 0.05)));
            const verticalPadding = Math.min(forChrome ? 80 : 64, Math.max(forChrome ? 32 : 20, height * (forChrome ? 0.2 : 0.15)));
            const extraBelow = forChrome ? 96 : 0;
            return clientX >= rect.left - horizontalPadding &&
                clientX <= rect.right + horizontalPadding &&
                clientY >= rect.top - verticalPadding &&
                clientY <= rect.bottom + verticalPadding + extraBelow;
        }));
    }

    function eventIsNearEmbeddedFrame(event) {
        const pointer = event?.touches?.[0] || event?.changedTouches?.[0] || event;
        const clientX = Number(pointer?.clientX);
        const clientY = Number(pointer?.clientY);
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
            return false;
        }

        try {
            return Array.from(document.querySelectorAll?.('iframe') || []).some((frame) => {
                if (typeof frame?.getBoundingClientRect !== 'function') {
                    return false;
                }
                const rect = frame.getBoundingClientRect();
                return clientX >= rect.left &&
                    clientX <= rect.right &&
                    clientY >= rect.top &&
                    clientY <= rect.bottom;
            });
        } catch {
            return false;
        }
    }

    function reportCrossFramePlayerIntent(event, phase) {
        if (event?.isTrusted === false) {
            return;
        }
        const now = Date.now();
        if (
            phase === 'move' &&
            (now - lastCrossFrameIntentReportAt) < CROSS_FRAME_MOVE_REPORT_INTERVAL_MS
        ) {
            return;
        }
        const sendMessage = globalThis.browser?.runtime?.sendMessage;
        if (typeof sendMessage !== 'function') {
            return;
        }
        lastCrossFrameIntentReportAt = now;
        crossFramePlayerIntentSequence += 1;
        void Promise.resolve(sendMessage.call(globalThis.browser.runtime, {
            type: Protocol.Messages.REPORT_PLAYER_VOLUME_INTENT,
            payload: {
                phase,
                gestureId: crossFramePlayerGestureId,
                sequence: crossFramePlayerIntentSequence
            }
        })).catch(() => {});
    }

    function beginCrossFramePlayerIntent(event) {
        if (event?.isTrusted === false) {
            return;
        }
        if (!crossFramePlayerPointerActive) {
            crossFramePlayerPointerActive = true;
            crossFramePlayerGestureCounter += 1;
            crossFramePlayerGestureId = `${Date.now()}-${crossFramePlayerGestureCounter}`;
            crossFramePlayerIntentSequence = 0;
            reportCrossFramePlayerIntent(event, 'start');
            return;
        }
        reportCrossFramePlayerIntent(event, 'move');
    }

    function endCrossFramePlayerIntent(event, cancelled = false) {
        if (!crossFramePlayerPointerActive) {
            return;
        }
        reportCrossFramePlayerIntent(event, cancelled ? 'cancel' : 'end');
        crossFramePlayerPointerActive = false;
        crossFramePlayerGestureId = null;
        resetSliderDragDetection();
    }

    function invalidateRemotePlayerVolumeIntent() {
        window.VolumeControl.__remotePlayerVolumeIntentActive = false;
        window.VolumeControl.__remotePlayerVolumeIntentUsed = true;
        window.VolumeControl.__remotePlayerVolumeIntentElement = null;
        window.VolumeControl.__remotePlayerVolumeIntentAt = 0;
        Array.from(crossFrameIntentWaiters).forEach((finish) => finish());
    }

    function noteUserInteraction(event, startsNewGesture = false) {
        const now = Date.now();
        if (startsNewGesture) {
            localPlayerVolumeIntentElement = null;
        }
        lastInteractionAt = now;
        const interactedMediaElement = getInteractedMediaElement(event);
        const trackedMediaElements = getTrackedMediaElements();
        const nearbyMediaElements = getTrackedMediaNearEvent(event, trackedMediaElements);
        const targetsMuteChrome = eventTargetsPlayerMuteChrome(event);
        if (targetsMuteChrome) {
            getTrackedMediaNearEvent(event, trackedMediaElements, { forChrome: true })
                .forEach((el) => nearbyMediaElements.add(el));
        }
        if (interactedMediaElement) {
            trackedMediaElements.add(interactedMediaElement);
            nearbyMediaElements.add(interactedMediaElement);
        }
        if (eventTargetsTimelineTransportControl(event, trackedMediaElements)) {
            // A seek gesture must also invalidate a previously bound volume gesture.
            endCrossFramePlayerIntent(event, true);
            invalidateRemotePlayerVolumeIntent();
            localPlayerVolumeIntentElement = null;
            lastInteractedMediaElement = null;
            lastVolumeControlInteractionAt = 0;
            lastInteractionTargetsMuteChrome = false;
            lastPointerMediaInteractionAt = 0;
            pointerInteractionMediaElements.clear();
            resetSliderDragDetection();
            return;
        }
        lastInteractedMediaElement = interactedMediaElement || null;
        const targetsVolumeControl = eventTargetsVolumeControl(event);
        lastInteractionTargetsVolumeControl = targetsVolumeControl;
        lastInteractionTargetsMuteChrome = targetsMuteChrome;
        pointerInteractionMediaElements = nearbyMediaElements;
        lastPointerMediaInteractionAt = pointerInteractionMediaElements.size > 0 ? now : 0;
        if (interactedMediaElement || targetsVolumeControl) {
            lastVolumeControlInteractionAt = now;
        } else {
            lastVolumeControlInteractionAt = 0;
        }
        if (targetsVolumeControl || (startsNewGesture && eventIsNearEmbeddedFrame(event))) {
            beginCrossFramePlayerIntent(event);
        }
    }

    function clearConsumedLocalPlayerIntent() {
        lastVolumeControlInteractionAt = 0;
        lastPointerMediaInteractionAt = 0;
        lastInteractedMediaElement = null;
        pointerInteractionMediaElements.clear();
        resetSliderDragDetection();
    }

    function consumePlayerVolumeIntent(element, bindLocalGesture = true) {
        if (
            bindLocalGesture &&
            isLocalPointerHeld() &&
            !localPlayerVolumeIntentElement
        ) {
            localPlayerVolumeIntentElement = element;
        }
        if (!isLocalPointerHeld()) {
            clearConsumedLocalPlayerIntent();
        }
        if (hasRecentCrossFramePlayerIntent(Date.now(), element)) {
            if (!window.VolumeControl.__remotePlayerVolumeIntentElement) {
                window.VolumeControl.__remotePlayerVolumeIntentElement = element;
            }
            if (window.VolumeControl.__remotePlayerVolumeIntentActive === true) {
                window.VolumeControl.__remotePlayerVolumeIntentUsed = true;
                window.VolumeControl.__remotePlayerVolumeIntentAt = Date.now();
            } else {
                window.VolumeControl.__remotePlayerVolumeIntentAt = 0;
            }
        }
    }

    function hasRecentCrossFramePlayerIntent(now = Date.now(), element = null) {
        const intentAt = Number(window.VolumeControl.__remotePlayerVolumeIntentAt) || 0;
        const intentAge = now - intentAt;
        const isActive = Boolean(
            window.VolumeControl.__remotePlayerVolumeIntentActive === true &&
            intentAt > 0 &&
            intentAge >= 0 &&
            intentAge < ACTIVE_GESTURE_FAILSAFE_MS
        );
        const isRecent = isActive ||
            (intentAge >= 0 && intentAge < INTERACTION_TIMEOUT_MS);
        if (!isRecent) {
            return false;
        }
        const boundElement = window.VolumeControl.__remotePlayerVolumeIntentElement;
        return !element || !boundElement || boundElement === element;
    }

    function waitForCrossFramePlayerIntent(element) {
        if (hasRecentCrossFramePlayerIntent(Date.now(), element)) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timeoutId);
                crossFrameIntentWaiters.delete(finish);
                resolve();
            };
            const timeoutId = setTimeout(finish, CROSS_FRAME_INTENT_GRACE_MS);
            crossFrameIntentWaiters.add(finish);
        });
    }

    function resetSliderDragDetection() {
        const manager = window.VolumeControl?.volumeSyncManager;
        const stateManager = window.VolumeControl?.elementStateManager;
        if (!manager || !stateManager) {
            return;
        }

        const elements = new Set();
        stateManager.elements?.forEach?.((stateData, element) => elements.add(element));
        stateManager.corsElements?.forEach?.((element) => elements.add(element));
        elements.forEach((element) => {
            const syncState = manager._getSyncState(element);
            syncState.rapidChangeCount = 0;
            syncState.lastVolumeChangeAt = 0;
            syncState.lastTrackedPlayerVolume = null;
        });
    }

    /**
     * VolumeSyncManager - Manages volume synchronization for all elements
     */
    class VolumeSyncManager {
        constructor() {
            this.elementSyncState = new WeakMap(); // Per-element sync state
            this.deferredPlayerGestureApplies = new Map();
        }

        /**
         * Get or create sync state for an element
         * @private
         */
        _getSyncState(element) {
            if (!this.elementSyncState.has(element)) {
                this.elementSyncState.set(element, {
                    // One guard token per element (see issueGuardToken): the live
                    // echo claim { target, issuedAt, source, lifetime, timeout }
                    // plus the debounce/hijack stamps. Null until first issued.
                    guard: null,
                    isSourceChanging: false,       // True during track/source switch
                    sourceChangeEpoch: 0,
                    sourceChangeTimeout: null,
                    lastVolumeChangeAt: 0,         // For rapid change detection (slider drag)
                    rapidChangeCount: 0,           // Count of rapid changes
                    lastTrackedPlayerVolume: null,
                    muteGestureInteractionAt: 0,
                    unmuteFromZeroAt: 0,           // A user unmute press at managed 0% is waiting for the player's volume
                    handlerEpoch: 0
                });
            }
            return this.elementSyncState.get(element);
        }

        _getMsSinceExtensionChange(element) {
            const lastChangeAt = this._getSyncState(element).guard?.extensionIssuedAt || 0;
            return Date.now() - lastChangeAt;
        }

        _getMsSinceHijackReject(element) {
            const lastRejectAt = this._getSyncState(element).guard?.hijackIssuedAt || 0;
            return Date.now() - lastRejectAt;
        }

        /**
         * Track volume change and detect rapid changes (slider drag pattern)
         * Returns true if this looks like a slider drag
         */
        trackVolumeChange(element, playerVolume = null) {
            const syncState = this._getSyncState(element);
            const now = Date.now();
            const nextPlayerVolume = Number.isFinite(playerVolume)
                ? playerVolume
                : Protocol.nativeVolumeToPercent(element.volume, 0);
            const guardTarget = this.getGuardEchoTarget(element);
            const expectedNative = guardTarget !== null
                ? Math.min(100, guardTarget)
                : null;
            const matchesEchoTarget = expectedNative !== null &&
                Math.abs(nextPlayerVolume - expectedNative) < MIN_CHANGE_PERCENT;
            if (matchesEchoTarget || this.isGuardTokenLive(element, now)) {
                return false;
            }
            const previousPlayerVolume = Number.isFinite(syncState.lastTrackedPlayerVolume)
                ? syncState.lastTrackedPlayerVolume
                : null;

            syncState.lastTrackedPlayerVolume = nextPlayerVolume;

            if (previousPlayerVolume !== null && Math.abs(nextPlayerVolume - previousPlayerVolume) < MIN_CHANGE_PERCENT) {
                return false;
            }

            const timeSinceLastChange = now - syncState.lastVolumeChangeAt;
            
            // If changes are coming rapidly (within 200ms), increment counter
            if (timeSinceLastChange < 200) {
                syncState.rapidChangeCount++;
            } else {
                // Reset counter if gap is too long
                syncState.rapidChangeCount = 1;
            }
            
            syncState.lastVolumeChangeAt = now;
            
            // 3+ rapid changes in a row looks like slider drag
            return syncState.rapidChangeCount >= RAPID_CHANGE_DRAG_COUNT;
        }

        /**
         * Check if element is likely in a slider drag (rapid volume changes)
         */
        isLikelySliderDrag(element, now = Date.now()) {
            const syncState = this._getSyncState(element);
            const timeSinceLastChange = now - syncState.lastVolumeChangeAt;
            // Recent rapid changes suggest ongoing slider drag
            return syncState.rapidChangeCount >= RAPID_CHANGE_DRAG_COUNT && timeSinceLastChange < SLIDER_DRAG_WINDOW_MS;
        }

        /**
         * One intent record: the freshest gesture that can explain a volume
         * write (`slider-drag` | `pointer-media` | `volume-control` |
         * `mute-chrome` | `remote-frame` | `none`). Direct claims beat
         * drag-counter heuristics; binding stays with the readers (binding-blind).
         */
        getRecentUserGesture(element, now = Date.now(), scope = 'full') {
            const localOnly = scope === 'local-fresh';
            const localPointerHeld = !localOnly && isLocalPointerHeld(now);
            const directClaims = [];
            const dragClaim = this.isLikelySliderDrag(element, now)
                ? { kind: 'slider-drag', ageMs: now - this._getSyncState(element).lastVolumeChangeAt }
                : null;

            if (lastInteractedMediaElement === element) {
                const ageMs = now - lastInteractionAt;
                if (ageMs < INTERACTION_TIMEOUT_MS) {
                    directClaims.push({ kind: 'pointer-media', ageMs });
                }
            }
            if (pointerInteractionMediaElements.has(element)) {
                const ageMs = now - lastPointerMediaInteractionAt;
                if (ageMs < INTERACTION_TIMEOUT_MS || localPointerHeld) {
                    directClaims.push({ kind: 'pointer-media', ageMs });
                }
            }
            if (lastVolumeControlInteractionAt > 0) {
                const ageMs = now - lastVolumeControlInteractionAt;
                if (ageMs < INTERACTION_TIMEOUT_MS || localPointerHeld) {
                    directClaims.push({ kind: 'volume-control', ageMs });
                }
            }
            if (lastInteractionTargetsMuteChrome && lastInteractionAt > 0) {
                const ageMs = now - lastInteractionAt;
                if (ageMs < INTERACTION_TIMEOUT_MS || localPointerHeld) {
                    directClaims.push({ kind: 'mute-chrome', ageMs });
                }
            }
            if (!localOnly && hasRecentCrossFramePlayerIntent(now, element)) {
                const intentAt = Number(window.VolumeControl.__remotePlayerVolumeIntentAt) || 0;
                directClaims.push({ kind: 'remote-frame', ageMs: intentAt > 0 ? now - intentAt : 0 });
            }
            if (directClaims.length > 0) {
                directClaims.sort((a, b) => a.ageMs - b.ageMs);
                return directClaims[0];
            }
            if (!localOnly && dragClaim) {
                return dragClaim;
            }
            return { kind: 'none', ageMs: Infinity };
        }

        getPlayerVolumeIntent(element, playerVolume, options = {}) {
            const now = Number.isFinite(options.now) ? options.now : Date.now();
            const isSliderDrag = options.trackChange === false
                ? this.isLikelySliderDrag(element, now)
                : this.trackVolumeChange(element, playerVolume);
            const boundPlayerGestureElement =
                localPlayerVolumeIntentElement ||
                window.VolumeControl.__remotePlayerVolumeIntentElement;
            const activeGestureAllowsElement =
                !boundPlayerGestureElement ||
                boundPlayerGestureElement === element;
            // Thin reader of the record: it applies the held-gesture binding
            // gate, and a drag-counter claim alone still needs a fresh gesture.
            const gesture = this.getRecentUserGesture(element, now);
            const gestureApplies = gesture.kind !== 'none' &&
                (gesture.kind !== 'slider-drag' || isSliderDrag) &&
                activeGestureAllowsElement;
            const interactedThisElement = Boolean(
                (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS &&
                lastInteractedMediaElement === element &&
                activeGestureAllowsElement
            );
            const hasRecentVolumeControlInteraction = Boolean(
                gestureApplies && gesture.kind === 'volume-control'
            );
            const hasRecentPointerMediaInteraction = Boolean(
                gestureApplies && gesture.kind === 'pointer-media'
            );
            const hasCrossFramePlayerIntent = Boolean(
                gestureApplies && gesture.kind === 'remote-frame'
            );
            const sliderDragHasFreshGesture = Boolean(
                isLocalPointerHeld(now) ||
                (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS
            );
            const hasUserVolumeIntent = Boolean(
                gestureApplies &&
                (gesture.kind !== 'slider-drag' || sliderDragHasFreshGesture)
            );

            // A press that toggled mute is spent: pages routinely reset volume (often to 100%)
            // in the same click as an unmute, and that must not be adopted as a volume choice.
            // A slider press or a drag still counts, so unmuting by dragging the slider works.
            const volumeIsMuteSideEffect = Boolean(
                lastInteractionAt > 0 &&
                this._getSyncState(element).muteGestureInteractionAt === lastInteractionAt &&
                !lastInteractionTargetsVolumeControl &&
                !isSliderDrag
            );

            return {
                now,
                isSliderDrag,
                activeGestureAllowsElement,
                interactedThisElement,
                hasRecentVolumeControlInteraction,
                hasRecentPointerMediaInteraction,
                hasCrossFramePlayerIntent,
                volumeIsMuteSideEffect,
                hasUserVolumeIntent: hasUserVolumeIntent && !volumeIsMuteSideEffect
            };
        }

        consumePlayerVolumeIntent(element, bindLocalGesture = true) {
            consumePlayerVolumeIntent(element, bindLocalGesture);
        }

        isSourceChangeActive(element) {
            return this._getSyncState(element).isSourceChanging === true;
        }

        /**
         * Whether a held local or remote gesture is bound to this element. The
         * drag rule comes from the intent record; held-pointer presence
         * semantics are unchanged.
         */
        isPlayerVolumeGestureActive(element) {
            const now = Date.now();
            const localPointerHeld = isLocalPointerHeld(now);
            const localGestureAllowsElement =
                !localPlayerVolumeIntentElement ||
                localPlayerVolumeIntentElement === element;
            const hasLocalElementIntent = Boolean(
                localGestureAllowsElement &&
                (
                    lastInteractedMediaElement === element ||
                    lastVolumeControlInteractionAt > 0 ||
                    pointerInteractionMediaElements.has(element) ||
                    this.isLikelySliderDrag(element)
                )
            );
            const hasRemoteElementIntent = Boolean(
                window.VolumeControl.__remotePlayerVolumeIntentActive === true &&
                hasRecentCrossFramePlayerIntent(now, element)
            );

            return (localPointerHeld && hasLocalElementIntent) || hasRemoteElementIntent;
        }

        /**
         * Queue one source-element apply for gesture end without hiding real player events
         * behind the extension-echo flag.
         */
        deferPlayerGestureApply(element, contextData, isCorsBlocked = false) {
            if (!element || !contextData || (!contextData.gainNode && !isCorsBlocked)) {
                return false;
            }

            this.deferredPlayerGestureApplies.set(element, {
                contextData,
                isCorsBlocked: isCorsBlocked === true
            });
            return true;
        }

        /**
         * Reconcile the latest canonical target after the website finishes its gesture.
         * Preserve raw website volume when it already maps to the managed whole percent.
         * Reading State here (rather than queue time) preserves latest-revision ownership.
         */
        flushDeferredPlayerGestureApplies() {
            const pending = Array.from(this.deferredPlayerGestureApplies.entries());
            this.deferredPlayerGestureApplies.clear();

            const State = window.VolumeControl.State;
            const stateManager = window.VolumeControl.elementStateManager;
            const VolumeController = window.VolumeControl.VolumeController;
            if (!State || State.extensionEnabled === false || !VolumeController) {
                return;
            }

            pending.forEach(([element, entry]) => {
                const { contextData, isCorsBlocked } = entry;
                if (
                    element?.isConnected === false ||
                    stateManager?.get?.(element) !== contextData
                ) {
                    return;
                }

                const latestVolume = State.currentVolumePercent;
                const currentNativeVolume = Protocol.nativeVolumeToPercent(element.volume);
                const nativeAlreadyMatches = latestVolume === 0
                    ? Number(element.volume) === 0
                    : latestVolume <= DEFAULT_VOLUME && currentNativeVolume === latestVolume;
                if (nativeAlreadyMatches) {
                    contextData.lastAppliedVolume = latestVolume;
                    return;
                }

                if (contextData.gainNode) {
                    VolumeController.applyVolume(element, contextData, latestVolume, {
                        force: true,
                        source: 'volume-sync-gesture-end'
                    });
                } else if (isCorsBlocked && VolumeController.applyNativeVolumeOnly) {
                    VolumeController.applyNativeVolumeOnly(element, latestVolume);
                }
            });
        }

        /**
         * Mark that a source change is in progress - reject ALL volume changes
         * This is critical for players that reuse an element across track switches.
         */
        startSourceChange(element, operationEpoch = null) {
            const State = window.VolumeControl.State;
            const syncState = this._getSyncState(element);
            const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
            
            syncState.isSourceChanging = true;
            syncState.sourceChangeEpoch = operationEpoch ?? (syncState.sourceChangeEpoch + 1);
            
            // Also update hijack protection for this element.
            this.markHijackRejected(element);
            
            if (syncState.sourceChangeTimeout) {
                clearTimeout(syncState.sourceChangeTimeout);
            }
            
            // Keep protection active for 2 seconds after source change starts
            const sourceChangeEpoch = syncState.sourceChangeEpoch;
            syncState.sourceChangeTimeout = setTimeout(() => {
                if (syncState.sourceChangeEpoch !== sourceChangeEpoch) {
                    return;
                }
                syncState.isSourceChanging = false;
                syncState.sourceChangeTimeout = null;
                log(`[VolumeSync] Source change timeout expired for ${elementInfo}`);
            }, SOURCE_CHANGE_PROTECTION_MS);
            
            // Enhanced logging
            if (logSourceChange) {
                logSourceChange({
                    phase: 'START',
                    elementInfo,
                    trigger: 'startSourceChange called',
                    extensionVolume: State?.currentVolumePercent,
                    playerVolume: (element.volume * 100).toFixed(1),
                    sourceType: 'unknown'
                });
            }
        }

        /**
         * Mark that source change is complete
         * We keep hijack protection active even after source change ends
         */
        endSourceChange(element, operationEpoch = null) {
            const State = window.VolumeControl.State;
            const syncState = this._getSyncState(element);
            const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;

            if (operationEpoch !== null && syncState.sourceChangeEpoch !== operationEpoch) {
                verbose(`[VolumeSync] Ignoring stale source-change completion for ${elementInfo}`);
                return;
            }
            
            syncState.isSourceChanging = false;
            
            if (syncState.sourceChangeTimeout) {
                clearTimeout(syncState.sourceChangeTimeout);
                syncState.sourceChangeTimeout = null;
            }
            
            // CRITICAL: Extend hijack protection after source change ends
            // This prevents late volume changes from being adopted
            this.markHijackRejected(element);
            
            // Enhanced logging
            if (logSourceChange) {
                logSourceChange({
                    phase: 'END',
                    elementInfo,
                    trigger: 'endSourceChange called',
                    extensionVolume: State?.currentVolumePercent,
                    playerVolume: (element.volume * 100).toFixed(1),
                    hijackProtectionExtendsFor: `${HIJACK_PROTECTION_MS}ms`
                });
            }
        }

        /**
         * Check if source is currently changing for an element
         */
        isSourceChanging(element) {
            return this._getSyncState(element).isSourceChanging;
        }

        /**
         * One guard token per element: the live echo claim plus the debounce
         * (`extensionIssuedAt`) and hijack (`hijackIssuedAt`) stamps. A
         * 'reject' source never extends the debounce, or a fighting page could
         * hold it open forever.
         */
        issueGuardToken(element, targetVolume, source = 'extension') {
            const syncState = this._getSyncState(element);
            const now = Date.now();
            if (syncState.guard?.timeout) {
                clearTimeout(syncState.guard.timeout);
            }
            const guard = syncState.guard || {};
            guard.target = targetVolume;
            guard.source = source;
            guard.issuedAt = now;
            guard.lifetime = source === 'extension'
                ? EXTENSION_VOLUME_LOCK_TIMEOUT_MS
                : PLAYER_ECHO_TIMEOUT_MS;
            if (source === 'extension') {
                guard.extensionIssuedAt = now;
            }
            guard.timeout = setTimeout(() => {
                if (this._getSyncState(element).guard === guard) {
                    guard.target = null;
                    guard.source = null;
                    guard.timeout = null;
                }
            }, guard.lifetime);
            syncState.guard = guard;
            return guard;
        }

        /** Single stale-check for the echo claim. */
        isGuardTokenLive(element, now = Date.now()) {
            const guard = this._getSyncState(element).guard;
            return Boolean(
                guard &&
                guard.target !== null &&
                guard.source !== null &&
                (now - guard.issuedAt) < (guard.lifetime || PLAYER_ECHO_TIMEOUT_MS)
            );
        }

        /** Exact expected target of the live echo claim, or null. */
        getGuardEchoTarget(element) {
            const guard = this._getSyncState(element).guard;
            return guard && guard.source !== null ? guard.target : null;
        }

        /**
         * Single clearer: retracts the echo claim. The debounce/hijack stamps
         * persist, exactly as the old timestamps survived clearApplyingVolume.
         */
        clearGuardToken(element) {
            const syncState = this._getSyncState(element);
            const guard = syncState.guard;
            if (!guard) {
                return;
            }
            if (guard.timeout) {
                clearTimeout(guard.timeout);
                guard.timeout = null;
            }
            guard.target = null;
            guard.source = null;
        }

        /** Record a hijack rejection (3 s policy window, cleared on adopt). */
        markHijackRejected(element) {
            const syncState = this._getSyncState(element);
            syncState.guard = Object.assign({ target: null, source: null }, syncState.guard);
            syncState.guard.hijackIssuedAt = Date.now();
        }

        /** Adopting a volume change releases hijack protection. */
        clearHijackProtection(element) {
            const guard = this._getSyncState(element).guard;
            if (guard) {
                guard.hijackIssuedAt = 0;
            }
        }

        /**
         * Mark that extension is applying volume (from popup or programmatic change)
         * Sets global debounce to block site-initiated resets
         */
        startApplyingVolume(element, targetVolume) {
            this.issueGuardToken(element, targetVolume, 'extension');
        }

        /**
         * Re-apply volume after rejecting a hijack attempt
         * CRITICAL: Does NOT reset the global debounce timestamp - prevents infinite loop
         * 
         * This is the key fix: when we reject a site's volume change and reapply ours,
         * we don't want to reset the debounce window, or else the user can never
         * regain control of the slider after the debounce expires.
         * 
         * @param {boolean} isHijackAttempt - If true, this was a clear hijack attempt (no user activity)
         *                                    and we should activate hijack protection.
         *                                    If false, user was recently active and we should NOT
         *                                    block future events with hijack protection.
         */
        reapplyVolumeAfterReject(element, targetVolume, isHijackAttempt = true) {
            // A reject reapply must never extend the extension debounce window:
            // the issuer only stamps it for 'extension' sources, so a fighting
            // page cannot hold the debounce open forever (no self-trigger loop).
            // ONLY the hijack stamp moves here, and only for clear hijacks.
            if (isHijackAttempt) {
                this.markHijackRejected(element);
            }

            this.issueGuardToken(element, targetVolume, 'reject');
        }

        /**
         * Mark that we're syncing volume from player (user used native slider)
         * Does NOT set global debounce - allows subsequent player changes through
         */
        startApplyingVolumeFromPlayer(element, targetVolume) {
            this.issueGuardToken(element, targetVolume, 'player');
        }

        /** Clear volume application state for an element */
        clearApplyingVolume(element) {
            this.clearGuardToken(element);
        }

        /** Check if we're currently applying volume to an element */
        isApplyingVolume(element) {
            if (
                this.deferredPlayerGestureApplies.has(element) &&
                !this.isPlayerVolumeGestureActive(element)
            ) {
                // The gesture ended without a release event (the failsafe expired). The queued
                // apply carries a confirmed target, so it is flushed, never dropped. Deferred to a
                // microtask: this is a query and may run inside an analysis of a page write.
                Promise.resolve().then(() => this.flushDeferredPlayerGestureApplies());
            }
            return this.isGuardTokenLive(element) ||
                this.deferredPlayerGestureApplies.has(element);
        }

        /** Get target volume for an element */
        getTargetVolume(element) {
            return this.getGuardEchoTarget(element);
        }

        /** Check if we're in the global debounce window */
        isInDebounceWindow(element) {
            return this._getMsSinceExtensionChange(element) < SYNC_DEBOUNCE_MS;
        }

        /** Check if we're in the hijack protection window (recently rejected an attack) */
        isInHijackProtectionWindow(element) {
            return this._getMsSinceHijackReject(element) < HIJACK_PROTECTION_MS;
        }

        /**
         * One policy for every mute change, whatever the capture state of the element:
         * 1. A user action wins, including over an extension mute, which is then released.
         * 2. Without one, the extension defends only a mute it owns (set from the popup).
         * 3. Otherwise the page owns the mute and the change is only observed.
         */
        _decideMuteChange(syncState, context) {
            const State = window.VolumeControl.State;
            const {
                isMuted,
                managedMuteState,
                canDriveSharedState,
                protectsManagedMuteState,
                hasMuteUserIntent,
                now
            } = context;
            const verb = isMuted ? 'muted' : 'unmuted';
            const observed = (type, reason, extra = {}) => ({
                shouldProcess: false,
                reason,
                type,
                muteStateChanged: true,
                newMuteState: isMuted,
                updateSharedMuteState: canDriveSharedState,
                ...extra
            });

            if (hasMuteUserIntent) {
                syncState.lastMuteToggleAt = now;
                syncState.muteGestureInteractionAt = lastInteractionAt;
                return observed('mute-toggle', `User ${verb}`, {
                    releaseMuteOwnership: true,
                    notifyStatusChange: true
                });
            }

            if (State.muteHasBeenSet === true && protectsManagedMuteState) {
                return {
                    shouldProcess: false,
                    reason: `Mute changed without user interaction - restoring ${managedMuteState ? 'muted' : 'unmuted'} state`,
                    type: 'mute-hijack',
                    rejectAndReapply: true,
                    isHijackAttempt: true,
                    reapplyMute: true,
                    reapplyMuteState: managedMuteState
                };
            }

            return observed('mute-observed', `Page ${verb} the media without extension mute ownership`);
        }

        /**
         * User unmuted at managed 0%. 0% is silence, so the player's own volume is the
         * audible answer. A click with no player control, or a page acting alone, does not qualify.
         */
        _unmuteFromZeroQualifies(element, extensionVolume, now) {
            const State = window.VolumeControl.State;
            if (!State.volumeHasBeenSet || extensionVolume !== 0 || document.hidden) {
                return false;
            }
            if (this._getSyncState(element).isSourceChanging) {
                return false;
            }
            const gesture = this.getRecentUserGesture(element, now);
            return gesture.kind === 'pointer-media' ||
                gesture.kind === 'volume-control' ||
                gesture.kind === 'mute-chrome' ||
                gesture.kind === 'remote-frame';
        }

        _unmuteFromZeroAnswer(playerVolume) {
            return {
                shouldProcess: true,
                reason: `Player answered a user unmute at 0% with its own volume (${playerVolume}%)`,
                type: 'unmute-from-zero-player-volume',
                newVolume: playerVolume,
                volumeOwnership: 'player-user'
            };
        }

        /**
         * The mute state a change is judged against: the extension's own mute while it
         * owns one, otherwise the last state observed on the element (the page's).
         */
        getReferenceMuteState(element, stateData) {
            const State = window.VolumeControl.State;
            if (State.muteHasBeenSet) {
                return Boolean(State.currentMutedState);
            }
            return typeof stateData?.observedNativeMutedState === 'boolean'
                ? stateData.observedNativeMutedState
                : Boolean(element.muted);
        }

        /**
         * Mute decision for elements that no dedicated volume handler covers (still
         * setting up, off-DOM, passthrough). Returns null when the mute did not change
         * relative to `options.managedMuteState`.
         */
        analyzeMuteChange(element, options = {}) {
            const isMuted = Boolean(element.muted);
            const managedMuteState = Boolean(options.managedMuteState);
            if (isMuted === managedMuteState) {
                return null;
            }

            const now = Date.now();
            const playerIntent = this.getPlayerVolumeIntent(
                element,
                Protocol.nativeVolumeToPercent(element.volume),
                { now }
            );
            const hasRecentInteraction = (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS || isLocalPointerHeld(now);

            return this._decideMuteChange(this._getSyncState(element), {
                isMuted,
                managedMuteState,
                canDriveSharedState: options.canDriveSharedState !== false,
                protectsManagedMuteState: options.protectsManagedMuteState !== false,
                hasMuteUserIntent: hasRecentInteraction || playerIntent.interactedThisElement || playerIntent.isSliderDrag,
                now
            });
        }

        /**
         * Commit a mute decision: record the observed native state, release the extension
         * mute when the user overrode it, undo a hijack of an owned mute, and tell the badge.
         * @returns {boolean} true when the decision was a mute decision and is fully handled
         */
        applyMuteDecision(element, contextData, result) {
            const State = window.VolumeControl.State;
            const VolumeController = window.VolumeControl.VolumeController;

            if (result.muteStateChanged && contextData) {
                contextData.observedNativeMutedState = result.newMuteState;
                if (result.commitMuteToRestore !== false && (result.releaseMuteOwnership || !State.muteHasBeenSet)) {
                    contextData.nativeMutedSnapshot = result.newMuteState;
                    contextData.userOriginalMutedState = result.newMuteState;
                }
            }

            // A mute -> write -> unmute dance across tasks never judges the stray
            // volume, so an unmute that exposes one reasserts the managed level.
            if (
                result.reapplyMute !== true &&
                !result.unmuteAnswer &&
                State.volumeHasBeenSet &&
                contextData?.isActive?.()
            ) {
                const finalMuted = Boolean(result.newMuteState);
                if (!finalMuted) {
                    const moment = Date.now();
                    const nativePercent = Protocol.nativeVolumeToPercent(element.volume);
                    const strays =
                        Math.abs(nativePercent - Math.min(DEFAULT_VOLUME, State.currentVolumePercent)) >=
                        MIN_CHANGE_PERCENT;
                    // Only a press that can be a volume choice blocks the restore. A press that
                    // toggled mute is spent for volume (a pointer near the media alone does not
                    // make the stray value the user's), while a slider press or drag still counts.
                    const strayIsVolumeChoice = this.getPlayerVolumeIntent(element, nativePercent, {
                        trackChange: false,
                        now: moment
                    }).hasUserVolumeIntent;
                    if (
                        strays &&
                        !strayIsVolumeChoice &&
                        !hasRecentCrossFramePlayerIntent(moment, element)
                    ) {
                        this.reapplyVolumeAfterReject(element, State.currentVolumePercent, true);
                        const stateManager = window.VolumeControl.elementStateManager;
                        if (contextData.gainNode && typeof VolumeController?.applyVolume === 'function') {
                            VolumeController.applyVolume(element, contextData, State.currentVolumePercent, {
                                force: true
                            });
                        } else if (
                            stateManager?.isCorsBlocked?.(element) === true &&
                            typeof VolumeController?.applyNativeVolumeOnly === 'function'
                        ) {
                            VolumeController.applyNativeVolumeOnly(element, State.currentVolumePercent);
                        }
                    }
                }
            }

            if (result.muteStateChanged) {
                if (result.releaseMuteOwnership) {
                    window.VolumeControl.Main?.releaseMuteOwnership?.();
                }
                if (result.updateSharedMuteState !== false) {
                    const oldMuted = State.currentMutedState;
                    State.currentMutedState = result.newMuteState;
                    stateChange('currentMutedState', oldMuted, result.newMuteState, 'volumechange');
                }
                if (result.notifyStatusChange !== false) {
                    window.VolumeControl.notifyPopupOfStatusChange?.();
                }
                return true;
            }

            if (result.reapplyMute === true) {
                VolumeController?.applyMute?.(element, Boolean(result.reapplyMuteState));
                return true;
            }

            return false;
        }

        /**
         * Analyze a player volume change event
         * 
         * Simplified logic:
         * 1. Always accept trusted events (real user actions)
         * 2. During debounce window, reject untrusted events that match our target (echoes)
         * 3. Outside debounce window, accept significant changes
         * 4. When page is hidden, always reject (prevents background hijacking)
         */
        analyzeVolumeChange(element, event, extensionVolume, options = {}) {
            const { 
                isSetupComplete = true, 
                isVisible = true 
            } = options;

            const syncState = this._getSyncState(element);
            const playerVolume = Protocol.nativeVolumeToPercent(element.volume);
            const isTrusted = event.isTrusted;
            const isMuted = element.muted;
            const hasGainNode = options.hasGainNode !== false;
            const isCorsBlocked = options.isCorsBlocked === true;
            const canDriveSharedState = options.canDriveSharedState !== false;
            const State = window.VolumeControl.State;
            const managedMuteState = Object.prototype.hasOwnProperty.call(options, 'managedMuteState')
                ? Boolean(options.managedMuteState)
                : Boolean(State.currentMutedState);
            const muteChanged = isMuted !== managedMuteState;
            const protectsManagedMuteState = Boolean(
                State.extensionEnabled !== false &&
                (hasGainNode || isCorsBlocked)
            );

            const now = Date.now();
            const hasRecentInteraction = (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS || isLocalPointerHeld(now);
            const protectsBoostedManagedVolume = Boolean(
                hasGainNode &&
                !isCorsBlocked &&
                State.volumeHasBeenSet &&
                extensionVolume > DEFAULT_VOLUME
            );

            const playerIntent = this.getPlayerVolumeIntent(element, playerVolume, { now });
            const {
                isSliderDrag,
                activeGestureAllowsElement,
                interactedThisElement,
                hasRecentVolumeControlInteraction,
                hasRecentPointerMediaInteraction,
                hasCrossFramePlayerIntent,
                hasUserVolumeIntent
            } = playerIntent;
            const hasMuteUserIntent = hasRecentInteraction || interactedThisElement || isSliderDrag;
            const hasSecondaryVolumeUserIntent = hasUserVolumeIntent;
            const hasRecentMuteToggle = (now - (syncState.lastMuteToggleAt || 0)) < MUTE_TOGGLE_SUPPRESSION_MS;
            const hasFreshMuteInteraction = isSliderDrag || lastInteractionAt > (syncState.lastMuteToggleAt || 0);
            // 1. Skip if setup not complete
            if (!isSetupComplete) {
                return {
                    shouldProcess: false,
                    reason: 'Setup not complete',
                    type: 'ignored'
                };
            }

            // Mute is arbitrated before any volume rule so a user's mute action is never
            // swallowed by a volume rejection window, and a page's own mute change is only
            // reverted when the extension owns the tab mute.
            if (muteChanged) {
                const muteResult = this._decideMuteChange(syncState, {
                    isMuted,
                    managedMuteState,
                    canDriveSharedState,
                    protectsManagedMuteState,
                    hasMuteUserIntent,
                    now
                });
                if (
                    muteResult.type === 'mute-toggle' &&
                    !isMuted &&
                    this._unmuteFromZeroQualifies(element, extensionVolume, now)
                ) {
                    syncState.unmuteFromZeroAt = now;
                    if (playerVolume >= MIN_CHANGE_PERCENT) {
                        muteResult.unmuteAnswer = this._unmuteFromZeroAnswer(playerVolume);
                    }
                }
                return muteResult;
            }

            if (
                syncState.unmuteFromZeroAt > 0 &&
                (now - syncState.unmuteFromZeroAt) < UNMUTE_ANSWER_MS &&
                !isMuted &&
                playerVolume >= MIN_CHANGE_PERCENT &&
                State.volumeHasBeenSet &&
                extensionVolume === 0 &&
                !document.hidden &&
                !syncState.isSourceChanging
            ) {
                syncState.unmuteFromZeroAt = 0;
                return this._unmuteFromZeroAnswer(playerVolume);
            }

            // 1b. CRITICAL: If source is changing (track switch), REJECT all volume changes
            // This prevents sites from resetting volume on track change
            // Before ownership, a delayed native start volume must still be readable.
            if (syncState.isSourceChanging && State.volumeHasBeenSet) {
                return {
                    shouldProcess: false,
                    reason: 'Source changing - rejecting volume change',
                    type: 'source-changing',
                    rejectAndReapply: true,
                    isHijackAttempt: true  // Track switch = clear hijack, not user slider
                };
            }

            if (
                isMuted &&
                State.volumeHasBeenSet &&
                extensionVolume === 0 &&
                playerVolume >= MIN_CHANGE_PERCENT &&
                !document.hidden
            ) {
                return {
                    shouldProcess: false,
                    reason: `Player volume held while muted at managed 0% (${playerVolume}%)`,
                    type: 'muted-volume-at-zero'
                };
            }

            // Hook confirmation: the hook already classified this write and the
            // quiet path restored it, so confirm the cascade verdict directly.
            // Every fallthrough still runs the legacy cascade.
            const hookSighting = syncState.lastHookSighting;
            const hookEchoTarget = hookSighting?.held === 'restore'
                ? this.getGuardEchoTarget(element)
                : null;
            if (
                hookEchoTarget !== null &&
                isSetupComplete &&
                State.volumeHasBeenSet &&
                !muteChanged &&
                !syncState.isSourceChanging &&
                !document.hidden
            ) {
                const hookExpectedNative = Math.min(100, hookEchoTarget);
                const hookVolumeDiff = Math.abs(playerVolume - hookExpectedNative);
                if (hookVolumeDiff < MIN_CHANGE_PERCENT && (hookVolumeDiff === 0 || !hasUserVolumeIntent)) {
                    syncState.lastHookSighting = null;
                    const cascadeVolumeDiff = Math.abs(playerVolume - extensionVolume);
                    if (this.isInHijackProtectionWindow(element) && !hasUserVolumeIntent) {
                        return {
                            shouldProcess: false,
                            reason: `In hijack protection window - rejecting ${isTrusted ? 'trusted' : 'untrusted'} change (${cascadeVolumeDiff.toFixed(1)}%)`,
                            type: 'hijack-protection-early',
                            rejectAndReapply: true,
                            isHijackAttempt: true,
                            hookConfirmed: true
                        };
                    }
                    return {
                        shouldProcess: false,
                        reason: `Matches target (${playerVolume}% ≈ ${hookExpectedNative}%)`,
                        type: 'echo',
                        hookConfirmed: true
                    };
                }
            }

            // 1c. CRITICAL: If in hijack protection window AND no user interaction, REJECT
            // This applies to BOTH trusted and untrusted events!
            // After track switch, browser may fire trusted volumechange with player's volume
            // EXCEPTION: If rapid volume changes detected (slider drag pattern)
            if (this.isInHijackProtectionWindow(element) && !hasUserVolumeIntent && State.volumeHasBeenSet) {
                return {
                    shouldProcess: false,
                    reason: `In hijack protection window - rejecting ${isTrusted ? 'trusted' : 'untrusted'} change (${Math.abs(playerVolume - extensionVolume).toFixed(1)}%)`,
                    type: 'hijack-protection-early',
                    rejectAndReapply: true,
                    isHijackAttempt: true  // No user interaction = clear hijack
                };
            }

            // 2. CRITICAL: If page is hidden, NEVER adopt volume changes once we own volume
            // This prevents sites from hijacking volume when tab is inactive
            if (document.hidden && State.volumeHasBeenSet) {
                return {
                    shouldProcess: false,
                    reason: 'Page hidden - ignoring volume change',
                    type: 'page-hidden',
                    rejectAndReapply: true,
                    isHijackAttempt: true  // User not on page = clear hijack
                };
            }
            
            // 3. Echo detection - if we just set this volume, ignore the event.
            // The token carries the exact expected target (see issueGuardToken).
            const guardTarget = this.getGuardEchoTarget(element);
            if (guardTarget !== null) {
                const expectedNative = Math.min(100, guardTarget);
                const volumeDiff = Math.abs(playerVolume - expectedNative);
                
                if (
                    volumeDiff < MIN_CHANGE_PERCENT &&
                    (volumeDiff === 0 || !hasUserVolumeIntent)
                ) {
                    return {
                        shouldProcess: false,
                        reason: `Matches target (${playerVolume}% ≈ ${expectedNative}%)`,
                        type: 'echo'
                    };
                }
            }

            // Before ownership, the first significant native volume is the page start volume.
            // Fast capture can finish while the element is still at the HTML default of 100%.
            if (!State.volumeHasBeenSet) {
                const initialVolumeDiff = Math.abs(playerVolume - extensionVolume);
                if (initialVolumeDiff >= MIN_CHANGE_PERCENT) {
                    if (!canDriveSharedState) {
                        // A page that keeps a second controllable element alive (ad slot,
                        // preview player) would otherwise deadlock: passive start volumes
                        // are refused here, but the secondary-media branch below that does
                        // honour user gestures requires ownership to already exist. The tab
                        // then stays unowned forever and no player gesture ever reaches the
                        // badge. An explicit gesture is exactly what that branch accepts, so
                        // let it establish ownership too.
                        if (!hasSecondaryVolumeUserIntent) {
                            return {
                                shouldProcess: false,
                                reason: `Secondary media start volume ignored until tab ownership is established (${initialVolumeDiff.toFixed(1)}%)`,
                                type: 'initial-player-volume-secondary'
                            };
                        }

                        return {
                            shouldProcess: true,
                            reason: `Secondary media player gesture establishes tab ownership (${initialVolumeDiff.toFixed(1)}%)`,
                            type: 'secondary-media-initial-claim',
                            newVolume: playerVolume,
                            volumeOwnership: 'player-user'
                        };
                    }

                    // A passive start volume (a page initializing, fading in, restoring its own
                    // remembered level, an ad slot starting low) is the page's own state, not
                    // a choice the user made. Claiming it stored it per tab, carried it to the
                    // next site in that tab and blocked the page's own later writes. Only a
                    // gesture on the player claims; the tab otherwise reports the live volume.
                    if (!hasUserVolumeIntent) {
                        return {
                            shouldProcess: false,
                            reason: `Passive player start volume ignored, only a user gesture claims it (${playerVolume}%)`,
                            type: 'initial-player-volume-passive'
                        };
                    }

                    return {
                        shouldProcess: true,
                        reason: `Initial player volume before extension ownership (${initialVolumeDiff.toFixed(1)}%)`,
                        type: 'initial-player-volume',
                        newVolume: playerVolume,
                        volumeOwnership: 'player-initial'
                    };
                }
            }

            if (!canDriveSharedState && State.volumeHasBeenSet && (hasGainNode || isCorsBlocked)) {
                const volumeDiff = Math.abs(playerVolume - extensionVolume);

                if (volumeDiff >= MIN_CHANGE_PERCENT) {
                    if (
                        hasSecondaryVolumeUserIntent &&
                        (!hasRecentMuteToggle || interactedThisElement || hasFreshMuteInteraction)
                    ) {
                        return {
                            shouldProcess: true,
                            reason: `Secondary media player change accepted from direct user interaction (${volumeDiff.toFixed(1)}%)`,
                            type: 'secondary-media-player-change',
                            newVolume: playerVolume,
                            volumeOwnership: 'player-user'
                        };
                    }

                    return {
                        shouldProcess: false,
                        reason: `Secondary media volume change ignored to preserve shared tab volume (${volumeDiff.toFixed(1)}%)`,
                        type: 'secondary-media-volume',
                        rejectAndReapply: true,
                        isHijackAttempt: !hasRecentInteraction && !isSliderDrag
                    };
                }
            }

            if (protectsBoostedManagedVolume) {
                const volumeDiff = Math.abs(playerVolume - extensionVolume);
                const allowBoostedPlayerAdoption = hasUserVolumeIntent;

                if (volumeDiff < MIN_CHANGE_PERCENT) {
                    return {
                        shouldProcess: false,
                        reason: `Boosted managed volume unchanged (${volumeDiff.toFixed(1)}%)`,
                        type: 'boosted-insignificant'
                    };
                }

                if (allowBoostedPlayerAdoption) {
                    return {
                        shouldProcess: true,
                        reason: `Boosted managed volume released to player interaction (${volumeDiff.toFixed(1)}%)`,
                        type: 'boosted-player-change',
                        newVolume: playerVolume,
                        volumeOwnership: 'player-user'
                    };
                }

                return {
                    shouldProcess: false,
                    reason: `Boosted managed volume owns state at ${extensionVolume}%`,
                    type: 'boosted-managed-ownership',
                    rejectAndReapply: true,
                    isHijackAttempt: !hasRecentInteraction
                };
            }

            // 4. TRUSTED events are usually user actions, but some players/browser paths
            // can emit trusted volumechange without direct user intent.
            // If extension volume ownership is established and there is no recent user
            // interaction, treat trusted changes as potential delayed site restores.
            if (isTrusted) {
                const volumeDiff = Math.abs(playerVolume - extensionVolume);

                // If extension has claimed volume control, reject passive trusted changes.
                // This protects against delayed player restores while still allowing
                // real user slider changes.
                if (State.volumeHasBeenSet) {
                    if (!hasUserVolumeIntent) {
                        return {
                            shouldProcess: false,
                            reason: `Trusted change without user interaction - rejecting (${volumeDiff.toFixed(1)}%)`,
                            type: 'trusted-no-user-activity',
                            rejectAndReapply: true,
                            isHijackAttempt: true
                        };
                    }
                }
                
                if (volumeDiff < MIN_CHANGE_PERCENT) {
                    // Might be mute toggle
                    if (isMuted !== managedMuteState) {
                        return {
                            shouldProcess: false,
                            reason: `User ${isMuted ? 'muted' : 'unmuted'}`,
                            type: 'mute-toggle',
                            muteStateChanged: true,
                            newMuteState: isMuted
                        };
                    }
                    if (volumeDiff === 0 || !hasUserVolumeIntent) {
                        return {
                            shouldProcess: false,
                            reason: `Change too small (${volumeDiff.toFixed(1)}%)`,
                            type: 'insignificant'
                        };
                    }
                }
                
                return {
                    shouldProcess: true,
                    reason: `Trusted user change (${volumeDiff.toFixed(1)}%)`,
                    type: 'player-change-trusted',
                    newVolume: playerVolume,
                    volumeOwnership: 'player-user'
                };
            }

            // 5. UNTRUSTED events (synthetic) - need more careful handling
            // These commonly come from custom player controls.
            
            const volumeDiff = Math.abs(playerVolume - extensionVolume);
            
            // 5a. Ignore synthetic events while we're actively applying owned volume
            if (this.isGuardTokenLive(element, now) && State.volumeHasBeenSet && !hasUserVolumeIntent) {
                return {
                    shouldProcess: false,
                    reason: 'Synthetic event during apply',
                    type: 'synthetic'
                };
            }
            
            // 5b. In debounce window - be more strict about accepting untrusted events
            if (this.isInDebounceWindow(element) && !hasUserVolumeIntent) {
                // Only reject if change is small (likely echo or hijack attempt)
                // Large changes are probably user actions we couldn't detect
                if (volumeDiff < 10) {
                    return {
                        shouldProcess: false,
                        reason: `In debounce window (${volumeDiff.toFixed(1)}% change)`,
                        type: 'debounce',
                        rejectAndReapply: true,
                        isHijackAttempt: !hasRecentInteraction  // Only hijack if no user activity
                    };
                }
                // Large change - allow through
            }
            
            // 5c. Check for insignificant change
            if (volumeDiff < MIN_CHANGE_PERCENT) {
                // Check mute toggle
                if (isMuted !== managedMuteState) {
                    return {
                        shouldProcess: false,
                        reason: `${isMuted ? 'Muted' : 'Unmuted'} (synthetic)`,
                        type: 'mute-toggle',
                        muteStateChanged: true,
                        newMuteState: isMuted
                    };
                }
                if (volumeDiff === 0 || !hasUserVolumeIntent) {
                    return {
                        shouldProcess: false,
                        reason: `Change too small (${volumeDiff.toFixed(1)}%)`,
                        type: 'insignificant'
                    };
                }
            }

            // 5d. Handle auto-mute from scroll (visibility change)
            if (isMuted && !isVisible) {
                return {
                    shouldProcess: false,
                    reason: 'Auto-mute from scroll',
                    type: 'auto-mute',
                    saveForRestore: true,
                    volumeToSave: extensionVolume
                };
            }

            // 5e. If we recently rejected a hijack attempt, keep rejecting untrusted events
            // This prevents sites from repeatedly trying to reset our volume
            // A correlated player-control interaction can still release ownership.
            if (this.isInHijackProtectionWindow(element) && !hasUserVolumeIntent && State.volumeHasBeenSet) {
                return {
                    shouldProcess: false,
                    reason: `In hijack protection window - rejecting (${volumeDiff.toFixed(1)}%)`,
                    type: 'hijack-protection',
                    rejectAndReapply: true,
                    isHijackAttempt: true  // No user interaction = clear hijack
                };
            }

            // 5f. If we have set volume before, REJECT untrusted events without user interaction
            // This is critical for preventing sites from hijacking.
            // Apply this rule for gainNode-controlled elements AND CORS-blocked (native-only) elements.
            // For CORS elements, this maintains control even without a GainNode.
            if (State.volumeHasBeenSet && (hasGainNode || isCorsBlocked)) {
                if (!hasUserVolumeIntent) {
                    return {
                        shouldProcess: false,
                        reason: `No user interaction - rejecting site change (${volumeDiff.toFixed(1)}%)`,
                        type: 'no-user-activity',
                        rejectAndReapply: true,
                        isHijackAttempt: true  // No user interaction = clear hijack
                    };
                }
                
            }
            
            // 5g. Accept the change - user is interacting
            return {
                shouldProcess: true,
                reason: `Accepting player change with interaction (${volumeDiff.toFixed(1)}%)`,
                type: 'player-change-untrusted',
                newVolume: playerVolume,
                volumeOwnership: 'player-user'
            };
        }

        /**
         * Whether a recent local user action on this player or its volume control explains a
         * volume write. Read only: it records nothing. Thin reader of the one intent
         * record in its binding-blind local-fresh scope (the held-gesture branch above
         * already covers held and remote claims, exactly as before).
         */
        hasImmediatePlayerIntent(element, now = Date.now()) {
            if (this.isPlayerVolumeGestureActive(element)) {
                return true;
            }
            return this.getRecentUserGesture(element, now, 'local-fresh').kind !== 'none';
        }

        /**
         * Synchronous half of the defence against sites that rewrite their own volume.
         *
         * Firefox applies element.volume to the output within the next audio block, but the
         * `volumechange` event that drives the decision is an asynchronous task, so any delay
         * before it runs is audible. The MAIN-world volume hook announces each changing page
         * write from inside the write itself; this raises a gain mask in that same task, which
         * lands in the same audio batch as the page's value, so the output never moves. The
         * volumechange handler later decides as usual: restoring native volume releases the
         * mask (VolumeController.applyVolume), and every other exit releases it in handler().
         *
         * A quiet top frame needs no mask at all: nothing can still explain the write (see
         * isQuietPageWrite), so the managed native volume is put back as soon as the page's own
         * script returns, in the same task. Firefox forwards element.volume to the output once
         * per task, so a value that is back before the task ends is never heard, while a
         * restore made in a later task (the volumechange event) can leak up to a few blocks.
         * The page still reads its own value for the rest of its script.
         *
         * Nothing is decided here, and a write that user intent explains is left alone.
         *
         * @param {*} element - `detail` of the hook event (validated by the state lookup)
         * @returns {boolean} - Whether the write is held (a mask is up, or a restore is queued)
         */
        holdPageVolumeWrite(element) {
            if (!element || (element instanceof HTMLAudioElement && !element.isConnected)) {
                return false;
            }
            const State = window.VolumeControl.State;
            const contextData = this.getPageWriteHoldContext(element);
            if (!contextData) {
                return false;
            }

            if (this.isQuietPageWrite(contextData) && this.canRestoreNativeVolume(element, contextData)) {
                this.stampHookSighting(element, 'restore');
                this.queueQuietPageWriteRestore(element);
                return true;
            }

            const mask = window.VolumeControl.VolumeController?.maskPageVolumeWrite?.(
                element,
                contextData,
                State.currentVolumePercent,
                State.currentCompressionEnabled === true
            );
            this.stampHookSighting(element, mask ? 'mask' : null);
            return Boolean(mask);
        }

        /** Records the hook's classification for the confirmation decision. */
        stampHookSighting(element, held) {
            this._getSyncState(element).lastHookSighting = {
                volume: element.volume,
                at: Date.now(),
                held
            };
        }

        /**
         * State of an owned, managed element whose page write is not the managed level and is not
         * explained by user intent or a mute change; null when the write needs no hold.
         */
        getPageWriteHoldContext(element) {
            const State = window.VolumeControl.State;
            const contextData = window.VolumeControl.elementStateManager?.get?.(element);
            if (
                !contextData ||
                !contextData.isActive?.() ||
                !State.volumeHasBeenSet ||
                State.extensionEnabled === false
            ) {
                return null;
            }

            const now = Date.now();
            const pageVolume = Protocol.nativeVolumeToPercent(element.volume);
            const unmuteAt = this._getSyncState(element).unmuteFromZeroAt || 0;
            const unmuteAnswerPending = unmuteAt > 0 && (now - unmuteAt) < UNMUTE_ANSWER_MS;
            if (
                pageVolume === Math.min(DEFAULT_VOLUME, State.currentVolumePercent) ||
                element.muted !== this.getReferenceMuteState(element, contextData) ||
                this.hasImmediatePlayerIntent(element, now) ||
                hasRecentCrossFramePlayerIntent(now, element) ||
                (element.muted && State.currentVolumePercent === 0) ||
                unmuteAnswerPending
            ) {
                return null;
            }
            return contextData;
        }

        /**
         * Whether no gesture can still explain this write: top frame, no recent
         * interaction, no held pointer, no mask up. Stricter than the intent
         * check on purpose: every adoption path needs one of those signals.
         */
        isQuietPageWrite(contextData) {
            return (
                window.top === window &&
                !contextData.gainMask &&
                !isLocalPointerHeld() &&
                (Date.now() - lastInteractionAt) >= INTERACTION_TIMEOUT_MS
            );
        }

        /** The decision engine restores through the gain graph, or natively when CORS blocks it. */
        canRestoreNativeVolume(element, contextData) {
            const stateManager = window.VolumeControl.elementStateManager;
            return Boolean(
                contextData.setupComplete !== false &&
                (contextData.gainNode || stateManager?.isCorsBlocked?.(element) === true)
            );
        }

        /**
         * Put the managed native volume back after the page's script returns (microtask: still
         * the page's task, so before Firefox forwards the page's value to the output). A burst of
         * writes queues several and the first one restores them all. Everything is re-checked on
         * wake-up: the managed volume, ownership and gestures may have changed since the write.
         */
        queueQuietPageWriteRestore(element) {
            Promise.resolve().then(() => {
                try {
                    const contextData = element.isConnected !== false
                        ? this.getPageWriteHoldContext(element)
                        : null;
                    if (
                        !contextData ||
                        !this.isQuietPageWrite(contextData) ||
                        !this.canRestoreNativeVolume(element, contextData)
                    ) {
                        return;
                    }
                    const State = window.VolumeControl.State;
                    // The same bookkeeping as a rejected write, so the volumechange event for it
                    // meets the hijack window and echo flags the decision itself would have set.
                    this.reapplyVolumeAfterReject(element, State.currentVolumePercent, true);
                    window.VolumeControl.VolumeController?.applyNativeVolumeOnly?.(element, State.currentVolumePercent);
                } catch (err) {
                    verbose('[VolumeSync] Quiet page write restore failed:', err);
                }
            });
        }

        /**
         * Create and attach a volume change handler for an element
         */
        attachVolumeChangeHandler(element, contextData) {
            const State = window.VolumeControl.State;
            const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
            const stateManager = window.VolumeControl.elementStateManager;
            const syncState = this._getSyncState(element);
    
            // Remove existing handler if present
            if (contextData.volumeSyncHandler) {
                element.removeEventListener('volumechange', contextData.volumeSyncHandler);
            }

            const handlerEpoch = contextData.beginOperation
                ? contextData.beginOperation('volumeSync')
                : (syncState.handlerEpoch + 1);
            syncState.handlerEpoch = handlerEpoch;
    
            const handleVolumeChange = async (event) => {
                if (contextData.isOperationCurrent && !contextData.isOperationCurrent('volumeSync', handlerEpoch)) {
                    verbose(`[VolumeSync] Ignoring stale handler event for ${elementInfo}`);
                    return;
                }

                if (!element.isConnected) {
                    return;
                }

                const currentStateData = stateManager?.get?.(element);
                if (!currentStateData || currentStateData !== contextData) {
                    return;
                }

                const pendingNow = Date.now();
                const pendingPlayerVolume = Protocol.nativeVolumeToPercent(element.volume);
                const pendingManagedMuteState = this.getReferenceMuteState(element, contextData);
                const hasImmediatePlayerIntent = this.hasImmediatePlayerIntent(element, pendingNow);
                // The grace only exists for a control in a sibling frame that reports a gesture
                // a few ms after the media frame already fired. Nothing can report to the top
                // frame that way, and a passive page write is audible until it is restored, so
                // only child frames wait. Identity comparison only: never read the top window.
                // pendingPlayerVolume is native percent (0-100), so compare with the native
                // target; a boosted target keeps native at 100 and its own echoes need no wait.
                const shouldAwaitCrossFrameIntent = Boolean(
                    State.volumeHasBeenSet &&
                    window.top !== window &&
                    pendingPlayerVolume !== Math.min(DEFAULT_VOLUME, State.currentVolumePercent) &&
                    element.muted === pendingManagedMuteState &&
                    !document.hidden &&
                    !syncState.isSourceChanging &&
                    !hasImmediatePlayerIntent &&
                    !hasRecentCrossFramePlayerIntent(pendingNow, element)
                );
                if (shouldAwaitCrossFrameIntent) {
                    // The page's own level is held by the gain mask that holdPageVolumeWrite
                    // raised inside the page's write (never by writing native volume: a held
                    // cross-frame gesture must not rewrite the source).
                    await waitForCrossFramePlayerIntent(element);
                    if (
                        !element.isConnected ||
                        (contextData.isOperationCurrent &&
                            !contextData.isOperationCurrent('volumeSync', handlerEpoch)) ||
                        stateManager?.get?.(element) !== contextData
                    ) {
                        return;
                    }
                }

                // Evaluate CORS state per event so source changes are reflected immediately.
                const isCorsBlocked = !!(stateManager && stateManager.isCorsBlocked && stateManager.isCorsBlocked(element));
                const now = Date.now();
                const currentSyncState = this._getSyncState(element);
                const playerVolume = Protocol.nativeVolumeToPercent(element.volume);
                const volumeDiff = Math.abs(playerVolume - State.currentVolumePercent);
                const managedMuteState = this.getReferenceMuteState(element, contextData);
                const canDriveSharedState = (() => {
                    const controllableElements = new Set();
                    const activeEntries = typeof stateManager?.getActive === 'function'
                        ? stateManager.getActive()
                        : [];

                    activeEntries.forEach((entry) => {
                        const activeElement = entry?.element;
                        if (activeElement?.isConnected) {
                            controllableElements.add(activeElement);
                        }
                    });

                    if (stateManager?.corsElements?.forEach) {
                        stateManager.corsElements.forEach((corsElement) => {
                            if (corsElement?.isConnected) {
                                controllableElements.add(corsElement);
                            }
                        });
                    }

                    return controllableElements.size === 0 ||
                        (controllableElements.size === 1 && controllableElements.has(element));
                })();
                
                let result = this.analyzeVolumeChange(element, event, State.currentVolumePercent, {
                    isSetupComplete: contextData.setupComplete !== false,
                    isVisible: contextData.isIntersecting !== false,
                    hasGainNode: !!contextData.gainNode,
                    isCorsBlocked,
                    managedMuteState,
                    canDriveSharedState
                });
                const hasRecentInteraction = (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS || isLocalPointerHeld(now);
                const interactedThisElement = Boolean(
                    (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS &&
                    lastInteractedMediaElement === element
                );
                const isSliderDrag = this.isLikelySliderDrag(element);
                const msSinceLastInteraction = lastInteractionAt > 0 ? now - lastInteractionAt : null;
                const msSinceLastMuteToggle = currentSyncState.lastMuteToggleAt
                    ? now - currentSyncState.lastMuteToggleAt
                    : null;
                // COMPREHENSIVE DEBUG LOGGING
                if (logVolumeEvent) {
                    logVolumeEvent({
                        elementInfo,
                        eventType: event.type,
                        isTrusted: event.isTrusted,
                        playerVolume,
                        extensionVolume: State.currentVolumePercent,
                        volumeDiff,
                        isMuted: element.muted,
                        // Protection state
                        isSourceChanging: currentSyncState.isSourceChanging,
                        isApplyingVolume: this.isGuardTokenLive(element, now),
                        targetVolume: this.getGuardEchoTarget(element),
                        inDebounceWindow: this.isInDebounceWindow(element),
                        msSinceExtensionChange: this._getMsSinceExtensionChange(element),
                        inHijackProtection: this.isInHijackProtectionWindow(element),
                        msSinceHijackReject: this._getMsSinceHijackReject(element),
                        rapidChangeCount: currentSyncState.rapidChangeCount,
                        lastTrackedPlayerVolume: currentSyncState.lastTrackedPlayerVolume,
                        // User interaction
                        hasRecentInteraction,
                        interactedThisElement,
                        isMouseDown,
                        isPointerDown,
                        isSliderDrag,
                        msSinceLastInteraction,
                        msSinceLastMuteToggle,
                        // Context
                        pageHidden: document.hidden,
                        isVisible: contextData.isIntersecting !== false,
                        hasGainNode: !!contextData.gainNode,
                        setupComplete: contextData.setupComplete !== false,
                        volumeHasBeenSet: State.volumeHasBeenSet,
                        muteHasBeenSet: State.muteHasBeenSet,
                        managedMuteState,
                        observedNativeMutedState: contextData.observedNativeMutedState,
                        nativeMutedSnapshot: contextData.nativeMutedSnapshot,
                        canDriveSharedState,
                        isCorsBlocked,
                        // Decision
                        decision: result
                    });
                }

                if (logDiagnostic && (result.muteStateChanged || result.rejectAndReapply || result.shouldProcess)) {
                    logDiagnostic('volume-sync-decision', {
                        elementInfo,
                        decisionType: result.type,
                        decisionReason: result.reason,
                        isTrusted: event.isTrusted,
                        shouldProcess: result.shouldProcess === true,
                        rejectAndReapply: result.rejectAndReapply === true,
                        reapplyMute: result.reapplyMute === true,
                        reapplyMuteState: result.reapplyMuteState ?? null,
                        muteStateChanged: result.muteStateChanged === true,
                        newMuteState: result.newMuteState,
                        playerVolume,
                        extensionVolume: State.currentVolumePercent,
                        elementMuted: element.muted,
                        managedMuteState,
                        muteHasBeenSet: State.muteHasBeenSet,
                        canDriveSharedState,
                        isCorsBlocked,
                        hasRecentInteraction,
                        interactedThisElement,
                        isSliderDrag,
                        rapidChangeCount: currentSyncState.rapidChangeCount,
                        lastTrackedPlayerVolume: currentSyncState.lastTrackedPlayerVolume,
                        msSinceLastInteraction,
                        msSinceLastMuteToggle,
                        observedNativeMutedState: contextData.observedNativeMutedState,
                        nativeMutedSnapshot: contextData.nativeMutedSnapshot,
                        contextManagedMutedState: contextData.managedMutedState,
                        decision: result
                    }, { threshold: 3 });
                }

                verbose(`[VolumeSync] ${elementInfo}: ${result.reason} (type: ${result.type})`);

                // Mute decisions (user action, defended extension mute, page-owned mute)
                if (result.muteStateChanged) {
                    this.applyMuteDecision(element, contextData, result);
                    if (!result.unmuteAnswer) {
                        return;
                    }
                    result = result.unmuteAnswer;
                }

                // Handle rejection with re-apply
                if (result.rejectAndReapply) {
                    const VolumeController = window.VolumeControl.VolumeController;
                    if (VolumeController) {
                        const isHijack = result.isHijackAttempt !== false; // Default to true for safety
                        const deferSourceApply = !isHijack &&
                            this.isPlayerVolumeGestureActive(element) &&
                            this.deferPlayerGestureApply(element, contextData, isCorsBlocked);

                        if (!deferSourceApply) {
                            this.deferredPlayerGestureApplies.delete(element);
                            log(`[VolumeSync] REJECTING and re-applying ${State.currentVolumePercent}% (was ${playerVolume}%)`);
                            // Use reapplyVolumeAfterReject - doesn't reset debounce timestamp.
                            // Pass isHijackAttempt to control whether hijack protection is activated.
                            this.reapplyVolumeAfterReject(element, State.currentVolumePercent, isHijack);

                            if (contextData.gainNode) {
                                VolumeController.applyVolume(
                                    element,
                                    contextData,
                                    State.currentVolumePercent,
                                    { force: true }
                                );
                            } else if (isCorsBlocked && VolumeController.applyNativeVolumeOnly) {
                                VolumeController.applyNativeVolumeOnly(element, State.currentVolumePercent);
                            }
                        }

                        if (result.reapplyMute === true && typeof VolumeController.applyMute === 'function') {
                            VolumeController.applyMute(element, Boolean(result.reapplyMuteState ?? managedMuteState));
                        }
                    }
                    return;
                }

                // Handle save for restore (auto-mute)
                if (result.saveForRestore) {
                    if ((contextData.volumeBeforeInvisible === null || contextData.volumeBeforeInvisible === undefined) 
                        && result.volumeToSave > 0) {
                        contextData.volumeBeforeInvisible = result.volumeToSave;
                        contextData.wasAutoMuted = true;
                        verbose(`[VolumeSync] Saved ${result.volumeToSave}% for restoration`);
                    }
                    return;
                }

                // Handle accepted change
                if (result.shouldProcess) {
                    this.consumePlayerVolumeIntent(
                        element,
                        result.volumeOwnership !== 'player-initial'
                    );
                    decision(true, `[VolumeSync] ADOPTING player volume: ${result.newVolume}%`);
                    log(`[VolumeSync] ⚠️ VOLUME ADOPTED from player: ${result.newVolume}% on ${elementInfo} (was ${State.currentVolumePercent}%)`);

                    // CRITICAL: Always reset hijack protection when adopting a volume change
                    // This ensures the user can continue using the native slider
                    // Even for visibility-related changes, we need to reset or user gets stuck
                    this.clearHijackProtection(element);

                    // Update extension state
                    const oldVolume = State.currentVolumePercent;
                    const ownershipSource = result.volumeOwnership === 'player-initial'
                        ? Protocol.VolumeControlSource.PLAYER_INITIAL
                        : Protocol.VolumeControlSource.PLAYER_USER;
                    const isHeldPlayerGesture = Boolean(
                        ownershipSource === Protocol.VolumeControlSource.PLAYER_USER &&
                        this.isPlayerVolumeGestureActive(element)
                    );
                    const commitWork = window.VolumeControl.VolumeOwnership.commitManagedVolume(
                        result.newVolume,
                        ownershipSource,
                        { immediatePersist: true }
                    );
                    const committedVolume = State.currentVolumePercent;
                    contextData.observedNativeVolume = element.volume;
                    contextData.nativeVolumeSnapshot = element.volume;
                    contextData.userOriginalVolume = element.volume;
                    stateChange('currentVolumePercent', oldVolume, committedVolume, 'native player');

                    // Clear any pending volume application
                    this.clearApplyingVolume(element);

                    // Apply through VolumeController so gain/native behavior stays
                    // consistent across browser/capture mode differences.
                    const VolumeController = window.VolumeControl.VolumeController;
                    if (VolumeController && contextData.gainNode) {
                        if (
                            isHeldPlayerGesture &&
                            this.deferPlayerGestureApply(element, contextData, false)
                        ) {
                            // A website slider owns native volume during the hold. Gain-only
                            // normalization releases a previous >100% boost without moving it,
                            // and puts back a gain that is off for any reason (gain is 1 up to
                            // 100%), so a held drag can never leave the audio silent. It is
                            // idempotent, parks under a live page-write mask, and writes no
                            // native volume.
                            VolumeController.applyGainOnly?.(contextData, committedVolume);
                        } else {
                            this.deferredPlayerGestureApplies.delete(element);
                            VolumeController.applyVolume(element, contextData, committedVolume, {
                                force: true,
                                source: 'volume-sync-adopt'
                            });
                            contextData.lastAppliedVolume = committedVolume;
                        }
                    }
                    
                    // Sync OTHER active / native-only elements
                    window.VolumeControl.Main?.applyVolumeToOtherElements?.(element, committedVolume, {
                        fromPlayer: true
                    });
                    
                    // Persist to storage
                    if (window.VolumeControl.scheduleStorageWrite) {
                        window.VolumeControl.scheduleStorageWrite(
                            window.VolumeControl.SESSION_STORAGE_KEY_VOLUME,
                            committedVolume.toString()
                        );
                    }

                    // Notify popup
                    if (window.VolumeControl.notifyPopupOfStatusChange) {
                        void Promise.resolve(commitWork).then(() => {
                            window.VolumeControl.notifyPopupOfStatusChange();
                        });
                    }
                } else {
                    decision(false, `[VolumeSync] Ignoring: ${result.reason}`);
                    this.reportUnownedNativeVolume(element, contextData);
                }
            };

            const handler = async (event) => {
                // Raised synchronously inside the page's write by holdPageVolumeWrite, if at all.
                const mask = contextData.gainMask;
                try {
                    await handleVolumeChange(event);
                } finally {
                    // applyVolume already released it when the decision restored native volume.
                    // This covers every exit that did not: an ignored change, a held-gesture
                    // adopt (no source rewrite), a stale or disconnected element.
                    if (mask) {
                        window.VolumeControl.VolumeController?.releasePageVolumeMask?.(contextData, mask);
                    }
                }
            };

            element.addEventListener('volumechange', handler);
            contextData.volumeSyncHandler = handler;
            verbose(`[VolumeSync] Attached handler to ${elementInfo}`);
        }

        /**
         * Push the player's current volume to the background while the tab is unowned.
         *
         * The toolbar badge renders from pushed STATUS_UPDATE messages, but an unowned
         * tab reports the media element's live volume rather than a managed target. A
         * player change that we deliberately do not adopt therefore still moves the value
         * the popup would display, and without this nothing tells the background about it
         * — the badge stays frozen at the load-time value until something else happens to
         * probe the frame. Adoption paths notify on their own, so this only covers the
         * ignored ones.
         *
         * The same applies to the live mute state, which status reports until the
         * extension's own mute is used, owned or not; an ignored player unmute must
         * still repaint the red badge.
         */
        reportUnownedNativeVolume(element, contextData) {
            if (!contextData) {
                return;
            }

            const isManaged = window.VolumeControl.VolumeOwnership?.isManaged?.() !== false;
            const reportsLiveMute = window.VolumeControl.State?.muteHasBeenSet !== true;
            // Managed tabs report the target, not raw native volume. Clearing the cache
            // makes a tab that returns to unowned report its first change.
            const observedVolume = isManaged ? null : Protocol.nativeVolumeToPercent(element.volume);
            const observedMuted = reportsLiveMute ? Boolean(element.muted) : null;
            if (!isManaged || reportsLiveMute) {
                // A drag emits a long burst of events; only report real movement so the
                // background is not flooded with identical payloads.
                const changed = contextData.lastReportedUnownedVolume !== observedVolume ||
                    contextData.lastReportedMutedState !== observedMuted;
                contextData.lastReportedUnownedVolume = observedVolume;
                contextData.lastReportedMutedState = observedMuted;
                const notify = window.VolumeControl.notifyPopupOfStatusChange;
                if (changed && typeof notify === 'function') {
                    notify();
                }
                return;
            }
            contextData.lastReportedUnownedVolume = null;
            contextData.lastReportedMutedState = null;
        }

        /** Remove volume change handler from element */
        removeVolumeChangeHandler(element, contextData) {
            if (contextData.volumeSyncHandler) {
                element.removeEventListener('volumechange', contextData.volumeSyncHandler);
                delete contextData.volumeSyncHandler;
            }
            if (contextData.invalidateOperation) {
                contextData.invalidateOperation('volumeSync');
            }
            this.clearApplyingVolume(element);
        }

        /** Cleanup all state for an element */
        cleanup(element) {
            const syncState = this.elementSyncState.get(element);
            if (syncState?.guard?.timeout) {
                clearTimeout(syncState.guard.timeout);
            }
            if (syncState?.sourceChangeTimeout) {
                clearTimeout(syncState.sourceChangeTimeout);
            }
            this.deferredPlayerGestureApplies.delete(element);
            this.elementSyncState.delete(element);
        }
    }

    // Create singleton instance and export
    const instance = new VolumeSyncManager();
    
    // Export both class and instance (for backward compatibility)
    window.VolumeControl.VolumeSyncManager = VolumeSyncManager;
    window.VolumeControl.volumeSyncManager = instance;

    globalThis.browser?.runtime?.onMessage?.addListener?.((message) => {
        if (message?.type === Protocol.Messages.PLAYER_VOLUME_INTENT) {
            const payload = message.payload || {};
            const phase = ['start', 'move', 'end', 'cancel'].includes(payload.phase)
                ? payload.phase
                : 'pulse';
            const gestureKey = `${payload.originFrameId ?? 0}:${payload.gestureId ?? 'legacy'}`;
            const sequence = Math.max(0, Math.floor(Number(payload.sequence) || 0));
            const currentGestureKey = window.VolumeControl.__remotePlayerVolumeIntentGestureKey;
            const currentSequence = Number(window.VolumeControl.__remotePlayerVolumeIntentSequence) || 0;
            const currentIntentAt = Number(window.VolumeControl.__remotePlayerVolumeIntentAt) || 0;

            if (
                (phase === 'end' || phase === 'cancel') &&
                currentGestureKey &&
                currentGestureKey !== gestureKey
            ) {
                return;
            }
            if (
                currentGestureKey === gestureKey &&
                sequence > 0 &&
                sequence <= currentSequence
            ) {
                return;
            }

            const isNewGesture = currentGestureKey !== gestureKey;
            if (((phase === 'start' || phase === 'move') && isNewGesture) || phase === 'pulse') {
                window.VolumeControl.__remotePlayerVolumeIntentUsed = false;
                window.VolumeControl.__remotePlayerVolumeIntentElement = null;
            } else if (phase === 'cancel') {
                window.VolumeControl.__remotePlayerVolumeIntentElement = null;
            }

            const intentWasUsed = window.VolumeControl.__remotePlayerVolumeIntentUsed === true;
            const currentIntentAge = Date.now() - currentIntentAt;
            const activeGestureExpired = Boolean(
                currentGestureKey === gestureKey &&
                window.VolumeControl.__remotePlayerVolumeIntentActive === true &&
                currentIntentAt > 0 &&
                currentIntentAge >= ACTIVE_GESTURE_FAILSAFE_MS
            );
            window.VolumeControl.__remotePlayerVolumeIntentGestureKey = gestureKey;
            window.VolumeControl.__remotePlayerVolumeIntentSequence = sequence;
            window.VolumeControl.__remotePlayerVolumeIntentActive = phase === 'start' || phase === 'move';
            window.VolumeControl.__remotePlayerVolumeIntentAt =
                phase === 'cancel' || (phase === 'end' && (intentWasUsed || activeGestureExpired))
                    ? 0
                    : Date.now();
            if (phase === 'end' || phase === 'cancel') {
                resetSliderDragDetection();
                instance.flushDeferredPlayerGestureApplies();
            }
            Array.from(crossFrameIntentWaiters).forEach((finish) => finish());
        }
    });

    // Simple interaction tracking (with unload cleanup)
    const capturePassive = { capture: true, passive: true };
    const isTrustedInteractionEvent = (event) => event?.isTrusted !== false;
    const clearLocalPlayerGestureIfReleased = () => {
        if (!isMouseDown && !isPointerDown) {
            const consumedHeldGesture = Boolean(localPlayerVolumeIntentElement);
            localPlayerVolumeIntentElement = null;
            if (consumedHeldGesture) {
                clearConsumedLocalPlayerIntent();
            } else {
                resetSliderDragDetection();
            }
        }
    };
    const clearCancelledLocalPlayerGesture = () => {
        lastInteractionAt = 0;
        lastPointerActivityAt = 0;
        pressedPointerType = null;
        localPlayerVolumeIntentElement = null;
        clearConsumedLocalPlayerIntent();
    };

    const onMouseDown = (event) => {
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        const startsNewGesture = !isLocalPointerHeld();
        isMouseDown = true;
        // Browsers fire the compatibility mouse events after the pointer events of the same press,
        // so a pointer press keeps the type it reported.
        notePointerPress(isPointerDown ? pressedPointerType : 'mouse');
        noteUserInteraction(event, startsNewGesture);
    };
    const onMouseUp = (event) => {
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        isMouseDown = false;
        if (!isPointerDown) {
            pressedPointerType = null;
        }
        endCrossFramePlayerIntent(event);
        instance.flushDeferredPlayerGestureApplies();
        clearLocalPlayerGestureIfReleased();
    };
    const onTouchStart = (event) => {
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        const startsNewGesture = !isLocalPointerHeld();
        isMouseDown = true;
        notePointerPress('touch');
        noteUserInteraction(event, startsNewGesture);
    };
    const onTouchEnd = (event) => {
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        isMouseDown = false;
        if (!isPointerDown) {
            pressedPointerType = null;
        }
        endCrossFramePlayerIntent(event);
        instance.flushDeferredPlayerGestureApplies();
        clearLocalPlayerGestureIfReleased();
    };
    const onTouchCancel = (event) => {
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        isMouseDown = false;
        isPointerDown = false;
        endCrossFramePlayerIntent(event, true);
        clearCancelledLocalPlayerGesture();
        instance.flushDeferredPlayerGestureApplies();
    };
    const onKeyDown = (event) => {
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        noteUserInteraction(event);
    };
    const onPointerDown = (event) => {
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        const startsNewGesture = !isLocalPointerHeld();
        isPointerDown = true;
        notePointerPress(event?.pointerType || 'mouse');
        noteUserInteraction(event, startsNewGesture);
    };
    const onPointerUp = (event) => {
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        isPointerDown = false;
        if (!isMouseDown) {
            pressedPointerType = null;
        }
        endCrossFramePlayerIntent(event);
        instance.flushDeferredPlayerGestureApplies();
        clearLocalPlayerGestureIfReleased();
    };
    const onPointerCancel = (event) => {
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        isMouseDown = false;
        isPointerDown = false;
        endCrossFramePlayerIntent(event, true);
        clearCancelledLocalPlayerGesture();
        instance.flushDeferredPlayerGestureApplies();
    };
    // A mouse move that reports no pressed buttons proves the press ended somewhere no up event
    // reached this document (released outside an iframe or the window). Release exactly as a
    // pointerup would, for both flags. Touch and pen moves are not read this way, and a mouse move
    // never ends a press that began as touch or pen (hybrid devices send stray mouse moves).
    const releaseStuckPointerGesture = (event) => {
        isMouseDown = false;
        isPointerDown = false;
        pressedPointerType = null;
        endCrossFramePlayerIntent(event);
        instance.flushDeferredPlayerGestureApplies();
        clearLocalPlayerGestureIfReleased();
    };
    const onPointerMove = (e) => {
        if (!isTrustedInteractionEvent(e)) {
            return;
        }
        if (
            (isMouseDown || isPointerDown) &&
            typeof e.buttons === 'number' &&
            e.buttons === 0 &&
            isMouseMoveEvent(e) &&
            pressedPointerType !== 'touch' &&
            pressedPointerType !== 'pen'
        ) {
            releaseStuckPointerGesture(e);
            return;
        }
        if (isPointerDown || e.buttons > 0) {
            lastInteractionAt = Date.now();
            if (isMouseDown || isPointerDown) {
                lastPointerActivityAt = lastInteractionAt;
            }
            if (crossFramePlayerPointerActive) {
                reportCrossFramePlayerIntent(e, 'move');
            }
        }
    };
    const onWheel = (event) => {
        // A trusted wheel over a volume control is a user gesture: stamp the
        // pointer-equivalent interaction so the write it drives adopts.
        if (!isTrustedInteractionEvent(event)) {
            return;
        }
        if (!eventTargetsVolumeControl(event)) {
            return;
        }
        noteUserInteraction(event, false);
    };
    const onBlur = () => {
        endCrossFramePlayerIntent(undefined, true);
        isMouseDown = false;
        isPointerDown = false;
        clearCancelledLocalPlayerGesture();
        window.VolumeControl.__remotePlayerVolumeIntentActive = false;
        window.VolumeControl.__remotePlayerVolumeIntentUsed = false;
        window.VolumeControl.__remotePlayerVolumeIntentElement = null;
        window.VolumeControl.__remotePlayerVolumeIntentAt = 0;
        instance.flushDeferredPlayerGestureApplies();
    };

    // Runs inside the page's own element.volume write (see volume_hook_main.js): keep it tiny and
    // never let it throw back into the page.
    const onPageVolumeWrite = (event) => {
        try {
            instance.holdPageVolumeWrite(event.detail);
        } catch (err) {
            verbose('[VolumeSync] Page volume write hold failed:', err);
        }
    };

    // Prevent duplicate global listeners on content-script reinjection.
    if (window._vcInteractionListenersAttached) {
        log('[VolumeSync] Interaction listeners already attached, skipping');
    } else {
        document.addEventListener('mousedown', onMouseDown, capturePassive);
        document.addEventListener('mouseup', onMouseUp, capturePassive);
        document.addEventListener('touchstart', onTouchStart, capturePassive);
        document.addEventListener('touchend', onTouchEnd, capturePassive);
        document.addEventListener('touchcancel', onTouchCancel, capturePassive);
        document.addEventListener('keydown', onKeyDown, capturePassive);
        document.addEventListener('pointerdown', onPointerDown, capturePassive);
        document.addEventListener('pointerup', onPointerUp, capturePassive);
        document.addEventListener('pointercancel', onPointerCancel, capturePassive);
        document.addEventListener('pointermove', onPointerMove, capturePassive);
        document.addEventListener('wheel', onWheel, capturePassive);
        window.addEventListener('blur', onBlur, { passive: true });
        document.addEventListener(VOLUME_HOOK_EVENT, onPageVolumeWrite, { passive: true });

        window._vcInteractionListenersAttached = true;

        window.addEventListener('unload', () => {
            document.removeEventListener('mousedown', onMouseDown, capturePassive);
            document.removeEventListener('mouseup', onMouseUp, capturePassive);
            document.removeEventListener('touchstart', onTouchStart, capturePassive);
            document.removeEventListener('touchend', onTouchEnd, capturePassive);
            document.removeEventListener('touchcancel', onTouchCancel, capturePassive);
            document.removeEventListener('keydown', onKeyDown, capturePassive);
            document.removeEventListener('pointerdown', onPointerDown, capturePassive);
            document.removeEventListener('pointerup', onPointerUp, capturePassive);
            document.removeEventListener('pointercancel', onPointerCancel, capturePassive);
            document.removeEventListener('pointermove', onPointerMove, capturePassive);
            document.removeEventListener('wheel', onWheel, capturePassive);
            window.removeEventListener('blur', onBlur, { passive: true });
            document.removeEventListener(VOLUME_HOOK_EVENT, onPageVolumeWrite, { passive: true });
            window._vcInteractionListenersAttached = false;
        }, { once: true });
    }

    log('[VolumeSync] Module initialized');
})();
