/**
 * Volume Controller Module
 * Handles volume calculation and application using native volume and gain nodes.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.VolumeController = {};

(function() {
    const { log, verbose, warn, logVolumeApply } = window.VolumeControl;
    const { NATIVE_VOLUME_EPSILON } = window.VolumeControl;

    /**
     * Calculate native volume and gain multiplier from desired percentage
     * @param {number} volumePercent - Desired volume (0-500)
     * @returns {Object} - { nativeVolume: 0-1, gainMultiplier: 0-5 }
     */
    function calculateVolumeLevels(volumePercent) {
        const clamped = Math.max(0, Math.min(500, volumePercent));
        
        if (clamped <= 100) {
            // Up to 100%: use native volume only, gain at 1.0
            return {
                nativeVolume: clamped / 100,
                gainMultiplier: 1.0,
                isAmplified: false
            };
        } else {
            // 100-500%: Native at 1.0, use gain for amplification
            return {
                nativeVolume: 1.0,
                gainMultiplier: clamped / 100,
                isAmplified: true
            };
        }
    }

    /**
     * Apply volume to an element with audio graph
     * @param {HTMLMediaElement} element - The media element
     * @param {Object} stateData - Element state data
     * @param {number} volumePercent - Volume to apply (0-500)
     * @param {Object} options - Optional settings
     * @returns {boolean} - Whether volume was applied
     */
    function applyVolume(element, stateData, volumePercent, options = {}) {
        const { force = false, timestamp = Date.now(), source = 'unknown' } = options;
        const elementInfo = stateData?.elementInfo || `${element.tagName}#${element.id || 'no-id'}`;
        
        // Skip if no state data or missing nodes
        if (!stateData || !stateData.gainNode || !stateData.audioContext) {
            verbose(`[VolumeController] Cannot apply volume to ${elementInfo}: missing audio nodes`);
            return false;
        }
        
        // Skip if same volume (unless forced)
        if (!force && stateData.lastAppliedVolume === volumePercent) {
            return true;
        }
        
        const levels = calculateVolumeLevels(volumePercent);
        const { nativeVolume, gainMultiplier } = levels;
        
        const previousVolume = stateData.lastAppliedVolume;
        const previousNativeVolume = element.volume;
        
        // Enhanced logging
        if (logVolumeApply) {
            logVolumeApply({
                source,
                elementInfo,
                targetVolume: volumePercent,
                previousVolume,
                method: 'applyVolume',
                force,
                willSetNativeVolume: true,
                nativeVolume,
                gainMultiplier,
                previousNativeVolume: (previousNativeVolume * 100).toFixed(1) + '%'
            });
        }
        
        // Record the change timestamp
        stateData.lastVolumeChangeAt = timestamp;
        
        // Apply volume: use native volume up to 100%, then keep native at 100% and use gain for amplification above 100%
        setNativeVolume(element, nativeVolume);
        
        // Gain compensates if native can't reach target
        const appliedNative = element.volume;
        const effectiveGain = appliedNative === 0 ? 0 : gainMultiplier / appliedNative * nativeVolume;
        
        setGainNode(stateData, effectiveGain);
        
        stateData.lastAppliedVolume = volumePercent;
        
        verbose(`[VolumeController] Applied ${volumePercent}% to ${elementInfo}: ` +
                `native=${element.volume.toFixed(3)}, gain=${gainMultiplier.toFixed(3)}`);
        
        return true;
    }

    /**
     * Set native element volume
     * @param {HTMLMediaElement} element - The media element
     * @param {number} volume - Volume 0-1
     */
    function setNativeVolume(element, volume) {
        const clamped = Math.max(0, Math.min(1, volume));
        const needsUpdate = Math.abs(element.volume - clamped) > NATIVE_VOLUME_EPSILON;
        
        if (needsUpdate) {
            try {
                element.volume = clamped;
            } catch (e) {
                warn(`[VolumeController] Failed to set native volume:`, e);
            }
        }
    }

    /**
     * Set gain node value
     * @param {Object} stateData - Element state data with gainNode
     * @param {number} gain - Gain multiplier
     */
    function setGainNode(stateData, gain) {
        const { gainNode, audioContext } = stateData;
        if (!gainNode || !audioContext) return;
        
        try {
            const clamped = Math.max(0, Math.min(5, gain));
            gainNode.gain.setValueAtTime(clamped, audioContext.currentTime);
        } catch (e) {
            warn(`[VolumeController] Failed to set gain:`, e);
        }
    }

    /**
     * Apply only the gain node value without touching native volume
     * Used after track switch when we just need to ensure gain is set
     * @param {Object} stateData - Element state data
     * @param {number} volumePercent - Volume percentage (0-500)
     */
    function applyGainOnly(stateData, volumePercent) {
        if (!stateData || !stateData.gainNode || !stateData.audioContext) {
            return false;
        }
        
        const levels = calculateVolumeLevels(volumePercent);
        
        // Enhanced logging
        if (logVolumeApply) {
            logVolumeApply({
                source: 'applyGainOnly',
                elementInfo: stateData.elementInfo || 'unknown',
                targetVolume: volumePercent,
                previousVolume: stateData.lastAppliedVolume,
                method: 'applyGainOnly',
                willSetNativeVolume: false,
                gainMultiplier: levels.gainMultiplier
            });
        }
        
        setGainNode(stateData, levels.gainMultiplier);
        
        verbose(`[VolumeController] Applied gain only: ${levels.gainMultiplier.toFixed(3)} for ${volumePercent}%`);
        return true;
    }

    /**
     * Apply native volume only (for CORS-blocked elements that can't use GainNode)
     * Native-only paths still set element.volume directly and rely on the player/browser
     * to honour or clamp values as supported.
     * @param {HTMLMediaElement} element - The media element
     * @param {number} volumePercent - Volume to apply (0-500)
     * @returns {boolean} - Whether volume was applied
     */
    function applyNativeVolumeOnly(element, volumePercent) {
        const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
        
        if (typeof volumePercent !== 'number' || isNaN(volumePercent)) {
            warn(`[VolumeController] Invalid volume percent for ${elementInfo}:`, volumePercent);
            return false;
        }

        const requestedPercent = Math.max(0, volumePercent);
        const nativeVolume = requestedPercent / 100;
        
        try {
            const currentVolume = element.volume;
            const needsUpdate = Math.abs(currentVolume - nativeVolume) > (NATIVE_VOLUME_EPSILON || 0.001);
            
            if (needsUpdate) {
                element.volume = nativeVolume;
                verbose(
                    `[VolumeController] Applied native-only request ${requestedPercent}% to ${elementInfo} ` +
                    `(actual native volume=${(element.volume * 100).toFixed(1)}%)`
                );
            }
            return true;
        } catch (e) {
            warn(`[VolumeController] Failed to set native volume on CORS-blocked ${elementInfo}:`, e);
            return false;
        }
    }

    /**
     * Apply mute state to element
     * @param {HTMLMediaElement} element - The media element
     * @param {boolean} muted - Whether to mute
     */
    function applyMute(element, muted) {
        if (element.muted !== muted) {
            element.muted = muted;
            verbose(`[VolumeController] Set muted=${muted} on ${element.tagName}#${element.id || 'no-id'}`);
        }
    }

    /**
     * Get effective volume from element
     * @param {HTMLMediaElement} element - The media element
     * @returns {number} - Volume as percentage (0-100 based on native only)
     */
    function getEffectiveVolume(element) {
        if (element.muted) return 0;
        return Math.round(element.volume * 100);
    }

    /**
     * Apply volume to all active elements
     * @param {number} volumePercent - Volume to apply
     * @param {Map} elementsMap - Map of element -> stateData
     */
    function applyToAll(volumePercent, elementsMap) {
        const timestamp = Date.now();
        let appliedCount = 0;
        
        // Prefer enum state checks to avoid string literal drift.
        const ElementState = window.VolumeControl.ElementState;
        elementsMap.forEach((stateData, element) => {
            if (stateData.state === ElementState.ACTIVE || stateData.gainNode) {
                if (applyVolume(element, stateData, volumePercent, { timestamp })) {
                    appliedCount++;
                }
            }
        });
        
        log(`[VolumeController] Applied ${volumePercent}% to ${appliedCount} elements`);
        return appliedCount;
    }

    // Export
    window.VolumeControl.VolumeController = {
        calculateVolumeLevels,
        applyVolume,
        applyNativeVolumeOnly,
        applyGainOnly,
        setNativeVolume,
        setGainNode,
        applyMute,
        getEffectiveVolume,
        applyToAll
    };

})();
