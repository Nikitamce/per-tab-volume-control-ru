/**
 * Media Detector Module - Unified media element detection system.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.MediaDetector = {};

(function() {
    const { log, error, verbose, decision, traceEnter, traceExit } = window.VolumeControl;
    const {
        MUTATION_SCAN_DELAY_MS,
        MUTATION_MAX_WAIT_MS,
        MUTATION_PENDING_CAP,
        PLAY_HOOK_EVENT,
        PERIODIC_SCAN_FORCE_EVERY_TICKS
    } = window.VolumeControl;

    /**
     * MediaDetector class - manages all media detection
     * Uses WeakSet for tracking instead of DOM attributes (not observable by page)
     */
    class MediaDetector {
        constructor() {
            this.mutationObserver = null;
            this.isStarted = false;
            this.pendingMutations = [];
            this.mutationDebounceTimer = null;
            this.firstPendingAt = 0;
            this.mutationOverflowScan = false;
            this._emptyScanStreak = 0;
            this.startGeneration = 0;
            this.captureOptions = { capture: true, passive: true };
            this.eventDelegationHandlers = {
                playing: null,
                loadedmetadata: null
            };
            this.observedRoots = new WeakSet();
            
            // Use WeakSet for tracking - prevents memory leaks and isn't visible to pages
            this.trackedElements = new WeakSet();
            
            // Callbacks to notify when elements are found
            this.onElementDiscovered = null;
            this.onElementRemoved = null;

            // Listener for the MAIN-world play hook's CustomEvent (set while started)
            this.playHookHandler = null;
            this.playHookOptions = { passive: true };

            // Periodic safety scan timer, plus the state that lets it skip a clean DOM
            this._periodicScanTimer = null;
            this._scanDirty = true;
            this._ticksSinceWalk = 0;
        }

        /**
         * Listen for the MAIN-world play hook (play_hook_main.js). It catches off-DOM media
         * (Bandcamp-style players that call `new Audio().play()` without attaching the element)
         * that the MutationObserver and event delegation cannot reach.
         *
         * The page-owned wrapper dispatches a CustomEvent on `document` whose `detail` is the
         * playing element. This listener only validates it and defers discovery to a microtask,
         * so no extension work runs inside the page's own play() call. Nothing is installed on
         * the page from this world, so no content-script function can be left behind for the
         * page to call after the extension is updated, disabled, or reloaded.
         */
        setupPlayHookListener() {
            if (this.playHookHandler) return;

            const generation = this.startGeneration;
            this.playHookHandler = (event) => {
                if (!this.isStarted || generation !== this.startGeneration) {
                    return;
                }

                let element;
                try {
                    element = event.detail;
                } catch {
                    return;
                }
                // Pages can dispatch this event too: only ever act on a real media element.
                if (!(element instanceof HTMLMediaElement) || this.isTracked(element)) {
                    return;
                }

                Promise.resolve().then(() => {
                    if (this.isStarted && generation === this.startGeneration && !this.isTracked(element)) {
                        this.notifyDiscovered(element, 'play-interception');
                    }
                }).catch((err) => {
                    verbose('[MediaDetector] play-interception discovery failed:', err);
                });
            };

            document.addEventListener(PLAY_HOOK_EVENT, this.playHookHandler, this.playHookOptions);
            verbose('[MediaDetector] Play hook listener set up');
        }

        teardownPlayHookListener() {
            if (!this.playHookHandler) return;

            document.removeEventListener(PLAY_HOOK_EVENT, this.playHookHandler, this.playHookOptions);
            this.playHookHandler = null;
        }

        /**
         * Start detection
         * @param {Function} onDiscovered - Callback when element discovered
         * @param {Function} onRemoved - Callback when element removed
         */
        start(onDiscovered, onRemoved) {
            if (this.isStarted) return;
            
            this.onElementDiscovered = onDiscovered;
            this.onElementRemoved = onRemoved;
            this.isStarted = true;
            this.startGeneration += 1;
            
            log('[MediaDetector] Starting detection');
            
            // 0. Listen for the MAIN-world play hook (catches off-DOM elements)
            this.setupPlayHookListener();
            
            // 1. Initial scan
            this.scanDocument();
            
            // 2. Set up MutationObserver
            this.setupMutationObserver();
            
            // 3. Set up event delegation (backup)
            this.setupEventDelegation();

            // 4. Periodic safety scan (recovers elements missed by
            //    MutationObserver due to shadow-DOM timing, batch
            //    manipulations, or other edge cases)
            this.startPeriodicScan();
        }

        /**
         * Stop detection
         */
        stop() {
            if (!this.isStarted) return;

            this.startGeneration += 1;
            
            if (this.mutationObserver) {
                this.mutationObserver.disconnect();
                this.mutationObserver = null;
            }
            
            if (this.mutationDebounceTimer) {
                clearTimeout(this.mutationDebounceTimer);
                this.mutationDebounceTimer = null;
            }

            this.pendingMutations = [];
            this.firstPendingAt = 0;
            this.mutationOverflowScan = false;
            this.teardownEventDelegation();
            this.teardownPlayHookListener();
            this.onElementDiscovered = null;
            this.onElementRemoved = null;
            
            // Clear periodic scan timer
            if (this._periodicScanTimer) {
                clearTimeout(this._periodicScanTimer);
                this._periodicScanTimer = null;
            }
            
            // WeakSet auto-cleans when elements are GC'd - no manual cleanup needed
            
            this.isStarted = false;
            log('[MediaDetector] Stopped detection');
        }

        /**
         * Scan entire document for media elements
         */
        scanDocument() {
            traceEnter('scanDocument');
            
            const mediaElements = this.findAllMediaElements(document.body);
            verbose(`[MediaDetector] Found ${mediaElements.length} media elements in initial scan`);
            
            mediaElements.forEach(element => {
                if (!this.isTracked(element)) {
                    this.notifyDiscovered(element, 'initial-scan');
                }
            });
            
            traceExit('scanDocument', `${mediaElements.length} elements`);
        }

        /**
         * Find all media elements including those in Shadow DOM
         * @param {Node} root - Root node to scan
         * @returns {HTMLMediaElement[]}
         */
        findAllMediaElements(root) {
            if (!root) return [];
            
            const mediaElements = new Set();
            
            // Find direct media elements
            try {
                const directMedia = root.querySelectorAll('video, audio');
                directMedia.forEach(el => mediaElements.add(el));
            } catch (e) {
                error('[MediaDetector] Error querying media elements:', e);
            }
            
            // Scan shadow DOMs with a TreeWalker. It deliberately has no JS filter: a filter
            // object makes the engine call back into script for every element in the document,
            // which freezes the main thread for 100+ ms on pages with tens of thousands of nodes.
            // The loop below does the same shadowRoot check natively.
            try {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
                
                let node;
                while ((node = walker.nextNode())) {
                    if (node.shadowRoot) {
                        this.observeRoot(node.shadowRoot);
                        const shadowMedia = this.findAllMediaElements(node.shadowRoot);
                        shadowMedia.forEach(el => mediaElements.add(el));
                    }
                }
            } catch (e) {
                // TreeWalker may fail on some nodes
                verbose('[MediaDetector] TreeWalker error (non-critical):', e);
            }
            
            return Array.from(mediaElements);
        }

        /**
         * Set up MutationObserver for DOM changes
         */
        setupMutationObserver() {
            if (this.mutationObserver) return;
            const generation = this.startGeneration;
            
            this.mutationObserver = new MutationObserver((mutations) => {
                if (!this.isStarted || generation !== this.startGeneration) {
                    return;
                }
                this.handleMutations(mutations);
            });
            
            this.observeRoot(document.body);
            
            verbose('[MediaDetector] MutationObserver started');
        }

        observeRoot(root) {
            if (!root || !this.mutationObserver || this.observedRoots.has(root)) {
                return;
            }

            this.mutationObserver.observe(root, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src', 'crossorigin']
            });
            this.observedRoots.add(root);
        }

        /**
         * Remember that the DOM changed in a way that could expose new media, so the next
         * periodic safety scan walks the document. Removal-only records cannot add media.
         * @param {MutationRecord[]} mutations
         */
        _noteRelevantMutations(mutations) {
            if (this._scanDirty) return;
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' || (mutation.addedNodes && mutation.addedNodes.length > 0)) {
                    this._scanDirty = true;
                    return;
                }
            }
        }

        /**
         * Handle mutation records with debouncing
         * @param {MutationRecord[]} mutations
         */
        handleMutations(mutations) {
            this._noteRelevantMutations(mutations);

            // Fast-path direct media additions to avoid debounce lag.
            const directMediaMutations = mutations.filter(m =>
                m.type === 'childList' &&
                Array.from(m.addedNodes).some(n => n instanceof HTMLMediaElement)
            );
            
            // Process direct media additions immediately
            for (const mutation of directMediaMutations) {
                for (const node of mutation.addedNodes) {
                    if (node instanceof HTMLMediaElement && !this.isTracked(node)) {
                        this.notifyDiscovered(node, 'mutation-fastpath');
                    }
                }
            }
            
            // Collect remaining mutations for debounced processing
            const remainingMutations = mutations.filter(m => !directMediaMutations.includes(m));
            if (remainingMutations.length === 0) return;
            
            this.pendingMutations.push(...remainingMutations);
            if (!this.firstPendingAt) {
                this.firstPendingAt = Date.now();
            }

            const pendingCap = MUTATION_PENDING_CAP || 500;
            if (this.pendingMutations.length > pendingCap) {
                this.pendingMutations.length = pendingCap;
                this.mutationOverflowScan = true;
            }

            const maxWaitMs = MUTATION_MAX_WAIT_MS || 1000;
            if (Date.now() - this.firstPendingAt >= maxWaitMs) {
                this.flushPendingMutations();
                return;
            }

            if (this.mutationDebounceTimer) {
                clearTimeout(this.mutationDebounceTimer);
            }
            this.mutationDebounceTimer = setTimeout(() => {
                this.flushPendingMutations();
            }, MUTATION_SCAN_DELAY_MS || 250);
        }

        flushPendingMutations() {
            if (this.mutationDebounceTimer) {
                clearTimeout(this.mutationDebounceTimer);
                this.mutationDebounceTimer = null;
            }
            const batch = this.pendingMutations;
            this.pendingMutations = [];
            this.firstPendingAt = 0;
            const overflow = this.mutationOverflowScan;
            this.mutationOverflowScan = false;
            if (batch.length > 0) {
                this.processMutations(batch);
            }
            if (overflow) {
                this.scanDocument();
            }
        }

        /**
         * Process batched mutations
         * @param {MutationRecord[]} mutations
         */
        // Shared collector used by both added/removed mutation branches.
        _collectMediaFromNodes(nodeList) {
            const mediaElements = new Set();
            for (const node of nodeList) {
                if (node instanceof HTMLMediaElement) {
                    mediaElements.add(node);
                } else if (node instanceof Element) {
                    const mediaInSubtree = this.findAllMediaElements(node);
                    mediaInSubtree.forEach(el => mediaElements.add(el));
                }
            }
            return mediaElements;
        }
    
        processMutations(mutations) {
            const addedElements = new Set();
            const removedElements = new Set();
            const changedElements = new Set();
            
            for (const mutation of mutations) {
                // Handle added nodes
                if (mutation.addedNodes && mutation.addedNodes.length > 0) {
                    Array.from(mutation.addedNodes).forEach((node) => {
                        if (node instanceof Element && node.shadowRoot) {
                            this.observeRoot(node.shadowRoot);
                        }
                    });
                    const media = this._collectMediaFromNodes(mutation.addedNodes);
                    media.forEach(el => addedElements.add(el));
                }
                
                // Handle removed nodes
                if (mutation.removedNodes && mutation.removedNodes.length > 0) {
                    const media = this._collectMediaFromNodes(mutation.removedNodes);
                    media.forEach(el => removedElements.add(el));
                }

                if (mutation.type === 'attributes' && mutation.target instanceof Element) {
                    const mediaElement = mutation.target instanceof HTMLMediaElement
                        ? mutation.target
                        : mutation.target.closest?.('video, audio');

                    if (mediaElement instanceof HTMLMediaElement) {
                        changedElements.add(mediaElement);
                    }
                }
            }
            
            // Notify about new elements
            addedElements.forEach(element => {
                if (!this.isTracked(element)) {
                    this.notifyDiscovered(element, 'mutation-observer');
                }
            });
            
            // Notify about removed elements
            removedElements.forEach(element => {
                if (this.isTracked(element)) {
                    this.notifyRemoved(element, 'mutation-observer');
                }
            });

            changedElements.forEach(element => {
                if (!this.isTracked(element)) {
                    this.notifyDiscovered(element, 'attribute-change');
                    return;
                }

                if (this.onElementDiscovered) {
                    this.onElementDiscovered(element, 'attribute-change');
                }
            });
            
            if (addedElements.size > 0 || removedElements.size > 0 || changedElements.size > 0) {
                verbose(`[MediaDetector] Processed mutations: +${addedElements.size} -${removedElements.size} ~${changedElements.size}`);
            }
        }

        /**
         * Start a periodic scan as a safety net for elements missed by
         * MutationObserver (shadow-DOM timing, detached subtrees, or
         * rapid add/remove cycles that the debounce might skip).
         *
         * Uses a gentle interval (5 s) to balance coverage and performance.
         * Each scan only reports elements that are NOT yet tracked, so
         * repeated scans are lightweight.
         *
         * Walking a large document is the expensive part, so a tick only
         * walks when the MutationObserver recorded a relevant change since
         * the last walk, or when PERIODIC_SCAN_FORCE_EVERY_TICKS ticks have
         * passed (some changes, such as attaching a shadow root to an
         * existing element, produce no observed mutation). A skipped tick
         * counts as an empty scan for the backoff.
         *
         * @param {number} intervalMs - Scan interval in milliseconds
         */
        startPeriodicScan(intervalMs = 5000) {
            if (this._periodicScanTimer) {
                clearTimeout(this._periodicScanTimer);
                this._periodicScanTimer = null;
            }

            const generation = this.startGeneration;
            const activeIntervalMs = intervalMs || 5000;
            const backoffMs = 15000;
            const forceEveryTicks = PERIODIC_SCAN_FORCE_EVERY_TICKS || 4;
            this._emptyScanStreak = 0;
            this._scanDirty = true;
            this._ticksSinceWalk = 0;

            const tick = () => {
                if (!this.isStarted || generation !== this.startGeneration) {
                    this._periodicScanTimer = null;
                    return;
                }

                if (!document.hidden) {
                    this._ticksSinceWalk += 1;
                    if (this._scanDirty || this._ticksSinceWalk >= forceEveryTicks) {
                        this._scanDirty = false;
                        this._ticksSinceWalk = 0;
                        const mediaElements = this.findAllMediaElements(document.body);
                        const untracked = mediaElements.filter((element) => !this.isTracked(element));
                        if (untracked.length === 0) {
                            this._emptyScanStreak += 1;
                        } else {
                            this._emptyScanStreak = 0;
                            untracked.forEach((element) => this.notifyDiscovered(element, 'periodic-scan'));
                        }
                    } else {
                        this._emptyScanStreak += 1;
                    }
                }

                const delay = this._emptyScanStreak >= 3 ? backoffMs : activeIntervalMs;
                this._periodicScanTimer = setTimeout(tick, delay);
            };

            this._periodicScanTimer = setTimeout(tick, activeIntervalMs);
            verbose(`[MediaDetector] Periodic safety scan started (every ${activeIntervalMs}ms)`);
        }

        /**
         * Set up event delegation for media events (backup detection)
         */
        setupEventDelegation() {
            if (this.eventDelegationHandlers.playing || this.eventDelegationHandlers.loadedmetadata) {
                return;
            }

            const generation = this.startGeneration;
            this.eventDelegationHandlers.playing = (e) => {
                if (!this.isStarted || generation !== this.startGeneration) {
                    return;
                }
                if (e.target instanceof HTMLMediaElement) {
                    this.handleMediaEvent(e.target, 'playing');
                }
            };

            this.eventDelegationHandlers.loadedmetadata = (e) => {
                if (!this.isStarted || generation !== this.startGeneration) {
                    return;
                }
                if (e.target instanceof HTMLMediaElement) {
                    this.handleMediaEvent(e.target, 'loadedmetadata');
                }
            };

            document.addEventListener('playing', this.eventDelegationHandlers.playing, this.captureOptions);
            document.addEventListener('loadedmetadata', this.eventDelegationHandlers.loadedmetadata, this.captureOptions);
            
            verbose('[MediaDetector] Event delegation set up');
        }

        teardownEventDelegation() {
            if (this.eventDelegationHandlers.playing) {
                document.removeEventListener('playing', this.eventDelegationHandlers.playing, this.captureOptions);
                this.eventDelegationHandlers.playing = null;
            }

            if (this.eventDelegationHandlers.loadedmetadata) {
                document.removeEventListener('loadedmetadata', this.eventDelegationHandlers.loadedmetadata, this.captureOptions);
                this.eventDelegationHandlers.loadedmetadata = null;
            }
        }

        /**
         * Handle media event for potential new element
         * @param {HTMLMediaElement} element
         * @param {string} eventType
         */
        handleMediaEvent(element, eventType) {
            if (!this.isTracked(element)) {
                verbose(`[MediaDetector] Element detected via ${eventType} event`);
                this.notifyDiscovered(element, `event-${eventType}`);
            }
        }

        /**
         * Check if element is already tracked
         * @param {HTMLMediaElement} element
         * @returns {boolean}
         */
        isTracked(element) {
            return this.trackedElements.has(element);
        }

        /**
         * Mark element as tracked
         * @param {HTMLMediaElement} element
         */
        markTracked(element) {
            this.trackedElements.add(element);
        }

        /**
         * Unmark element as tracked
         * @param {HTMLMediaElement} element
         */
        unmarkTracked(element) {
            this.trackedElements.delete(element);
        }

        /**
         * Notify callback about discovered element
         * @param {HTMLMediaElement} element
         * @param {string} source
         */
        notifyDiscovered(element, source) {
            this.markTracked(element);
            
            const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
            decision(true, `[MediaDetector] Discovered ${elementInfo} via ${source}`);
            
            if (this.onElementDiscovered) {
                this.onElementDiscovered(element, source);
            }
        }

        /**
         * Notify callback about removed element
         * @param {HTMLMediaElement} element
         * @param {string} source
         */
        notifyRemoved(element, source) {
            this.unmarkTracked(element);
            
            const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
            decision(true, `[MediaDetector] Removed ${elementInfo} via ${source}`);
            
            if (this.onElementRemoved) {
                this.onElementRemoved(element, source);
            }
        }

        /**
         * Force a re-scan (for debugging or recovery)
         */
        rescan() {
            log('[MediaDetector] Forced re-scan');
            this.scanDocument();
        }
    }

    /**
     * IntersectionObserver wrapper for visibility tracking
     * This is separate from detection - only tracks if elements are visible
     */
    class VisibilityTracker {
        constructor() {
            this.observer = null;
            this.onVisibilityChange = null;
        }

        /**
         * Start visibility tracking
         * @param {Function} callback - Called with (element, isVisible)
         */
        start(callback) {
            this.onVisibilityChange = callback;
            
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (this.onVisibilityChange) {
                        this.onVisibilityChange(entry.target, entry.isIntersecting);
                    }
                });
            }, {
                threshold: [0, 0.1]
            });
            
            verbose('[VisibilityTracker] Started');
        }

        /**
         * Stop tracking
         */
        stop() {
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
        }

        /**
         * Start observing an element
         * @param {HTMLMediaElement} element
         */
        observe(element) {
            if (this.observer) {
                this.observer.observe(element);
            }
        }

        /**
         * Stop observing an element
         * @param {HTMLMediaElement} element
         */
        unobserve(element) {
            if (this.observer) {
                this.observer.unobserve(element);
            }
        }
    }

    // Create singleton instances
    const mediaDetector = new MediaDetector();
    const visibilityTracker = new VisibilityTracker();

    // Export
    window.VolumeControl.MediaDetector = {
        // Classes
        MediaDetector,
        VisibilityTracker,
        
        // Singletons
        detector: mediaDetector,
        visibility: visibilityTracker,
        
        // Convenience methods
        start: (onDiscovered, onRemoved) => mediaDetector.start(onDiscovered, onRemoved),
        stop: () => mediaDetector.stop(),
        rescan: () => mediaDetector.rescan(),
        findAllMediaElements: (root) => mediaDetector.findAllMediaElements(root)
    };

})();
