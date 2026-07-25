/**
 * Other Tabs Manager for Popup
 * Handles display and control of audio from other tabs
 */

window.Popup = window.Popup || {};

const OtherTabsProtocol = globalThis.VCProtocol;
const OtherTabsMessages = OtherTabsProtocol.Messages;

window.Popup.OtherTabsManager = {
    // UI Element references
    elements: {
        container: null,
        list: null,
        badge: null,
        empty: null
    },

    // State
    currentTabId: null,
    audioTabs: [],
    volumeDebounceTimers: new Map(),
    compressionDebounceTimers: new Map(),
    refreshTimer: null,
    refreshSettleTimer: null,
    refreshSettleUntil: 0,
    refreshRequestId: 0,
    listenersBound: false,
    handlers: {
        mouseup: null,
        touchend: null,
        touchcancel: null,
        blur: null,
        click: null,
        runtimeMessage: null,
        panelChanged: null,
        visibilityChange: null
    },

    // When user is holding buttons or editing volume, defer full refresh/rerender
    pendingRefresh: false,
    pendingRefreshOptions: null,
    didInitialHydrate: false,

    // Favicon cache for efficient image handling
    faviconCache: new Map(), // url -> objectUrl

    // Active button hold state - centralized to prevent orphaned timers
    activeHold: {
        tabId: null,
        direction: null,
        timer: null,
        interval: null,
        currentInterval: null, // Set from constants in initialize()
        pendingVolume: null
    },

    // Active volume input editing state
    activeVolumeInput: {
        tabId: null,
        element: null,
        originalValue: null
    },

    // Constants - Use shared constants from popup/constants.js
    // These are getters that read from the shared constants object
    get VOLUME_DEBOUNCE_MS() { return window.Popup?.Constants?.VOLUME_DEBOUNCE_MS ?? 150; },
    get COMPRESSION_DEBOUNCE_MS() { return window.Popup?.Constants?.COMPRESSION_DEBOUNCE_MS ?? 200; },
    get VOLUME_STEP_INITIAL() { return window.Popup?.Constants?.VOLUME_ADJUST_STEP ?? 5; },
    get VOLUME_STEP_REPEAT() { return window.Popup?.Constants?.VOLUME_ADJUST_STEP ?? 5; },
    get INITIAL_HOLD_DELAY_MS() { return window.Popup?.Constants?.INITIAL_VOLUME_ADJUST_DELAY_MS ?? 400; },
    get INITIAL_INTERVAL_MS() { return window.Popup?.Constants?.INITIAL_VOLUME_ADJUST_INTERVAL_MS ?? 80; },
    get MIN_INTERVAL_MS() { return window.Popup?.Constants?.MIN_VOLUME_ADJUST_INTERVAL_MS ?? 5; },
    get INTERVAL_DECREMENT() { return window.Popup?.Constants?.VOLUME_ADJUST_INTERVAL_DECREMENT ?? 5; },
    get MAX_VOLUME() { return window.Popup?.Constants?.MAX_VOLUME ?? 500; },
    get MIN_VOLUME() { return window.Popup?.Constants?.MIN_VOLUME ?? 0; },
    get DEFAULT_VOLUME() { return window.Popup?.Constants?.DEFAULT_VOLUME ?? 100; },
    get DEFAULT_COMPRESSION_THRESHOLD() { return window.Popup?.Constants?.DEFAULT_COMPRESSION_THRESHOLD ?? -18; },
    get DEFAULT_COMPRESSION_RATIO() { return window.Popup?.Constants?.DEFAULT_COMPRESSION_RATIO ?? 6; },
    get DEFAULT_COMPRESSION_KNEE() { return window.Popup?.Constants?.DEFAULT_COMPRESSION_KNEE ?? 3; },

    // Local-only constants (not shared with main popup)
    REFRESH_INTERVAL_MS: 2000,
    REFRESH_SETTLE_DELAY_MS: 450,

    /**
     * Initialize the Other Tabs Manager
     * @param {number} currentTabId - The current active tab ID
     */
    initialize: function(currentTabId) {
        this.currentTabId = currentTabId;
        // Initialize activeHold.currentInterval from constants
        this.activeHold.currentInterval = this.INITIAL_INTERVAL_MS;
        this.initializeElements();
        this.setupGlobalEventListeners();
        this.refreshTabs({ forceHydrate: true });
        this.didInitialHydrate = true;
        this.syncRefreshLoop();
    },

    /**
     * Initialize UI element references
     */
    initializeElements: function() {
        this.elements.container = document.getElementById('other-tabs-panel');
        this.elements.list = document.getElementById('other-tabs-list');
        this.elements.badge = document.getElementById('other-tabs-badge');
        this.elements.empty = document.getElementById('other-tabs-empty');
    },

    /**
     * Set up global event listeners for proper cleanup
     */
    setupGlobalEventListeners: function() {
        if (this.listenersBound) {
            return;
        }

        this.handlers.mouseup = () => this.stopHold();
        this.handlers.touchend = () => this.stopHold();
        this.handlers.touchcancel = () => this.stopHold();
        this.handlers.blur = () => {
            this.stopHold();
            this.commitVolumeInput();
        };
        this.handlers.click = (e) => {
            if (this.activeVolumeInput.element &&
                !this.activeVolumeInput.element.contains(e.target)) {
                this.commitVolumeInput();
            }
        };
        this.handlers.runtimeMessage = (message, sender) => this.handleRuntimeMessage(message, sender);
        this.handlers.panelChanged = (event) => this.handlePanelChanged(event);
        this.handlers.visibilityChange = () => this.handleVisibilityChange();

        // Global mouseup/touchend to catch releases outside buttons
        document.addEventListener('mouseup', this.handlers.mouseup);
        document.addEventListener('touchend', this.handlers.touchend);
        document.addEventListener('touchcancel', this.handlers.touchcancel);
        
        // Also stop on window blur (user switches away)
        window.addEventListener('blur', this.handlers.blur);

        // Global click to close volume input when clicking elsewhere
        document.addEventListener('click', this.handlers.click);

        document.addEventListener('vc:panel-tab-changed', this.handlers.panelChanged);
        document.addEventListener('visibilitychange', this.handlers.visibilityChange);

        // Listen for updates; avoid full rerender during holds (it cancels repeat) and avoid rerender on every update (it causes UI blink)
        browser.runtime.onMessage.addListener(this.handlers.runtimeMessage);

        this.listenersBound = true;
    },

    isOtherTabsPanelActive: function() {
        return window.Popup?.PanelTabManager?.getActiveTab?.() === 'other-tabs';
    },

    shouldRunWatchdogRefresh: function() {
        return this.isOtherTabsPanelActive() && document.visibilityState === 'visible';
    },

    isRefreshSettling: function() {
        return this.refreshSettleUntil > Date.now();
    },

    beginRefreshSettleWindow: function() {
        this.refreshSettleUntil = Date.now() + this.REFRESH_SETTLE_DELAY_MS;

        if (this.refreshSettleTimer) {
            clearTimeout(this.refreshSettleTimer);
        }

        this.refreshSettleTimer = setTimeout(() => {
            this.refreshSettleTimer = null;
            this.refreshSettleUntil = 0;
            this.flushPendingRefresh();
        }, this.REFRESH_SETTLE_DELAY_MS);
    },

    cancelRefreshSettleWindow: function() {
        if (this.refreshSettleTimer) {
            clearTimeout(this.refreshSettleTimer);
            this.refreshSettleTimer = null;
        }
        this.refreshSettleUntil = 0;
    },

    flushPendingRefresh: function() {
        if (this.pendingRefresh && !this.isUserInteracting() && !this.isRefreshSettling()) {
            const opts = this.pendingRefreshOptions || {};
            this.pendingRefresh = false;
            this.pendingRefreshOptions = null;
            this.refreshTabs(opts);
        }
    },

    handlePanelChanged: function(event) {
        if (event?.detail?.tabId === 'other-tabs') {
            this.requestRefresh({ forceHydrate: !this.didInitialHydrate });
        }
        this.syncRefreshLoop();
    },

    handleVisibilityChange: function() {
        this.syncRefreshLoop();
        if (document.visibilityState === 'visible' && this.isOtherTabsPanelActive()) {
            this.requestRefresh();
        }
    },

    handleRuntimeMessage: function(message, sender) {
        if (!message || !message.type) {
            return;
        }

        if (message.type === OtherTabsMessages.STATUS_UPDATE) {
            const tabId = sender?.tab?.id;
            if (!tabId || tabId === this.currentTabId) {
                return;
            }

            if (this.isOtherTabsPanelActive()) {
                this.requestRefresh();
            }
            return;
        }

        if (message.type === OtherTabsMessages.VOLUME_UPDATE) {
            const tabId = message.payload?.tabId;
            const volume = message.payload?.volume;
            if (!tabId || tabId === this.currentTabId || typeof volume !== 'number') {
                return;
            }

            const existing = this.audioTabs.find(t => t.tabId === tabId);
            if (!existing) {
                this.requestRefresh();
                return;
            }

            const isHeldTab = this.activeHold.tabId === tabId;
            const normalizedVolume = OtherTabsProtocol.normalizeVolume(volume, existing.volume);
            if (!isHeldTab) {
                if (existing.muted) {
                    existing.volumeBeforeMute = normalizedVolume;
                } else {
                    existing.volume = normalizedVolume;
                }
            }
            this.updateRowUI(tabId);
            return;
        }

        if (message.type === OtherTabsMessages.TAB_AUDIO_STATE_CHANGED) {
            this.requestRefresh();
        }
    },

    /**
     * True when we should not re-render the list (prevents cancelling press-and-hold)
     */
    isUserInteracting: function() {
        return Boolean(this.activeHold.tabId || this.activeVolumeInput.element);
    },

    /**
     * Request a refresh, deferring if the user is holding/editing
     */
    requestRefresh: function(options = {}) {
        if (this.isUserInteracting() || this.isRefreshSettling()) {
            this.pendingRefresh = true;
            this.pendingRefreshOptions = {
                ...(this.pendingRefreshOptions || {}),
                ...(options || {})
            };
            return;
        }
        this.refreshTabs(options);
    },

    /**
     * Start auto-refresh timer
     */
    startAutoRefresh: function() {
        if (!this.shouldRunWatchdogRefresh()) {
            return;
        }
        this.stopAutoRefresh();
        this.refreshTimer = setInterval(() => {
            this.requestRefresh();
        }, this.REFRESH_INTERVAL_MS);
    },

    /**
     * Stop auto-refresh timer
     */
    stopAutoRefresh: function() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    },

    syncRefreshLoop: function() {
        if (this.shouldRunWatchdogRefresh()) {
            this.startAutoRefresh();
            return;
        }
        this.stopAutoRefresh();
    },

    /**
     * Refresh the list of tabs with audio
     */
    refreshTabs: async function(options = {}) {
        try {
            if (this.isUserInteracting() || this.isRefreshSettling()) {
                this.pendingRefresh = true;
                this.pendingRefreshOptions = {
                    ...(this.pendingRefreshOptions || {}),
                    ...(options || {})
                };
                return;
            }

            const requestId = ++this.refreshRequestId;

            const response = await browser.runtime.sendMessage({
                type: OtherTabsMessages.GET_AUDIO_TABS,
                payload: {
                    excludeTabId: this.currentTabId,
                    forceHydrate: Boolean(options.forceHydrate)
                }
            });

            if (requestId !== this.refreshRequestId) {
                return;
            }

            if (response && response.tabs) {
                const nextTabs = response.tabs.map((tab) => OtherTabsProtocol.normalizeAudioTab(tab));

                // If membership/order is unchanged, update in-place to avoid UI blink.
                const prevIds = this.audioTabs.map(t => t.tabId);
                const nextIds = nextTabs.map(t => t.tabId);
                const sameOrder = prevIds.length === nextIds.length && prevIds.every((id, i) => id === nextIds[i]);

                this.audioTabs = nextTabs;

                if (sameOrder) {
                    const count = this.audioTabs.length;
                    if (count === 0) {
                        this.elements.empty?.classList.add('visible');
                    } else {
                        this.elements.empty?.classList.remove('visible');
                    }
                    nextIds.forEach((tabId) => this.updateRowUI(tabId));
                } else {
                    this.renderTabs();
                }

                this.updateBadge();
            }
        } catch (error) {
            console.error("Failed to get audio tabs:", error);
        }
    },

    /**
     * Update the badge count on the tab button
     */
    updateBadge: function() {
        const count = this.audioTabs.length;
        if (this.elements.badge) {
            if (count > 0) {
                this.elements.badge.textContent = count;
                this.elements.badge.classList.add('visible');
            } else {
                this.elements.badge.textContent = '';
                this.elements.badge.classList.remove('visible');
            }
        }
    },

    handleGlobalCompressionPreferenceChange: function() {
        if (!Array.isArray(this.audioTabs) || this.audioTabs.length === 0) {
            return;
        }

        this.audioTabs.forEach((tab) => this.updateRowUI(tab.tabId));
    },

    /**
     * Render the tabs list
     */
    renderTabs: function() {
        if (!this.elements.list || !this.elements.empty) return;

        // Stop any active hold and commit volume input before re-rendering
        this.stopHold();
        this.commitVolumeInput();

        const count = this.audioTabs.length;

        // Track which favicons are still in use
        const currentFavicons = new Set();

        // Clear existing tab items (except empty message)
        const existingItems = this.elements.list.querySelectorAll('.other-tab-item');
        existingItems.forEach(item => item.remove());

        // Show/hide empty message
        if (count === 0) {
            this.elements.empty.classList.add('visible');
            // Clean up all cached favicons since no tabs
            this.cleanupFaviconCache(currentFavicons);
            return;
        }

        this.elements.empty.classList.remove('visible');

        // Render each tab
        this.audioTabs.forEach(tab => {
            if (tab.favIconUrl) {
                currentFavicons.add(tab.favIconUrl);
            }
            const tabElement = this.createTabElement(tab);
            this.elements.list.appendChild(tabElement);
        });

        // Clean up unused favicon cache entries
        this.cleanupFaviconCache(currentFavicons);
    },

    /**
     * Create a tab element
     * @param {Object} tab - Tab info object
     * @returns {HTMLElement}
     */
    createTabElement: function(tab) {
        const item = document.createElement('div');
        item.className = 'other-tab-item';
        item.setAttribute('data-tab-id', tab.tabId);

        // Favicon with caching
        const favicon = document.createElement('img');
        favicon.className = 'other-tab-favicon';
        favicon.src = this.getCachedFavicon(tab.favIconUrl);
        favicon.alt = '';
        favicon.draggable = false;
        favicon.onerror = () => {
            favicon.src = 'icons/default-favicon.svg';
        };

        // Tab info container - now clickable entire row
        const infoContainer = document.createElement('div');
        infoContainer.className = 'other-tab-info';

        // Title (unselectable)
        const title = document.createElement('span');
        title.className = 'other-tab-title';
        title.textContent = this.truncateTitle(tab.title, 18);
        title.title = tab.title; // Full title on hover

        // Double-click title to reset volume to 100%
        title.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.resetTabVolume(tab.tabId);
        });

        infoContainer.appendChild(title);

        // Controls container
        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'other-tab-controls';

        // Mute button
        const muteBtn = document.createElement('button');
        muteBtn.className = 'other-tab-icon-btn mute-btn' + (tab.muted ? ' muted' : '');
        muteBtn.textContent = tab.muted ? '🔇' : '🔊';
        muteBtn.title = tab.muted ? 'Включить звук' : 'Без звука';
        muteBtn.setAttribute('aria-label', tab.muted ? 'Включить звук' : 'Без звука');
        muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMute(tab.tabId);
        });

        // Compressor toggle button
        const compressorBtn = document.createElement('button');
        compressorBtn.className = 'other-tab-icon-btn compressor-btn' + (tab.compressionEnabled ? ' active' : '');
        compressorBtn.textContent = '🎛️';
        compressorBtn.disabled = false;
        compressorBtn.title = tab.compressionEnabled ? 'Выключить компрессор' : 'Включить компрессор';
        compressorBtn.setAttribute('aria-label', tab.compressionEnabled ? 'Выключить компрессор' : 'Включить компрессор');
        compressorBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCompressor(tab.tabId);
        });

        // Decrement button
        const decrementBtn = document.createElement('button');
        decrementBtn.className = 'other-tab-volume-btn decrement';
        decrementBtn.textContent = '−';
        decrementBtn.title = 'Уменьшить громкость (удерживайте для повтора)';
        decrementBtn.setAttribute('aria-label', 'Уменьшить громкость');
        this.setupVolumeButton(decrementBtn, tab.tabId, -1);

        // Volume value (clickable for direct input)
        const volumeValue = document.createElement('span');
        volumeValue.className = 'other-tab-volume-value' + (tab.muted ? ' muted' : '');
        volumeValue.textContent = `${Math.round(tab.muted ? tab.volumeBeforeMute || tab.volume : tab.volume)}%`;
        volumeValue.setAttribute('data-tab-id', tab.tabId);
        volumeValue.title = 'Нажмите, чтобы изменить громкость';
        volumeValue.addEventListener('click', (e) => {
            e.stopPropagation();
            this.startVolumeInput(tab.tabId, volumeValue);
        });

        // Increment button
        const incrementBtn = document.createElement('button');
        incrementBtn.className = 'other-tab-volume-btn increment';
        incrementBtn.textContent = '+';
        incrementBtn.title = 'Увеличить громкость (удерживайте для повтора)';
        incrementBtn.setAttribute('aria-label', 'Увеличить громкость');
        this.setupVolumeButton(incrementBtn, tab.tabId, 1);

        // Focus tab button (clickable row indicator)
        const focusBtn = document.createElement('button');
        focusBtn.className = 'other-tab-focus-btn';
        focusBtn.textContent = '↗';
        focusBtn.title = 'Перейти на эту вкладку';
        focusBtn.setAttribute('aria-label', 'Перейти на эту вкладку';
        focusBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.focusTab(tab.tabId, tab.windowId);
        });

        controlsContainer.appendChild(muteBtn);
        controlsContainer.appendChild(compressorBtn);
        controlsContainer.appendChild(decrementBtn);
        controlsContainer.appendChild(volumeValue);
        controlsContainer.appendChild(incrementBtn);
        controlsContainer.appendChild(focusBtn);

        item.appendChild(favicon);
        item.appendChild(infoContainer);
        item.appendChild(controlsContainer);

        return item;
    },

    /**
     * Get cached favicon URL or cache it
     * @param {string} url - Original favicon URL
     * @returns {string} - URL to use for favicon
     */
    getCachedFavicon: function(url) {
        if (!url) return 'icons/default-favicon.svg';
        
        // If already cached, return it
        if (this.faviconCache.has(url)) {
            return this.faviconCache.get(url) || url;
        }
        
        // Cache the URL (we don't create blob URLs for external URLs)
        this.faviconCache.set(url, url);
        return url;
    },

    /**
     * Clean up favicon cache entries no longer in use
     * @param {Set} currentUrls - Set of URLs currently being used
     */
    cleanupFaviconCache: function(currentUrls) {
        const toDelete = [];
        this.faviconCache.forEach((cached, url) => {
            if (!currentUrls.has(url)) {
                toDelete.push(url);
            }
        });
        toDelete.forEach(url => {
            this.faviconCache.delete(url);
        });
    },

    /**
     * Set up volume button with press-and-hold functionality
     * Uses centralized hold state to prevent orphaned timers
        * Matches the main popup timing and step behaviour.
     * @param {HTMLElement} button - The button element
     * @param {number} tabId - Target tab ID
     * @param {number} direction - 1 for increment, -1 for decrement
     */
    setupVolumeButton: function(button, tabId, direction) {
        const self = this;

        const startHold = (e) => {
            e.preventDefault();
            e.stopPropagation();
            self.cancelRefreshSettleWindow();
            
            // Stop any existing hold first
            self.stopHold();
            
            // Do initial adjustment with larger step (matches main page)
            self.adjustVolume(tabId, direction, 10, { sendToTab: true, immediate: true });
            
            // Set up new hold state
            self.activeHold.tabId = tabId;
            self.activeHold.direction = direction;
            self.activeHold.currentInterval = self.INITIAL_INTERVAL_MS;
            self.activeHold.pendingVolume = null;
            
            // Start the hold timer for repeat (matches main page INITIAL_VOLUME_ADJUST_DELAY_MS)
            self.activeHold.timer = setTimeout(() => {
                self.startHoldInterval();
            }, self.INITIAL_HOLD_DELAY_MS);
        };

        // Only mousedown/touchstart to start - release is handled globally
        button.addEventListener('mousedown', startHold);
        button.addEventListener('touchstart', startHold, { passive: false });
        
        // Also stop on mouseleave for this specific button
        button.addEventListener('mouseleave', () => {
            if (self.activeHold.tabId === tabId && self.activeHold.direction === direction) {
                self.stopHold();
            }
        });
    },

    /**
     * Start the interval for continuous volume adjustment
        * Matches the main popup's accelerating repeat interval.
     */
    startHoldInterval: function() {
        const self = this;
        
        if (!this.activeHold.tabId) return;
        
        this.activeHold.interval = setInterval(() => {
            if (!self.activeHold.tabId) {
                self.stopHold();
                return;
            }
            
            // Use smaller step for repeat (matches main page VOLUME_ADJUST_STEP)
            self.adjustVolume(self.activeHold.tabId, self.activeHold.direction, self.VOLUME_STEP_REPEAT, { sendToTab: false, recordPending: true });
            
            // Speed up interval progressively (matches main page acceleration)
            if (self.activeHold.currentInterval > self.MIN_INTERVAL_MS) {
                self.activeHold.currentInterval = Math.max(
                    self.MIN_INTERVAL_MS, 
                    self.activeHold.currentInterval - self.INTERVAL_DECREMENT
                );
                clearInterval(self.activeHold.interval);
                self.startHoldInterval();
            }
        }, this.activeHold.currentInterval);
    },

    /**
     * Stop any active hold operation - CRITICAL for preventing runaway timers
     */
    stopHold: function() {
        const pendingTabId = this.activeHold.tabId;
        const pendingVolume = this.activeHold.pendingVolume;

        if (this.activeHold.timer) {
            clearTimeout(this.activeHold.timer);
            this.activeHold.timer = null;
        }
        if (this.activeHold.interval) {
            clearInterval(this.activeHold.interval);
            this.activeHold.interval = null;
        }
        this.activeHold.tabId = null;
        this.activeHold.direction = null;
        this.activeHold.currentInterval = this.INITIAL_INTERVAL_MS;
        this.activeHold.pendingVolume = null;

        // If we were holding, apply the final volume once on release.
        if (pendingTabId && typeof pendingVolume === 'number') {
            this.sendVolumeToTab(pendingTabId, pendingVolume, { immediate: true });
        }

        if (pendingTabId) {
            this.beginRefreshSettleWindow();
        }
    },

    /**
     * Adjust volume for a specific tab
     * @param {number} tabId - Tab ID
     * @param {number} direction - 1 or -1
     * @param {number} step - Volume step amount
     */
    adjustVolume: function(tabId, direction, step = this.VOLUME_STEP_REPEAT, options = {}) {
        const tab = this.audioTabs.find(t => t.tabId === tabId);
        if (!tab) {
            this.stopHold();
            return;
        }

        const baseVolume = tab.muted
            ? (tab.volumeBeforeMute ?? tab.volume ?? this.DEFAULT_VOLUME)
            : tab.volume;

        let newVolume = baseVolume + (step * direction);
        newVolume = Math.max(this.MIN_VOLUME, Math.min(this.MAX_VOLUME, newVolume));

        if (newVolume !== baseVolume) {
            if (tab.muted) {
                tab.volumeBeforeMute = newVolume;
            } else {
                tab.volume = newVolume;
            }
            this.updateRowUI(tabId);

            if (options.recordPending) {
                if (this.activeHold.tabId === tabId) {
                    this.activeHold.pendingVolume = newVolume;
                }
                return;
            }

            if (options.sendToTab) {
                this.sendVolumeToTab(tabId, newVolume, { immediate: Boolean(options.immediate) });
            }
        }
    },

    /**
     * Update the UI for a specific row without re-rendering the entire list
     * @param {number} tabId
     */
    updateRowUI: function(tabId) {
        const tab = this.audioTabs.find(t => t.tabId === tabId);
        if (!tab || !this.elements.list) return;

        const row = this.elements.list.querySelector(`.other-tab-item[data-tab-id="${tabId}"]`);
        if (!row) return;

        const volumeEl = row.querySelector(`.other-tab-volume-value[data-tab-id="${tabId}"]`);
        if (volumeEl) {
            const displayVolume = tab.muted ? (tab.volumeBeforeMute || tab.volume) : tab.volume;
            volumeEl.textContent = `${Math.round(displayVolume)}%`;
            volumeEl.classList.toggle('muted', tab.muted);
        }

        const muteBtn = row.querySelector('.other-tab-icon-btn.mute-btn');
        if (muteBtn) {
            muteBtn.classList.toggle('muted', tab.muted);
            muteBtn.textContent = tab.muted ? '🔇' : '🔊';
            muteBtn.title = tab.muted ? 'Включить звук' : 'Без звука';
            muteBtn.setAttribute('aria-label', tab.muted ? 'Включить звук' : 'Без звука');
        }

        const compressorBtn = row.querySelector('.other-tab-icon-btn.compressor-btn');
        if (compressorBtn) {
            compressorBtn.classList.toggle('active', Boolean(tab.compressionEnabled));
            compressorBtn.classList.remove('disabled');
            compressorBtn.disabled = false;
            compressorBtn.title = tab.compressionEnabled ? 'Выключить компрессор' : 'Включить компрессор';
            compressorBtn.setAttribute('aria-label', tab.compressionEnabled ? 'Выключить компрессор' : 'Включить компрессор');
        }
    },

    /**
     * Reset a specific tab's volume to default (100%)
     * @param {number} tabId - Tab ID
     */
    resetTabVolume: function(tabId) {
        const tab = this.audioTabs.find(t => t.tabId === tabId);
        if (!tab) return;

        // Clear muted state and restore to default volume
        const defaultVolume = this.DEFAULT_VOLUME;
        tab.muted = false;
        delete tab.volumeBeforeMute;
        tab.volume = defaultVolume;

        this.updateRowUI(tabId);
        this.sendVolumeToTab(tabId, defaultVolume, { immediate: true });
        this.sendMuteStateToTab(tabId, false, undefined);
    },

    /**
     * Update volume display for a specific tab
     * @param {number} tabId - Tab ID
     * @param {number} volume - New volume value
     * @param {boolean} muted - Whether tab is muted
     */
    updateVolumeDisplay: function(tabId, volume, muted = false) {
        const volumeElement = this.elements.list?.querySelector(
            `.other-tab-volume-value[data-tab-id="${tabId}"]`
        );
        if (volumeElement) {
            volumeElement.textContent = `${Math.round(volume)}%`;
            volumeElement.classList.toggle('muted', muted);
        }
    },

    /**
     * Start inline volume input editing
     * @param {number} tabId - Tab ID
     * @param {HTMLElement} valueElement - The volume value span element
     */
    startVolumeInput: function(tabId, valueElement) {
        // Commit any existing input first
        this.commitVolumeInput();
        this.cancelRefreshSettleWindow();

        const tab = this.audioTabs.find(t => t.tabId === tabId);
        if (!tab) return;

        const currentVolume = tab.muted ? (tab.volumeBeforeMute || tab.volume) : tab.volume;
        const Utils = window.Popup?.Utils;
        
        // Store state
        this.activeVolumeInput.tabId = tabId;
        this.activeVolumeInput.originalValue = currentVolume;
        
        // Create input element - use type="text" with inputmode="numeric" for full control
        // type="number" in Firefox allows 'e', 'E', '+', '-' which we don't want
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'other-tab-volume-input';
        input.value = String(Math.round(currentVolume));
        input.setAttribute('maxlength', '3');
        input.setAttribute('inputmode', 'numeric');
        input.setAttribute('pattern', '[0-9]*');
        input.setAttribute('autocomplete', 'off');
        
        // Replace span with input
        valueElement.style.display = 'none';
        valueElement.parentNode.insertBefore(input, valueElement.nextSibling);
        
        this.activeVolumeInput.element = input;
        
        // Select all text
        input.focus();
        input.select();
        
        const self = this;
        
        // Prevent invalid characters from being typed
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                self.commitVolumeInput();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                self.cancelVolumeInput();
                return;
            }
            
            // Allow: backspace, delete, tab, arrows, home, end
            const allowedKeys = ['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
            if (allowedKeys.includes(e.key)) {
                // Handle arrow up/down for increment/decrement
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    const currentVal = parseInt(input.value, 10) || 0;
                    const direction = e.key === 'ArrowUp' ? 1 : -1;
                    const newVal = Math.max(self.MIN_VOLUME, Math.min(self.MAX_VOLUME, currentVal + direction));
                    input.value = String(newVal);
                    // Trigger input event to apply volume
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                return;
            }
            
            // Allow Ctrl/Cmd combinations (copy, paste, select all)
            if (e.ctrlKey || e.metaKey) {
                return;
            }
            
            // Block any non-digit key
            if (!/^\d$/.test(e.key)) {
                e.preventDefault();
            }
        });
        
        // Handle paste - sanitize pasted content
        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const pastedText = (e.clipboardData || window.clipboardData).getData('text');
            const sanitized = Utils ? Utils.sanitizeVolumeInput(pastedText) : pastedText.replace(/\D/g, '');
            if (sanitized) {
                const start = input.selectionStart;
                const end = input.selectionEnd;
                const currentValue = input.value;
                const newValue = currentValue.substring(0, start) + sanitized + currentValue.substring(end);
                // Clamp to max 3 digits
                const clampedStr = newValue.substring(0, 3);
                input.value = clampedStr;
                // Trigger input event to apply volume
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        // Live apply volume changes
        input.addEventListener('input', () => {
            const tab = self.audioTabs.find(t => t.tabId === tabId);
            if (!tab) return;

            // Sanitize input - remove any non-digit characters that might have snuck through
            const raw = String(input.value ?? '');
            const sanitized = Utils ? Utils.sanitizeVolumeInput(raw) : raw.replace(/\D/g, '');
            
            // Update input if sanitization changed it
            if (sanitized !== raw) {
                input.value = sanitized;
            }
            
            // Don't process empty input - wait for blur/commit
            if (sanitized === '') return;
            
            const parsed = parseInt(sanitized, 10);
            if (!Number.isFinite(parsed)) return;

            const clamped = Math.max(self.MIN_VOLUME, Math.min(self.MAX_VOLUME, parsed));

            if (tab.muted) {
                tab.volumeBeforeMute = clamped;
            } else {
                tab.volume = clamped;
            }
            self.updateRowUI(tabId);
            self.sendVolumeToTab(tabId, clamped);
        });
        
        input.addEventListener('blur', () => {
            // Small delay to allow click events to process first
            setTimeout(() => {
                if (self.activeVolumeInput.element === input) {
                    self.commitVolumeInput();
                }
            }, 100);
        });
    },

    /**
     * Commit volume input and apply the value
     */
    commitVolumeInput: function() {
        if (!this.activeVolumeInput.element) return;
        
        const input = this.activeVolumeInput.element;
        const tabId = this.activeVolumeInput.tabId;
        const originalValue = this.activeVolumeInput.originalValue;
        const tab = this.audioTabs.find(t => t.tabId === tabId);
        const Utils = window.Popup?.Utils;
        
        // Sanitize and parse the value
        const sanitized = Utils ? Utils.sanitizeVolumeInput(input.value) : String(input.value || '').replace(/\D/g, '');
        let newVolume;
        
        if (sanitized === '' || sanitized === undefined) {
            // Empty input - restore original value instead of setting to 0
            newVolume = typeof originalValue === 'number' ? originalValue : this.MIN_VOLUME;
        } else {
            const parsed = parseInt(sanitized, 10);
            if (isNaN(parsed)) {
                // Invalid - restore original value
                newVolume = typeof originalValue === 'number' ? originalValue : this.MIN_VOLUME;
            } else {
                // Clamp to valid range
                newVolume = Math.max(this.MIN_VOLUME, Math.min(this.MAX_VOLUME, parsed));
            }
        }
        
        // Clean up input
        const valueSpan = input.previousSibling;
        input.remove();
        if (valueSpan) {
            valueSpan.style.display = '';
        }
        
        // Apply volume if changed
        const currentComparableVolume = tab
            ? (tab.muted ? (tab.volumeBeforeMute ?? tab.volume) : tab.volume)
            : null;

        if (tab && newVolume !== currentComparableVolume) {
            if (tab.muted) {
                tab.volumeBeforeMute = newVolume;
                this.updateVolumeDisplay(tabId, newVolume, true);
            } else {
                tab.volume = newVolume;
                this.updateVolumeDisplay(tabId, newVolume, false);
            }
            this.sendVolumeToTab(tabId, newVolume, { immediate: true });
        } else if (tab) {
            // Just update display in case mute state changed
            this.updateVolumeDisplay(tabId, tab.muted ? (tab.volumeBeforeMute ?? tab.volume) : tab.volume, tab.muted);
        }
        
        // Clear state
        this.activeVolumeInput.tabId = null;
        this.activeVolumeInput.element = null;
        this.activeVolumeInput.originalValue = null;

        this.beginRefreshSettleWindow();
    },

    /**
     * Cancel volume input and restore original value
     */
    cancelVolumeInput: function() {
        if (!this.activeVolumeInput.element) return;
        
        const input = this.activeVolumeInput.element;
        const tabId = this.activeVolumeInput.tabId;
        const tab = this.audioTabs.find(t => t.tabId === tabId);
        
        // Clean up input
        const valueSpan = input.previousSibling;
        input.remove();
        if (valueSpan) {
            valueSpan.style.display = '';
        }
        
        // Restore display
        if (tab) {
            this.updateVolumeDisplay(tabId, tab.volume, tab.muted);
        }
        
        // Clear state
        this.activeVolumeInput.tabId = null;
        this.activeVolumeInput.element = null;
        this.activeVolumeInput.originalValue = null;

        this.beginRefreshSettleWindow();
    },

    /**
     * Toggle mute state for a tab
     * @param {number} tabId - Tab ID
     */
    toggleMute: function(tabId) {
        const tab = this.audioTabs.find(t => t.tabId === tabId);
        if (!tab) return;

        if (tab.muted) {
            // Unmute - restore the latest remembered target volume.
            tab.muted = false;
            const restoreVolume = (tab.volumeBeforeMute && tab.volumeBeforeMute > 0) 
                                  ? tab.volumeBeforeMute 
                                  : this.DEFAULT_VOLUME;
            tab.volume = restoreVolume;
            delete tab.volumeBeforeMute;
            this.sendVolumeToTab(tabId, restoreVolume, { immediate: true });
        } else {
            // Mute should not zero the saved target volume.
            tab.volumeBeforeMute = tab.volume > 0 ? tab.volume : this.DEFAULT_VOLUME;
            tab.muted = true;
        }

        // Update UI
        this.updateRowUI(tabId);
        this.sendMuteStateToTab(tabId, tab.muted, tab.volumeBeforeMute);
    },

    /**
     * Toggle compressor for a tab
     * @param {number} tabId - Tab ID
     */
    toggleCompressor: function(tabId) {
        const tab = this.audioTabs.find(t => t.tabId === tabId);
        if (!tab) return;

        const newState = !tab.compressionEnabled;
        tab.compressionEnabled = newState;

        // Send compression settings to tab
        this.sendCompressionToTab(tabId, {
            enabled: newState,
            threshold: tab.compressionThreshold || this.DEFAULT_COMPRESSION_THRESHOLD,
            ratio: tab.compressionRatio || this.DEFAULT_COMPRESSION_RATIO,
            knee: tab.compressionKnee || this.DEFAULT_COMPRESSION_KNEE
        });

        // Update UI
        this.updateRowUI(tabId);
    },

    /**
     * Send mute state to a remote tab (for UI sync purposes)
     * @param {number} tabId - Target tab ID
     * @param {boolean} muted - Mute state
     * @param {number} volumeBeforeMute - Volume before muting
     */
    sendMuteStateToTab: function(tabId, muted, volumeBeforeMute) {
        browser.runtime.sendMessage({
            type: OtherTabsMessages.SET_TAB_MUTE_STATE,
            payload: { tabId, muted, volumeBeforeMute }
        }).catch(e => console.error("Failed to send mute state:", e));
    },

    /**
     * Send volume change to a remote tab (debounced)
     * @param {number} tabId - Target tab ID
     * @param {number} volume - New volume value
     */
    sendVolumeToTab: function(tabId, volume, options = {}) {
        const immediate = Boolean(options.immediate);

        // Clear existing timer for this tab
        if (this.volumeDebounceTimers.has(tabId)) {
            clearTimeout(this.volumeDebounceTimers.get(tabId));
        }

        if (immediate) {
            this.volumeDebounceTimers.delete(tabId);
            browser.runtime.sendMessage({
                type: OtherTabsMessages.SET_REMOTE_TAB_VOLUME,
                payload: {
                    tabId: tabId,
                    volume: OtherTabsProtocol.normalizeVolume(volume, this.DEFAULT_VOLUME)
                }
            }).catch((error) => {
                console.error(`Failed to set volume for tab ${tabId}:`, error);
            });
            return;
        }

        // Set debounced send
        const timer = setTimeout(async () => {
            this.volumeDebounceTimers.delete(tabId);
            try {
                await browser.runtime.sendMessage({
                    type: OtherTabsMessages.SET_REMOTE_TAB_VOLUME,
                    payload: {
                        tabId: tabId,
                        volume: OtherTabsProtocol.normalizeVolume(volume, this.DEFAULT_VOLUME)
                    }
                });
            } catch (error) {
                console.error(`Failed to set volume for tab ${tabId}:`, error);
            }
        }, this.VOLUME_DEBOUNCE_MS);

        this.volumeDebounceTimers.set(tabId, timer);
    },

    /**
     * Send compression settings to a remote tab (debounced)
     * @param {number} tabId - Target tab ID
     * @param {Object} settings - Compression settings
     */
    sendCompressionToTab: function(tabId, settings, options = {}) {
        const immediate = Boolean(options.immediate);
        
        // Clear existing timer for this tab
        if (this.compressionDebounceTimers.has(tabId)) {
            clearTimeout(this.compressionDebounceTimers.get(tabId));
        }

        if (immediate) {
            this.compressionDebounceTimers.delete(tabId);
            browser.runtime.sendMessage({
                type: OtherTabsMessages.SET_REMOTE_TAB_COMPRESSION,
                payload: {
                    tabId: tabId,
                    settings: OtherTabsProtocol.normalizeCompressionSettings(settings)
                }
            }).catch((error) => {
                console.error(`Failed to set compression for tab ${tabId}:`, error);
            });
            return;
        }

        // Set debounced send
        const timer = setTimeout(async () => {
            this.compressionDebounceTimers.delete(tabId);
            try {
                await browser.runtime.sendMessage({
                    type: OtherTabsMessages.SET_REMOTE_TAB_COMPRESSION,
                    payload: {
                        tabId: tabId,
                        settings: OtherTabsProtocol.normalizeCompressionSettings(settings)
                    }
                });
            } catch (error) {
                console.error(`Failed to set compression for tab ${tabId}:`, error);
            }
        }, this.COMPRESSION_DEBOUNCE_MS);

        this.compressionDebounceTimers.set(tabId, timer);
    },

    /**
     * Focus/switch to a specific tab
     * @param {number} tabId - Target tab ID
     * @param {number} windowId - Window ID of the tab
     */
    focusTab: async function(tabId, windowId) {
        try {
            await browser.runtime.sendMessage({
                type: OtherTabsMessages.FOCUS_TAB,
                payload: {
                    tabId: tabId,
                    windowId: windowId
                }
            });
            // Close the popup after switching tabs
            window.close();
        } catch (error) {
            console.error(`Failed to focus tab ${tabId}:`, error);
        }
    },

    /**
     * Truncate title to specified length
     * @param {string} title - Full title
     * @param {number} maxLength - Maximum length
     * @returns {string}
     */
    truncateTitle: function(title, maxLength) {
        if (!title) return 'Без названия';
        if (title.length <= maxLength) return title;
        return title.substring(0, maxLength - 1) + '…';
    },

    /**
     * Clean up resources
     */
    cleanup: function() {
        this.stopHold();
        this.commitVolumeInput();
        this.stopAutoRefresh();
        this.cancelRefreshSettleWindow();
        this.refreshRequestId += 1;

        if (this.listenersBound) {
            document.removeEventListener('mouseup', this.handlers.mouseup);
            document.removeEventListener('touchend', this.handlers.touchend);
            document.removeEventListener('touchcancel', this.handlers.touchcancel);
            document.removeEventListener('click', this.handlers.click);
            document.removeEventListener('vc:panel-tab-changed', this.handlers.panelChanged);
            document.removeEventListener('visibilitychange', this.handlers.visibilityChange);
            window.removeEventListener('blur', this.handlers.blur);
            browser.runtime.onMessage.removeListener(this.handlers.runtimeMessage);
            this.listenersBound = false;
        }
        
        // Clear all debounce timers
        this.volumeDebounceTimers.forEach(timer => clearTimeout(timer));
        this.volumeDebounceTimers.clear();
        this.compressionDebounceTimers.forEach(timer => clearTimeout(timer));
        this.compressionDebounceTimers.clear();
        
        // Clear favicon cache
        this.faviconCache.clear();
    }
};
