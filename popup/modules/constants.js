/**
 * Constants for Popup
 */

window.Popup = window.Popup || {};

const PopupProtocol = globalThis.VCProtocol;

window.Popup.Constants = {
    // Volume Range
    MIN_VOLUME: 0,
    MAX_VOLUME: 500,
    DEFAULT_VOLUME: 100,

    // Audio Settings Defaults
    DEFAULT_MONO_ENABLED: PopupProtocol.CONSTANTS.DEFAULT_MONO_ENABLED ?? false,
    DEFAULT_BALANCE: PopupProtocol.CONSTANTS.DEFAULT_BALANCE ?? 0,
    BALANCE_MIN: PopupProtocol.CONSTANTS.BALANCE_MIN ?? -100,
    BALANCE_MAX: PopupProtocol.CONSTANTS.BALANCE_MAX ?? 100,
    
    // Compression Defaults
    DEFAULT_COMPRESSION_THRESHOLD: -18,
    DEFAULT_COMPRESSION_RATIO: 6,
    DEFAULT_COMPRESSION_KNEE: 3,
    RESET_COMPRESSION_THRESHOLD: -18,
    RESET_COMPRESSION_RATIO: 6,
    
    // Debounce / throttle timing
    VOLUME_DEBOUNCE_MS: 150,
    VOLUME_SEND_THROTTLE_MS: 100,
    COMPRESSION_DEBOUNCE_MS: 200,
    AUDIO_SETTINGS_DEBOUNCE_MS: 120,
    SETTINGS_SAVE_DEBOUNCE_MS: 160,
    
    // Volume Snapping
    VOLUME_SNAP_POINTS: [0, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500],
    VOLUME_SNAP_THRESHOLD: 3,
    VOLUME_SNAP_THRESHOLD_STRICT: 1.5,
    
    // Volume Adjust Button Timing
    INITIAL_VOLUME_ADJUST_DELAY_MS: 400,
    INITIAL_VOLUME_ADJUST_INTERVAL_MS: 80,
    MIN_VOLUME_ADJUST_INTERVAL_MS: 5,
    VOLUME_ADJUST_INTERVAL_DECREMENT: 5,
    VOLUME_ADJUST_STEP: 5,

    // Popup View IDs
    VIEW_MAIN: 'main-view',
    VIEW_SETTINGS: 'settings-view',
    VIEW_SHORTCUTS: 'shortcuts-view',

    // Shortcut display fallbacks (descriptions resolved via i18n descriptionKey)
    SHORTCUT_COMMAND_FALLBACKS: [
        {
            name: 'volume-up',
            shortcut: 'Alt+Shift+Up',
            descriptionKey: 'shortcut.volumeUp'
        },
        {
            name: 'volume-down',
            shortcut: 'Alt+Shift+Down',
            descriptionKey: 'shortcut.volumeDown'
        },
        {
            name: 'volume-reset',
            shortcut: 'Alt+Shift+R',
            descriptionKey: 'shortcut.volumeReset'
        },
        {
            name: 'toggle-mute',
            shortcut: 'Alt+Shift+M',
            descriptionKey: 'shortcut.toggleMute'
        },
        {
            name: 'toggle-compressor',
            shortcut: 'Alt+Shift+C',
            descriptionKey: 'shortcut.toggleCompressor'
        }
    ]
};

/**
 * Utility Functions for Popup
 * Shared validation and normalization functions
 */
window.Popup.Utils = {
    /**
     * Normalize and clamp a volume value to valid range
     * @param {number|string} value - The value to normalize
     * @param {number} fallback - Fallback value if invalid (default: DEFAULT_VOLUME)
     * @returns {number} - Normalized volume (MIN_VOLUME to MAX_VOLUME)
     */
    normalizeVolume: function(value, fallback) {
        const fb = typeof fallback === 'number' ? fallback : window.Popup.Constants.DEFAULT_VOLUME;
        return PopupProtocol.normalizeVolume(value, fb);
    },
    
    /**
     * Sanitize volume input string - remove non-digit characters
     * @param {string} str - Input string
     * @returns {string} - Sanitized string with only digits
     */
    sanitizeVolumeInput: function(str) {
        return PopupProtocol.sanitizeVolumeInput(str);
    },

    /**
     * Step a volume text/number field by 1%. Empty or invalid input is treated as 0.
     * Used by the main popup field and Other Tabs inline editor (mouse wheel and arrows).
     * @param {HTMLInputElement} input
     * @param {number} direction - positive increases, negative decreases
     * @returns {boolean} whether the field value was written
     */
    nudgeVolumeInput: function(input, direction) {
        if (!input || input.disabled) {
            return false;
        }
        const min = window.Popup.Constants.MIN_VOLUME;
        const max = window.Popup.Constants.MAX_VOLUME;
        const currentVal = parseInt(input.value, 10) || 0;
        const step = direction < 0 ? -1 : 1;
        const newVal = Math.max(min, Math.min(max, currentVal + step));
        input.value = String(newVal);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    },

    /**
     * One-percent mouse-wheel step, only while the field itself is focused
     * (clicked or tabbed into). Hover alone never steps, so scrolling the
     * popup list over the field keeps scrolling. A zero deltaY is ignored.
     * @param {WheelEvent} event
     * @param {HTMLInputElement} input
     * @returns {boolean} whether a step was applied
     */
    handleVolumeInputWheel: function(event, input) {
        if (!event || !event.deltaY) {
            return false;
        }
        if (typeof document !== 'undefined' && document) {
            const focused = document.activeElement;
            if (focused != null && focused !== input) {
                return false;
            }
        }
        if (typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        if (typeof event.stopPropagation === 'function') {
            event.stopPropagation();
        }
        return this.nudgeVolumeInput(input, event.deltaY < 0 ? 1 : -1);
    },

    /**
     * Bind the shared non-passive wheel listener to a volume field.
     * @param {HTMLInputElement} input
     */
    bindVolumeInputWheel: function(input) {
        if (!input || typeof input.addEventListener !== 'function') {
            return;
        }
        const self = this;
        input.addEventListener('wheel', (event) => {
            self.handleVolumeInputWheel(event, input);
        }, { passive: false });
    }
};
