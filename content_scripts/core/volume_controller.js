/**
 * Volume Controller Module
 * Handles volume calculation and application using native volume and gain nodes.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.VolumeController = {};

(function() {
    const { log, verbose, warn, logVolumeApply } = window.VolumeControl;
    const { NATIVE_VOLUME_EPSILON } = window.VolumeControl;
    const Protocol = globalThis.VCProtocol;
    const MASK_MIN_NATIVE_VOLUME = 0.001; // Below this a page write is silent and gain cannot hold it
    const MASK_MAX_SCALE = 100; // Upper bound for the compensating step on a very quiet page write
    const MASK_FAILSAFE_MS = 500; // A mask never outlives this, even if no decision ever releases it
    // Last gain written to a node outside any mask, kept per node so a rebuilt graph starts fresh.
    const restingGain = new WeakMap();

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
        
        // Gain compensates if native can't reach target. Native at 0 has nothing to compensate:
        // the gain stays at its multiplier (1 up to 100%), because a gain of 0 would be a second,
        // hidden mute that no later non-zero native volume undoes.
        const appliedNative = element.volume;
        const effectiveGain = appliedNative > 0 ? gainMultiplier / appliedNative * nativeVolume : gainMultiplier;
        
        setGainNode(stateData, effectiveGain);

        // Native is back at the managed value, so the page-write mask has done its job.
        releasePageVolumeMask(stateData);
        
        stateData.lastAppliedVolume = volumePercent;
        
        verbose(`[VolumeController] Applied ${volumePercent}% to ${elementInfo}: ` +
                `native=${element.volume.toFixed(3)}, gain=${effectiveGain.toFixed(3)}`);
        
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
            const mask = stateData.gainMask;
            if (mask && mask.node === gainNode) {
                // This node is held by a page-write mask: the new gain becomes the one the
                // release hands back, instead of being written under the mask.
                mask.savedGain = clamped;
            } else {
                gainNode.gain.setValueAtTime(clamped, audioContext.currentTime);
            }
            // AudioParam.value can lag a write made in the same render quantum, so the
            // gain a mask must hand back is remembered instead of being read back.
            restingGain.set(gainNode, clamped);
        } catch (e) {
            warn(`[VolumeController] Failed to set gain:`, e);
        }
    }

    /**
     * Hold the audible level while a passive page write to element.volume waits for a
     * decision. Firefox applies element.volume to the output within the next audio block,
     * so until the managed volume is restored the page's own level is audible. A gain step
     * made in the same task as the page's write lands in the same audio batch, so the output
     * never moves; the decision engine later restores native volume and releases the mask.
     *
     * The step goes on the first gain node after the source, because that is the only place
     * where scaling is linear: the pre-compressor gain with the compressor on (the compressor
     * then sees exactly the signal it would see at the managed volume, so it never dips or
     * pumps), the main gain node otherwise. It never touches the source, which the
     * held-gesture rule forbids rewriting during a wait.
     *
     * One mask per element: overlapping page writes reuse it and only retarget the step.
     *
     * @param {HTMLMediaElement} element - Media element holding the page-written volume
     * @param {Object} stateData - Element state data
     * @param {number} volumePercent - Managed target (0-500)
     * @param {boolean} [compressed] - Whether the compressor is in the connected graph
     * @returns {Object|null} - Mask token for releasePageVolumeMask, or null if nothing was masked
     */
    function maskPageVolumeWrite(element, stateData, volumePercent, compressed = false) {
        const { audioContext } = stateData || {};
        const node = compressed ? stateData?.preCompressorGainNode : stateData?.gainNode;
        // A passthrough graph bypasses the gain nodes, so masking would do nothing.
        if (!node || !audioContext || stateData.passthroughMode) return null;

        const native = element.volume;
        if (!(native > MASK_MIN_NATIVE_VOLUME)) return null;

        try {
            // The audible level is native * gain, and the managed native volume is min(1, target).
            const scale = Math.min(MASK_MAX_SCALE, Math.min(1, volumePercent / 100) / native);
            let mask = stateData.gainMask;
            if (!mask || mask.node !== node) {
                // A mask on another node (the compressor toggled mid-mask) would otherwise be
                // orphaned: its release would no-op and that node would stay stepped down.
                if (mask) {
                    releasePageVolumeMask(stateData, mask);
                }
                // Saved before the first mask write, and from what was last written rather
                // than from AudioParam.value, which can lag a write in the same audio block.
                if (!restingGain.has(node)) restingGain.set(node, node.gain.value);
                mask = { node, savedGain: restingGain.get(node), timer: null };
                mask.timer = setTimeout(() => releasePageVolumeMask(stateData, mask), MASK_FAILSAFE_MS);
                stateData.gainMask = mask;
            }
            node.gain.setValueAtTime(mask.savedGain * scale, audioContext.currentTime);
            return mask;
        } catch (e) {
            warn(`[VolumeController] Failed to mask page volume write:`, e);
            return null;
        }
    }

    /**
     * Hand the real gain back once native volume is managed again. With a token, only that
     * mask is released, so a late caller cannot undo a newer one.
     * @param {Object} stateData - Element state data
     * @param {Object} [mask] - Token returned by maskPageVolumeWrite
     * @returns {boolean} - Whether the saved gain was written back
     */
    function releasePageVolumeMask(stateData, mask) {
        const current = stateData?.gainMask;
        if (!current || (mask && current !== mask)) return false;

        clearTimeout(current.timer);
        stateData.gainMask = null;
        const live = current.node === stateData.gainNode || current.node === stateData.preCompressorGainNode;
        if (!live || !stateData.audioContext) return false;
        try {
            current.node.gain.setValueAtTime(current.savedGain, stateData.audioContext.currentTime);
            return true;
        } catch (e) {
            warn(`[VolumeController] Failed to release page volume mask:`, e);
            return false;
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
     * HTMLMediaElement.volume is specified as [0, 1]; requests above 100% clamp to 1.0.
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
        const nativeVolume = Math.min(1, requestedPercent / 100);
        
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
        return Protocol.nativeVolumeToPercent(element.volume);
    }

    // Export
    window.VolumeControl.VolumeController = {
        calculateVolumeLevels,
        applyVolume,
        applyNativeVolumeOnly,
        applyGainOnly,
        setNativeVolume,
        setGainNode,
        maskPageVolumeWrite,
        releasePageVolumeMask,
        applyMute,
        getEffectiveVolume
    };

})();
