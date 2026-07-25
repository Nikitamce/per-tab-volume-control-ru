/**
 * Logger Utility for Volume Control Extension
 * Debug levels: 0=errors, 1=warnings, 2=info, 3=verbose, 4=trace, 5=ultra
 */

window.VolumeControl = window.VolumeControl || {};

// Production builds default to warn-level logging. Runtime diagnostics can be
// enabled on demand and persisted when deeper site-specific investigation is needed.
const DEFAULT_DEBUG_LEVEL = 1;
const MIN_DEBUG_LEVEL = 0;
const MAX_DEBUG_LEVEL = 5;
const DEBUG_LEVEL_STORAGE_KEY = 'perTabVolume_debugLevel';

let debugLevel = DEFAULT_DEBUG_LEVEL;

const LOG_THROTTLE_MS = {
    INFO: 900,
    VERBOSE: 0,
    ULTRA: 0
};

const perfTimers = new Map();
let callDepth = 0;
const messageHistory = new Map();
const MESSAGE_HISTORY_MAX_SIZE = 100;
const MESSAGE_HISTORY_CLEANUP_THRESHOLD = 150;

// Session-wide event counter for correlating logs.
let globalEventCounter = 0;

// Store recent events for export and post-mortem inspection.
const recentVolumeEvents = [];
const MAX_RECENT_EVENTS = 200;
const recentDiagnostics = [];
const MAX_RECENT_DIAGNOSTICS = 250;

const browserApi = globalThis.browser;

function getWindowLocation() {
    try {
        return window.location || null;
    } catch (_error) {
        return null;
    }
}

const FRAME_DESCRIPTOR = (() => {
    try {
        const location = getWindowLocation();
        return window === window.top ? 'top-level' : `iframe@${location?.href || 'unknown'}`;
    } catch (_error) {
        return 'iframe';
    }
})();

function normalizeDebugLevel(level, fallback = DEFAULT_DEBUG_LEVEL) {
    const parsedLevel = Number(level);
    if (!Number.isFinite(parsedLevel)) {
        return fallback;
    }

    return Math.max(MIN_DEBUG_LEVEL, Math.min(MAX_DEBUG_LEVEL, Math.round(parsedLevel)));
}

function getDebugLevel() {
    return debugLevel;
}

function sanitizeLabel(label) {
    if (!label) return '';
    const str = String(label);
    return str.length > 120 ? `${str.slice(0, 120)}...` : str;
}

function shouldThrottle(levelName, label) {
    // No throttling in high debug modes.
    if (getDebugLevel() >= 3) return false;

    const throttleWindow = LOG_THROTTLE_MS[levelName];
    if (!label || !throttleWindow) return false;
    const now = Date.now();
    const historyKey = `${levelName}:${label}`;
    const lastLoggedAt = messageHistory.get(historyKey);
    if (lastLoggedAt && now - lastLoggedAt < throttleWindow) {
        return true;
    }
    messageHistory.set(historyKey, now);

    if (messageHistory.size > MESSAGE_HISTORY_CLEANUP_THRESHOLD) {
        const entries = Array.from(messageHistory.entries());
        entries.sort((a, b) => a[1] - b[1]);
        const toRemove = entries.slice(0, entries.length - MESSAGE_HISTORY_MAX_SIZE);
        toRemove.forEach(([key]) => messageHistory.delete(key));
    }

    return false;
}

function describeLocation() {
    const location = getWindowLocation();
    if (!location) {
        return 'unknown';
    }

    try {
        return `${location.origin}${location.pathname}${location.search}`;
    } catch (_error) {
        return location.href || 'unknown';
    }
}

function getTimestamp() {
    const now = new Date();
    return `${now.toLocaleTimeString('en-US', { hour12: false })}.${now.getMilliseconds().toString().padStart(3, '0')}`;
}

function buildMeta(levelName, extra = {}) {
    return {
        level: levelName,
        frame: FRAME_DESCRIPTOR,
        timestamp: getTimestamp(),
        eventId: globalEventCounter,
        ...extra
    };
}

function nextEventId() {
    globalEventCounter += 1;
    return globalEventCounter;
}

function pushRecentRecord(collection, maxSize, record) {
    collection.push(record);
    if (collection.length > maxSize) {
        collection.shift();
    }
}

function serializeDiagnosticValue(value, depth = 0) {
    if (value === undefined) {
        return undefined;
    }

    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : String(value);
    }

    if (Array.isArray(value)) {
        return value.slice(0, 25).map((entry) => serializeDiagnosticValue(entry, depth + 1));
    }

    if (typeof value === 'object') {
        if (typeof value.tagName === 'string') {
            return `${value.tagName}#${value.id || 'no-id'}`;
        }

        if (depth >= 3) {
            return '[object]';
        }

        const result = {};
        Object.keys(value).slice(0, 50).forEach((key) => {
            const serialised = serializeDiagnosticValue(value[key], depth + 1);
            if (serialised !== undefined) {
                result[key] = serialised;
            }
        });
        return result;
    }

    return String(value);
}

function rememberDiagnostic(category, details = {}, options = {}) {
    const normalisedDetails = Array.isArray(details) || typeof details !== 'object' || details === null
        ? { value: serializeDiagnosticValue(details) }
        : serializeDiagnosticValue(details);
    const record = {
        eventId: options.eventId ?? nextEventId(),
        timestamp: options.timestamp ?? getTimestamp(),
        frame: FRAME_DESCRIPTOR,
        location: describeLocation(),
        category,
        ...normalisedDetails
    };
    pushRecentRecord(recentDiagnostics, MAX_RECENT_DIAGNOSTICS, record);
    return record;
}

function toPercent(value) {
    if (!Number.isFinite(Number(value))) {
        return null;
    }

    return Math.round(Number(value) * 1000) / 10;
}

function ageMs(timestamp) {
    return Number.isFinite(Number(timestamp)) && Number(timestamp) > 0
        ? Date.now() - Number(timestamp)
        : null;
}

function persistDebugLevel(level) {
    if (!browserApi?.storage?.local?.set) {
        return;
    }

    browserApi.storage.local.set({ [DEBUG_LEVEL_STORAGE_KEY]: level }).catch(() => {});
}

function updateDebugLevel(level, options = {}) {
    const {
        persist = false,
        announce = false
    } = options;
    const nextLevel = normalizeDebugLevel(level);
    const previousLevel = debugLevel;
    debugLevel = nextLevel;

    if (persist) {
        persistDebugLevel(nextLevel);
    }

    if (announce && previousLevel !== nextLevel) {
        console.info(`[${getTimestamp()}] VC/LOGGER Debug level set to ${nextLevel}`);
    }

    return nextLevel;
}

function loadPersistedDebugLevel() {
    if (!browserApi?.storage?.local?.get) {
        return;
    }

    browserApi.storage.local.get(DEBUG_LEVEL_STORAGE_KEY)
        .then((result) => {
            if (result && Object.prototype.hasOwnProperty.call(result, DEBUG_LEVEL_STORAGE_KEY)) {
                updateDebugLevel(result[DEBUG_LEVEL_STORAGE_KEY], { persist: false, announce: true });
            }
        })
        .catch(() => {});
}

function listenForDebugLevelChanges() {
    if (!browserApi?.storage?.onChanged?.addListener) {
        return;
    }

    browserApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, DEBUG_LEVEL_STORAGE_KEY)) {
            return;
        }

        updateDebugLevel(changes[DEBUG_LEVEL_STORAGE_KEY]?.newValue, {
            persist: false,
            announce: true
        });
    });
}

function logChannel(levelName, threshold, consoleFn, args, extraMeta = {}) {
    if (getDebugLevel() < threshold) return;
    const message = typeof args[0] === 'string' ? args[0] : '';
    const label = sanitizeLabel(message);
    if (shouldThrottle(levelName, label)) return;

    const ts = getTimestamp();
    const prefix = `[${ts}] VC/${levelName}`;

    if (getDebugLevel() >= 5) {
        const meta = buildMeta(levelName, extraMeta);
        consoleFn(prefix, meta, ...args);
    } else {
        consoleFn(prefix, ...args);
    }
}

window.VolumeControl.log = (...args) => logChannel('INFO', 2, console.log, args);
window.VolumeControl.warn = (...args) => logChannel('WARN', 1, console.warn, args);
window.VolumeControl.error = (...args) => logChannel('ERROR', 0, console.error, args);
window.VolumeControl.verbose = (...args) => logChannel('VERBOSE', 3, console.log, args);
window.VolumeControl.ultra = (...args) => logChannel('ULTRA', 5, console.log, args);

window.VolumeControl.trace = (...args) => {
    if (getDebugLevel() < 4) return;
    const indent = '  '.repeat(callDepth);
    const ts = getTimestamp();
    const prefix = `[${ts}] VC/TRACE ${indent}`;
    console.log(prefix, ...args);
};

window.VolumeControl.traceEnter = (functionName, ...params) => {
    if (getDebugLevel() < 4) return;
    const indent = '  '.repeat(callDepth);
    const paramStr = params.length > 0 ? JSON.stringify(params).substring(0, 200) : '';
    const ts = getTimestamp();
    console.log(`[${ts}] VC/TRACE ${indent}> ${functionName}(${paramStr})`);
    callDepth++;
    perfTimers.set(functionName, performance.now());
};

window.VolumeControl.traceExit = (functionName, result) => {
    if (getDebugLevel() < 4) return;
    callDepth = Math.max(0, callDepth - 1);
    const indent = '  '.repeat(callDepth);
    const startTime = perfTimers.get(functionName);
    const duration = startTime ? `${(performance.now() - startTime).toFixed(2)}ms` : '';
    const resultStr = result !== undefined ? ` -> ${JSON.stringify(result).substring(0, 100)}` : '';
    const ts = getTimestamp();
    console.log(`[${ts}] VC/TRACE ${indent}< ${functionName} ${duration}${resultStr}`);
    perfTimers.delete(functionName);
};

window.VolumeControl.decision = (condition, reason) => {
    if (getDebugLevel() < 3) return;
    const symbol = condition ? 'OK' : 'NO';
    const ts = getTimestamp();
    console.log(`[${ts}] VC/DECISION ${symbol} ${reason}`);
};

window.VolumeControl.stateChange = (property, oldValue, newValue, context = '') => {
    if (getDebugLevel() < 3) return;
    const ctx = context ? ` [${context}]` : '';
    const ts = getTimestamp();
    console.log(`[${ts}] VC/STATE ${property}${ctx}: ${oldValue} -> ${newValue}`);
};

window.VolumeControl.event = (eventName, element, details = {}) => {
    if (getDebugLevel() < 3) return;
    const elemDesc = element ? `${element.tagName}#${element.id || 'no-id'}` : 'unknown';
    const ts = getTimestamp();
    console.log(`[${ts}] VC/EVENT ${eventName} on ${elemDesc}`, details);
};

window.VolumeControl.dom = (operation, selector, result) => {
    if (getDebugLevel() < 4) return;
    const ts = getTimestamp();
    console.log(`[${ts}] VC/DOM ${operation}("${selector}") -> ${result ? 'FOUND' : 'NOT FOUND'}`);
};

window.VolumeControl.api = (apiName, params, result) => {
    if (getDebugLevel() < 3) return;
    const paramStr = JSON.stringify(params).substring(0, 100);
    const resultStr = JSON.stringify(result).substring(0, 100);
    const ts = getTimestamp();
    console.log(`[${ts}] VC/API ${apiName}(${paramStr}) -> ${resultStr}`);
};

window.VolumeControl.logDiagnostic = function(category, details = {}, options = {}) {
    const threshold = normalizeDebugLevel(options.threshold, 3);
    if (getDebugLevel() < threshold) return null;

    const record = rememberDiagnostic(category, details);
    console.log(`[${record.timestamp}] VC/DIAG ${category}`, record);
    return record;
};

window.VolumeControl.logVolumeEvent = function(eventData) {
    if (getDebugLevel() < 3) return;

    const eventId = nextEventId();
    const ts = getTimestamp();
    const record = {
        eventId,
        timestamp: ts,
        frame: FRAME_DESCRIPTOR,
        location: describeLocation(),
        ...serializeDiagnosticValue(eventData)
    };
    pushRecentRecord(recentVolumeEvents, MAX_RECENT_EVENTS, record);
    rememberDiagnostic('volume-event', {
        elementInfo: record.elementInfo || 'unknown',
        decisionType: record.decision?.type || 'unknown',
        reason: record.decision?.reason || 'none',
        playerVolume: record.playerVolume,
        extensionVolume: record.extensionVolume,
        isMuted: record.isMuted,
        managedMuteState: record.managedMuteState,
        muteHasBeenSet: record.muteHasBeenSet
    }, { eventId, timestamp: ts });

    const lines = [
        '',
        '╔══════════════════════════════════════════════════════════════════════════════',
        `║ VOLUME EVENT #${eventId} @ ${ts}`,
        '╠══════════════════════════════════════════════════════════════════════════════',
        `║ Element: ${record.elementInfo || 'unknown'}`,
        `║ Event Type: ${record.eventType || 'volumechange'}`,
        `║ Trusted: ${record.isTrusted ? 'YES (browser native)' : 'NO (synthetic/script)'}`,
        '╠──────────────────────────────────────────────────────────────────────────────',
        '║ VOLUMES:',
        `║   Player native (element.volume x 100): ${record.playerVolume?.toFixed?.(1) ?? record.playerVolume}%`,
        `║   Extension target (State.currentVolumePercent): ${record.extensionVolume}%`,
        `║   Difference: ${record.volumeDiff?.toFixed?.(1) ?? record.volumeDiff}%`,
        `║   Element muted: ${record.isMuted}`,
        '╠──────────────────────────────────────────────────────────────────────────────',
        '║ MUTE OWNERSHIP:',
        `║   managedMuteState: ${record.managedMuteState}`,
        `║   muteHasBeenSet: ${record.muteHasBeenSet}`,
        `║   observedNativeMutedState: ${record.observedNativeMutedState}`,
        `║   nativeMutedSnapshot: ${record.nativeMutedSnapshot}`,
        `║   canDriveSharedState: ${record.canDriveSharedState}`,
        `║   isCorsBlocked: ${record.isCorsBlocked}`,
        '╠──────────────────────────────────────────────────────────────────────────────',
        '║ PROTECTION STATE:',
        `║   isSourceChanging: ${record.isSourceChanging}`,
        `║   isApplyingVolume: ${record.isApplyingVolume}`,
        `║   targetVolume: ${record.targetVolume}`,
        `║   inDebounceWindow: ${record.inDebounceWindow} (last ext change: ${record.msSinceExtensionChange}ms ago)`,
        `║   inHijackProtection: ${record.inHijackProtection} (last hijack reject: ${record.msSinceHijackReject}ms ago)`,
        `║   rapidChangeCount: ${record.rapidChangeCount}`,
        `║   lastTrackedPlayerVolume: ${record.lastTrackedPlayerVolume}`,
        '╠──────────────────────────────────────────────────────────────────────────────',
        '║ USER INTERACTION:',
        `║   hasRecentInteraction: ${record.hasRecentInteraction}`,
        `║   interactedThisElement: ${record.interactedThisElement}`,
        `║   isMouseDown: ${record.isMouseDown}`,
        `║   isPointerDown: ${record.isPointerDown}`,
        `║   isSliderDrag: ${record.isSliderDrag}`,
        `║   msSinceLastInteraction: ${record.msSinceLastInteraction}ms`,
        `║   msSinceLastMuteToggle: ${record.msSinceLastMuteToggle}ms`,
        `║   msSinceLastAcceptedMuteInteraction: ${record.msSinceLastAcceptedMuteInteraction}ms`,
        '╠──────────────────────────────────────────────────────────────────────────────',
        '║ CONTEXT:',
        `║   pageHidden: ${record.pageHidden}`,
        `║   isVisible: ${record.isVisible}`,
        `║   hasGainNode: ${record.hasGainNode}`,
        `║   setupComplete: ${record.setupComplete}`,
        `║   volumeHasBeenSet: ${record.volumeHasBeenSet}`,
        `║   frame: ${record.frame}`,
        '╠──────────────────────────────────────────────────────────────────────────────',
        `║ DECISION: ${record.decision?.type || 'unknown'}`,
        `║   Reason: ${record.decision?.reason || 'none'}`,
        `║   shouldProcess: ${record.decision?.shouldProcess}`,
        `║   rejectAndReapply: ${record.decision?.rejectAndReapply}`,
        `║   muteStateChanged: ${record.decision?.muteStateChanged}`,
        `║   reapplyMute: ${record.decision?.reapplyMute}`,
        `║   reapplyMuteState: ${record.decision?.reapplyMuteState}`,
        '╚══════════════════════════════════════════════════════════════════════════════',
        ''
    ];

    console.log(lines.join('\n'));
};

window.VolumeControl.logVolumeApply = function(data) {
    if (getDebugLevel() < 3) return;

    const eventId = nextEventId();
    const ts = getTimestamp();
    rememberDiagnostic('volume-apply', data, { eventId, timestamp: ts });

    const lines = [
        '',
        '┌─────────────────────────────────────────────────────────────────────────────',
        `│ APPLYING VOLUME #${eventId} @ ${ts}`,
        '├─────────────────────────────────────────────────────────────────────────────',
        `│ Source: ${data.source || 'unknown'}`,
        `│ Element: ${data.elementInfo || 'unknown'}`,
        `│ Target Volume: ${data.targetVolume}%`,
        `│ Previous Volume: ${data.previousVolume}%`,
        `│ Method: ${data.method || 'applyVolume'}`,
        `│ Force: ${data.force || false}`,
        `│ Will set element.volume: ${data.willSetNativeVolume !== false}`,
        `│ Gain multiplier: ${data.gainMultiplier?.toFixed?.(3) || data.gainMultiplier || 'N/A'}`,
        '└─────────────────────────────────────────────────────────────────────────────',
        ''
    ];

    console.log(lines.join('\n'));
};

window.VolumeControl.logSourceChange = function(data) {
    if (getDebugLevel() < 3) return;

    const eventId = nextEventId();
    const ts = getTimestamp();
    rememberDiagnostic('source-change', data, { eventId, timestamp: ts });

    const lines = [
        '',
        '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `┃ SOURCE CHANGE #${eventId} @ ${ts}`,
        '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `┃ Phase: ${data.phase || 'unknown'}`,
        `┃ Element: ${data.elementInfo || 'unknown'}`,
        `┃ Trigger: ${data.trigger || 'unknown'}`,
        `┃ Current extension volume: ${data.extensionVolume}%`,
        `┃ Current player volume: ${data.playerVolume}%`,
        `┃ Source type: ${data.sourceType || 'unknown'}`,
        '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ''
    ];

    console.log(lines.join('\n'));
};

function buildGlobalStateSnapshot(State) {
    return {
        extensionEnabled: State?.extensionEnabled !== false,
        currentVolumePercent: State?.currentVolumePercent,
        volumeHasBeenSet: Boolean(State?.volumeHasBeenSet),
        currentMutedState: Boolean(State?.currentMutedState),
        muteHasBeenSet: Boolean(State?.muteHasBeenSet),
        currentMonoEnabled: Boolean(State?.currentMonoEnabled),
        currentBalance: State?.currentBalance,
        localBalance: State?.localBalance,
        defaultBalanceEnabled: Boolean(State?.defaultBalanceEnabled),
        defaultBalance: State?.defaultBalance,
        currentCompressionEnabled: Boolean(State?.currentCompressionEnabled),
        currentCompressionThreshold: State?.currentCompressionThreshold,
        currentCompressionRatio: State?.currentCompressionRatio,
        currentCompressionKnee: State?.currentCompressionKnee
    };
}

function buildTrackedElementSnapshot(element, stateData, stateManager, syncManager) {
    const syncState = typeof syncManager?._getSyncState === 'function'
        ? syncManager._getSyncState(element)
        : null;
    const elementInfo = `${element?.tagName || 'UNKNOWN'}#${element?.id || 'no-id'}`;

    return {
        elementInfo,
        state: stateData?.state || 'unknown',
        active: Boolean(stateData?.isActive?.()),
        corsBlocked: Boolean(stateManager?.isCorsBlocked?.(element)),
        sourceType: stateData?.sourceType || null,
        lastKnownSrc: stateData?.lastKnownSrc || null,
        passthroughMode: Boolean(stateData?.passthroughMode),
        hasGainNode: Boolean(stateData?.gainNode),
        hasSource: Boolean(stateData?.source),
        playback: {
            connected: Boolean(element?.isConnected),
            paused: Boolean(element?.paused),
            ended: Boolean(element?.ended),
            seeking: Boolean(element?.seeking),
            readyState: Number(element?.readyState ?? 0),
            currentTime: Number.isFinite(Number(element?.currentTime)) ? Number(element.currentTime) : null,
            duration: Number.isFinite(Number(element?.duration)) ? Number(element.duration) : null,
            isIntersecting: stateData?.isIntersecting !== false
        },
        nativeState: {
            elementVolume: toPercent(element?.volume),
            elementMuted: Boolean(element?.muted),
            observedNativeVolume: toPercent(stateData?.observedNativeVolume),
            observedNativeMutedState: stateData?.observedNativeMutedState,
            nativeVolumeSnapshot: toPercent(stateData?.nativeVolumeSnapshot),
            nativeMutedSnapshot: stateData?.nativeMutedSnapshot,
            managedMutedState: stateData?.managedMutedState,
            userOriginalVolume: toPercent(stateData?.userOriginalVolume),
            userOriginalMutedState: stateData?.userOriginalMutedState,
            lastAppliedVolume: stateData?.lastAppliedVolume ?? null
        },
        verification: {
            needsConnectionVerification: Boolean(stateData?.needsConnectionVerification),
            consecutiveVerificationFailures: stateData?.consecutiveVerificationFailures ?? 0,
            lastObservedCurrentTime: Number.isFinite(Number(stateData?.lastObservedCurrentTime))
                ? Number(stateData.lastObservedCurrentTime)
                : null,
            lastVerifiedAudioAgeMs: ageMs(stateData?.lastVerifiedAudioAt),
            detachedSinceAgeMs: ageMs(stateData?.detachedSinceAt)
        },
        sync: syncState
            ? {
                isApplyingVolume: Boolean(syncState.isApplyingVolume),
                targetVolume: syncState.targetVolume,
                isSourceChanging: Boolean(syncState.isSourceChanging),
                sourceChangeEpoch: syncState.sourceChangeEpoch,
                rapidChangeCount: syncState.rapidChangeCount ?? 0,
                lastTrackedPlayerVolume: syncState.lastTrackedPlayerVolume,
                wasRecentlyHidden: Boolean(syncState.wasRecentlyHidden),
                lastVisibilityChangeAgeMs: ageMs(syncState.lastVisibilityChangeAt),
                lastExtensionChangeAgeMs: ageMs(syncState.lastExtensionChangeAt),
                lastHijackRejectedAgeMs: ageMs(syncState.lastHijackRejectedAt),
                lastMuteToggleAgeMs: ageMs(syncState.lastMuteToggleAt),
                lastAcceptedMuteInteractionAgeMs: ageMs(syncState.lastAcceptedMuteInteractionAt),
                handlerEpoch: syncState.handlerEpoch
            }
            : null
    };
}

function buildDiagnosticsSnapshot() {
    const State = window.VolumeControl.State;
    const syncManager = window.VolumeControl.volumeSyncManager;
    const stateManager = window.VolumeControl.elementStateManager;
    const trackedElements = [];

    if (stateManager?.elements) {
        stateManager.elements.forEach((stateData, element) => {
            trackedElements.push(buildTrackedElementSnapshot(element, stateData, stateManager, syncManager));
        });
    }

    return {
        meta: {
            timestamp: getTimestamp(),
            frame: FRAME_DESCRIPTOR,
            location: describeLocation(),
            debugLevel: getDebugLevel(),
            trackedElementCount: trackedElements.length,
            recentVolumeEventCount: recentVolumeEvents.length,
            recentDiagnosticCount: recentDiagnostics.length
        },
        state: buildGlobalStateSnapshot(State),
        trackedElements,
        recentVolumeEvents: recentVolumeEvents.map((record) => serializeDiagnosticValue(record)),
        recentDiagnostics: recentDiagnostics.map((record) => serializeDiagnosticValue(record))
    };
}

window.VolumeControl.exportDiagnostics = function() {
    return buildDiagnosticsSnapshot();
};

window.VolumeControl.dumpState = function() {
    const snapshot = buildDiagnosticsSnapshot();

    const lines = [
        '',
        '╔══════════════════════════════════════════════════════════════════════════════',
        `║ STATE DUMP @ ${snapshot.meta.timestamp}`,
        '╠══════════════════════════════════════════════════════════════════════════════',
        `║ Frame: ${snapshot.meta.frame}`,
        `║ Location: ${snapshot.meta.location}`,
        `║ Debug level: ${snapshot.meta.debugLevel}`,
        '╠──────────────────────────────────────────────────────────────────────────────',
        '║ GLOBAL STATE:',
        `║   extensionEnabled: ${snapshot.state.extensionEnabled}`,
        `║   currentVolumePercent: ${snapshot.state.currentVolumePercent}`,
        `║   volumeHasBeenSet: ${snapshot.state.volumeHasBeenSet}`,
        `║   currentMutedState: ${snapshot.state.currentMutedState}`,
        `║   muteHasBeenSet: ${snapshot.state.muteHasBeenSet}`,
        `║   currentMonoEnabled: ${snapshot.state.currentMonoEnabled}`,
        `║   currentBalance: ${snapshot.state.currentBalance}`,
        `║   currentCompressionEnabled: ${snapshot.state.currentCompressionEnabled}`,
        '╠──────────────────────────────────────────────────────────────────────────────',
        `║ TRACKED ELEMENTS (${snapshot.trackedElements.length}):`
    ];

    snapshot.trackedElements.forEach((entry) => {
        lines.push(`║   ${entry.elementInfo}:`);
        lines.push(`║     state=${entry.state}, active=${entry.active}, corsBlocked=${entry.corsBlocked}, passthrough=${entry.passthroughMode}, sourceType=${entry.sourceType || 'none'}`);
        lines.push(`║     native volume=${entry.nativeState.elementVolume}%, muted=${entry.nativeState.elementMuted}, observed=${entry.nativeState.observedNativeVolume}%/${entry.nativeState.observedNativeMutedState}, managedMute=${entry.nativeState.managedMutedState}, snapshot=${entry.nativeState.nativeVolumeSnapshot}%/${entry.nativeState.nativeMutedSnapshot}`);
        lines.push(`║     playback paused=${entry.playback.paused}, readyState=${entry.playback.readyState}, currentTime=${entry.playback.currentTime}, visible=${entry.playback.isIntersecting}`);
        lines.push(`║     verification needsRepair=${entry.verification.needsConnectionVerification}, failures=${entry.verification.consecutiveVerificationFailures}, lastVerifiedAudioAgeMs=${entry.verification.lastVerifiedAudioAgeMs}`);
        lines.push(`║     sync applying=${entry.sync?.isApplyingVolume}, targetVolume=${entry.sync?.targetVolume}, sourceChanging=${entry.sync?.isSourceChanging}, rapidChangeCount=${entry.sync?.rapidChangeCount}, lastRejectAgeMs=${entry.sync?.lastHijackRejectedAgeMs}`);
    });

    lines.push('╠──────────────────────────────────────────────────────────────────────────────');
    lines.push(`║ RECENT DIAGNOSTICS (last ${Math.min(snapshot.recentDiagnostics.length, 10)}):`);
    snapshot.recentDiagnostics.slice(-10).forEach((entry) => {
        lines.push(`║   #${entry.eventId}: ${entry.category} - ${(entry.reason || entry.decisionType || entry.phase || '').toString().substring(0, 70)}`);
    });
    lines.push('╚══════════════════════════════════════════════════════════════════════════════');
    lines.push('');

    console.log(lines.join('\n'));
    return snapshot;
};

window.VolumeControl.FRAME_DESCRIPTOR = FRAME_DESCRIPTOR;
window.VolumeControl.getDebugLevel = getDebugLevel;
window.VolumeControl.setDebugLevel = (level, options = {}) => updateDebugLevel(level, {
    persist: options.persist !== false,
    announce: options.announce !== false
});
window.VolumeControl.DEBUG_LEVEL_STORAGE_KEY = DEBUG_LEVEL_STORAGE_KEY;

Object.defineProperty(window.VolumeControl, 'DEBUG_LEVEL', {
    configurable: true,
    enumerable: true,
    get() {
        return getDebugLevel();
    },
    set(value) {
        updateDebugLevel(value, { persist: true, announce: true });
    }
});

window.vcDump = window.VolumeControl.dumpState;
window.vcEvents = () => recentVolumeEvents.slice();
window.vcDiagnostics = () => recentDiagnostics.slice();
window.vcExportDiagnostics = window.VolumeControl.exportDiagnostics;
window.vcSetDebugLevel = (level) => updateDebugLevel(level, { persist: true, announce: true });
window.vcEnableLogs = (level = DEFAULT_DEBUG_LEVEL) => updateDebugLevel(level, { persist: true, announce: true });
window.vcDisableLogs = () => updateDebugLevel(1, { persist: true, announce: true });

loadPersistedDebugLevel();
listenForDebugLevelChanges();