/**
 * Element State Machine
 * Manages explicit states for media elements with well-defined transitions.
 */

window.VolumeControl = window.VolumeControl || {};

(function() {
    const { log, warn, verbose, stateChange } = window.VolumeControl;
    const OPERATION_SCOPES = Object.freeze(['setup', 'sourceChange', 'retry', 'volumeSync']);

    /**
     * Element states enum
     */
    const ElementState = Object.freeze({
        UNDISCOVERED: 'undiscovered',
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
        CONTEXT_SUSPENDED: 'context_suspended',
        TIMEOUT: 'timeout',
        UNKNOWN: 'unknown'
    });

    /**
     * Valid state transitions
     */
    const VALID_TRANSITIONS = {
        [ElementState.UNDISCOVERED]: [ElementState.DISCOVERED],
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
            
            // Native-only fallback flag (set when verification detects a
            // silent mozCaptureStream and control reverts to direct player volume)
            // native until the element is replaced and re-discovered).
            this.nativeOnlyFallbackActive = false;
            
            // Source tracking
            this.lastKnownSrc = element.currentSrc || element.src || (element.srcObject ? 'srcObject:attached' : null);
            this.userOriginalVolume = element.volume;
            this.userOriginalMutedState = element.muted;
            this.nativeVolumeSnapshot = element.volume;
            this.nativeMutedSnapshot = element.muted;
            this.observedNativeVolume = element.volume;
            this.observedNativeMutedState = element.muted;
            this.managedMutedState = element.muted;
            
            // Error tracking
            this.errorType = null;
            this.errorMessage = null;
            this.retryCount = 0;
            
            // Visibility tracking
            this.isIntersecting = true;
            this.volumeBeforeInvisible = null;
            this.wasAutoMuted = false;
            this.needsConnectionVerification = false;
            this.consecutiveVerificationFailures = 0;
            this.lastObservedCurrentTime = 0;
            this.lastVerifiedAudioAt = 0;
            this.detachedSinceAt = null;
            
            // Timers to clean up
            this.verificationTimer = null;
            this.compressionMonitoringInterval = null;
            
            // Event handlers reference
            this.eventHandlers = null;

            // Async operation coordination
            this.operationEpochs = Object.fromEntries(OPERATION_SCOPES.map(scope => [scope, 0]));
            this.operationTimeouts = Object.fromEntries(OPERATION_SCOPES.map(scope => [scope, new Map()]));
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
            this.operationEpochs[scope] += 1;
            return this.operationEpochs[scope];
        }

        invalidateOperation(scope) {
            this._assertOperationScope(scope);
            this.clearOperationTimeouts(scope);
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

            // Merge additional data
            Object.assign(this, data);

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
         * Check if element is ready for setup
         */
        canSetup() {
            return this.state === ElementState.DISCOVERED || 
                   (this.state === ElementState.ERROR && this.retryCount < 3);
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
         * Called when source changes, as new source might not have CORS issues
         */
        clearCorsBlocked(element) {
            if (this.corsElements.has(element)) {
                this.corsElements.delete(element);
                const elementInfo = element ? `${element.tagName}#${element.id || 'no-id'}` : 'unknown';
                verbose(`[ElementStateManager] Cleared CORS-blocked status for ${elementInfo}`);
            }
        }

        /**
         * Clean up stale CORS elements
         * Removes elements that are:
         * - No longer connected to DOM
         * - No longer have a valid source
         * - Have a source that has changed (might no longer be CORS-blocked)
         * @returns {number} Number of elements cleaned up
         */
        cleanupStaleCorsElements() {
            let cleanedCount = 0;
            const toRemove = [];
            
            this.corsElements.forEach(element => {
                // Remove if disconnected from DOM
                if (!element.isConnected) {
                    toRemove.push(element);
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
                if (src.startsWith(window.location.origin)) {
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
                this.corsElements.delete(element);
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
         * Transition an element to a new state
         */
        transition(element, newState, data = {}) {
            const stateData = this.get(element);
            if (!stateData) {
                warn(`[ElementStateManager] Cannot transition unknown element`);
                return false;
            }
            return stateData.transition(newState, data);
        }

        /**
         * Mark element as CORS-blocked
         */
        markCorsBlocked(element) {
            this.corsElements.add(element);
            const stateData = this.get(element);
            if (stateData) {
                stateData.transition(ElementState.ERROR, {
                    errorType: ErrorType.CORS,
                    errorMessage: 'Cross-origin media without CORS headers'
                });
            }
        }

        /**
         * Check if element is CORS-blocked
         */
        isCorsBlocked(element) {
            return this.corsElements.has(element);
        }

        /**
         * Get total count of controlled elements (active + CORS)
         */
        getTotalControlledCount() {
            let count = 0;
            this.elements.forEach(stateData => {
                if (stateData.state === ElementState.ACTIVE) count++;
            });
            return count + this.corsElements.size;
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
