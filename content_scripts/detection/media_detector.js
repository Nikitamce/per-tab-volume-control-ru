/**
 * Media Detector Module - Unified media element detection system.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.MediaDetector = {};

(function() {
    const { log, error, verbose, decision, traceEnter, traceExit } = window.VolumeControl;
    const { MUTATION_SCAN_DELAY_MS } = window.VolumeControl;

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

            // Play() interception (installed once per page)
            this._playInterceptorInstalled = false;
            this._originalPlay = null;

            // Periodic safety scan timer
            this._periodicScanTimer = null;
        }

        /**
         * Install a monkey-patch on HTMLMediaElement.prototype.play
         * to catch off-DOM media elements that the MutationObserver
         * and event delegation cannot reach (e.g., Bandcamp-style players
         * that create Audio elements without attaching to the DOM).
         *
         * The patch is installed once per page and is transparent to
         * the page's own callers — it preserves the original return
         * value (a Promise) and does not interfere with normal playback.
         * It also avoids re-wrapping if already installed by another
         * instance (e.g., in a different frame within the same page).
         */
        installPlayInterception() {
            if (this._playInterceptorInstalled) return;

            // If another detector instance already patched play(), just
            // mark ourselves as aware so we don't double-wrap.
            if (this._originalPlay === null) {
                this._originalPlay = HTMLMediaElement.prototype.play;

                // If the prototype was already replaced by another instance
                // on this same frame, skip re-wrapping.
                if (this._originalPlay._vcWrapped) {
                    this._playInterceptorInstalled = true;
                    return;
                }

                const self = this;
                const WrappedPlay = function() {
                    if (self.isStarted && !self.isTracked(this)) {
                        self.notifyDiscovered(this, 'play-interception');
                    }
                    return self._originalPlay.apply(this, arguments);
                };
                WrappedPlay._vcWrapped = true;
                HTMLMediaElement.prototype.play = WrappedPlay;
            }

            this._playInterceptorInstalled = true;
            verbose('[MediaDetector] HTMLMediaElement.prototype.play interception installed');
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
            
            // 0. Install play() interception (catches off-DOM elements)
            this.installPlayInterception();
            
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
            this.teardownEventDelegation();
            this.onElementDiscovered = null;
            this.onElementRemoved = null;
            
            // Clear periodic scan timer
            if (this._periodicScanTimer) {
                clearInterval(this._periodicScanTimer);
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
            
            // Scan shadow DOMs using TreeWalker for efficiency
            try {
                const walker = document.createTreeWalker(
                    root,
                    NodeFilter.SHOW_ELEMENT,
                    {
                        acceptNode: (node) => {
                            // Skip media elements (already found)
                            if (node instanceof HTMLMediaElement) {
                                return NodeFilter.FILTER_REJECT;
                            }
                            // Accept elements with shadow roots
                            if (node.shadowRoot) {
                                return NodeFilter.FILTER_ACCEPT;
                            }
                            // Skip to children
                            return NodeFilter.FILTER_SKIP;
                        }
                    }
                );
                
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
         * Handle mutation records with debouncing
         * @param {MutationRecord[]} mutations
         */
        handleMutations(mutations) {
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
            
            // Debounce processing
            if (this.mutationDebounceTimer) {
                clearTimeout(this.mutationDebounceTimer);
            }
            
            this.mutationDebounceTimer = setTimeout(() => {
                this.processMutations(this.pendingMutations);
                this.pendingMutations = [];
            }, MUTATION_SCAN_DELAY_MS || 250);
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
         * @param {number} intervalMs - Scan interval in milliseconds
         */
        startPeriodicScan(intervalMs = 5000) {
            if (this._periodicScanTimer) {
                clearInterval(this._periodicScanTimer);
            }

            const generation = this.startGeneration;
            this._periodicScanTimer = setInterval(() => {
                if (!this.isStarted || generation !== this.startGeneration) {
                    clearInterval(this._periodicScanTimer);
                    this._periodicScanTimer = null;
                    return;
                }
                this.scanDocument();
            }, intervalMs);

            verbose(`[MediaDetector] Periodic safety scan started (every ${intervalMs}ms)`);
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
