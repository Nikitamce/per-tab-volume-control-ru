/**
 * Volume Sync Module - Bidirectional volume synchronization between extension and player.
 */

window.VolumeControl = window.VolumeControl || {};
window.VolumeControl.VolumeSyncManager = {};

(function() {
    const { 
        log, warn, verbose, decision, stateChange, 
        logVolumeEvent, logSourceChange, logDiagnostic,
        EXTENSION_VOLUME_LOCK_TIMEOUT_MS,
        DEFAULT_VOLUME,
        MIN_VOLUME,
        MAX_VOLUME
    } = window.VolumeControl;

    // Timing constants
    const SYNC_DEBOUNCE_MS = 100;
    const MIN_CHANGE_PERCENT = 2;
    const PLAYER_ECHO_TIMEOUT_MS = 150;
    const HIJACK_PROTECTION_MS = 3000;
    const MUTE_TOGGLE_SUPPRESSION_MS = 750;  // Ignore immediate follow-up volume resets after a mute toggle
    const SOURCE_CHANGE_PROTECTION_MS = 2000;
    const VISIBILITY_GRACE_MS = 500;
    
    // Track only direct media-intent interactions to strengthen hijack detection.
    const INTERACTION_TIMEOUT_MS = 500;      // Window to consider user as "recently interacted"
    let lastInteractionAt = 0;               // Timestamp of last user interaction
    let isMouseDown = false;                 // Is mouse currently held down?
    let isPointerDown = false;               // Is pointer (mouse/touch/pen) currently down?
    let lastInteractedMediaElement = null;   // Most recently interacted media element within the interaction window

    function isMediaElement(node) {
        return Boolean(node && typeof node.tagName === 'string' && /^(VIDEO|AUDIO)$/i.test(node.tagName));
    }

    function getInteractedMediaElement(event) {
        if (typeof event?.composedPath === 'function') {
            const mediaInPath = event.composedPath().find(isMediaElement);
            if (mediaInPath) {
                return mediaInPath;
            }
        }

        let currentNode = event?.target || null;
        while (currentNode) {
            if (isMediaElement(currentNode)) {
                return currentNode;
            }

            if (typeof currentNode.closest === 'function') {
                const mediaAncestor = currentNode.closest('video, audio');
                if (mediaAncestor) {
                    return mediaAncestor;
                }
            }

            currentNode = currentNode.parentElement || currentNode.parentNode || null;
        }

        return null;
    }

    function noteUserInteraction(event) {
        lastInteractionAt = Date.now();
        const interactedMediaElement = getInteractedMediaElement(event);
        lastInteractedMediaElement = interactedMediaElement || null;
    }

    /**
     * VolumeSyncManager - Manages volume synchronization for all elements
     */
    class VolumeSyncManager {
        constructor() {
            this.elementSyncState = new WeakMap(); // Per-element sync state
        }

        /**
         * Get or create sync state for an element
         * @private
         */
        _getSyncState(element) {
            if (!this.elementSyncState.has(element)) {
                this.elementSyncState.set(element, {
                    isApplyingVolume: false,
                    targetVolume: null,
                    lockTimeout: null,
                    lastChangeAt: 0,
                    isSourceChanging: false,       // True during track/source switch
                    sourceChangeEpoch: 0,
                    sourceChangeTimeout: null,
                    lastVisibilityChangeAt: 0,     // When element visibility last changed
                    wasRecentlyHidden: false,      // Was element recently scrolled out of view
                    lastVolumeChangeAt: 0,         // For rapid change detection (slider drag)
                    rapidChangeCount: 0,           // Count of rapid changes
                    lastTrackedPlayerVolume: null,
                    lastExtensionChangeAt: 0,
                    lastHijackRejectedAt: 0,
                    lastAcceptedMuteInteractionAt: 0,
                    handlerEpoch: 0
                });
            }
            return this.elementSyncState.get(element);
        }

        _getMsSinceExtensionChange(element) {
            const lastChangeAt = this._getSyncState(element).lastExtensionChangeAt || 0;
            return Date.now() - lastChangeAt;
        }

        _getMsSinceHijackReject(element) {
            const lastRejectAt = this._getSyncState(element).lastHijackRejectedAt || 0;
            return Date.now() - lastRejectAt;
        }

        /**
         * Mark that element visibility changed (scrolled in/out of view)
         * Used to provide grace period for site volume restoration
         */
        markVisibilityChange(element, isNowVisible) {
            const syncState = this._getSyncState(element);
            syncState.lastVisibilityChangeAt = Date.now();
            syncState.wasRecentlyHidden = !isNowVisible;
            
            if (isNowVisible) {
                verbose(`[VolumeSync] Element became visible - grace period started`);
            }
        }

        /**
         * Check if element is in visibility grace period (just became visible)
         * During this window, we're more lenient about site volume changes
         */
        isInVisibilityGracePeriod(element) {
            const syncState = this._getSyncState(element);
            const timeSinceVisibilityChange = Date.now() - syncState.lastVisibilityChangeAt;
            return timeSinceVisibilityChange < VISIBILITY_GRACE_MS;
        }

        /**
         * Track volume change and detect rapid changes (slider drag pattern)
         * Returns true if this looks like a slider drag
         */
        trackVolumeChange(element, playerVolume = null) {
            const syncState = this._getSyncState(element);
            const now = Date.now();
            const nextPlayerVolume = Number.isFinite(playerVolume)
                ? playerVolume
                : Math.round((Number.isFinite(element.volume) ? element.volume : 0) * 100);
            const previousPlayerVolume = Number.isFinite(syncState.lastTrackedPlayerVolume)
                ? syncState.lastTrackedPlayerVolume
                : null;

            syncState.lastTrackedPlayerVolume = nextPlayerVolume;

            if (previousPlayerVolume !== null && Math.abs(nextPlayerVolume - previousPlayerVolume) < MIN_CHANGE_PERCENT) {
                return false;
            }

            const timeSinceLastChange = now - syncState.lastVolumeChangeAt;
            
            // If changes are coming rapidly (within 200ms), increment counter
            if (timeSinceLastChange < 200) {
                syncState.rapidChangeCount++;
            } else {
                // Reset counter if gap is too long
                syncState.rapidChangeCount = 1;
            }
            
            syncState.lastVolumeChangeAt = now;
            
            // 3+ rapid changes in a row looks like slider drag
            return syncState.rapidChangeCount >= 3;
        }

        /**
         * Check if element is likely in a slider drag (rapid volume changes)
         */
        isLikelySliderDrag(element) {
            const syncState = this._getSyncState(element);
            const timeSinceLastChange = Date.now() - syncState.lastVolumeChangeAt;
            // Recent rapid changes suggest ongoing slider drag
            return syncState.rapidChangeCount >= 3 && timeSinceLastChange < 300;
        }

        /**
         * Mark that a source change is in progress - reject ALL volume changes
         * This is critical for track switches on YouTube Music, Spotify, etc.
         */
        startSourceChange(element, operationEpoch = null) {
            const State = window.VolumeControl.State;
            const syncState = this._getSyncState(element);
            const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
            
            syncState.isSourceChanging = true;
            syncState.sourceChangeEpoch = operationEpoch ?? (syncState.sourceChangeEpoch + 1);
            
            // Also update hijack protection for this element.
            syncState.lastHijackRejectedAt = Date.now();
            
            if (syncState.sourceChangeTimeout) {
                clearTimeout(syncState.sourceChangeTimeout);
            }
            
            // Keep protection active for 2 seconds after source change starts
            const sourceChangeEpoch = syncState.sourceChangeEpoch;
            syncState.sourceChangeTimeout = setTimeout(() => {
                if (syncState.sourceChangeEpoch !== sourceChangeEpoch) {
                    return;
                }
                syncState.isSourceChanging = false;
                syncState.sourceChangeTimeout = null;
                log(`[VolumeSync] Source change timeout expired for ${elementInfo}`);
            }, SOURCE_CHANGE_PROTECTION_MS);
            
            // Enhanced logging
            if (logSourceChange) {
                logSourceChange({
                    phase: 'START',
                    elementInfo,
                    trigger: 'startSourceChange called',
                    extensionVolume: State?.currentVolumePercent,
                    playerVolume: (element.volume * 100).toFixed(1),
                    sourceType: 'unknown'
                });
            }
        }

        /**
         * Mark that source change is complete
         * We keep hijack protection active even after source change ends
         */
        endSourceChange(element, operationEpoch = null) {
            const State = window.VolumeControl.State;
            const syncState = this._getSyncState(element);
            const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;

            if (operationEpoch !== null && syncState.sourceChangeEpoch !== operationEpoch) {
                verbose(`[VolumeSync] Ignoring stale source-change completion for ${elementInfo}`);
                return;
            }
            
            syncState.isSourceChanging = false;
            
            if (syncState.sourceChangeTimeout) {
                clearTimeout(syncState.sourceChangeTimeout);
                syncState.sourceChangeTimeout = null;
            }
            
            // CRITICAL: Extend hijack protection after source change ends
            // This prevents late volume changes from being adopted
            syncState.lastHijackRejectedAt = Date.now();
            
            // Enhanced logging
            if (logSourceChange) {
                logSourceChange({
                    phase: 'END',
                    elementInfo,
                    trigger: 'endSourceChange called',
                    extensionVolume: State?.currentVolumePercent,
                    playerVolume: (element.volume * 100).toFixed(1),
                    hijackProtectionExtendsFor: `${HIJACK_PROTECTION_MS}ms`
                });
            }
        }

        /**
         * Check if source is currently changing for an element
         */
        isSourceChanging(element) {
            return this._getSyncState(element).isSourceChanging;
        }

        /**
         * Mark that extension is applying volume (from popup or programmatic change)
         * Sets global debounce to block site-initiated resets
         */
        startApplyingVolume(element, targetVolume) {
            const syncState = this._getSyncState(element);
            
            syncState.lastExtensionChangeAt = Date.now();
            
            syncState.isApplyingVolume = true;
            syncState.targetVolume = targetVolume;
            syncState.lastChangeAt = Date.now();

            if (syncState.lockTimeout) {
                clearTimeout(syncState.lockTimeout);
            }

            syncState.lockTimeout = setTimeout(() => {
                syncState.isApplyingVolume = false;
                syncState.targetVolume = null;
            }, EXTENSION_VOLUME_LOCK_TIMEOUT_MS);
        }

        /**
         * Re-apply volume after rejecting a hijack attempt
         * CRITICAL: Does NOT reset the global debounce timestamp - prevents infinite loop
         * 
         * This is the key fix: when we reject a site's volume change and reapply ours,
         * we don't want to reset the debounce window, or else the user can never
         * regain control of the slider after the debounce expires.
         * 
         * @param {boolean} isHijackAttempt - If true, this was a clear hijack attempt (no user activity)
         *                                    and we should activate hijack protection.
         *                                    If false, user was recently active and we should NOT
         *                                    block future events with hijack protection.
         */
        reapplyVolumeAfterReject(element, targetVolume, isHijackAttempt = true) {
            const syncState = this._getSyncState(element);
            
            // DO NOT update lastExtensionChangeAt here!
            // Updating it would create an infinite loop when user drags slider
            
            // ONLY update hijack rejection timestamp if this was a CLEAR hijack attempt
            // (no user interaction). If user was recently active, don't activate hijack
            // protection or we'll block their subsequent slider drags.
            if (isHijackAttempt) {
                syncState.lastHijackRejectedAt = Date.now();
            }
            
            syncState.isApplyingVolume = true;
            syncState.targetVolume = targetVolume;
            syncState.lastChangeAt = Date.now();

            if (syncState.lockTimeout) {
                clearTimeout(syncState.lockTimeout);
            }

            // Very short timeout - just enough to catch the echo
            syncState.lockTimeout = setTimeout(() => {
                syncState.isApplyingVolume = false;
                syncState.targetVolume = null;
            }, PLAYER_ECHO_TIMEOUT_MS);
        }

        /**
         * Mark that we're syncing volume from player (user used native slider)
         * Does NOT set global debounce - allows subsequent player changes through
         */
        startApplyingVolumeFromPlayer(element, targetVolume) {
            const syncState = this._getSyncState(element);
            
            // NO global timestamp update - player changes shouldn't block other player changes
            
            syncState.isApplyingVolume = true;
            syncState.targetVolume = targetVolume;
            syncState.lastChangeAt = Date.now();

            if (syncState.lockTimeout) {
                clearTimeout(syncState.lockTimeout);
            }

            // Short timeout - just catch the immediate echo from setting element.volume
            syncState.lockTimeout = setTimeout(() => {
                syncState.isApplyingVolume = false;
                syncState.targetVolume = null;
            }, PLAYER_ECHO_TIMEOUT_MS);
        }

        /** Clear volume application state for an element */
        clearApplyingVolume(element) {
            const syncState = this._getSyncState(element);
            
            if (syncState.lockTimeout) {
                clearTimeout(syncState.lockTimeout);
                syncState.lockTimeout = null;
            }
            
            syncState.isApplyingVolume = false;
            syncState.targetVolume = null;
        }

        /** Check if we're currently applying volume to an element */
        isApplyingVolume(element) {
            return this._getSyncState(element).isApplyingVolume;
        }

        /** Get target volume for an element */
        getTargetVolume(element) {
            return this._getSyncState(element).targetVolume;
        }

        /** Check if we're in the global debounce window */
        isInDebounceWindow(element) {
            return this._getMsSinceExtensionChange(element) < SYNC_DEBOUNCE_MS;
        }

        /** Check if we're in the hijack protection window (recently rejected an attack) */
        isInHijackProtectionWindow(element) {
            return this._getMsSinceHijackReject(element) < HIJACK_PROTECTION_MS;
        }

        /**
         * Analyze a player volume change event
         * 
         * Simplified logic:
         * 1. Always accept trusted events (real user actions)
         * 2. During debounce window, reject untrusted events that match our target (echoes)
         * 3. Outside debounce window, accept significant changes
         * 4. When page is hidden, always reject (prevents background hijacking)
         */
        analyzeVolumeChange(element, event, extensionVolume, options = {}) {
            const { 
                isSetupComplete = true, 
                isVisible = true 
            } = options;

            const syncState = this._getSyncState(element);
            const playerVolume = Math.round(element.volume * 100);
            const isTrusted = event.isTrusted;
            const isMuted = element.muted;
            const hasGainNode = options.hasGainNode !== false;
            const isCorsBlocked = options.isCorsBlocked === true;
            const canDriveSharedState = options.canDriveSharedState !== false;
            const State = window.VolumeControl.State;
            const managedMuteState = Object.prototype.hasOwnProperty.call(options, 'managedMuteState')
                ? Boolean(options.managedMuteState)
                : Boolean(State.currentMutedState);
            const muteChanged = isMuted !== managedMuteState;
            const protectsManagedMuteState = Boolean(
                State.extensionEnabled !== false &&
                (hasGainNode || isCorsBlocked)
            );

            const now = Date.now();
            const hasRecentInteraction = (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS || isMouseDown || isPointerDown;
            const protectsBoostedManagedVolume = Boolean(
                hasGainNode &&
                !isCorsBlocked &&
                State.volumeHasBeenSet &&
                extensionVolume > DEFAULT_VOLUME
            );
            
            // Track this volume change for slider drag detection
            const isSliderDrag = this.trackVolumeChange(element, playerVolume);
            const interactedThisElement = Boolean(
                (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS &&
                lastInteractedMediaElement === element
            );
            const hasMuteUserIntent = hasRecentInteraction || interactedThisElement || isSliderDrag;
            const hasSecondaryVolumeUserIntent = isSliderDrag || interactedThisElement;
            const hasRecentMuteToggle = (now - (syncState.lastMuteToggleAt || 0)) < MUTE_TOGGLE_SUPPRESSION_MS;
            const hasFreshMuteInteraction = isSliderDrag || lastInteractionAt > (syncState.lastMuteToggleAt || 0);
            const hasFreshAcceptedMuteInteraction = isSliderDrag || lastInteractionAt > (syncState.lastAcceptedMuteInteractionAt || 0);

            // 1. Skip if setup not complete
            if (!isSetupComplete) {
                return {
                    shouldProcess: false,
                    reason: 'Setup not complete',
                    type: 'ignored'
                };
            }

            // 1b. CRITICAL: If source is changing (track switch), REJECT all volume changes
            // This prevents sites from resetting volume on track change
            if (syncState.isSourceChanging) {
                return {
                    shouldProcess: false,
                    reason: 'Source changing - rejecting volume change',
                    type: 'source-changing',
                    rejectAndReapply: true,
                    isHijackAttempt: true  // Track switch = clear hijack, not user slider
                };
            }

            // 1c. CRITICAL: If in hijack protection window AND no user interaction, REJECT
            // This applies to BOTH trusted and untrusted events!
            // After track switch, browser may fire trusted volumechange with player's volume
            // EXCEPTION: If element just became visible (scroll back), allow a grace period
            // EXCEPTION: If rapid volume changes detected (slider drag pattern)
            const inVisibilityGrace = this.isInVisibilityGracePeriod(element);
            if (this.isInHijackProtectionWindow(element) && !hasRecentInteraction && !isSliderDrag && State.volumeHasBeenSet && !inVisibilityGrace) {
                return {
                    shouldProcess: false,
                    reason: `In hijack protection window - rejecting ${isTrusted ? 'trusted' : 'untrusted'} change (${Math.abs(playerVolume - extensionVolume).toFixed(1)}%)`,
                    type: 'hijack-protection-early',
                    rejectAndReapply: true,
                    isHijackAttempt: true  // No user interaction = clear hijack
                };
            }

            // 2. CRITICAL: If page is hidden, NEVER adopt volume changes
            // This prevents sites from hijacking volume when tab is inactive
            if (document.hidden) {
                return {
                    shouldProcess: false,
                    reason: 'Page hidden - ignoring volume change',
                    type: 'page-hidden',
                    rejectAndReapply: true,
                    isHijackAttempt: true  // User not on page = clear hijack
                };
            }
            
            // 3. Echo detection - if we just set this volume, ignore the event
            if (syncState.targetVolume !== null) {
                const expectedNative = Math.min(100, syncState.targetVolume);
                const volumeDiff = Math.abs(playerVolume - expectedNative);
                
                if (volumeDiff < MIN_CHANGE_PERCENT && !muteChanged) {
                    return {
                        shouldProcess: false,
                        reason: `Matches target (${playerVolume}% ≈ ${expectedNative}%)`,
                        type: 'echo'
                    };
                }
            }

            if (muteChanged) {
                if (!protectsManagedMuteState) {
                    return {
                        shouldProcess: false,
                        reason: `User ${isMuted ? 'muted' : 'unmuted'}`,
                        type: 'mute-toggle',
                        muteStateChanged: true,
                        newMuteState: isMuted
                    };
                }

                if (!canDriveSharedState) {
                    if (hasMuteUserIntent) {
                        if (!State.muteHasBeenSet && managedMuteState !== isMuted && !hasFreshAcceptedMuteInteraction) {
                            return {
                                shouldProcess: false,
                                reason: `Secondary media follow-up mute change ignored to preserve local managed mute (${managedMuteState ? 'muted' : 'unmuted'})`,
                                type: 'secondary-media-mute-follow-up',
                                rejectAndReapply: true,
                                isHijackAttempt: false,
                                reapplyMute: true,
                                reapplyMuteState: managedMuteState
                            };
                        }

                        syncState.lastMuteToggleAt = now;
                        syncState.lastAcceptedMuteInteractionAt = lastInteractionAt;

                            if (State.muteHasBeenSet) {
                                return {
                                    shouldProcess: false,
                                    reason: `Secondary media mute change ignored because extension owns tab mute (${managedMuteState ? 'muted' : 'unmuted'})`,
                                    type: 'secondary-media-mute-owned',
                                    rejectAndReapply: true,
                                    isHijackAttempt: false,
                                    reapplyMute: true,
                                    reapplyMuteState: managedMuteState
                                };
                            }

                        return {
                            shouldProcess: false,
                                reason: `User ${isMuted ? 'muted' : 'unmuted'} via secondary media control without changing tab-wide mute`,
                            type: 'secondary-media-mute-toggle',
                            muteStateChanged: true,
                                newMuteState: isMuted,
                                updateSharedMuteState: false,
                                commitMuteToRestore: true,
                                    notifyStatusChange: true
                        };
                    }

                    return {
                        shouldProcess: false,
                        reason: `Secondary media mute change ignored to preserve shared tab mute (${isMuted ? 'muted' : 'unmuted'})`,
                        type: 'secondary-media-mute',
                        rejectAndReapply: true,
                        isHijackAttempt: !hasRecentInteraction && !isSliderDrag,
                            reapplyMute: true,
                            reapplyMuteState: managedMuteState
                    };
                }

                if (hasMuteUserIntent) {
                    syncState.lastMuteToggleAt = now;
                    syncState.lastAcceptedMuteInteractionAt = lastInteractionAt;
                    return {
                        shouldProcess: false,
                        reason: `User ${isMuted ? 'muted' : 'unmuted'}`,
                        type: 'mute-toggle',
                        muteStateChanged: true,
                        newMuteState: isMuted
                    };
                }

                return {
                    shouldProcess: false,
                    reason: `Mute changed without user interaction - restoring ${managedMuteState ? 'muted' : 'unmuted'} state`,
                    type: 'mute-hijack',
                    rejectAndReapply: true,
                    isHijackAttempt: true,
                    reapplyMute: true,
                    reapplyMuteState: managedMuteState
                };
            }

            if (!canDriveSharedState && State.volumeHasBeenSet && (hasGainNode || isCorsBlocked)) {
                const volumeDiff = Math.abs(playerVolume - extensionVolume);

                if (volumeDiff >= MIN_CHANGE_PERCENT) {
                    if (hasSecondaryVolumeUserIntent && (!hasRecentMuteToggle || interactedThisElement)) {
                        return {
                            shouldProcess: true,
                            reason: `Secondary media player change accepted from direct user interaction (${volumeDiff.toFixed(1)}%)`,
                            type: 'secondary-media-player-change',
                            newVolume: playerVolume
                        };
                    }

                    return {
                        shouldProcess: false,
                        reason: `Secondary media volume change ignored to preserve shared tab volume (${volumeDiff.toFixed(1)}%)`,
                        type: 'secondary-media-volume',
                        rejectAndReapply: true,
                        isHijackAttempt: !hasRecentInteraction && !isSliderDrag
                    };
                }
            }

            if (protectsBoostedManagedVolume) {
                const volumeDiff = Math.abs(playerVolume - extensionVolume);
                const allowBoostedPlayerAdoption = hasRecentInteraction || isSliderDrag;

                if (volumeDiff < MIN_CHANGE_PERCENT) {
                    return {
                        shouldProcess: false,
                        reason: `Boosted managed volume unchanged (${volumeDiff.toFixed(1)}%)`,
                        type: 'boosted-insignificant'
                    };
                }

                if (allowBoostedPlayerAdoption) {
                    return {
                        shouldProcess: true,
                        reason: `Boosted managed volume released to player interaction (${volumeDiff.toFixed(1)}%)`,
                        type: 'boosted-player-change',
                        newVolume: playerVolume
                    };
                }

                return {
                    shouldProcess: false,
                    reason: `Boosted managed volume owns state at ${extensionVolume}%`,
                    type: 'boosted-managed-ownership',
                    rejectAndReapply: true,
                    isHijackAttempt: !hasRecentInteraction
                };
            }

            // 4. TRUSTED events are usually user actions, but some players/browser paths
            // can emit trusted volumechange without direct user intent.
            // If extension volume ownership is established and there is no recent user
            // interaction, treat trusted changes as potential delayed site restores.
            if (isTrusted) {
                const volumeDiff = Math.abs(playerVolume - extensionVolume);

                // If extension has claimed volume control, reject passive trusted changes.
                // This specifically protects against delayed restores on sites like
                // YouTube/YouTube Music while still allowing real user slider changes.
                if (State.volumeHasBeenSet && (hasGainNode || isCorsBlocked)) {
                    if (!hasRecentInteraction && !isSliderDrag && !inVisibilityGrace) {
                        return {
                            shouldProcess: false,
                            reason: `Trusted change without user interaction - rejecting (${volumeDiff.toFixed(1)}%)`,
                            type: 'trusted-no-user-activity',
                            rejectAndReapply: true,
                            isHijackAttempt: true
                        };
                    }
                }
                
                if (volumeDiff < MIN_CHANGE_PERCENT) {
                    // Might be mute toggle
                    if (isMuted !== managedMuteState) {
                        return {
                            shouldProcess: false,
                            reason: `User ${isMuted ? 'muted' : 'unmuted'}`,
                            type: 'mute-toggle',
                            muteStateChanged: true,
                            newMuteState: isMuted
                        };
                    }
                    return {
                        shouldProcess: false,
                        reason: `Change too small (${volumeDiff.toFixed(1)}%)`,
                        type: 'insignificant'
                    };
                }
                
                return {
                    shouldProcess: true,
                    reason: `Trusted user change (${volumeDiff.toFixed(1)}%)`,
                    type: 'player-change-trusted',
                    newVolume: playerVolume
                };
            }

            // 5. UNTRUSTED events (synthetic) - need more careful handling
            // These come from custom players (YouTube, Reddit, etc.)
            
            const volumeDiff = Math.abs(playerVolume - extensionVolume);
            
            // 5a. Ignore synthetic events while we're actively applying
            if (syncState.isApplyingVolume) {
                return {
                    shouldProcess: false,
                    reason: 'Synthetic event during apply',
                    type: 'synthetic'
                };
            }
            
            // 5b. In debounce window - be more strict about accepting untrusted events
            if (this.isInDebounceWindow(element)) {
                // Only reject if change is small (likely echo or hijack attempt)
                // Large changes are probably user actions we couldn't detect
                if (volumeDiff < 10) {
                    return {
                        shouldProcess: false,
                        reason: `In debounce window (${volumeDiff.toFixed(1)}% change)`,
                        type: 'debounce',
                        rejectAndReapply: true,
                        isHijackAttempt: !hasRecentInteraction  // Only hijack if no user activity
                    };
                }
                // Large change - allow through
            }
            
            // 5c. Check for insignificant change
            if (volumeDiff < MIN_CHANGE_PERCENT) {
                // Check mute toggle
                if (isMuted !== managedMuteState) {
                    return {
                        shouldProcess: false,
                        reason: `${isMuted ? 'Muted' : 'Unmuted'} (synthetic)`,
                        type: 'mute-toggle',
                        muteStateChanged: true,
                        newMuteState: isMuted
                    };
                }
                return {
                    shouldProcess: false,
                    reason: `Change too small (${volumeDiff.toFixed(1)}%)`,
                    type: 'insignificant'
                };
            }

            // 5d. Handle auto-mute from scroll (visibility change)
            if (isMuted && !isVisible) {
                return {
                    shouldProcess: false,
                    reason: 'Auto-mute from scroll',
                    type: 'auto-mute',
                    saveForRestore: true,
                    volumeToSave: extensionVolume
                };
            }

            // 5e. If we recently rejected a hijack attempt, keep rejecting untrusted events
            // This prevents sites from repeatedly trying to reset our volume
            // EXCEPTION: Allow during visibility grace period (site restoring volume after scroll)
            // EXCEPTION: Allow if slider drag pattern detected
            if (this.isInHijackProtectionWindow(element) && !hasRecentInteraction && !isSliderDrag && !inVisibilityGrace) {
                return {
                    shouldProcess: false,
                    reason: `In hijack protection window - rejecting (${volumeDiff.toFixed(1)}%)`,
                    type: 'hijack-protection',
                    rejectAndReapply: true,
                    isHijackAttempt: true  // No user interaction = clear hijack
                };
            }

            // 5f. If we have set volume before, REJECT untrusted events without user interaction
            // This is critical for preventing sites from hijacking.
            // Apply this rule for gainNode-controlled elements AND CORS-blocked (native-only) elements.
            // For CORS elements, this ensures we maintain control even though we can't use GainNode.
            // EXCEPTION: During visibility grace period, allow site to restore (user scrolled back)
            // EXCEPTION: If slider drag pattern detected
            if (State.volumeHasBeenSet && (hasGainNode || isCorsBlocked)) {
                if (!hasRecentInteraction && !isSliderDrag && !inVisibilityGrace) {
                    return {
                        shouldProcess: false,
                        reason: `No user interaction - rejecting site change (${volumeDiff.toFixed(1)}%)`,
                        type: 'no-user-activity',
                        rejectAndReapply: true,
                        isHijackAttempt: true  // No user interaction = clear hijack
                    };
                }
                
                // During visibility grace, accept site restoration
                if (inVisibilityGrace && !hasRecentInteraction && !isSliderDrag) {
                    verbose(`[VolumeSync] In visibility grace period - allowing site change`);
                    return {
                        shouldProcess: true,
                        reason: `Visibility grace - accepting site restoration (${volumeDiff.toFixed(1)}%)`,
                        type: 'visibility-grace-adoption',
                        newVolume: playerVolume,
                        isVisibilityRelated: true  // Flag to not extend hijack protection
                    };
                }
            }
            
            // 5g. Accept the change - user is interacting
            return {
                shouldProcess: true,
                reason: `Accepting player change with interaction (${volumeDiff.toFixed(1)}%)`,
                type: 'player-change-untrusted',
                newVolume: playerVolume
            };
        }

        /**
         * Create and attach a volume change handler for an element
         */
        attachVolumeChangeHandler(element, contextData) {
            const State = window.VolumeControl.State;
            const elementInfo = `${element.tagName}#${element.id || 'no-id'}`;
            const stateManager = window.VolumeControl.elementStateManager;
            const syncState = this._getSyncState(element);
    
            // Remove existing handler if present
            if (contextData.volumeSyncHandler) {
                element.removeEventListener('volumechange', contextData.volumeSyncHandler);
            }

            const handlerEpoch = contextData.beginOperation
                ? contextData.beginOperation('volumeSync')
                : (syncState.handlerEpoch + 1);
            syncState.handlerEpoch = handlerEpoch;
    
            const handler = (event) => {
                if (contextData.isOperationCurrent && !contextData.isOperationCurrent('volumeSync', handlerEpoch)) {
                    verbose(`[VolumeSync] Ignoring stale handler event for ${elementInfo}`);
                    return;
                }

                if (!element.isConnected) {
                    return;
                }

                const currentStateData = stateManager?.get?.(element);
                if (!currentStateData || currentStateData !== contextData) {
                    return;
                }

                // Evaluate CORS state per event so source changes are reflected immediately.
                const isCorsBlocked = !!(stateManager && stateManager.isCorsBlocked && stateManager.isCorsBlocked(element));
                const now = Date.now();
                const currentSyncState = this._getSyncState(element);
                const playerVolume = Math.round(element.volume * 100);
                const volumeDiff = Math.abs(playerVolume - State.currentVolumePercent);
                const managedMuteState = (() => {
                    if (window.VolumeControl.State?.muteHasBeenSet) {
                        return window.VolumeControl.State.currentMutedState;
                    }

                    if (typeof contextData?.managedMutedState === 'boolean') {
                        return contextData.managedMutedState;
                    }

                    if (typeof contextData?.observedNativeMutedState === 'boolean') {
                        return contextData.observedNativeMutedState;
                    }

                    if (typeof contextData?.nativeMutedSnapshot === 'boolean') {
                        return contextData.nativeMutedSnapshot;
                    }

                    return element.muted;
                })();
                const canDriveSharedState = (() => {
                    const controllableElements = new Set();
                    const activeEntries = typeof stateManager?.getActive === 'function'
                        ? stateManager.getActive()
                        : [];

                    activeEntries.forEach((entry) => {
                        const activeElement = entry?.element;
                        if (activeElement?.isConnected) {
                            controllableElements.add(activeElement);
                        }
                    });

                    if (stateManager?.corsElements?.forEach) {
                        stateManager.corsElements.forEach((corsElement) => {
                            if (corsElement?.isConnected) {
                                controllableElements.add(corsElement);
                            }
                        });
                    }

                    return controllableElements.size === 0 ||
                        (controllableElements.size === 1 && controllableElements.has(element));
                })();
                
                const result = this.analyzeVolumeChange(element, event, State.currentVolumePercent, {
                    isSetupComplete: contextData.setupComplete !== false,
                    isVisible: contextData.isIntersecting !== false,
                    hasGainNode: !!contextData.gainNode,
                    isCorsBlocked,
                    managedMuteState,
                    canDriveSharedState
                });
                const hasRecentInteraction = (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS || isMouseDown || isPointerDown;
                const interactedThisElement = Boolean(
                    (now - lastInteractionAt) < INTERACTION_TIMEOUT_MS &&
                    lastInteractedMediaElement === element
                );
                const isSliderDrag = this.isLikelySliderDrag(element);
                const msSinceLastInteraction = lastInteractionAt > 0 ? now - lastInteractionAt : null;
                const msSinceLastMuteToggle = currentSyncState.lastMuteToggleAt
                    ? now - currentSyncState.lastMuteToggleAt
                    : null;
                const msSinceLastAcceptedMuteInteraction = currentSyncState.lastAcceptedMuteInteractionAt
                    ? now - currentSyncState.lastAcceptedMuteInteractionAt
                    : null;

                // COMPREHENSIVE DEBUG LOGGING
                if (logVolumeEvent) {
                    logVolumeEvent({
                        elementInfo,
                        eventType: event.type,
                        isTrusted: event.isTrusted,
                        playerVolume,
                        extensionVolume: State.currentVolumePercent,
                        volumeDiff,
                        isMuted: element.muted,
                        // Protection state
                        isSourceChanging: currentSyncState.isSourceChanging,
                        isApplyingVolume: currentSyncState.isApplyingVolume,
                        targetVolume: currentSyncState.targetVolume,
                        inDebounceWindow: this.isInDebounceWindow(element),
                        msSinceExtensionChange: this._getMsSinceExtensionChange(element),
                        inHijackProtection: this.isInHijackProtectionWindow(element),
                        msSinceHijackReject: this._getMsSinceHijackReject(element),
                        rapidChangeCount: currentSyncState.rapidChangeCount,
                        lastTrackedPlayerVolume: currentSyncState.lastTrackedPlayerVolume,
                        // User interaction
                        hasRecentInteraction,
                        interactedThisElement,
                        isMouseDown,
                        isPointerDown,
                        isSliderDrag,
                        msSinceLastInteraction,
                        msSinceLastMuteToggle,
                        msSinceLastAcceptedMuteInteraction,
                        // Context
                        pageHidden: document.hidden,
                        isVisible: contextData.isIntersecting !== false,
                        hasGainNode: !!contextData.gainNode,
                        setupComplete: contextData.setupComplete !== false,
                        volumeHasBeenSet: State.volumeHasBeenSet,
                        muteHasBeenSet: State.muteHasBeenSet,
                        managedMuteState,
                        observedNativeMutedState: contextData.observedNativeMutedState,
                        nativeMutedSnapshot: contextData.nativeMutedSnapshot,
                        canDriveSharedState,
                        isCorsBlocked,
                        // Decision
                        decision: result
                    });
                }

                if (logDiagnostic && (result.muteStateChanged || result.rejectAndReapply || result.shouldProcess)) {
                    logDiagnostic('volume-sync-decision', {
                        elementInfo,
                        decisionType: result.type,
                        decisionReason: result.reason,
                        isTrusted: event.isTrusted,
                        shouldProcess: result.shouldProcess === true,
                        rejectAndReapply: result.rejectAndReapply === true,
                        reapplyMute: result.reapplyMute === true,
                        reapplyMuteState: result.reapplyMuteState ?? null,
                        muteStateChanged: result.muteStateChanged === true,
                        newMuteState: result.newMuteState,
                        playerVolume,
                        extensionVolume: State.currentVolumePercent,
                        elementMuted: element.muted,
                        managedMuteState,
                        muteHasBeenSet: State.muteHasBeenSet,
                        canDriveSharedState,
                        isCorsBlocked,
                        hasRecentInteraction,
                        interactedThisElement,
                        isSliderDrag,
                        rapidChangeCount: currentSyncState.rapidChangeCount,
                        lastTrackedPlayerVolume: currentSyncState.lastTrackedPlayerVolume,
                        msSinceLastInteraction,
                        msSinceLastMuteToggle,
                        msSinceLastAcceptedMuteInteraction,
                        observedNativeMutedState: contextData.observedNativeMutedState,
                        nativeMutedSnapshot: contextData.nativeMutedSnapshot,
                        contextManagedMutedState: contextData.managedMutedState,
                        decision: result
                    }, { threshold: 3 });
                }

                verbose(`[VolumeSync] ${elementInfo}: ${result.reason} (type: ${result.type})`);

                // Handle mute state changes
                if (result.muteStateChanged) {
                    contextData.observedNativeMutedState = result.newMuteState;

                    if (!State.muteHasBeenSet && result.updateManagedMuteState !== false) {
                        contextData.managedMutedState = result.newMuteState;
                    }

                        if (result.commitMuteToRestore !== false) {
                            contextData.nativeMutedSnapshot = result.newMuteState;
                            contextData.userOriginalMutedState = result.newMuteState;
                        }

                        if (result.updateSharedMuteState !== false) {
                            const oldMuted = State.currentMutedState;
                            State.currentMutedState = result.newMuteState;
                            stateChange('currentMutedState', oldMuted, result.newMuteState, 'volumechange');
                        }
                    
                        if (result.notifyStatusChange !== false && window.VolumeControl.notifyPopupOfStatusChange) {
                        window.VolumeControl.notifyPopupOfStatusChange();
                    }
                    return;
                }

                // Handle rejection with re-apply
                if (result.rejectAndReapply) {
                    const VolumeController = window.VolumeControl.VolumeController;
                    if (VolumeController) {
                        log(`[VolumeSync] REJECTING and re-applying ${State.currentVolumePercent}% (was ${playerVolume}%)`);
                        // Use reapplyVolumeAfterReject - doesn't reset debounce timestamp
                        // Pass isHijackAttempt to control whether hijack protection window is activated
                        const isHijack = result.isHijackAttempt !== false; // Default to true for safety
                        this.reapplyVolumeAfterReject(element, State.currentVolumePercent, isHijack);

                        if (contextData.gainNode) {
                            VolumeController.applyVolume(element, contextData, State.currentVolumePercent, { force: true });
                        } else if (isCorsBlocked && VolumeController.applyNativeVolumeOnly) {
                            VolumeController.applyNativeVolumeOnly(element, State.currentVolumePercent);
                        }

                        if (result.reapplyMute === true && typeof VolumeController.applyMute === 'function') {
                            VolumeController.applyMute(element, Boolean(result.reapplyMuteState ?? managedMuteState));
                        }
                    }
                    return;
                }

                // Handle save for restore (auto-mute)
                if (result.saveForRestore) {
                    if ((contextData.volumeBeforeInvisible === null || contextData.volumeBeforeInvisible === undefined) 
                        && result.volumeToSave > 0) {
                        contextData.volumeBeforeInvisible = result.volumeToSave;
                        contextData.wasAutoMuted = true;
                        verbose(`[VolumeSync] Saved ${result.volumeToSave}% for restoration`);
                    }
                    return;
                }

                // Handle accepted change
                if (result.shouldProcess) {
                    decision(true, `[VolumeSync] ADOPTING player volume: ${result.newVolume}%`);
                    log(`[VolumeSync] ⚠️ VOLUME ADOPTED from player: ${result.newVolume}% on ${elementInfo} (was ${State.currentVolumePercent}%)`);

                    // CRITICAL: Always reset hijack protection when adopting a volume change
                    // This ensures the user can continue using the native slider
                    // Even for visibility-related changes, we need to reset or user gets stuck
                    currentSyncState.lastHijackRejectedAt = 0;

                    // Update extension state
                    const oldVolume = State.currentVolumePercent;
                    State.currentVolumePercent = result.newVolume;
                    State.volumeHasBeenSet = true;
                    contextData.observedNativeVolume = element.volume;
                    contextData.nativeVolumeSnapshot = element.volume;
                    contextData.userOriginalVolume = element.volume;
                    stateChange('currentVolumePercent', oldVolume, result.newVolume, 'native player');

                    // Clear any pending volume application
                    this.clearApplyingVolume(element);

                    // Apply through VolumeController so gain/native behavior stays
                    // consistent across browser/capture mode differences.
                    const VolumeController = window.VolumeControl.VolumeController;
                    if (VolumeController && contextData.gainNode) {
                        VolumeController.applyVolume(element, contextData, result.newVolume, {
                            force: true,
                            source: 'volume-sync-adopt'
                        });
                        contextData.lastAppliedVolume = result.newVolume;
                    }
                    
                    // Sync OTHER active elements
                    const stateManager = window.VolumeControl.elementStateManager;
                    if (stateManager && VolumeController) {
                        stateManager.elements.forEach((otherStateData, otherElement) => {
                            if (otherElement !== element && otherStateData.isActive()) {
                                this.startApplyingVolumeFromPlayer(otherElement, result.newVolume);
                                VolumeController.applyVolume(otherElement, otherStateData, result.newVolume);
                            }
                        });
                    }
                    
                    // Persist to storage
                    if (window.VolumeControl.scheduleStorageWrite) {
                        window.VolumeControl.scheduleStorageWrite(
                            window.VolumeControl.SESSION_STORAGE_KEY_VOLUME,
                            result.newVolume.toString()
                        );
                    }

                    // Notify popup
                    if (window.VolumeControl.notifyPopupOfStatusChange) {
                        window.VolumeControl.notifyPopupOfStatusChange();
                    }
                } else {
                    decision(false, `[VolumeSync] Ignoring: ${result.reason}`);
                }
            };

            element.addEventListener('volumechange', handler);
            contextData.volumeSyncHandler = handler;
            verbose(`[VolumeSync] Attached handler to ${elementInfo}`);
        }

        /** Remove volume change handler from element */
        removeVolumeChangeHandler(element, contextData) {
            if (contextData.volumeSyncHandler) {
                element.removeEventListener('volumechange', contextData.volumeSyncHandler);
                delete contextData.volumeSyncHandler;
            }
            if (contextData.invalidateOperation) {
                contextData.invalidateOperation('volumeSync');
            }
            this.clearApplyingVolume(element);
        }

        /** Cleanup all state for an element */
        cleanup(element) {
            const syncState = this.elementSyncState.get(element);
            if (syncState?.lockTimeout) {
                clearTimeout(syncState.lockTimeout);
            }
            if (syncState?.sourceChangeTimeout) {
                clearTimeout(syncState.sourceChangeTimeout);
            }
            this.elementSyncState.delete(element);
        }
    }

    // Create singleton instance and export
    const instance = new VolumeSyncManager();
    
    // Export both class and instance (for backward compatibility)
    window.VolumeControl.VolumeSyncManager = VolumeSyncManager;
    window.VolumeControl.volumeSyncManager = instance;

    // Simple interaction tracking (with unload cleanup)
    const capturePassive = { capture: true, passive: true };

    const onMouseDown = (event) => {
        isMouseDown = true;
        noteUserInteraction(event);
    };
    const onMouseUp = () => {
        isMouseDown = false;
    };
    const onTouchStart = (event) => {
        isMouseDown = true;
        noteUserInteraction(event);
    };
    const onTouchEnd = () => {
        isMouseDown = false;
    };
    const onKeyDown = () => {
        lastInteractionAt = Date.now();
    };
    const onPointerDown = (event) => {
        isPointerDown = true;
        noteUserInteraction(event);
    };
    const onPointerUp = () => {
        isPointerDown = false;
    };
    const onPointerMove = (e) => {
        if (isPointerDown || e.buttons > 0) {
            lastInteractionAt = Date.now();
        }
    };
    const onBlur = () => {
        isMouseDown = false;
        isPointerDown = false;
        lastInteractedMediaElement = null;
    };

    // Prevent duplicate global listeners on content-script reinjection.
    if (window._vcInteractionListenersAttached) {
        log('[VolumeSync] Interaction listeners already attached, skipping');
    } else {
        document.addEventListener('mousedown', onMouseDown, capturePassive);
        document.addEventListener('mouseup', onMouseUp, capturePassive);
        document.addEventListener('touchstart', onTouchStart, capturePassive);
        document.addEventListener('touchend', onTouchEnd, capturePassive);
        document.addEventListener('keydown', onKeyDown, capturePassive);
        document.addEventListener('pointerdown', onPointerDown, capturePassive);
        document.addEventListener('pointerup', onPointerUp, capturePassive);
        document.addEventListener('pointermove', onPointerMove, capturePassive);
        window.addEventListener('blur', onBlur, { passive: true });

        window._vcInteractionListenersAttached = true;

        window.addEventListener('unload', () => {
            document.removeEventListener('mousedown', onMouseDown, capturePassive);
            document.removeEventListener('mouseup', onMouseUp, capturePassive);
            document.removeEventListener('touchstart', onTouchStart, capturePassive);
            document.removeEventListener('touchend', onTouchEnd, capturePassive);
            document.removeEventListener('keydown', onKeyDown, capturePassive);
            document.removeEventListener('pointerdown', onPointerDown, capturePassive);
            document.removeEventListener('pointerup', onPointerUp, capturePassive);
            document.removeEventListener('pointermove', onPointerMove, capturePassive);
            window.removeEventListener('blur', onBlur, { passive: true });
            window._vcInteractionListenersAttached = false;
        }, { once: true });
    }

    log('[VolumeSync] Module initialized');
})();
