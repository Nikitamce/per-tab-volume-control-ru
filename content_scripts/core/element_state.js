/**
 * Element State Machine
 * Manages explicit states for media elements with well-defined transitions.
 */

window.VolumeControl = window.VolumeControl || {};

(function() {
    const { log, warn, verbose, stateChange } = window.VolumeControl;
    const OPERATION_SCOPES = Object.freeze(['setup', 'sourceChange', 'retry', 'volumeSync']);
    const STICKY_NATIVE_ONLY_REASONS = Object.freeze([
        'page-owned-capture-conflict',
        'capture-error',
        'capture-lost'
    ]);

    /**
     * Element states enum
     */
    const ElementState = Object.freeze({
        DISCOVERED: 'discovered',
        SETTING_UP: 'setting_up',
        ACTIVE: 'active',
        ERROR: 'error',
        CLEANUP: 'cleanup'
    });

    /**
     * Error types for failed setups
     */
    const ErrorType = Object.freeze({
        CORS: 'cors',
        ALREADY_CAPTURED: 'already_captured',
        INVALID_SOURCE: 'invalid_source',
        TIMEOUT: 'timeout',
        UNKNOWN: 'unknown'
    });

    /**
     * Valid state transitions
     */
    const VALID_TRANSITIONS = {
        [ElementState.DISCOVERED]: [ElementState.SETTING_UP, ElementState.CLEANUP],
        [ElementState.SETTING_UP]: [ElementState.ACTIVE, ElementState.ERROR, ElementState.CLEANUP],
        [ElementState.ACTIVE]: [ElementState.CLEANUP],
        [ElementState.ERROR]: [ElementState.SETTING_UP, ElementState.CLEANUP],
        [ElementState.CLEANUP]: [ElementState.DISCOVERED] // Allow reset for re-setup
    };

    /**
     * Element state data class
     * Contains all data associated with an element's current state
     */
    class ElementStateData {
        constructor(element) {
            this.element = element;
            this.state = ElementState.DISCOVERED;
            this.elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
            
            // Timestamps
            this.discoveredAt = Date.now();
            this.lastStateChangeAt = Date.now();
            this.setupStartedAt = null;
            this.lastVolumeChangeAt = 0;
            
            // Setup data
            this.setupTimeoutId = null;
            
            // Audio graph data (populated in ACTIVE state)
            this.audioContext = null;
            this.source = null;
            this.sourceStream = null;
            this.sourceType = null;
            this.gainNode = null;
            this.compressorNode = null;
            this.preCompressorGainNode = null;
            this.makeupGainNode = null;
            this.monoSplitterNode = null;
            this.monoLeftGainNode = null;
            this.monoRightGainNode = null;
            this.monoMergerNode = null;
            this.stereoPannerNode = null;
            this.analyser = null;
            
            // Volume sync data
            this.lastAppliedVolume = null;
            this.lastAppliedSettings = null;
            this.lastAppliedMonoEnabled = null;
            this.lastAppliedBalance = null;
            this.passthroughMode = false;
            this.volumeSyncHandler = null;
            // Live page-write mask owned by VolumeController.maskPageVolumeWrite (one per element)
            this.gainMask = null;
            
            // Source tracking
            this.lastKnownSrc = element.currentSrc || element.src || (element.srcObject ? 'srcObject:attached' : null);
            this.userOriginalVolume = element.volume;
            this.userOriginalMutedState = element.muted;
            this.nativeVolumeSnapshot = element.volume;
            this.nativeMutedSnapshot = element.muted;
            this.observedNativeVolume = element.volume;
            this.observedNativeMutedState = element.muted;
            this.managedMutedState = element.muted;
            // Last volume pushed to the background while the tab was unowned, so a drag
            // burst does not re-send an unchanged value.
            this.lastReportedUnownedVolume = null;
            this.lastReportedMutedState = element.muted;
            
            // Error tracking
            this.errorType = null;
            this.errorMessage = null;
            // `name` of the thrown error behind the last ERROR transition, when there was one
            this.errorName = null;
            this.retryCount = 0;
            
            // Visibility tracking
            this.isIntersecting = true;
            this.volumeBeforeInvisible = null;
            this.wasAutoMuted = false;
            this.needsConnectionVerification = false;
            this.consecutiveVerificationFailures = 0;
            this.lastObservedCurrentTime = 0;
            // The first audio-flow sample only records a baseline; failures count from the second
            this.flowBaselineTaken = false;
            this.lastVerifiedAudioAt = 0;
            this.detachedSinceAt = null;
            
            // Timers to clean up
            this.verificationTimer = null;
            this.compressionMonitoringInterval = null;
            this.captureRecoveryTimer = null;

            // Stalled-capture retry budget
            this.captureRecoveryAttempts = 0;
            this.captureRecoverySourceKey = null;
            this.lastCaptureRecoveryAt = 0;
            
            // Event handlers reference
            this.eventHandlers = null;

            // Async operation coordination
            this.operationEpochs = Object.fromEntries(OPERATION_SCOPES.map(scope => [scope, 0]));
            this.operationTimeouts = Object.fromEntries(OPERATION_SCOPES.map(scope => [scope, new Map()]));
            // Temporary once-listeners owned by an operation scope; they leave with the scope.
            this.operationListeners = Object.fromEntries(OPERATION_SCOPES.map(scope => [scope, new Map()]));
        }

        _assertOperationScope(scope) {
            if (!OPERATION_SCOPES.includes(scope)) {
                throw new Error(`Unknown operation scope: ${scope}`);
            }
        }

        beginOperation(scope, options = {}) {
            const { invalidate = [] } = options;
            this._assertOperationScope(scope);
            invalidate.forEach((otherScope) => {
                this.invalidateOperation(otherScope);
            });
            this.clearOperationTimeouts(scope);
            this.clearOperationListeners(scope);
            this.operationEpochs[scope] += 1;
            return this.operationEpochs[scope];
        }

        invalidateOperation(scope) {
            this._assertOperationScope(scope);
            this.clearOperationTimeouts(scope);
            this.clearOperationListeners(scope);
            this.operationEpochs[scope] += 1;
            return this.operationEpochs[scope];
        }

        invalidateAllOperations() {
            OPERATION_SCOPES.forEach((scope) => {
                this.invalidateOperation(scope);
            });
        }

        isOperationCurrent(scope, epoch) {
            this._assertOperationScope(scope);
            return this.operationEpochs[scope] === epoch;
        }

        registerOperationTimeout(scope, key, timeoutId) {
            this._assertOperationScope(scope);
            if (this.operationTimeouts[scope].has(key)) {
                clearTimeout(this.operationTimeouts[scope].get(key));
            }
            this.operationTimeouts[scope].set(key, timeoutId);
            return timeoutId;
        }

        clearOperationTimeout(scope, key) {
            this._assertOperationScope(scope);
            if (!this.operationTimeouts[scope].has(key)) {
                return;
            }
            clearTimeout(this.operationTimeouts[scope].get(key));
            this.operationTimeouts[scope].delete(key);
        }

        clearOperationTimeouts(scope) {
            this._assertOperationScope(scope);
            this.operationTimeouts[scope].forEach((timeoutId) => clearTimeout(timeoutId));
            this.operationTimeouts[scope].clear();
        }

        /**
         * Attach a temporary once-listener that belongs to an operation scope. One listener per
         * key: registering the key again replaces the old one. It is removed when the scope is
         * begun or invalidated again (a superseding operation or a cleanup), or when it fires.
         * Only listeners registered here are ever removed; other features' listeners stay.
         */
        registerOperationListener(scope, key, target, type, handler) {
            this._assertOperationScope(scope);
            this.clearOperationListener(scope, key);
            const listeners = this.operationListeners[scope];
            const entry = {
                target,
                type,
                handler: (event) => {
                    if (listeners.get(key) === entry) {
                        listeners.delete(key);
                    }
                    handler(event);
                }
            };
            listeners.set(key, entry);
            target.addEventListener(type, entry.handler, { once: true });
        }

        clearOperationListener(scope, key) {
            this._assertOperationScope(scope);
            const entry = this.operationListeners[scope].get(key);
            if (!entry) {
                return;
            }
            this.operationListeners[scope].delete(key);
            entry.target.removeEventListener(entry.type, entry.handler);
        }

        clearOperationListeners(scope) {
            this._assertOperationScope(scope);
            const listeners = this.operationListeners[scope];
            listeners.forEach((entry) => entry.target.removeEventListener(entry.type, entry.handler));
            listeners.clear();
        }

        /**
         * Check if a transition is valid
         */
        canTransitionTo(newState) {
            const validTargets = VALID_TRANSITIONS[this.state] || [];
            return validTargets.includes(newState);
        }

        /**
         * Perform a state transition
         * @param {string} newState - The target state
         * @param {Object} data - Optional data to merge into state
         * @returns {boolean} - Whether transition succeeded
         */
        transition(newState, data = {}) {
            if (!this.canTransitionTo(newState)) {
                warn(`[ElementState] Invalid transition: ${this.state} → ${newState} for ${this.elementInfo}`);
                return false;
            }

            const oldState = this.state;
            this.state = newState;
            this.lastStateChangeAt = Date.now();

            // Merge additional data. An ERROR without an error object forgets the previous name,
            // so the name never describes an older failure than the message beside it.
            Object.assign(this, newState === ElementState.ERROR && data.errorName === undefined
                ? { ...data, errorName: null }
                : data);

            stateChange(`element:${this.elementInfo}`, oldState, newState, 
                `transition${data.reason ? ` (${data.reason})` : ''}`);
            
            log(`[ElementState] ${this.elementInfo}: ${oldState} → ${newState}`);
            return true;
        }

        /**
         * Check if element is in a specific state
         */
        isState(state) {
            return this.state === state;
        }

        /**
         * Check if element has active audio graph
         */
        isActive() {
            return this.state === ElementState.ACTIVE;
        }

        /**
         * Check if element is in a transitional state
         */
        isTransitioning() {
            return this.state === ElementState.SETTING_UP || 
                   this.state === ElementState.CLEANUP;
        }

        /**
         * Forget what was applied to the audio graph that is being dropped. A rebuilt graph
         * starts from fresh nodes, so a remembered volume, mono state or balance would make
         * its first apply look unchanged and leave the new nodes at their defaults. These are
         * the constructor's initial values.
         */
        resetAppliedGraphState() {
            this.lastAppliedVolume = null;
            this.lastAppliedMonoEnabled = null;
            this.lastAppliedBalance = null;
        }

        /**
         * Clean up all timers and resources
         */
        cleanup() {
            this.invalidateAllOperations();

            if (this.setupTimeoutId) {
                clearTimeout(this.setupTimeoutId);
                this.setupTimeoutId = null;
            }
            if (this.verificationTimer) {
                clearTimeout(this.verificationTimer);
                this.verificationTimer = null;
            }
            if (this.compressionMonitoringInterval) {
                clearInterval(this.compressionMonitoringInterval);
                this.compressionMonitoringInterval = null;
            }
            if (this.captureRecoveryTimer) {
                clearTimeout(this.captureRecoveryTimer);
                this.captureRecoveryTimer = null;
            }
        }
    }

    /**
     * Element State Manager
     * Manages all element states in a centralized way
     */
    class ElementStateManager {
        constructor() {
            // Map of element -> ElementStateData
            this.elements = new Map();
            
            // CORS-affected elements (can't control volume)
            this.corsElements = new Set();
        }

        /**
         * Get or create state data for an element
         */
        getOrCreate(element) {
            if (!this.elements.has(element)) {
                const stateData = new ElementStateData(element);
                this.elements.set(element, stateData);
                verbose(`[ElementStateManager] Created state for ${stateData.elementInfo}`);
            }
            return this.elements.get(element);
        }

        /**
         * Get state data for an element (returns null if not tracked)
         */
        get(element) {
            return this.elements.get(element) || null;
        }

        /**
         * Check if element is tracked
         */
        has(element) {
            return this.elements.has(element);
        }

        /**
         * Remove element from tracking
         */
        remove(element) {
            const stateData = this.elements.get(element);
            if (stateData) {
                stateData.cleanup();
                this.elements.delete(element);
                verbose(`[ElementStateManager] Removed ${stateData.elementInfo}`);
            }
            this.corsElements.delete(element);
        }

        /**
         * Clear CORS-blocked status for an element
         * Called when source changes, as new source might not have CORS issues.
         * The Set and the native-only fields of the state leave together, so the
         * two never disagree about whether the element is native-only.
         */
        clearCorsBlocked(element) {
            const wasBlocked = this.corsElements.delete(element);
            const stateData = this.elements.get(element);
            if (stateData) {
                stateData.nativeOnlyReason = null;
                stateData.nativeOnlySourceKey = null;
                if (stateData.errorType === ErrorType.CORS) {
                    stateData.errorType = null;
                    stateData.errorMessage = null;
                    stateData.errorName = null;
                }
            }
            if (wasBlocked) {
                const elementInfo = element ? `${element.tagName}#${element.id || 'no-id'}` : 'unknown';
                verbose(`[ElementStateManager] Cleared CORS-blocked status for ${elementInfo}`);
            }
        }

        /**
         * Whether the element is native-only for a reason that holds until its source key
         * changes: a page-owned source, a failed capture, or a capture that was lost (that
         * one is also revisited on a schedule by Main). Neither the stale-entry sweep nor a
         * recovery refresh may release such an element, or it would be rebuilt on every
         * status read. The single definition; do not copy it.
         */
        isStickyNativeOnly(element) {
            const stateData = this.elements.get(element);
            if (!stateData || !STICKY_NATIVE_ONLY_REASONS.includes(stateData.nativeOnlyReason)) {
                return false;
            }
            const sourceKey = window.VolumeControl.SourceCapture?.getElementSourceKey?.(element)
                || element.currentSrc
                || element.src
                || '';
            return Boolean(sourceKey) && sourceKey === stateData.nativeOnlySourceKey;
        }

        /**
         * Clean up stale CORS elements
         * Evicts (through clearCorsBlocked) elements that are:
         * - Detached from the DOM and no longer playing; a detached element that is
         *   still playing keeps its native-only registration
         * - No longer have a valid source
         * - Have a source that has changed (might no longer be CORS-blocked)
         * Lifecycle paths call this (discovery, refresh, removal, setup); a status
         * getter must not, because it would change what the next read reports.
         * @returns {number} Number of elements cleaned up
         */
        cleanupStaleCorsElements() {
            let cleanedCount = 0;
            const toRemove = [];
            // A seek is not a stop: nothing calls play() again once it completes.
            const hasStopped = (element) => Boolean(element.paused || element.ended);
            
            this.corsElements.forEach(element => {
                // Remove a detached element once it stopped; while it plays, only a changed
                // source below may evict it.
                if (!element.isConnected && hasStopped(element)) {
                    toRemove.push(element);
                    return;
                }

                if (this.isStickyNativeOnly(element)) {
                    return;
                }

                // MediaStream-backed elements are capturable and should not remain marked as native-only fallback.
                if (element.srcObject) {
                    toRemove.push(element);
                    return;
                }
                
                // Remove if source is now a blob URL (likely MediaSource changed)
                const src = element.currentSrc || element.src || '';
                if (src.startsWith('blob:') || src.startsWith('data:')) {
                    toRemove.push(element);
                    return;
                }
                
                // Remove if source is now same-origin
                let isSameOrigin = false;
                try {
                    isSameOrigin = new URL(src, window.location.href).origin === window.location.origin;
                } catch {
                    isSameOrigin = false;
                }
                if (isSameOrigin) {
                    toRemove.push(element);
                    return;
                }
                
                // Remove if element now has crossOrigin attribute
                if (element.crossOrigin && element.crossOrigin !== '') {
                    toRemove.push(element);
                    return;
                }
            });
            
            toRemove.forEach(element => {
                this.clearCorsBlocked(element);
                cleanedCount++;
                const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
                verbose(`[ElementStateManager] Cleaned up stale CORS element: ${elementInfo}`);
            });
            
            return cleanedCount;
        }

        /**
         * Get all elements in a specific state
         */
        getByState(state) {
            const result = [];
            this.elements.forEach((stateData, element) => {
                if (stateData.state === state) {
                    result.push({ element, stateData });
                }
            });
            return result;
        }

        /**
         * Get all active elements (with working audio graphs)
         */
        getActive() {
            return this.getByState(ElementState.ACTIVE);
        }

        /**
         * Get count of elements by state
         */
        getStateCounts() {
            const counts = {};
            Object.values(ElementState).forEach(state => counts[state] = 0);
            
            this.elements.forEach(stateData => {
                counts[stateData.state]++;
            });
            
            counts.cors = this.corsElements.size;
            return counts;
        }

        /**
         * Mark element as CORS-blocked
         * The Set entry and the ERROR/cors state are written together. A tracked
         * element that cannot enter ERROR is not registered, so the two never diverge.
         * @returns {boolean} Whether the element is now registered as native-only
         */
        markCorsBlocked(element) {
            const stateData = this.get(element);
            if (!stateData) {
                return false;
            }

            const details = {
                errorType: ErrorType.CORS,
                errorMessage: 'Cross-origin media without CORS headers'
            };
            // A timeout may already have parked the element in ERROR; ERROR to ERROR is not
            // a transition, so the native-only details are recorded in place.
            if (stateData.isState(ElementState.ERROR)) {
                Object.assign(stateData, details);
            } else if (!stateData.transition(ElementState.ERROR, details)) {
                return false;
            }

            this.corsElements.add(element);
            return true;
        }

        /**
         * Check if element is CORS-blocked
         */
        isCorsBlocked(element) {
            return this.corsElements.has(element);
        }

        /**
         * Clean up all elements
         */
        cleanupAll() {
            this.elements.forEach((stateData, element) => {
                stateData.cleanup();
            });
            this.elements.clear();
            this.corsElements.clear();
        }

        /**
         * Log current state summary
         */
        logSummary() {
            const counts = this.getStateCounts();
            log(`[ElementStateManager] State summary:`, counts);
        }
    }

    // Create singleton instance
    const elementStateManager = new ElementStateManager();

    // Export
    window.VolumeControl.ElementState = ElementState;
    window.VolumeControl.ErrorType = ErrorType;
    window.VolumeControl.ElementStateData = ElementStateData;
    window.VolumeControl.elementStateManager = elementStateManager;

})();
