/**
 * Audio Context Management
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.AudioContext = {};

(function() {
    const { log, warn, error, verbose } = window.VolumeControl;

    /**
     * Ensures AudioContext is running. Handles concurrent resume requests safely.
     */
    window.VolumeControl.AudioContext.ensureAudioContextRunning = async function() {
        const State = window.VolumeControl.State;
        const audioContext = window.VolumeControl.AudioContext.getSharedAudioContext();
        
        if (!audioContext) {
            throw new Error("Failed to get shared AudioContext");
        }
        
        if (audioContext.state === 'running') {
            return audioContext;
        }
        
        if (State.audioContextResumePromise) {
            log(`AudioContext resume already in progress, waiting for existing resume...`);
            try {
                await Promise.race([
                    State.audioContextResumePromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Resume timeout')), 3000))
                ]);
                return audioContext;
            } catch (e) {
                log(`Existing resume failed/timed out: ${e.message}, attempting new resume...`);
            }
        }
        
        log(`AudioContext state is ${audioContext.state}, attempting to resume...`);
        try {
            const resumePromise = audioContext.resume()
                .then(() => {
                    // CRITICAL: Check ACTUAL state, not just promise resolution
                    // Firefox can resolve resume() while staying suspended (autoplay policy)
                    const actualState = audioContext.state;
                    log(`AudioContext.resume() completed, actual state: ${actualState}`);
                    
                    if (actualState === 'suspended') {
                        warn("AudioContext.resume() succeeded but state is still suspended (autoplay policy)");
                        warn("Setting up user interaction listener for autoplay bypass...");
                        window.VolumeControl.AudioContext.setupAutoplayBypassListener();
                    } else if (actualState === 'running') {
                        log(`AudioContext successfully transitioned to running state`);
                    }
                    
                    return audioContext;
                })
                .catch(e => {
                    warn("AudioContext.resume() rejected (autoplay policy):", e.message || e);
                    warn("Audio will work once user interacts with the page (scroll, click, etc.)");
                    
                    // Set up listener to resume on user interaction
                    window.VolumeControl.AudioContext.setupAutoplayBypassListener();
                    
                    return audioContext;
                })
                .finally(() => {
                    State.audioContextResumePromise = null;
                });
            
            State.audioContextResumePromise = Promise.race([
                resumePromise,
                new Promise((resolve) => {
                    setTimeout(() => {
                        const currentState = audioContext.state;
                        if (currentState !== 'running') {
                            warn(`AudioContext resume timed out after 3s, state: ${currentState}`);
                            warn("Waiting for user interaction to complete resume...");
                            window.VolumeControl.AudioContext.setupAutoplayBypassListener();
                        }
                        State.audioContextResumePromise = null;
                        resolve(audioContext);
                    }, 3000);
                })
            ]);
            
            return await State.audioContextResumePromise;
        } catch (e) {
            State.audioContextResumePromise = null;
            throw e;
        }
    };

    /**
     * Gets or creates the shared AudioContext.
     */
    window.VolumeControl.AudioContext.getSharedAudioContext = function() {
        const State = window.VolumeControl.State;
        
        if (State.sharedAudioContext && State.sharedAudioContext.state !== 'closed') {
            return State.sharedAudioContext;
        }
        
        try {
            State.sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            log("Created shared AudioContext");
            
            State.sharedAudioContext.addEventListener('statechange', async () => {
                const state = State.sharedAudioContext.state;
                log(`AudioContext state changed to: ${state}`);
                
                if (state === 'suspended' || state === 'interrupted') {
                    warn(`AudioContext ${state} - attempting immediate resume`);
                    
                    try {
                        await State.sharedAudioContext.resume();
                        log(`AudioContext resumed from ${state}, new state: ${State.sharedAudioContext.state}`);
                        
                        // Mark elements needing verification using new architecture
                        const elementStateManager = window.VolumeControl.elementStateManager;
                        if (elementStateManager) {
                            elementStateManager.getActive().forEach(({ element, stateData }) => {
                                const isPlaying = !element.paused && !element.ended && element.currentTime > 0;
                                if (isPlaying) {
                                    stateData.needsConnectionVerification = true;
                                }
                            });
                        }
                        
                        // Trigger repair through Main module
                        if (window.VolumeControl.Main && window.VolumeControl.Main.repairAllElements) {
                            window.VolumeControl.Main.repairAllElements();
                        }
                    } catch (e) {
                        error(`Failed to resume AudioContext from ${state}:`, e);
                        // Mark elements for retry using new architecture
                        const elementStateManager = window.VolumeControl.elementStateManager;
                        if (elementStateManager) {
                            elementStateManager.getActive().forEach(({ element, stateData }) => {
                                const isPlaying = !element.paused && !element.ended && element.currentTime > 0;
                                if (isPlaying) {
                                    stateData.needsConnectionVerification = true;
                                }
                            });
                        }
                    }
                }
            });
            
            // Set up Page Visibility API listener to handle tab focus changes
            // This fixes the bug where AudioContext gets interrupted when tab loses focus
            // (especially critical for YouTube Music and similar streaming sites)
            if (!State.visibilityChangeListenerAttached) {
                // Keep this handler module-local instead of storing function refs on shared state.
                const visibilityChangeHandler = async () => {
                    if (!document.hidden && State.sharedAudioContext) {
                        const currentState = State.sharedAudioContext.state;
                        
                        // When tab becomes visible again, check if AudioContext needs resume
                        if (currentState !== 'running') {
                            log(`Tab became visible, AudioContext is ${currentState} - attempting resume...`);
                            
                            try {
                                await State.sharedAudioContext.resume();
                                const newState = State.sharedAudioContext.state;
                                log(`AudioContext resume attempt complete, state: ${newState}`);
                                
                                if (newState === 'running') {
                                    // Repair all active elements
                                    if (window.VolumeControl.Main && window.VolumeControl.Main.repairAllElements) {
                                        const repaired = window.VolumeControl.Main.repairAllElements();
                                        if (repaired > 0) {
                                            log(`✓ Repaired ${repaired} elements after tab focus`);
                                        }
                                    }
                                    
                                    // Also update new architecture elements
                                    const elementStateManager = window.VolumeControl.elementStateManager;
                                    const VolumeSyncManager = window.VolumeControl.volumeSyncManager;
                                    if (elementStateManager) {
                                        const VolumeController = window.VolumeControl.VolumeController;
                                        const State = window.VolumeControl.State;
                                        
                                        elementStateManager.getActive().forEach(({ element, stateData }) => {
                                            const isPlaying = !element.paused && !element.ended && element.currentTime > 0;
                                            
                                            if (isPlaying && VolumeController) {
                                                // Mark that we're applying volume to prevent hijack false positives
                                                if (VolumeSyncManager) {
                                                    VolumeSyncManager.startApplyingVolume(element, State.currentVolumePercent);
                                                }
                                                // Force re-apply volume to ensure it sticks after AudioContext resume
                                                VolumeController.applyVolume(
                                                    element, 
                                                    stateData, 
                                                    State.currentVolumePercent,
                                                    { force: true }
                                                );
                                                verbose(`Reapplied volume to ${element.tagName} after AudioContext resume`);
                                            }
                                        });
                                    }
                                }
                            } catch (e) {
                                warn(`Failed to resume AudioContext on visibility change:`, e);
                            }
                        }
                        // NOTE: Removed aggressive force-reapply when AudioContext is already running.
                        // This was causing conflicts with site players trying to restore volume.
                        // The AudioContext being 'running' means our audio graph is intact - no need to force volume.
                        // Volume will be maintained correctly through the volumechange handler.
                    }
                };

                document.addEventListener('visibilitychange', visibilityChangeHandler);
                State.visibilityChangeListenerAttached = true;
                log("Page Visibility API listener attached for AudioContext recovery");

                // Ensure the listener is removed on page unload
                if (!State.visibilityChangeCleanupAttached) {
                    State.visibilityChangeCleanupAttached = true;
                    window.addEventListener('unload', () => {
                        try {
                            if (visibilityChangeHandler) {
                                document.removeEventListener('visibilitychange', visibilityChangeHandler);
                            }
                        } finally {
                            State.visibilityChangeListenerAttached = false;
                            State.visibilityChangeCleanupAttached = false;
                        }
                    }, { once: true });
                }
            }
            
            return State.sharedAudioContext;
        } catch (err) {
            error("Error creating shared AudioContext:", err);
            return null;
        }
    };

    /**
     * Set up one-time user interaction listener to bypass autoplay policy
     */
    window.VolumeControl.AudioContext.setupAutoplayBypassListener = function() {
        const State = window.VolumeControl.State;
        
        // Don't set up multiple listeners
        if (State.autoplayBypassListenerActive) {
            return;
        }
        
        const audioContext = State.sharedAudioContext;
        if (!audioContext || audioContext.state === 'running') {
            return;
        }
        
        log("Setting up autoplay bypass listener - waiting for user interaction...");
        State.autoplayBypassListenerActive = true;
        
        const resumeOnInteraction = async () => {
            if (!audioContext || audioContext.state === 'running') {
                cleanup();
                return;
            }
            
            log("User interaction detected, attempting AudioContext resume...");
            
            try {
                await audioContext.resume();
                
                // CRITICAL: Check if resume ACTUALLY worked
                // Some events (like scroll) don't grant autoplay permission
                // If resume didn't work, keep listeners active for a real user gesture
                if (audioContext.state !== 'running') {
                    log(`AudioContext resume attempted but state is still ${audioContext.state} - keeping listeners active`);
                    return; // Don't cleanup, wait for a proper user gesture
                }
                
                log(`AudioContext resumed via user interaction, state: ${audioContext.state}`);
                
                // Trigger repair through Main module
                if (window.VolumeControl.Main && window.VolumeControl.Main.repairAllElements) {
                    const repairedCount = window.VolumeControl.Main.repairAllElements();
                    if (repairedCount > 0) {
                        log(`✓ Repaired ${repairedCount} elements after autoplay bypass`);
                    }
                }
                
                cleanup();
            } catch (e) {
                warn("Failed to resume AudioContext on user interaction:", e);
                // Keep listeners active, might work on next interaction
            }
        };
        
        const cleanup = () => {
            document.removeEventListener('click', resumeOnInteraction, true);
            document.removeEventListener('keydown', resumeOnInteraction, true);
            document.removeEventListener('touchstart', resumeOnInteraction, true);
            document.removeEventListener('scroll', resumeOnInteraction, true);
            State.autoplayBypassListenerActive = false;
            log("Autoplay bypass listener cleaned up");
        };
        
        // Listen for various user interaction events
        // Note: We don't use { once: true } because we need to clean up ALL listeners when ANY fires
        // Using { once: true } would only auto-remove the fired listener, leaving others to leak
        document.addEventListener('click', resumeOnInteraction, { capture: true });
        document.addEventListener('keydown', resumeOnInteraction, { capture: true });
        document.addEventListener('touchstart', resumeOnInteraction, { capture: true });
        document.addEventListener('scroll', resumeOnInteraction, { capture: true, passive: true });
    };
})();
