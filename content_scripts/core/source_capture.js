/**
 * Source Capture Module - Browser-specific audio source capture methods.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.SourceCapture = {};

(function() {
    const { log, warn, error, verbose } = window.VolumeControl;
    const { FIREFOX_STANDARD_CAPTURE_MIN_VERSION } = window.VolumeControl;

    /**
     * Source types
     */
    const SourceType = {
        MOZ_CAPTURE_STREAM: 'mozCaptureStream',
        MEDIA_ELEMENT_SOURCE: 'mediaElementSource'
    };

    /**
     * CORS check result
     */
    const CorsCheckResult = {
        ALLOWED: 'allowed',
        BLOCKED: 'blocked',
        SAME_ORIGIN: 'same_origin',
        BLOB_OR_DATA: 'blob_or_data',
        MEDIA_STREAM: 'media_stream'
    };

    function getElementSourceKey(element) {
        if (!element) return '';

        const mediaSrc = element.currentSrc || element.src || '';
        if (mediaSrc && mediaSrc !== 'about:blank') {
            return mediaSrc;
        }

        if (element.srcObject) {
            const objectId = typeof element.srcObject.id === 'string' && element.srcObject.id
                ? element.srcObject.id
                : 'attached';
            return `srcObject:${objectId}`;
        }

        return '';
    }

    function hasUsableMediaSource(element) {
        return Boolean(getElementSourceKey(element));
    }

    function getFirefoxMajorVersion() {
        const ua = navigator.userAgent || '';
        const match = ua.match(/Firefox\/(\d+)/);
        if (!match) return null;
        const major = Number(match[1]);
        return Number.isInteger(major) && major > 0 ? major : null;
    }

    function getFirefoxStandardCaptureMinVersion() {
        const configured = Number(FIREFOX_STANDARD_CAPTURE_MIN_VERSION);
        if (!Number.isInteger(configured) || configured < 1) {
            warn(
                `[SourceCapture] Invalid FIREFOX_STANDARD_CAPTURE_MIN_VERSION="${FIREFOX_STANDARD_CAPTURE_MIN_VERSION}"; falling back to 149`
            );
            return 149;
        }
        return configured;
    }

    function shouldUseLegacyFirefoxCapture(ffVersion) {
        if (ffVersion === null) return false;
        return ffVersion < getFirefoxStandardCaptureMinVersion();
    }

    function isFirefoxBrowser() {
        return getFirefoxMajorVersion() !== null;
    }

    function buildTemporaryCaptureError(message) {
        const captureError = new Error(message);
        captureError.name = 'NotReadyError';
        captureError.isTemporary = true;
        return captureError;
    }

    /**
     * Check if an element's source is CORS-blocked
     * @param {HTMLMediaElement} element - The media element to check
     * @returns {Object} - { allowed: boolean, reason: string }
     */
    function checkCorsStatus(element) {
        const mediaSrc = element.currentSrc || element.src || '';
        const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;

        if (element.srcObject) {
            verbose(`[SourceCapture] ${elementInfo}: srcObject present - CORS allowed`);
            return {
                allowed: true,
                reason: CorsCheckResult.MEDIA_STREAM,
                message: 'MediaStream source attached'
            };
        }

        // No source - can't determine CORS status yet
        // Return as temporary block - setup will retry later
        if (!hasUsableMediaSource(element)) {
            return {
                allowed: false,
                reason: CorsCheckResult.BLOCKED,
                message: 'No valid source',
                isTemporary: true  // Signal that this might change - don't mark as CORS blocked
            };
        }

        // Blob and data URLs are always same-origin
        const isBlob = mediaSrc.startsWith('blob:');
        const isData = mediaSrc.startsWith('data:');
        if (isBlob || isData) {
            verbose(`[SourceCapture] ${elementInfo}: Blob/data URL - CORS allowed`);
            return {
                allowed: true,
                reason: CorsCheckResult.BLOB_OR_DATA,
                message: 'Blob or data URL (same-origin)'
            };
        }

        // Check if same origin
        const pageOrigin = window.location.origin;
        const isSameOrigin = mediaSrc.startsWith(pageOrigin);
        if (isSameOrigin) {
            verbose(`[SourceCapture] ${elementInfo}: Same origin - CORS allowed`);
            return {
                allowed: true,
                reason: CorsCheckResult.SAME_ORIGIN,
                message: 'Same origin'
            };
        }

        // Cross-origin HTTP(S) - check for crossOrigin attribute
        const isCrossOriginHTTP = mediaSrc.startsWith('http://') || mediaSrc.startsWith('https://');
        // Explicit null/undefined check keeps behavior consistent across sites.
        const hasCorsAttribute = element.crossOrigin != null && element.crossOrigin !== '';

        if (isCrossOriginHTTP && !hasCorsAttribute) {
            verbose(`[SourceCapture] ${elementInfo}: Cross-origin without crossOrigin attribute - CORS blocked`);
            return {
                allowed: false,
                reason: CorsCheckResult.BLOCKED,
                message: `Cross-origin media without CORS headers (${mediaSrc.substring(0, 50)}...)`
            };
        }

        // Cross-origin with CORS attribute - allowed
        verbose(`[SourceCapture] ${elementInfo}: Cross-origin with crossOrigin="${element.crossOrigin}" - CORS allowed`);
        return {
            allowed: true,
            reason: CorsCheckResult.ALLOWED,
            message: 'Cross-origin with CORS enabled'
        };
    }

    /**
     * Determine which capture method to use
     * @param {HTMLMediaElement} element - The media element
     * @returns {string} - The source type to use
     */
    function determineCaptureMethod(element) {
        const ffVersion = getFirefoxMajorVersion();
        // Legacy Firefox requires mozCaptureStream; modern Firefox follows standard APIs.
        if (shouldUseLegacyFirefoxCapture(ffVersion) && typeof element.mozCaptureStream === 'function') {
            return SourceType.MOZ_CAPTURE_STREAM;
        }
        
        // Chrome, Edge, and modern Firefox (149+) use the clean, standard Web Audio API
        return SourceType.MEDIA_ELEMENT_SOURCE;
    }

    /**
     * Create audio source from media element
     * @param {HTMLMediaElement} element - The media element
     * @param {AudioContext} audioContext - The audio context to use
     * @returns {Object} - { source, stream, sourceType, error }
     */
    function createSource(element, audioContext) {
        const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
        const captureMethod = determineCaptureMethod(element);

        let source = null;
        let stream = null;
        let sourceError = null;

        try {
            if (captureMethod === SourceType.MOZ_CAPTURE_STREAM) {
                log(`[SourceCapture] Using mozCaptureStream for ${elementInfo}`);
                
                // mozCaptureStream captures audio without disconnecting from speakers
                stream = element.mozCaptureStream();
                
                // Check if stream has audio tracks
                const audioTracks = stream.getAudioTracks();
                verbose(`[SourceCapture] ${elementInfo} mozCaptureStream: ${audioTracks.length} audio tracks (${audioTracks.map(t => t.label || 'unlabeled').join(', ')})`);
                
                // Monitor track lifecycle: log when tracks end/die — this is
                // the #1 suspect for sudden audio disappearance.
                audioTracks.forEach((track) => {
                    const trackLabel = track.label || 'unlabeled';
                    const trackId = track.id;
                    if (typeof track.addEventListener === 'function') {
                        track.addEventListener('ended', () => {
                            verbose(`[SourceCapture] ⚠️ mozCaptureStream track ENDED on ${elementInfo}: id=${trackId}, label=${trackLabel}, kind=${track.kind}, readyState=${track.readyState}`);
                        });
                        track.addEventListener('mute', () => {
                            verbose(`[SourceCapture] ⚠️ mozCaptureStream track MUTED on ${elementInfo}: id=${trackId}, label=${trackLabel}, kind=${track.kind}`);
                        });
                    }
                    verbose(`[SourceCapture] mozCaptureStream track initial state: id=${trackId}, label=${trackLabel}, kind=${track.kind}, enabled=${track.enabled}, readyState=${track.readyState}`);
                });
                
                // Also watch the stream itself for any added/removed tracks
                if (typeof stream.addEventListener === 'function') {
                    stream.addEventListener('addtrack', (e) => {
                        verbose(`[SourceCapture] ⚠️ mozCaptureStream ADDTRACK on ${elementInfo}: kind=${e.track?.kind}, label=${e.track?.label}`);
                    });
                    stream.addEventListener('removetrack', (e) => {
                        verbose(`[SourceCapture] ⚠️ mozCaptureStream REMOVETRACK on ${elementInfo}: kind=${e.track?.kind}, label=${e.track?.label}`);
                    });
                }

                if (audioTracks.length === 0) {
                    verbose(`[SourceCapture] No audio tracks yet in stream for ${elementInfo}, deferring source creation`);
                    return {
                        source: null,
                        stream,
                        sourceType: captureMethod,
                        error: buildTemporaryCaptureError('MediaStream has no audio tracks yet'),
                        isTemporary: true
                    };
                }
                
                source = audioContext.createMediaStreamSource(stream);
                
                verbose(`[SourceCapture] Created MediaStreamSource from mozCaptureStream for ${elementInfo}`);
            } else {
                log(`[SourceCapture] Using createMediaElementSource for ${elementInfo}`);
                
                // Standard Web Audio API - note: this disconnects the element from speakers
                // Audio will only be heard through our audio graph destination
                source = audioContext.createMediaElementSource(element);
                
                verbose(`[SourceCapture] Created MediaElementSource for ${elementInfo}`);
            }
        } catch (err) {
            sourceError = err;
            
            if (err.name === 'InvalidStateError') {
                warn(`[SourceCapture] ${elementInfo} already has an AudioContext source (InvalidStateError)`);
            } else if (err.name === 'NotSupportedError') {
                error(`[SourceCapture] Failed to create source for ${elementInfo}: Not supported`, err);
            } else {
                error(`[SourceCapture] Failed to create source for ${elementInfo}:`, err);
            }
        }

        return {
            source,
            stream,
            sourceType: captureMethod,
            error: sourceError
        };
    }

    /**
     * Recreate a MediaStreamAudioSourceNode from an existing stream
     * Used when track changes occur in mozCaptureStream
     * 
     * @param {MediaStream} stream - The existing stream from mozCaptureStream
     * @param {AudioContext} audioContext - The audio context
     * @param {string} elementInfo - Element description for logging
     * @returns {Object} - { source, error }
     */
    function recreateSourceFromStream(stream, audioContext, elementInfo) {
        if (!stream || !audioContext) {
            return { source: null, error: new Error('Missing stream or audioContext') };
        }

        try {
            const audioTracks = stream.getAudioTracks();
            log(`[SourceCapture] Recreating source from stream for ${elementInfo}, ${audioTracks.length} audio tracks`);

            if (audioTracks.length === 0) {
                return {
                    source: null,
                    error: buildTemporaryCaptureError('MediaStream has no audio tracks yet'),
                    isTemporary: true
                };
            }
            
            const source = audioContext.createMediaStreamSource(stream);
            return { source, error: null };
        } catch (err) {
            error(`[SourceCapture] Failed to recreate source for ${elementInfo}:`, err);
            return { source: null, error: err };
        }
    }

    /**
     * Release a source stream (simplified interface for cleanup)
     * @param {MediaStream} stream - The media stream to release
     * @param {string} sourceType - The source type ('mozCaptureStream' or 'mediaElementSource')
     * @param {string} elementInfo - Element description for logging
     * 
     * WARNING: For mozCaptureStream, this will PERMANENTLY disable the stream.
     * Only call this when the element is being fully removed/destroyed.
     */
    function releaseSource(stream, sourceType, elementInfo) {
        if (!stream) return;
        
        // Stop tracks from mozCaptureStream - ONLY for full cleanup
        if (sourceType === SourceType.MOZ_CAPTURE_STREAM || sourceType === 'mozCaptureStream') {
            try {
                const tracks = stream.getTracks();
                tracks.forEach(track => {
                    verbose(`[SourceCapture] Stopping track: ${track.kind} (${track.label})`);
                    track.stop();
                });
                log(`[SourceCapture] Released ${tracks.length} tracks for ${elementInfo}`);
            } catch (err) {
                warn(`[SourceCapture] Error releasing stream tracks for ${elementInfo}:`, err);
            }
        }
    }

    /**
     * Refresh a mozCaptureStream capture after the previous stream died.
     *
     * Firefox's mozCaptureStream() returns a MediaStream whose tracks are
     * PERMANENTLY muted/ended when the underlying <video> element switches
     * sources (DASH track change).  The only way to restore audio is to
     * release the dead stream (via track.stop()) and then call
     * mozCaptureStream() again for a fresh stream.
     *
     * NOTE: releaseSource() MUST be called before this — track.stop()
     * frees the element's internal capture slot so a second call to
     * mozCaptureStream() does not throw InvalidStateError.
     *
     * @param {HTMLMediaElement} element - The media element to recapture
     * @param {AudioContext} audioContext - The shared AudioContext
     * @param {string} elementInfo - Element description for logging
     * @returns {Object} - { source, stream, sourceType, error }
     */
    function refreshMozCaptureStream(element, audioContext, elementInfo) {
        log(`[SourceCapture] Refreshing mozCaptureStream for ${elementInfo}`);

        const captureMethod = SourceType.MOZ_CAPTURE_STREAM;
        let stream = null;
        let source = null;

        try {
            // Step 1: Call mozCaptureStream() again to get a fresh stream.
            // This should succeed because the old stream's tracks were
            // stopped via releaseSource() before this call.
            stream = element.mozCaptureStream();

            const audioTracks = stream.getAudioTracks();
            verbose(`[SourceCapture] Fresh mozCaptureStream: ${audioTracks.length} audio tracks (${audioTracks.map(t => t.label || 'unlabeled').join(', ')})`);

            // Attach lifecycle listeners on the new tracks
            audioTracks.forEach((track) => {
                const trackLabel = track.label || 'unlabeled';
                const trackId = track.id;
                if (typeof track.addEventListener === 'function') {
                    track.addEventListener('ended', () => {
                        verbose(`[SourceCapture] ⚠️ Fresh mozCaptureStream track ENDED on ${elementInfo}: id=${trackId}, label=${trackLabel}`);
                    });
                    track.addEventListener('mute', () => {
                        verbose(`[SourceCapture] ⚠️ Fresh mozCaptureStream track MUTED on ${elementInfo}: id=${trackId}, label=${trackLabel}`);
                    });
                }
                verbose(`[SourceCapture] Fresh mozCaptureStream track: id=${trackId}, label=${trackLabel}, enabled=${track.enabled}, readyState=${track.readyState}`);
            });

            if (typeof stream.addEventListener === 'function') {
                stream.addEventListener('addtrack', (e) => {
                    verbose(`[SourceCapture] Fresh mozCaptureStream ADDTRACK on ${elementInfo}: kind=${e.track?.kind}`);
                });
                stream.addEventListener('removetrack', (e) => {
                    verbose(`[SourceCapture] Fresh mozCaptureStream REMOVETRACK on ${elementInfo}: kind=${e.track?.kind}`);
                });
            }

            if (audioTracks.length === 0) {
                verbose(`[SourceCapture] Fresh mozCaptureStream has no audio tracks yet for ${elementInfo}`);
                return {
                    source: null,
                    stream,
                    sourceType: captureMethod,
                    error: buildTemporaryCaptureError('Fresh mozCaptureStream has no audio tracks'),
                    isTemporary: true
                };
            }

            source = audioContext.createMediaStreamSource(stream);
            verbose(`[SourceCapture] Created MediaStreamSource from fresh mozCaptureStream for ${elementInfo}`);

        } catch (err) {
            error(`[SourceCapture] Failed to refresh mozCaptureStream for ${elementInfo}:`, err);
            return {
                source: null,
                stream: null,
                sourceType: captureMethod,
                error: err
            };
        }

        return {
            source,
            stream,
            sourceType: captureMethod,
            error: null
        };
    }

    // Export to VolumeControl namespace
    window.VolumeControl.SourceCapture = {
        SourceType,
        CorsCheckResult,
        checkCorsStatus,
        getElementSourceKey,
        hasUsableMediaSource,
        getFirefoxMajorVersion,
        isFirefoxBrowser,
        shouldUseLegacyFirefoxCapture,
        determineCaptureMethod,
        createSource,
        recreateSourceFromStream,
        releaseSource,
        refreshMozCaptureStream
    };
})();
