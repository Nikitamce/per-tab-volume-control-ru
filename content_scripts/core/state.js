/**
 * Global State for Volume Control Extension
 */

window.VolumeControl = window.VolumeControl || {};

// Get DEFAULT_VOLUME from constants (loaded before this file)
const DEFAULT_VOLUME_STATE = window.VolumeControl.DEFAULT_VOLUME || 100;

window.VolumeControl.State = {
    sharedAudioContext: null,
    
    // Setup coordination
    audioContextResumePromise: null,
    autoplayBypassListenerActive: false,
    visibilityChangeListenerAttached: false,
    
    // CORS tracking
    corsAffectedElements: new Set(),
    
    // Current Settings
    currentVolumePercent: DEFAULT_VOLUME_STATE,
    currentMutedState: false,
    currentMonoEnabled: window.VolumeControl.DEFAULT_MONO_ENABLED,
    localBalance: window.VolumeControl.DEFAULT_BALANCE,
    currentBalance: window.VolumeControl.DEFAULT_BALANCE,
    currentCompressionEnabled: false,
    currentCompressionThreshold: window.VolumeControl.DEFAULT_COMPRESSOR_THRESHOLD,
    currentCompressionRatio: window.VolumeControl.DEFAULT_COMPRESSOR_RATIO,
    currentCompressionKnee: window.VolumeControl.DEFAULT_COMPRESSOR_KNEE,
    extensionEnabled: true,

    // Tracks whether settings came from tab session state versus extension defaults
    monoHasBeenSet: false,
    balanceHasBeenSet: false,
    compressionHasBeenSet: false,
    defaultCompressionEnabled: false,
    defaultMonoEnabled: window.VolumeControl.DEFAULT_MONO_ENABLED,
    defaultBalanceEnabled: false,
    defaultBalance: window.VolumeControl.DEFAULT_BALANCE,
    
    // Track if volume has been explicitly set
    volumeHasBeenSet: false,
    muteHasBeenSet: false,
    
    lastReportedStatus: null,
    volumeCommandSequence: 0
};
