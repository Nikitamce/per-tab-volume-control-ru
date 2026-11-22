/**
 * Compressor Module - Dynamic range compression (optional feature).
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.Compressor = {};

(function() {
    const { log, warn, error, verbose } = window.VolumeControl;
    const {
        DEFAULT_COMPRESSOR_THRESHOLD,
        DEFAULT_COMPRESSOR_RATIO,
        DEFAULT_COMPRESSOR_KNEE,
        DEFAULT_COMPRESSOR_ATTACK,
        DEFAULT_COMPRESSOR_RELEASE,
        MAKEUP_GAIN_ENABLED,
        MAKEUP_GAIN_FACTOR,
        COMPRESSOR_MONITOR_INTERVAL_MS,
        COMPRESSOR_THRESHOLD_MIN,
        COMPRESSOR_THRESHOLD_MAX,
        COMPRESSOR_RATIO_MIN,
        COMPRESSOR_RATIO_MAX,
        COMPRESSOR_KNEE_MIN,
        COMPRESSOR_KNEE_MAX
    } = window.VolumeControl;

    /**
     * Default compressor settings
     */
    const DEFAULT_SETTINGS = {
        enabled: false,
        threshold: DEFAULT_COMPRESSOR_THRESHOLD || -18,
        ratio: DEFAULT_COMPRESSOR_RATIO || 6,
        knee: DEFAULT_COMPRESSOR_KNEE || 3,
        attack: DEFAULT_COMPRESSOR_ATTACK || 0.003,
        release: DEFAULT_COMPRESSOR_RELEASE || 0.100
    };

    /**
     * Settings ranges for UI validation
     */
    const SETTINGS_RANGES = {
        threshold: { min: COMPRESSOR_THRESHOLD_MIN || -50, max: COMPRESSOR_THRESHOLD_MAX || -10 },
        ratio: { min: COMPRESSOR_RATIO_MIN || 2, max: COMPRESSOR_RATIO_MAX || 12 },
        knee: { min: COMPRESSOR_KNEE_MIN || 0, max: COMPRESSOR_KNEE_MAX || 20 }
    };

    /**
     * Validate and clamp compressor settings
     * @param {Object} settings - Raw settings
     * @returns {Object} - Validated settings
     */
    function validateSettings(settings) {
        const validated = { ...DEFAULT_SETTINGS };
        
        if (typeof settings.enabled === 'boolean') {
            validated.enabled = settings.enabled;
        }
        
        if (typeof settings.threshold === 'number') {
            validated.threshold = Math.max(
                SETTINGS_RANGES.threshold.min,
                Math.min(SETTINGS_RANGES.threshold.max, settings.threshold)
            );
        }
        
        if (typeof settings.ratio === 'number') {
            validated.ratio = Math.max(
                SETTINGS_RANGES.ratio.min,
                Math.min(SETTINGS_RANGES.ratio.max, settings.ratio)
            );
        }
        
        if (typeof settings.knee === 'number') {
            validated.knee = Math.max(
                SETTINGS_RANGES.knee.min,
                Math.min(SETTINGS_RANGES.knee.max, settings.knee)
            );
        }
        
        return validated;
    }

    /**
     * Calculate makeup gain to compensate for compression
     * Formula: makeupGain ≈ |threshold| / ratio
     * @param {number} threshold - Compression threshold in dB (negative)
     * @param {number} ratio - Compression ratio
     * @returns {number} - Linear gain multiplier
     */
    function calculateMakeupGain(threshold, ratio) {
        if (!MAKEUP_GAIN_ENABLED) return 1.0;
        
        const makeupGainDb = Math.abs(threshold) / ratio * (MAKEUP_GAIN_FACTOR || 0.7);
        const makeupGainLinear = Math.pow(10, makeupGainDb / 20);
        
        return makeupGainLinear;
    }

    /**
     * Apply settings to a compressor node
     * @param {DynamicsCompressorNode} compressorNode
     * @param {GainNode} makeupGainNode
     * @param {AudioContext} audioContext
     * @param {Object} settings
     */
    function applySettings(compressorNode, makeupGainNode, audioContext, settings) {
        if (!compressorNode || !audioContext) return;
        
        const validated = validateSettings(settings);
        
        try {
            compressorNode.threshold.setValueAtTime(validated.threshold, audioContext.currentTime);
            compressorNode.ratio.setValueAtTime(validated.ratio, audioContext.currentTime);
            compressorNode.knee.setValueAtTime(validated.knee, audioContext.currentTime);
            compressorNode.attack.setValueAtTime(validated.attack, audioContext.currentTime);
            compressorNode.release.setValueAtTime(validated.release, audioContext.currentTime);
            
            // Apply makeup gain
            if (makeupGainNode) {
                const makeupGain = validated.enabled 
                    ? calculateMakeupGain(validated.threshold, validated.ratio)
                    : 1.0;
                makeupGainNode.gain.setValueAtTime(makeupGain, audioContext.currentTime);
            }
            
            verbose(`[Compressor] Applied settings:`, validated);
        } catch (e) {
            error(`[Compressor] Error applying settings:`, e);
        }
    }

    /**
     * Get current compression reduction (how much compression is happening)
     * @param {DynamicsCompressorNode} compressorNode
     * @returns {number} - Reduction in dB (negative value)
     */
    function getReduction(compressorNode) {
        if (!compressorNode) return 0;
        return compressorNode.reduction;
    }

    /**
     * Check if compression is actively working
     * @param {DynamicsCompressorNode} compressorNode
     * @returns {boolean}
     */
    function isCompressing(compressorNode) {
        return getReduction(compressorNode) < -0.5;
    }

    /**
     * Create a settings key for comparison (to detect changes)
     * @param {Object} settings
     * @returns {string}
     */
    function createSettingsKey(settings) {
        const { enabled, threshold, ratio, knee } = validateSettings(settings);
        return `${enabled}_${threshold}_${ratio}_${knee}`;
    }

    /**
     * CompressorMonitor - Monitors compression in real-time
     */
    class CompressorMonitor {
        constructor() {
            this.intervals = new Map(); // element -> intervalId
            this.monitorIntervalMs = COMPRESSOR_MONITOR_INTERVAL_MS || 2000;
        }

        /**
         * Start monitoring an element's compressor
         * @param {HTMLMediaElement} element
         * @param {Object} stateData - Element state data with compressor node
         * @param {Function} onMonitorData - Callback with monitor data
         */
        start(element, stateData, onMonitorData) {
            // Clear existing monitor
            this.stop(element);
            
            const intervalId = setInterval(() => {
                if (!stateData.compressorNode || !stateData.analyser) return;
                
                const isPlaying = !element.paused && !element.ended && element.currentTime > 0;
                if (!isPlaying) return;
                
                const reduction = getReduction(stateData.compressorNode);
                const audioFlow = window.VolumeControl.AudioPipeline?.checkAudioFlow(stateData.analyser);
                
                const monitorData = {
                    reduction,
                    isCompressing: reduction < -0.5,
                    audioAmplitude: audioFlow?.avgAmplitude || 0,
                    hasAudio: audioFlow?.hasAudio || false,
                    threshold: stateData.compressorNode.threshold.value,
                    ratio: stateData.compressorNode.ratio.value
                };
                
                if (onMonitorData) {
                    onMonitorData(element, monitorData);
                }
                
                // Warn if compression is aggressive
                if (monitorData.isCompressing && reduction < -10) {
                    warn(`[CompressorMonitor] Aggressive compression: ${reduction.toFixed(2)} dB`);
                }
            }, this.monitorIntervalMs);
            
            this.intervals.set(element, intervalId);
            verbose(`[CompressorMonitor] Started monitoring ${element.tagName}#${element.id || 'no-id'}`);
        }

        /**
         * Stop monitoring an element
         * @param {HTMLMediaElement} element
         */
        stop(element) {
            const intervalId = this.intervals.get(element);
            if (intervalId) {
                clearInterval(intervalId);
                this.intervals.delete(element);
            }
        }

        /**
         * Stop all monitoring
         */
        stopAll() {
            this.intervals.forEach(intervalId => clearInterval(intervalId));
            this.intervals.clear();
        }
    }

    // Create singleton
    const compressorMonitor = new CompressorMonitor();

    // Export
    window.VolumeControl.Compressor = {
        // Constants
        DEFAULT_SETTINGS,
        SETTINGS_RANGES,
        
        // Functions
        validateSettings,
        calculateMakeupGain,
        applySettings,
        getReduction,
        isCompressing,
        createSettingsKey,
        
        // Monitor
        monitor: compressorMonitor
    };

})();
