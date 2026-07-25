/**
 * Panel Tab Manager for Popup
 * Handles the tab navigation system for Compressor and Other Tabs panels
 */

window.Popup = window.Popup || {};

window.Popup.PanelTabManager = {
    // UI Element references
    elements: {
        tabButtons: null,
        compressorTab: null,
        otherTabsTab: null,
        compressorPanel: null,
        otherTabsPanel: null
    },

    // State
    activeTab: 'compressor', // 'compressor' or 'other-tabs'

    // Storage key
    STORAGE_KEY: 'activePanelTab',

    /**
     * Initialize the Panel Tab Manager
     */
    initialize: function() {
        this.initializeElements();
        this.setupEventListeners();
        this.loadActiveTab();
    },

    /**
     * Initialize UI element references
     */
    initializeElements: function() {
        this.elements.tabButtons = document.querySelectorAll('.panel-tab-btn');
        this.elements.compressorTab = document.getElementById('tab-compressor');
        this.elements.otherTabsTab = document.getElementById('tab-other-tabs');
        this.elements.compressorPanel = document.getElementById('compressor-panel');
        this.elements.otherTabsPanel = document.getElementById('other-tabs-panel');
    },

    /**
     * Set up event listeners for tab buttons
     */
    setupEventListeners: function() {
        this.elements.tabButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const tabId = e.currentTarget.getAttribute('data-tab');
                this.switchTab(tabId);
            });
        });
    },

    /**
     * Load the active tab from storage
     */
    loadActiveTab: function() {
        browser.storage.local.get(this.STORAGE_KEY).then(result => {
            const savedTab = result[this.STORAGE_KEY];
            if (savedTab && (savedTab === 'compressor' || savedTab === 'other-tabs')) {
                this.activeTab = savedTab;
            }
            this.updateUI();
        }).catch(() => {
            this.updateUI();
        });
    },

    /**
     * Save the active tab to storage
     */
    saveActiveTab: function() {
        browser.storage.local.set({ [this.STORAGE_KEY]: this.activeTab }).catch(e => {
            console.error("Failed to save active tab:", e);
        });
    },

    /**
     * Switch to a specific tab
     * @param {string} tabId - 'compressor' or 'other-tabs'
     */
    switchTab: function(tabId) {
        if (tabId === this.activeTab) return;
        
        this.activeTab = tabId;
        this.updateUI();
        this.saveActiveTab();

        if (tabId === 'other-tabs') {
            try {
                window.Popup?.OtherTabsManager?.requestRefresh?.({ forceHydrate: true });
            } catch {
                // noop
            }
        }
    },

    /**
     * Update the UI to reflect the current active tab
     */
    updateUI: function() {
        // Update tab button states
        this.elements.tabButtons.forEach(button => {
            const isActive = button.getAttribute('data-tab') === this.activeTab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        // Update panel visibility
        if (this.elements.compressorPanel) {
            const isCompressorActive = this.activeTab === 'compressor';
            this.elements.compressorPanel.classList.toggle('active', isCompressorActive);
            this.elements.compressorPanel.setAttribute('aria-hidden', !isCompressorActive);
        }

        if (this.elements.otherTabsPanel) {
            const isOtherTabsActive = this.activeTab === 'other-tabs';
            this.elements.otherTabsPanel.classList.toggle('active', isOtherTabsActive);
            this.elements.otherTabsPanel.setAttribute('aria-hidden', !isOtherTabsActive);
        }

        document.dispatchEvent(new CustomEvent('vc:panel-tab-changed', {
            detail: { tabId: this.activeTab }
        }));
    },

    /**
     * Get the currently active tab
     * @returns {string}
     */
    getActiveTab: function() {
        return this.activeTab;
    }
};
