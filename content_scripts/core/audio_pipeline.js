/**
 * Audio Pipeline Module - Handles creation and destruction of Web Audio graphs.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.AudioPipeline = {};

(function() {
    const { log, error, verbose, traceEnter, traceExit } = window.VolumeControl;
    const {
        DEFAULT_COMPRESSOR_KNEE, DEFAULT_COMPRESSOR_ATTACK, DEFAULT_COMPRESSOR_RELEASE,
        DEFAULT_MONO_ENABLED, DEFAULT_BALANCE,
        MAKEUP_GAIN_ENABLED, MAKEUP_GAIN_FACTOR, PRE_COMPRESSOR_GAIN_DB
    } = window.VolumeControl;

    function normalizeProcessingOptions(options) {
        if (typeof options === 'boolean') {
            return {
                compressionEnabled: options,
                monoEnabled: DEFAULT_MONO_ENABLED,
                balance: DEFAULT_BALANCE
            };
        }

        const source = options && typeof options === 'object' ? options : {};
        return {
            compressionEnabled: Boolean(source.compressionEnabled),
            monoEnabled: Boolean(source.monoEnabled),
            balance: Math.max(-100, Math.min(100, Number.isFinite(Number(source.balance)) ? Math.round(Number(source.balance)) : DEFAULT_BALANCE))
        };
    }

    /**
     * Create all audio nodes for an element
     * @param {AudioContext} audioContext - The audio context
     * @param {Object} sourceData - Source data from SourceCapture.createSource()
     * @param {Object} compressionSettings - Current compression settings
     * @returns {Object} - All created nodes
     */
    function createAudioNodes(audioContext, sourceData, compressionSettings) {
        const { source, stream, sourceType } = sourceData;
        
        verbose(`[AudioPipeline] Creating audio nodes...`);
        
        // Create all nodes
        const gainNode = audioContext.createGain();
        const compressorNode = audioContext.createDynamicsCompressor();
        const preCompressorGainNode = audioContext.createGain();
        const makeupGainNode = audioContext.createGain();
        const monoSplitterNode = audioContext.createChannelSplitter(2);
        const monoLeftGainNode = audioContext.createGain();
        const monoRightGainNode = audioContext.createGain();
        const monoMergerNode = audioContext.createChannelMerger(2);
        const stereoPannerNode = typeof audioContext.createStereoPanner === 'function'
            ? audioContext.createStereoPanner()
            : null;
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 32;
        
        // Initialize compressor parameters
        const {
            threshold = -18,
            ratio = 6,
            knee = DEFAULT_COMPRESSOR_KNEE
        } = compressionSettings;
        
        try {
            compressorNode.threshold.setValueAtTime(threshold, audioContext.currentTime);
            compressorNode.ratio.setValueAtTime(ratio, audioContext.currentTime);
            compressorNode.knee.setValueAtTime(knee, audioContext.currentTime);
            compressorNode.attack.setValueAtTime(DEFAULT_COMPRESSOR_ATTACK, audioContext.currentTime);
            compressorNode.release.setValueAtTime(DEFAULT_COMPRESSOR_RELEASE, audioContext.currentTime);
            
            // Pre-compressor gain boost
            const preCompGainLinear = Math.pow(10, PRE_COMPRESSOR_GAIN_DB / 20);
            preCompressorGainNode.gain.setValueAtTime(preCompGainLinear, audioContext.currentTime);
            
            // Initial makeup gain (will be recalculated when compression enabled)
            makeupGainNode.gain.setValueAtTime(1.0, audioContext.currentTime);

            // Mono stage averages both channels into dual-mono output.
            monoLeftGainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
            monoRightGainNode.gain.setValueAtTime(0.5, audioContext.currentTime);

            if (stereoPannerNode) {
                stereoPannerNode.pan.setValueAtTime(DEFAULT_BALANCE / 100, audioContext.currentTime);
            }
            
            verbose(`[AudioPipeline] Nodes created with compressor settings:`, {
                threshold: `${threshold} dB`,
                ratio: `${ratio}:1`,
                knee: `${knee} dB`
            });
        } catch (e) {
            error(`[AudioPipeline] Error setting compressor parameters:`, e);
        }
        
        return {
            source,
            sourceStream: stream,
            sourceType,
            gainNode,
            compressorNode,
            preCompressorGainNode,
            makeupGainNode,
            monoSplitterNode,
            monoLeftGainNode,
            monoRightGainNode,
            monoMergerNode,
            stereoPannerNode,
            analyser
        };
    }

    function updateAudioSettings(nodes, audioContext, settings) {
        const { stereoPannerNode } = nodes;
        const { balance = DEFAULT_BALANCE } = settings || {};

        if (!audioContext || !stereoPannerNode) {
            return;
        }

        try {
            stereoPannerNode.pan.setValueAtTime(Math.max(-1, Math.min(1, balance / 100)), audioContext.currentTime);
        } catch (e) {
            error(`[AudioPipeline] Error updating stereo pan:`, e);
        }
    }

    function disconnectNode(node) {
        if (!node) {
            return;
        }

        try {
            node.disconnect();
        } catch (e) {
            // Safe no-op when a node is not connected.
        }
    }

    /**
     * Connect audio graph nodes
     * @param {Object} nodes - All audio nodes
     * @param {AudioContext} audioContext - The audio context
     * @param {boolean} compressionEnabled - Whether to include compressor in chain
     */
    function connectGraph(nodes, audioContext, compressionEnabled) {
        const {
            source, gainNode, compressorNode, preCompressorGainNode, makeupGainNode,
            monoSplitterNode, monoLeftGainNode, monoRightGainNode, monoMergerNode,
            stereoPannerNode, analyser
        } = nodes;
        const options = normalizeProcessingOptions(compressionEnabled);
        const { compressionEnabled: shouldCompress, monoEnabled, balance } = options;
        
        traceEnter("connectGraph", shouldCompress ? "with compressor" : "bypass");
        
        // Disconnect all nodes first (safe to call even if not connected)
        disconnectNode(source);
        disconnectNode(preCompressorGainNode);
        disconnectNode(compressorNode);
        disconnectNode(makeupGainNode);
        disconnectNode(gainNode);
        disconnectNode(monoSplitterNode);
        disconnectNode(monoLeftGainNode);
        disconnectNode(monoRightGainNode);
        disconnectNode(monoMergerNode);
        disconnectNode(stereoPannerNode);
        disconnectNode(analyser);

        updateAudioSettings(nodes, audioContext, { balance });
        
        if (shouldCompress) {
            // Full chain with compressor
            // Source → PreGain(+6dB) → Compressor → MakeupGain → GainNode
            source.connect(preCompressorGainNode);
            preCompressorGainNode.connect(compressorNode);
            compressorNode.connect(makeupGainNode);
            makeupGainNode.connect(gainNode);
            
            verbose(`[AudioPipeline] Connected with compressor chain`);
        } else {
            // Bypass chain
            // Source → GainNode
            source.connect(gainNode);
            
            verbose(`[AudioPipeline] Connected bypass chain (no compressor)`);
        }

        let outputNode = gainNode;

        if (monoEnabled) {
            gainNode.connect(monoSplitterNode);
            monoSplitterNode.connect(monoLeftGainNode, 0);
            monoSplitterNode.connect(monoLeftGainNode, 1);
            monoSplitterNode.connect(monoRightGainNode, 0);
            monoSplitterNode.connect(monoRightGainNode, 1);
            monoLeftGainNode.connect(monoMergerNode, 0, 0);
            monoRightGainNode.connect(monoMergerNode, 0, 1);

            if (stereoPannerNode) {
                monoMergerNode.connect(stereoPannerNode);
                outputNode = stereoPannerNode;
            } else {
                outputNode = monoMergerNode;
            }
        } else if (stereoPannerNode) {
            gainNode.connect(stereoPannerNode);
            outputNode = stereoPannerNode;
        }

        outputNode.connect(analyser);
        analyser.connect(audioContext.destination);
        
        traceExit("connectGraph", "success");
    }

    function connectPassthrough(nodes, audioContext) {
        const {
            source, gainNode, compressorNode, preCompressorGainNode, makeupGainNode,
            monoSplitterNode, monoLeftGainNode, monoRightGainNode, monoMergerNode,
            stereoPannerNode, analyser
        } = nodes;

        traceEnter('connectPassthrough');

        disconnectNode(source);
        disconnectNode(preCompressorGainNode);
        disconnectNode(compressorNode);
        disconnectNode(makeupGainNode);
        disconnectNode(gainNode);
        disconnectNode(monoSplitterNode);
        disconnectNode(monoLeftGainNode);
        disconnectNode(monoRightGainNode);
        disconnectNode(monoMergerNode);
        disconnectNode(stereoPannerNode);
        disconnectNode(analyser);

        source.connect(analyser);
        analyser.connect(audioContext.destination);

        traceExit('connectPassthrough', 'success');
    }

    /**
     * Disconnect and cleanup all audio nodes
     * @param {Object} nodes - All audio nodes
     * @param {string} elementInfo - Element description for logging
     * @param {Object} options - Cleanup options
     * @param {boolean} options.releaseStream - Whether to release the source stream (default: true)
     *                                          Set to false for mozCaptureStream to preserve the stream
     */
    function disconnectGraph(nodes, elementInfo, options = {}) {
        if (!nodes) return;
        
        const { releaseStream = true } = options;
        
        const {
            source, sourceStream, sourceType,
            gainNode, compressorNode, preCompressorGainNode, makeupGainNode,
            monoSplitterNode, monoLeftGainNode, monoRightGainNode, monoMergerNode,
            stereoPannerNode, analyser
        } = nodes;
        
        verbose(`[AudioPipeline] Disconnecting graph for ${elementInfo}`);

        // Log stream state before disconnecting
        const logCallback = window.VolumeControl.logDiagnostic;
        if (logCallback) {
            logCallback('graph-disconnect', {
                elementInfo,
                sourceType,
                releaseStream,
                streamHasTracks: sourceStream?.getAudioTracks?.()?.length ?? -1,
                streamTrackStates: sourceStream?.getAudioTracks?.()?.map(t => ({
                    id: t.id, label: t.label, kind: t.kind,
                    enabled: t.enabled, readyState: t.readyState
                })),
                hasAnalyser: Boolean(analyser)
            }, { threshold: 3 });
        }
        
        try {
            // Disconnect all nodes
            if (source) source.disconnect();
            if (preCompressorGainNode) preCompressorGainNode.disconnect();
            if (compressorNode) compressorNode.disconnect();
            if (makeupGainNode) makeupGainNode.disconnect();
            if (gainNode) gainNode.disconnect();
            if (monoSplitterNode) monoSplitterNode.disconnect();
            if (monoLeftGainNode) monoLeftGainNode.disconnect();
            if (monoRightGainNode) monoRightGainNode.disconnect();
            if (monoMergerNode) monoMergerNode.disconnect();
            if (stereoPannerNode) stereoPannerNode.disconnect();
            if (analyser) analyser.disconnect();
            
            // Release source stream (critical for Firefox mozCaptureStream)
            // BUT: Only do this when fully cleaning up, NOT during source changes
            // mozCaptureStream() can only be called once per element - stopping the tracks
            // breaks it permanently and we can't recapture.
            if (releaseStream && sourceStream && window.VolumeControl.SourceCapture) {
                window.VolumeControl.SourceCapture.releaseSource(sourceStream, sourceType, elementInfo);
            } else if (!releaseStream) {
                verbose(`[AudioPipeline] Keeping source stream alive for ${elementInfo} (mozCaptureStream preservation)`);
            }
            
            verbose(`[AudioPipeline] Graph disconnected successfully`);
        } catch (err) {
            error(`[AudioPipeline] Error disconnecting graph:`, err);
        }
    }

    /**
     * Update compressor settings on existing nodes
     * @param {Object} nodes - Audio nodes with compressor
     * @param {AudioContext} audioContext - The audio context
     * @param {Object} settings - New compressor settings
     */
    function updateCompressorSettings(nodes, audioContext, settings) {
        const { compressorNode, makeupGainNode } = nodes;
        if (!compressorNode) return;
        
        const {
            enabled = false,
            threshold = -18,
            ratio = 6,
            knee = DEFAULT_COMPRESSOR_KNEE
        } = settings;
        
        try {
            compressorNode.threshold.setValueAtTime(threshold, audioContext.currentTime);
            compressorNode.ratio.setValueAtTime(ratio, audioContext.currentTime);
            compressorNode.knee.setValueAtTime(knee, audioContext.currentTime);
            
            // Update makeup gain based on new settings
            if (MAKEUP_GAIN_ENABLED && enabled && makeupGainNode) {
                const makeupGainDb = Math.abs(threshold) / ratio * MAKEUP_GAIN_FACTOR;
                const makeupGainLinear = Math.pow(10, makeupGainDb / 20);
                makeupGainNode.gain.setValueAtTime(makeupGainLinear, audioContext.currentTime);
                verbose(`[AudioPipeline] Makeup gain: ${makeupGainDb.toFixed(2)} dB`);
            } else if (makeupGainNode) {
                makeupGainNode.gain.setValueAtTime(1.0, audioContext.currentTime);
            }
            
            verbose(`[AudioPipeline] Updated compressor: threshold=${threshold}dB, ratio=${ratio}:1`);
        } catch (e) {
            error(`[AudioPipeline] Error updating compressor:`, e);
        }
    }

    /**
     * Set gain value
     * @param {GainNode} gainNode - The gain node
     * @param {AudioContext} audioContext - The audio context
     * @param {number} gainValue - Linear gain value (0 to 5)
     */
    function setGain(gainNode, audioContext, gainValue) {
        if (!gainNode || !audioContext) return;
        
        try {
            const clampedGain = Math.max(0, Math.min(5, gainValue));
            gainNode.gain.setValueAtTime(clampedGain, audioContext.currentTime);
        } catch (e) {
            error(`[AudioPipeline] Error setting gain:`, e);
        }
    }

    /**
     * Check if audio is flowing through the analyser
     * @param {AnalyserNode} analyser - The analyser node
     * @returns {Object} - { hasAudio: boolean, avgAmplitude: number, peakAmplitude: number }
     */
    function checkAudioFlow(analyser) {
        if (!analyser) return { hasAudio: false, avgAmplitude: 0, peakAmplitude: 0 };
        
        // Reuse a single analyser buffer to avoid allocation churn.
        if (!analyser._vcBuffer || analyser._vcBuffer.length !== analyser.frequencyBinCount) {
            analyser._vcBuffer = new Uint8Array(analyser.frequencyBinCount);
        }
        const dataArray = analyser._vcBuffer;
        analyser.getByteTimeDomainData(dataArray);
        
        let sum = 0;
        let peak = 0;
        
        for (let i = 0; i < dataArray.length; i++) {
            const amplitude = Math.abs(dataArray[i] - 128);
            sum += amplitude;
            peak = Math.max(peak, amplitude);
        }
        
        const avgAmplitude = sum / dataArray.length;
        const hasAudio = avgAmplitude > 0.5;
        
        return { hasAudio, avgAmplitude, peakAmplitude: peak };
    }

    /**
     * Get current compressor reduction
     * @param {DynamicsCompressorNode} compressorNode - The compressor node
     * @returns {number} - Gain reduction in dB (negative value)
     */
    function getCompressorReduction(compressorNode) {
        if (!compressorNode) return 0;
        return compressorNode.reduction;
    }

    // Export
    window.VolumeControl.AudioPipeline = {
        createAudioNodes,
        connectGraph,
        connectPassthrough,
        disconnectGraph,
        updateAudioSettings,
        updateCompressorSettings,
        setGain,
        checkAudioFlow,
        getCompressorReduction
    };

})();
