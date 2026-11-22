/**
 * Constants for Volume Control Extension
 */

window.VolumeControl = window.VolumeControl || {};

// ============================================
// Volume Range Constants
// ============================================
window.VolumeControl.MIN_VOLUME = 0;
window.VolumeControl.MAX_VOLUME = 500;
window.VolumeControl.DEFAULT_VOLUME = 100;

// ============================================
// Storage Keys
// ============================================
window.VolumeControl.SESSION_STORAGE_KEY_VOLUME = 'perTabVolume_volumePercent';
window.VolumeControl.SESSION_STORAGE_KEY_MONO_ENABLED = 'perTabVolume_monoEnabled';
window.VolumeControl.SESSION_STORAGE_KEY_BALANCE = 'perTabVolume_balance';
window.VolumeControl.SESSION_STORAGE_KEY_COMPRESSION_ENABLED = 'perTabVolume_compEnabled';
window.VolumeControl.SESSION_STORAGE_KEY_COMPRESSION_THRESHOLD = 'perTabVolume_compThreshold';
window.VolumeControl.SESSION_STORAGE_KEY_COMPRESSION_RATIO = 'perTabVolume_compRatio';
window.VolumeControl.SESSION_STORAGE_KEY_COMPRESSION_KNEE = 'perTabVolume_compKnee';

// ============================================
// Channel Settings Defaults
// ============================================
window.VolumeControl.DEFAULT_MONO_ENABLED = false;
window.VolumeControl.DEFAULT_BALANCE = 0;
window.VolumeControl.BALANCE_MIN = -100;
window.VolumeControl.BALANCE_MAX = 100;

// ============================================
// Default Compressor Parameters
// ============================================
window.VolumeControl.DEFAULT_COMPRESSOR_THRESHOLD = -18; // dB
window.VolumeControl.DEFAULT_COMPRESSOR_RATIO = 6;       // :1
window.VolumeControl.DEFAULT_COMPRESSOR_KNEE = 3;        // dB
window.VolumeControl.DEFAULT_COMPRESSOR_ATTACK = 0.003;  // seconds
window.VolumeControl.DEFAULT_COMPRESSOR_RELEASE = 0.100; // seconds

// ============================================
// Compressor Ranges (for UI sliders)
// ============================================
window.VolumeControl.COMPRESSOR_THRESHOLD_MIN = -50;
window.VolumeControl.COMPRESSOR_THRESHOLD_MAX = -10;
window.VolumeControl.COMPRESSOR_RATIO_MIN = 2;
window.VolumeControl.COMPRESSOR_RATIO_MAX = 12;
window.VolumeControl.COMPRESSOR_KNEE_MIN = 0;
window.VolumeControl.COMPRESSOR_KNEE_MAX = 20;

// ============================================
// Makeup Gain
// ============================================
window.VolumeControl.MAKEUP_GAIN_ENABLED = true;
window.VolumeControl.MAKEUP_GAIN_FACTOR = 0.7;

// ============================================
// Pre-compressor gain
// ============================================
window.VolumeControl.PRE_COMPRESSOR_GAIN_DB = 6;

// ============================================
// Timing Constants
// ============================================
window.VolumeControl.MUTATION_SCAN_DELAY_MS = 250;
window.VolumeControl.MUTATION_MAX_WAIT_MS = 1000;
window.VolumeControl.MUTATION_PENDING_CAP = 500;
window.VolumeControl.STORAGE_WRITE_DEBOUNCE_MS = 500;

// ============================================
// Media Detection
// ============================================
// CustomEvent that the MAIN-world play hook (detection/play_hook_main.js) dispatches on document
// with the playing element as `detail`. The hook runs in the page world and cannot load this file,
// so it repeats the literal; tests/main-world-play-hook.test.js keeps the two equal.
window.VolumeControl.PLAY_HOOK_EVENT = '__vc_play';
// Same contract for the MAIN-world element.volume setter hook (detection/volume_hook_main.js): the
// event is dispatched synchronously inside the page's own write, with the element as `detail`.
window.VolumeControl.VOLUME_HOOK_EVENT = '__vc_volume';
// The periodic safety scan skips its document walk while no DOM mutation was recorded, but still
// walks once every N ticks (shadow roots can gain media without any observed mutation).
window.VolumeControl.PERIODIC_SCAN_FORCE_EVERY_TICKS = 4;

// ============================================
// Setup / Retry Constants
// ============================================
window.VolumeControl.SETUP_TIMEOUT_MS = 5000;

// ============================================
// Volume Sync Timing
// ============================================
window.VolumeControl.EXTENSION_VOLUME_LOCK_TIMEOUT_MS = 150;
// ============================================
// Misc
// ============================================
window.VolumeControl.NATIVE_VOLUME_EPSILON = 0.002;
window.VolumeControl.COMPRESSOR_MONITOR_INTERVAL_MS = 2000;

// ============================================
// Browser Version Policy
// ============================================
// Firefox 149+ uses MediaElementAudioSourceNode for capturable media.
// Firefox <149 keeps legacy fallback behavior via mozCaptureStream().
// Blocked cross-origin Firefox media still bypasses capture confirmation and uses native-only fallback.
window.VolumeControl.FIREFOX_STANDARD_CAPTURE_MIN_VERSION = 149;
