/**
 * Storage Sync Module - Handles persistence of settings to sessionStorage.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.StorageSync = {};

(function() {
    const { log, warn, verbose } = window.VolumeControl;
    const { 
        MIN_VOLUME,
        MAX_VOLUME,
        DEFAULT_VOLUME,
        SESSION_STORAGE_KEY_VOLUME,
        SESSION_STORAGE_KEY_MONO_ENABLED,
        SESSION_STORAGE_KEY_BALANCE,
        SESSION_STORAGE_KEY_COMPRESSION_ENABLED,
        SESSION_STORAGE_KEY_COMPRESSION_THRESHOLD,
        SESSION_STORAGE_KEY_COMPRESSION_RATIO,
        SESSION_STORAGE_KEY_COMPRESSION_KNEE,
        STORAGE_WRITE_DEBOUNCE_MS,
        DEFAULT_MONO_ENABLED,
        DEFAULT_BALANCE,
        BALANCE_MIN,
        BALANCE_MAX,
        COMPRESSOR_THRESHOLD_MIN,
        COMPRESSOR_THRESHOLD_MAX,
        COMPRESSOR_RATIO_MIN,
        COMPRESSOR_RATIO_MAX,
        COMPRESSOR_KNEE_MIN,
        COMPRESSOR_KNEE_MAX,
        DEFAULT_COMPRESSOR_THRESHOLD,
        DEFAULT_COMPRESSOR_RATIO,
        DEFAULT_COMPRESSOR_KNEE
    } = window.VolumeControl;

    /**
     * StorageSyncManager - Manages settings persistence
     */
    class StorageSyncManager {
        constructor() {
            this.pendingWrites = {};
            this.writeTimer = null;
            this.isAvailable = this._checkAvailability();
        }

        /**
         * Check if sessionStorage is available
         */
        _checkAvailability() {
            try {
                const test = '__vc_test__';
                sessionStorage.setItem(test, test);
                sessionStorage.removeItem(test);
                return true;
            } catch (e) {
                warn('[StorageSync] sessionStorage not available');
                return false;
            }
        }

        /**
         * Schedule a debounced write
         * @param {string} key - Storage key
         * @param {string} value - Value to write
         */
        scheduleWrite(key, value) {
            if (!this.isAvailable) return;

            this.pendingWrites[key] = value;

            if (this.writeTimer) {
                clearTimeout(this.writeTimer);
            }

            this.writeTimer = setTimeout(() => {
                this.flushWrites();
            }, STORAGE_WRITE_DEBOUNCE_MS || 500);
        }

        /**
         * Immediately flush all pending writes
         */
        flushWrites() {
            if (!this.isAvailable) return;
            if (Object.keys(this.pendingWrites).length === 0) return;

            try {
                for (const [key, value] of Object.entries(this.pendingWrites)) {
                    sessionStorage.setItem(key, value);
                    verbose(`[StorageSync] Wrote ${key}=${value}`);
                }
                this.pendingWrites = {};
            } catch (e) {
                warn('[StorageSync] Error writing to sessionStorage:', e);
            }

            if (this.writeTimer) {
                clearTimeout(this.writeTimer);
                this.writeTimer = null;
            }
        }

        /**
         * Read a value from storage
         * @param {string} key - Storage key
         * @param {*} defaultValue - Default value if not found
         * @returns {string|null}
         */
        read(key, defaultValue = null) {
            if (!this.isAvailable) return defaultValue;

            try {
                const value = sessionStorage.getItem(key);
                return value !== null ? value : defaultValue;
            } catch (e) {
                warn('[StorageSync] Error reading from sessionStorage:', e);
                return defaultValue;
            }
        }

        /**
         * Save volume setting
         * @param {number} volume - Volume percentage (0-500)
         */
        saveVolume(volume) {
            this.scheduleWrite(SESSION_STORAGE_KEY_VOLUME, volume.toString());
        }

        /**
         * Save channel settings
         * @param {Object} settings - Audio channel settings
         */
        saveAudioSettings(settings) {
            const { monoEnabled, balance } = settings;

            this.scheduleWrite(SESSION_STORAGE_KEY_MONO_ENABLED, Boolean(monoEnabled).toString());
            this.scheduleWrite(SESSION_STORAGE_KEY_BALANCE, Number(balance).toString());
        }

        /**
         * Save all compression settings
         * @param {Object} settings - Compression settings
         */
        saveCompressionSettings(settings) {
            const { enabled, threshold, ratio, knee } = settings;
            
            this.scheduleWrite(SESSION_STORAGE_KEY_COMPRESSION_ENABLED, enabled.toString());
            this.scheduleWrite(SESSION_STORAGE_KEY_COMPRESSION_THRESHOLD, threshold.toString());
            this.scheduleWrite(SESSION_STORAGE_KEY_COMPRESSION_RATIO, ratio.toString());
            this.scheduleWrite(SESSION_STORAGE_KEY_COMPRESSION_KNEE, knee.toString());
        }

        /**
         * Load all settings from storage
         * @returns {Object} - Loaded settings
         */
        loadAllSettings() {
            const settings = {
                volume: DEFAULT_VOLUME,
                volumeWasStored: false, // Track if volume was actually in storage
                monoEnabled: DEFAULT_MONO_ENABLED,
                monoWasStored: false,
                balance: DEFAULT_BALANCE,
                balanceWasStored: false,
                compressionEnabled: false,
                compressionWasStored: false,
                compressionThreshold: DEFAULT_COMPRESSOR_THRESHOLD,
                compressionRatio: DEFAULT_COMPRESSOR_RATIO,
                compressionKnee: DEFAULT_COMPRESSOR_KNEE
            };

            if (!this.isAvailable) {
                log('[StorageSync] Storage not available, using defaults');
                return settings;
            }

            // Load volume
            try {
                const storedVolume = this.read(SESSION_STORAGE_KEY_VOLUME);
                if (storedVolume !== null) {
                    const parsed = parseInt(storedVolume, 10);
                    if (!isNaN(parsed) && parsed >= MIN_VOLUME && parsed <= MAX_VOLUME) {
                        settings.volume = parsed;
                        settings.volumeWasStored = true;
                        log(`[StorageSync] Loaded volume: ${settings.volume}%`);
                    }
                }
            } catch (e) {
                warn('[StorageSync] Error loading volume:', e);
            }

            // Load mono enabled
            try {
                const storedMonoEnabled = this.read(SESSION_STORAGE_KEY_MONO_ENABLED);
                if (storedMonoEnabled !== null) {
                    settings.monoEnabled = storedMonoEnabled === 'true';
                    settings.monoWasStored = true;
                    log(`[StorageSync] Loaded mono enabled: ${settings.monoEnabled}`);
                }
            } catch (e) {
                warn('[StorageSync] Error loading mono enabled:', e);
            }

            // Load balance
            try {
                const storedBalance = this.read(SESSION_STORAGE_KEY_BALANCE);
                if (storedBalance !== null) {
                    const parsed = parseInt(storedBalance, 10);
                    if (!isNaN(parsed) && parsed >= BALANCE_MIN && parsed <= BALANCE_MAX) {
                        settings.balance = parsed;
                        settings.balanceWasStored = true;
                        log(`[StorageSync] Loaded balance: ${settings.balance}`);
                    }
                }
            } catch (e) {
                warn('[StorageSync] Error loading balance:', e);
            }

            // Load compression enabled
            try {
                const storedEnabled = this.read(SESSION_STORAGE_KEY_COMPRESSION_ENABLED);
                if (storedEnabled !== null) {
                    settings.compressionEnabled = storedEnabled === 'true';
                    settings.compressionWasStored = true;
                    log(`[StorageSync] Loaded compression enabled: ${settings.compressionEnabled}`);
                }
            } catch (e) {
                warn('[StorageSync] Error loading compression enabled:', e);
            }

            // Load compression threshold
            try {
                const storedThreshold = this.read(SESSION_STORAGE_KEY_COMPRESSION_THRESHOLD);
                if (storedThreshold !== null) {
                    const parsed = parseInt(storedThreshold, 10);
                    if (!isNaN(parsed) && 
                        parsed >= (COMPRESSOR_THRESHOLD_MIN || -50) && 
                        parsed <= (COMPRESSOR_THRESHOLD_MAX || -10)) {
                        settings.compressionThreshold = parsed;
                        log(`[StorageSync] Loaded compression threshold: ${settings.compressionThreshold}dB`);
                    }
                }
            } catch (e) {
                warn('[StorageSync] Error loading compression threshold:', e);
            }

            // Load compression ratio
            try {
                const storedRatio = this.read(SESSION_STORAGE_KEY_COMPRESSION_RATIO);
                if (storedRatio !== null) {
                    const parsed = parseInt(storedRatio, 10);
                    if (!isNaN(parsed) && 
                        parsed >= (COMPRESSOR_RATIO_MIN || 2) && 
                        parsed <= (COMPRESSOR_RATIO_MAX || 12)) {
                        settings.compressionRatio = parsed;
                        log(`[StorageSync] Loaded compression ratio: ${settings.compressionRatio}:1`);
                    }
                }
            } catch (e) {
                warn('[StorageSync] Error loading compression ratio:', e);
            }

            // Load compression knee
            try {
                const storedKnee = this.read(SESSION_STORAGE_KEY_COMPRESSION_KNEE);
                if (storedKnee !== null) {
                    const parsed = parseInt(storedKnee, 10);
                    if (!isNaN(parsed) && 
                        parsed >= (COMPRESSOR_KNEE_MIN || 0) && 
                        parsed <= (COMPRESSOR_KNEE_MAX || 20)) {
                        settings.compressionKnee = parsed;
                        log(`[StorageSync] Loaded compression knee: ${settings.compressionKnee}dB`);
                    }
                }
            } catch (e) {
                warn('[StorageSync] Error loading compression knee:', e);
            }

            return settings;
        }

        /**
         * Apply loaded settings to state
         * @param {Object} state - State object to update
         * @returns {Object} - The loaded settings
         */
        loadAndApplyToState(state) {
            const settings = this.loadAllSettings();

            state.currentVolumePercent = settings.volume;
            state.currentMonoEnabled = settings.monoEnabled;
            state.localBalance = settings.balance;
            state.currentBalance = settings.balance;
            state.currentCompressionEnabled = settings.compressionEnabled;
            state.currentCompressionThreshold = settings.compressionThreshold;
            state.currentCompressionRatio = settings.compressionRatio;
            state.currentCompressionKnee = settings.compressionKnee;

            // If volume was loaded from storage (different from default), mark it as set
            // This prevents adopting player volume on first element setup
            if (settings.volumeWasStored) {
                state.volumeHasBeenSet = true;
                log('[StorageSync] Volume was stored, marking as set');
            }

            if (settings.monoWasStored) {
                state.monoHasBeenSet = true;
            }

            if (settings.balanceWasStored) {
                state.balanceHasBeenSet = true;
            }

            if (settings.compressionWasStored) {
                state.compressionHasBeenSet = true;
            }

            log('[StorageSync] Applied settings to state');
            return settings;
        }

        /**
         * Clear all stored settings
         */
        clearAll() {
            if (!this.isAvailable) return;

            try {
                sessionStorage.removeItem(SESSION_STORAGE_KEY_VOLUME);
                sessionStorage.removeItem(SESSION_STORAGE_KEY_MONO_ENABLED);
                sessionStorage.removeItem(SESSION_STORAGE_KEY_BALANCE);
                sessionStorage.removeItem(SESSION_STORAGE_KEY_COMPRESSION_ENABLED);
                sessionStorage.removeItem(SESSION_STORAGE_KEY_COMPRESSION_THRESHOLD);
                sessionStorage.removeItem(SESSION_STORAGE_KEY_COMPRESSION_RATIO);
                sessionStorage.removeItem(SESSION_STORAGE_KEY_COMPRESSION_KNEE);
                log('[StorageSync] Cleared all settings');
            } catch (e) {
                warn('[StorageSync] Error clearing settings:', e);
            }
        }

        /**
         * Cleanup on unload
         */
        cleanup() {
            this.flushWrites();
            if (this.writeTimer) {
                clearTimeout(this.writeTimer);
                this.writeTimer = null;
            }
        }
    }

    // Export to VolumeControl namespace
    window.VolumeControl.StorageSyncManager = StorageSyncManager;

    // Create singleton instance
    window.VolumeControl.storageSync = new StorageSyncManager();

    // Keep backward compatibility with existing code
    window.VolumeControl.scheduleStorageWrite = function(key, value) {
        window.VolumeControl.storageSync.scheduleWrite(key, value);
    };

    window.VolumeControl.flushStorageWrites = function() {
        window.VolumeControl.storageSync.flushWrites();
    };

    window.VolumeControl.loadSettingsFromStorage = function() {
        const State = window.VolumeControl.State;
        window.VolumeControl.storageSync.loadAndApplyToState(State);
    };
})();
