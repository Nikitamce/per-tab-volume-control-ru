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
    
    // Debounce Timing
    VOLUME_DEBOUNCE_MS: 150,
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

    // Shortcut display fallbacks
    SHORTCUT_COMMAND_FALLBACKS: [
        {
            name: 'volume-up',
            shortcut: 'Alt+Shift+Up',
            description: 'Увеличить громкость активной вкладки'
        },
        {
            name: 'volume-down',
            shortcut: 'Alt+Shift+Down',
            description: 'Уменьшить громкость активной вкладки'
        },
        {
            name: 'volume-reset',
            shortcut: 'Alt+Shift+R',
            description: 'Сбросить громкость активной вкладки'
        },
        {
            name: 'toggle-mute',
            shortcut: 'Alt+Shift+M',
            description: 'Включить или выключить звук активной вкладки'
        },
        {
            name: 'toggle-compressor',
            shortcut: 'Alt+Shift+C',
            description: 'Включить или выключить компрессор на активной вкладке'
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
     * Check if a string contains only digits
     * @param {string} str - String to test
     * @returns {boolean}
     */
    isDigitsOnly: function(str) {
        return /^\d*$/.test(str);
    },
    
    /**
     * Sanitize volume input string - remove non-digit characters
     * @param {string} str - Input string
     * @returns {string} - Sanitized string with only digits
     */
    sanitizeVolumeInput: function(str) {
        return PopupProtocol.sanitizeVolumeInput(str);
    }
};
