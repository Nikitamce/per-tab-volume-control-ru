/**
 * Background script
 * Handles extension icon updates with real-time volume badge display.
 * Also tracks tabs with active audio for cross-tab volume control.
 */

const Protocol = globalThis.VCProtocol;
const { Messages, PreferenceKeys } = Protocol;

// ============================================
// Constants - Centralized for consistency
// ============================================
const CONSTANTS = {
    ...Protocol.CONSTANTS,
    
    // State Persistence
    STATE_STORAGE_KEY: 'tabStateCacheV1',
    STATE_PERSIST_DEBOUNCE_MS: 400,
    
    // Icon
    BADGE_DEBOUNCE_MS: 50,
    MAX_ICON_CACHE_SIZE: 50,
    
    // State Hydration
    HYDRATE_TTL_MS: 30_000,
    RECENT_MEDIA_TTL_MS: 3 * 60_000  // 3 minutes
};

// Track state per tab (volume, status, tab info)
const tabState = new Map();

// Persist minimal state so icon stays accurate across MV3 background-context restarts.
// Prefer session storage when available; fall back to local.
const storageArea = (browser?.storage?.session) ? browser.storage.session : browser.storage.local;
let persistTimer = null;
const persistDirtyTabIds = new Set();
const LEGACY_PREFERENCE_STORAGE_KEYS = [
    'rememberCompressionBySite',
    'rememberMonoBySite',
    'rememberBalanceBySite',
    'siteAudioPreferences'
];

async function cleanupLegacyPreferenceStorage() {
    try {
        await browser.storage.local.remove(LEGACY_PREFERENCE_STORAGE_KEYS);
    } catch {
        // ignore cleanup errors - legacy keys are optional
    }
}

function serializeTabStateForStorage(state) {
    if (!state) return null;
    return {
        volume: normalizeVolume(state.volume, CONSTANTS.DEFAULT_VOLUME),
        extensionEnabled: typeof state.extensionEnabled === 'boolean' ? state.extensionEnabled : true,
        monoEnabled: Boolean(state.monoEnabled),
        balance: Protocol.normalizeBalance(state.balance, CONSTANTS.DEFAULT_BALANCE),
        corsAffectedCount: normalizeCorsCount(state.corsAffectedCount),
        muted: Boolean(state.muted),
        volumeBeforeMute: state.volumeBeforeMute,
        compressionEnabled: Boolean(state.compressionEnabled),
        compressionThreshold: (typeof state.compressionThreshold === 'number') ? state.compressionThreshold : CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD,
        compressionRatio: (typeof state.compressionRatio === 'number') ? state.compressionRatio : CONSTANTS.DEFAULT_COMPRESSION_RATIO,
        compressionKnee: (typeof state.compressionKnee === 'number') ? state.compressionKnee : CONSTANTS.DEFAULT_COMPRESSION_KNEE,
        audioSettingsAvailable: typeof state.audioSettingsAvailable === 'boolean' ? state.audioSettingsAvailable : true,
        audioSettingsReason: state.audioSettingsReason ?? null,
        statusDetail: state.statusDetail ?? null,
        lastSeenAt: (typeof state.lastSeenAt === 'number') ? state.lastSeenAt : Date.now(),
        lastMediaSeenAt: (typeof state.lastMediaSeenAt === 'number') ? state.lastMediaSeenAt : undefined,
        hasMedia: Boolean(state.hasMedia),
        status: state.status
    };
}

function schedulePersistTabState(tabId) {
    if (!tabId) return;
    persistDirtyTabIds.add(String(tabId));
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        flushPersistedTabState().catch(() => {});
    }, CONSTANTS.STATE_PERSIST_DEBOUNCE_MS);
}

async function flushPersistedTabState() {
    if (persistDirtyTabIds.size === 0) return;

    const dirty = Array.from(persistDirtyTabIds);
    persistDirtyTabIds.clear();

    const existing = (await storageArea.get(CONSTANTS.STATE_STORAGE_KEY))[CONSTANTS.STATE_STORAGE_KEY] || {};
    for (const id of dirty) {
        const tabId = Number(id);
        const state = tabState.get(tabId);
        if (state) {
            existing[id] = serializeTabStateForStorage(state);
        } else {
            delete existing[id];
        }
    }

    await storageArea.set({ [CONSTANTS.STATE_STORAGE_KEY]: existing });
}

async function removePersistedTabState(tabId) {
    try {
        const key = String(tabId);
        const existing = (await storageArea.get(CONSTANTS.STATE_STORAGE_KEY))[CONSTANTS.STATE_STORAGE_KEY] || {};
        if (Object.prototype.hasOwnProperty.call(existing, key)) {
            delete existing[key];
            await storageArea.set({ [CONSTANTS.STATE_STORAGE_KEY]: existing });
        }
    } catch {
        // ignore
    }
}

async function restoreTabStateFromStorage() {
    const stored = (await storageArea.get(CONSTANTS.STATE_STORAGE_KEY))[CONSTANTS.STATE_STORAGE_KEY] || {};
    const tabs = await browser.tabs.query({});
    const openIds = new Set(tabs.filter(t => t?.id).map(t => String(t.id)));

    // Prune stored entries for closed tabs
    let changed = false;
    for (const key of Object.keys(stored)) {
        if (!openIds.has(key)) {
            delete stored[key];
            changed = true;
        }
    }

    // Seed in-memory state
    for (const tab of tabs) {
        if (!tab?.id) continue;
        const key = String(tab.id);
        const prev = tabState.get(tab.id) || {};
        const persisted = stored[key];
        if (!persisted) continue;

        tabState.set(tab.id, {
            ...prev,
            ...persisted,
            title: tab.title || prev.title || 'Unknown Tab',
            favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
            url: tab.url || prev.url || '',
            windowId: tab.windowId
        });
    }

    if (changed) {
        await storageArea.set({ [CONSTANTS.STATE_STORAGE_KEY]: stored });
    }
}

async function getFrameStatusPayloads(tabId) {
    const results = await browser.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
            try {
                return window.__volumeControlExtension__?.getCurrentStatus?.() || null;
            } catch {
                return null;
            }
        }
    });

    return (results || [])
        .map((result) => ({
            frameId: typeof result?.frameId === 'number' ? result.frameId : 0,
            payload: result?.result
        }))
        .filter((result) => Boolean(result.payload));
}

async function installPageMediaBridge(tabId, frameId) {
    if (!tabId || typeof frameId !== 'number') {
        return false;
    }

    const results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        injectImmediately: true,
        files: ['content_scripts/page/media_play_bridge.js']
    });

    return (results || []).some((result) => result?.result?.installed === true || result?.result?.alreadyInstalled === true);
}

function mergeFrameStatusPayloads(framePayloads) {
    const defaults = {
        status: 'no-media',
        statusDetail: null,
        volume: CONSTANTS.DEFAULT_VOLUME,
        extensionEnabled: true,
        muted: false,
        corsAffectedCount: 0,
        monoEnabled: CONSTANTS.DEFAULT_MONO_ENABLED,
        balance: CONSTANTS.DEFAULT_BALANCE,
        compressionEnabled: false,
        compressionThreshold: CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD,
        compressionRatio: CONSTANTS.DEFAULT_COMPRESSION_RATIO,
        compressionKnee: CONSTANTS.DEFAULT_COMPRESSION_KNEE,
        audioSettingsAvailable: true,
        audioSettingsReason: null,
        elementCounts: { total: 0 }
    };
    return Protocol.mergeStatusPayloads(framePayloads, defaults);
}

const frameStatusCache = new Map();

function mergeCachedFrameStatusPayload(tabId, frameId, framePayload) {
    let frameMap = frameStatusCache.get(tabId);
    if (!frameMap) {
        frameMap = new Map();
        frameStatusCache.set(tabId, frameMap);
    }

    frameMap.set(frameId, framePayload);
    return mergeFrameStatusPayloads(Array.from(frameMap.values()));
}

function replaceCachedFrameStatusPayloads(tabId, framePayloads) {
    const frameMap = new Map();
    (framePayloads || []).forEach((framePayload, index) => {
        const frameId = typeof framePayload?.frameId === 'number' ? framePayload.frameId : index;
        frameMap.set(frameId, framePayload?.payload ?? framePayload);
    });
    frameStatusCache.set(tabId, frameMap);
}

function clearCachedFrameStatusPayloads(tabId) {
    frameStatusCache.delete(tabId);
}

function mergedStatusHasMedia(merged) {
    return Protocol.statusPayloadHasMedia(merged);
}

function getNextLastMediaSeenAt(previousState, hasMedia, status) {
    if (!hasMedia) {
        return previousState?.lastMediaSeenAt;
    }

    if (typeof previousState?.lastMediaSeenAt !== 'number') {
        return Date.now();
    }

    if (!previousState?.hasMedia) {
        return Date.now();
    }

    if (status === 'active' && previousState.status !== 'active') {
        return Date.now();
    }

    return previousState.lastMediaSeenAt;
}

async function probeTabStatus(tabId) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab?.id) return null;
    if (!tab.url || !/^(https?|file):/i.test(tab.url)) return null;

    try {
        const framePayloads = await getFrameStatusPayloads(tab.id);
        if (framePayloads.length === 0) return null;
        replaceCachedFrameStatusPayloads(tab.id, framePayloads);
        const merged = mergeFrameStatusPayloads(framePayloads);
        const hasMedia = mergedStatusHasMedia(merged);
        const nextVolume = normalizeVolume(merged.volume, CONSTANTS.DEFAULT_VOLUME);
        const nextCors = normalizeCorsCount(merged.corsAffectedCount);

        const prev = tabState.get(tab.id) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        tabState.set(tab.id, {
            ...prev,
            title: tab.title || prev.title || 'Unknown Tab',
            favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
            url: tab.url || prev.url || '',
            windowId: tab.windowId,
            volume: nextVolume,
            extensionEnabled: merged.extensionEnabled ?? prev.extensionEnabled ?? true,
            muted: merged.muted ?? prev.muted ?? false,
            monoEnabled: merged.monoEnabled ?? prev.monoEnabled,
            balance: merged.balance ?? prev.balance,
            corsAffectedCount: nextCors,
            status: merged.status,
            statusDetail: merged.statusDetail ?? prev.statusDetail ?? null,
            hasMedia,
            compressionEnabled: merged.compressionEnabled ?? prev.compressionEnabled,
            compressionThreshold: merged.compressionThreshold ?? prev.compressionThreshold,
            compressionRatio: merged.compressionRatio ?? prev.compressionRatio,
            compressionKnee: merged.compressionKnee ?? prev.compressionKnee,
            audioSettingsAvailable: merged.audioSettingsAvailable ?? prev.audioSettingsAvailable ?? true,
            audioSettingsReason: merged.audioSettingsReason ?? prev.audioSettingsReason ?? null,
            lastMediaSeenAt: getNextLastMediaSeenAt(prev, hasMedia, merged.status),
            lastSeenAt: Date.now()
        });

        schedulePersistTabState(tab.id);

        // Keep icon in sync for the active tab.
        updateIcon(tab.id, nextVolume, nextCors, { showDefault: true });
        return merged;
    } catch {
        return null;
    }
}

function getTabStatusPayloadFromState(state) {
    return Protocol.normalizeStatusPayload({
        status: state?.status || 'inactive',
        statusDetail: state?.statusDetail ?? null,
        volume: state?.volume ?? CONSTANTS.DEFAULT_VOLUME,
        extensionEnabled: state?.extensionEnabled ?? true,
        muted: state?.muted ?? false,
        monoEnabled: state?.monoEnabled ?? CONSTANTS.DEFAULT_MONO_ENABLED,
        balance: state?.balance ?? CONSTANTS.DEFAULT_BALANCE,
        compressionEnabled: state?.compressionEnabled ?? false,
        compressionThreshold: state?.compressionThreshold ?? CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD,
        compressionRatio: state?.compressionRatio ?? CONSTANTS.DEFAULT_COMPRESSION_RATIO,
        compressionKnee: state?.compressionKnee ?? CONSTANTS.DEFAULT_COMPRESSION_KNEE,
        audioSettingsAvailable: state?.audioSettingsAvailable ?? true,
        audioSettingsReason: state?.audioSettingsReason ?? null,
        corsAffectedCount: state?.corsAffectedCount ?? 0,
        elementCounts: state?.hasMedia ? { total: 1 } : { total: 0 }
    });
}

async function getTabStatus(tabId, options = {}) {
    if (!tabId) {
        return getTabStatusPayloadFromState(null);
    }

    const forceProbe = Boolean(options.forceProbe);
    const probedPayload = forceProbe ? await probeTabStatus(tabId).catch(() => null) : null;
    if (probedPayload) {
        return Protocol.normalizeStatusPayload(probedPayload, getTabStatusPayloadFromState(tabState.get(tabId)));
    }

    return getTabStatusPayloadFromState(tabState.get(tabId));
}

const DEFAULT_ICON_PATHS = Object.freeze({
    16: 'icons/app-icon-16.png',
    32: 'icons/app-icon-32.png',
    48: 'icons/app-icon-48.png',
    128: 'icons/app-icon-128.png'
});

const NATIVE_BADGE_STYLE = Object.freeze({
    activeBackgroundColor: '#185abc',
    mutedBackgroundColor: '#d93025',
    disabledBackgroundColor: '#7b8390',
    textColor: '#ffffff'
});

// Debounce timers per tab for badge updates
const badgeUpdateTimers = new Map();
const probeTimers = new Map();

function normalizeVolume(value, fallback = CONSTANTS.DEFAULT_VOLUME) {
    return Protocol.normalizeVolume(value, fallback);
}

function normalizeCorsCount(value) {
    return Protocol.normalizeCorsCount(value);
}

function getDisplayedVolumeForState(state, fallback = CONSTANTS.DEFAULT_VOLUME) {
    if (!state) {
        return normalizeVolume(fallback, CONSTANTS.DEFAULT_VOLUME);
    }

    const rawVolume = state.muted
        ? (state.volumeBeforeMute ?? state.volume ?? fallback)
        : (state.volume ?? fallback);

    return normalizeVolume(rawVolume, CONSTANTS.DEFAULT_VOLUME);
}

function formatBadgeText(volume, showDefault = false) {
    const safeVolume = normalizeVolume(volume, CONSTANTS.DEFAULT_VOLUME);
    if (safeVolume === CONSTANTS.DEFAULT_VOLUME && !showDefault) {
        return '';
    }

    return String(Math.round(safeVolume));
}

function getBadgeBackgroundColor(tabId) {
    const state = tabState.get(tabId);
    if (state?.extensionEnabled === false) {
        return NATIVE_BADGE_STYLE.disabledBackgroundColor;
    }
    const showMutedBadge = Boolean(state?.muted) && state?.extensionEnabled !== false;
    return showMutedBadge
        ? NATIVE_BADGE_STYLE.mutedBackgroundColor
        : NATIVE_BADGE_STYLE.activeBackgroundColor;
}

/**
 * Update the extension icon for a specific tab
 * @param {number} tabId - The tab ID
 * @param {number} volume - Current volume percentage
 * @param {number} corsCount - Number of CORS-blocked elements
 */
async function updateIcon(tabId, volume, corsCount, options = {}) {
    try {
        const state = tabState.get(tabId);
        const safeVolume = normalizeVolume(volume, CONSTANTS.DEFAULT_VOLUME);
        const displayVolume = getDisplayedVolumeForState(state, safeVolume);
        const safeCors = normalizeCorsCount(corsCount);
        const badgeText = formatBadgeText(displayVolume, Boolean(options.showDefault));
        const badgeBackgroundColor = getBadgeBackgroundColor(tabId);
        await browser.action.setIcon({
            path: DEFAULT_ICON_PATHS,
            tabId: tabId
        });

        await browser.action.setBadgeBackgroundColor({
            color: badgeBackgroundColor,
            tabId: tabId
        });

        if (typeof browser.action.setBadgeTextColor === 'function') {
            await browser.action.setBadgeTextColor({
                color: NATIVE_BADGE_STYLE.textColor,
                tabId: tabId
            });
        }

        await browser.action.setBadgeText({
            text: badgeText,
            tabId: tabId
        });
        
        // Update tooltip
        let title = `Per-Tab Volume Control: ${Math.round(displayVolume)}%`;
        if (state?.muted && state?.extensionEnabled !== false) {
            title += ' (muted)';
        }
        // Only show the native-only warning when it actually matters to the user (boost > 100%)
        if (safeCors > 0 && displayVolume > CONSTANTS.DEFAULT_VOLUME) {
            title += `\n⚠️ ${safeCors} CORS-limited media element${safeCors > 1 ? 's are' : ' is'} using native-only fallback`;
        }
        browser.action.setTitle({
            title: title,
            tabId: tabId
        });
    } catch (error) {
        // Ignore expected tab lifecycle/permission errors.
        const isExpectedError = error.message?.includes('Invalid tab ID') ||
                                error.message?.includes('No tab with id') ||
                                error.message?.includes('Missing host permission');
        if (!isExpectedError) {
            console.error("Failed to update icon:", error);
        }
    }
}

/**
 * Debounced icon update to prevent rapid flickering during slider drag
 */
function debouncedUpdateIcon(tabId, volume, corsCount) {
    // Clear existing timer for this tab
    if (badgeUpdateTimers.has(tabId)) {
        clearTimeout(badgeUpdateTimers.get(tabId));
    }
    
    // Set new timer
    const timer = setTimeout(() => {
        badgeUpdateTimers.delete(tabId);
        const state = tabState.get(tabId);
        const showDefault = Boolean(state && (state.hasMedia === true || typeof state.lastSeenAt === 'number'));
        updateIcon(tabId, volume, corsCount, { showDefault });
    }, CONSTANTS.BADGE_DEBOUNCE_MS);
    
    badgeUpdateTimers.set(tabId, timer);
}

function scheduleProbeTabStatus(tabId, delayMs = 120) {
    if (!tabId) {
        return;
    }

    if (probeTimers.has(tabId)) {
        clearTimeout(probeTimers.get(tabId));
    }

    const timer = setTimeout(() => {
        probeTimers.delete(tabId);
        probeTabStatus(tabId).catch(() => false);
    }, delayMs);

    probeTimers.set(tabId, timer);
}

/**
 * Update tab info (title, favicon, url) for a tab
 * @param {number} tabId - The tab ID
 */
async function updateTabInfo(tabId) {
    try {
        const tab = await browser.tabs.get(tabId);
        const state = tabState.get(tabId);
        if (state && tab) {
            state.title = tab.title || 'Unknown Tab';
            state.favIconUrl = tab.favIconUrl || '';
            state.url = tab.url || '';
            state.windowId = tab.windowId;
            tabState.set(tabId, state);
        }
    } catch (error) {
        // Tab might have been closed
        if (!error.message?.includes('Invalid tab ID')) {
            console.error("Failed to get tab info:", error);
        }
    }
}

/**
 * Get all tabs with audio (status === 'active' OR 'inactive' with media)
 * @param {number} excludeTabId - Tab ID to exclude (usually the current tab)
 * @returns {Array} Array of tab info objects
 */
async function getTabsWithAudio(excludeTabId = null) {
    const tabsWithAudio = [];

    const included = new Set();
    
    tabState.forEach((state, tabId) => {
        // Exclude the specified tab and include tabs with audio activity
        // Include active tabs and any tab we've observed to have media (covers 'inactive' and 'error' too)
        const hasRecentMedia = state?.lastMediaSeenAt && (Date.now() - state.lastMediaSeenAt) < CONSTANTS.RECENT_MEDIA_TTL_MS;
        const hasAudioActivity = state.status === 'active' || state.hasMedia === true || hasRecentMedia;
        
        if (tabId !== excludeTabId && hasAudioActivity) {
            tabsWithAudio.push(Protocol.normalizeAudioTab({
                tabId: tabId,
                title: state.title || 'Unknown Tab',
                favIconUrl: state.favIconUrl || '',
                url: state.url || '',
                volume: state.volume ?? CONSTANTS.DEFAULT_VOLUME,
                extensionEnabled: state.extensionEnabled ?? true,
                monoEnabled: state.monoEnabled ?? CONSTANTS.DEFAULT_MONO_ENABLED,
                balance: state.balance ?? CONSTANTS.DEFAULT_BALANCE,
                muted: state.muted ?? false,
                volumeBeforeMute: state.volumeBeforeMute,
                compressionEnabled: state.compressionEnabled ?? false,
                compressionThreshold: state.compressionThreshold ?? CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD,
                compressionRatio: state.compressionRatio ?? CONSTANTS.DEFAULT_COMPRESSION_RATIO,
                compressionKnee: state.compressionKnee ?? CONSTANTS.DEFAULT_COMPRESSION_KNEE,
                corsAffectedCount: state.corsAffectedCount ?? 0,
                lastMediaSeenAt: state.lastMediaSeenAt,
                windowId: state.windowId,
                status: state.status
            }));

            included.add(tabId);
        }
    });

    // Fallback: include currently-audible tabs even if tabState is missing/stale
    try {
        const allTabs = await browser.tabs.query({});
        for (const tab of allTabs) {
            if (!tab?.id || tab.id === excludeTabId) continue;
            if (!tab.audible) continue;
            if (included.has(tab.id)) continue;

            const state = tabState.get(tab.id) || {};
            tabsWithAudio.push(Protocol.normalizeAudioTab({
                tabId: tab.id,
                title: tab.title || state.title || 'Unknown Tab',
                favIconUrl: tab.favIconUrl || state.favIconUrl || '',
                url: tab.url || state.url || '',
                volume: state.volume ?? CONSTANTS.DEFAULT_VOLUME,
                extensionEnabled: state.extensionEnabled ?? true,
                monoEnabled: state.monoEnabled ?? CONSTANTS.DEFAULT_MONO_ENABLED,
                balance: state.balance ?? CONSTANTS.DEFAULT_BALANCE,
                muted: state.muted ?? false,
                volumeBeforeMute: state.volumeBeforeMute,
                compressionEnabled: state.compressionEnabled ?? false,
                compressionThreshold: state.compressionThreshold ?? CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD,
                compressionRatio: state.compressionRatio ?? CONSTANTS.DEFAULT_COMPRESSION_RATIO,
                compressionKnee: state.compressionKnee ?? CONSTANTS.DEFAULT_COMPRESSION_KNEE,
                corsAffectedCount: state.corsAffectedCount ?? 0,
                lastMediaSeenAt: state.lastMediaSeenAt,
                windowId: tab.windowId,
                status: state.status || 'active'
            }));

            included.add(tab.id);

            // Ensure state exists for this tab so subsequent refreshes are stable
            tabState.set(tab.id, {
                ...state,
                title: tab.title || state.title || 'Unknown Tab',
                favIconUrl: tab.favIconUrl || state.favIconUrl || '',
                url: tab.url || state.url || '',
                windowId: tab.windowId,
                hasMedia: true,
                status: state.status || 'active',
                lastSeenAt: Date.now()
            });
        }
    } catch (e) {
        console.warn('tabs.query audible fallback failed:', e);
    }
    
    // Deterministic sort by most recently seen media, then stable tab id tie-breaker.
    tabsWithAudio.sort((a, b) => {
        const aTime = a.lastMediaSeenAt || 0;
        const bTime = b.lastMediaSeenAt || 0;
        if (bTime !== aTime) return bTime - aTime;
        return a.tabId - b.tabId;
    });
    
    return tabsWithAudio;
}

function isStateStale() {
    if (tabState.size === 0) return true;
    const now = Date.now();
    let newest = 0;
    tabState.forEach((s) => {
        newest = Math.max(newest, s?.lastSeenAt || 0);
    });
    return (now - newest) > CONSTANTS.HYDRATE_TTL_MS;
}

// Process tab probes in bounded batches to reduce API pressure.
async function runInBatches(items, batchSize, asyncFn) {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(batch.map(asyncFn));
        results.push(...batchResults);
    }
    return results;
}

async function hydrateTabStateFromOpenTabs() {
    const tabs = await browser.tabs.query({});
    const now = Date.now();

    // First pass: at least capture basic tab metadata + audible hint
    for (const tab of tabs) {
        if (!tab?.id) continue;
        const prev = tabState.get(tab.id) || {};

        tabState.set(tab.id, {
            ...prev,
            title: tab.title || prev.title || 'Unknown Tab',
            favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
            url: tab.url || prev.url || '',
            windowId: tab.windowId,
            extensionEnabled: prev.extensionEnabled ?? true,
            hasMedia: prev.hasMedia === true || tab.audible === true,
            status: tab.audible ? 'active' : (prev.status || 'no-media'),
            lastSeenAt: prev.lastSeenAt || now
        });
    }

    // Second pass: rebuild via executeScript (covers iframe players).
    // Only do this when needed, because it's heavier.
    const hasAnyMedia = Array.from(tabState.values()).some(s => s?.hasMedia);
    if (hasAnyMedia) return;

    // Use bounded concurrency to avoid spikes when many tabs are open.
    const HYDRATE_BATCH_SIZE = 10;
    await runInBatches(tabs, HYDRATE_BATCH_SIZE, async (tab) => {
        if (!tab?.id) return;
        if (!tab.url || !/^(https?|file):/i.test(tab.url)) return;

        try {
            const framePayloads = await getFrameStatusPayloads(tab.id);
            if (framePayloads.length === 0) return;
            const merged = mergeFrameStatusPayloads(framePayloads);

            const prev = tabState.get(tab.id) || {};
            const hasMedia = mergedStatusHasMedia(merged);

            tabState.set(tab.id, {
                ...prev,
                volume: merged.volume ?? prev.volume ?? 100,
                extensionEnabled: merged.extensionEnabled ?? prev.extensionEnabled ?? true,
                monoEnabled: merged.monoEnabled ?? prev.monoEnabled,
                balance: merged.balance ?? prev.balance,
                corsAffectedCount: merged.corsAffectedCount ?? prev.corsAffectedCount ?? 0,
                compressionEnabled: merged.compressionEnabled ?? prev.compressionEnabled,
                compressionThreshold: merged.compressionThreshold ?? prev.compressionThreshold,
                compressionRatio: merged.compressionRatio ?? prev.compressionRatio,
                compressionKnee: merged.compressionKnee ?? prev.compressionKnee,
                audioSettingsAvailable: merged.audioSettingsAvailable ?? prev.audioSettingsAvailable ?? true,
                audioSettingsReason: merged.audioSettingsReason ?? prev.audioSettingsReason ?? null,
                hasMedia,
                status: merged.status,
                lastMediaSeenAt: getNextLastMediaSeenAt(prev, hasMedia, merged.status),
                lastSeenAt: Date.now()
            });
        } catch {
            // Ignore restricted pages or transient errors
        }
    });
}

async function hydrateMutedMediaCandidatesFromOpenTabs(limit = 15) {
    // When popup forces hydrate, also probe a small set of non-audible tabs to catch muted-but-playing media.
    const tabs = await browser.tabs.query({ currentWindow: true });
    let probed = 0;

    for (const tab of tabs) {
        if (probed >= limit) break;
        if (!tab?.id) continue;
        if (!tab.url || !/^(https?|file):/i.test(tab.url)) continue;
        if (tab.audible) continue; // already covered

        const prev = tabState.get(tab.id) || {};
        if (prev.hasMedia === true) continue;
        if (prev.lastMediaSeenAt && (Date.now() - prev.lastMediaSeenAt) < CONSTANTS.RECENT_MEDIA_TTL_MS) continue;

        try {
            const framePayloads = await getFrameStatusPayloads(tab.id);
            if (framePayloads.length === 0) continue;

            const merged = mergeFrameStatusPayloads(framePayloads);
            const hasMedia = mergedStatusHasMedia(merged);

            if (!hasMedia) continue;

            tabState.set(tab.id, {
                ...prev,
                title: tab.title || prev.title || 'Unknown Tab',
                favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
                url: tab.url || prev.url || '',
                windowId: tab.windowId,
                volume: normalizeVolume(merged.volume ?? prev.volume ?? CONSTANTS.DEFAULT_VOLUME, CONSTANTS.DEFAULT_VOLUME),
                monoEnabled: merged.monoEnabled ?? prev.monoEnabled,
                balance: merged.balance ?? prev.balance,
                corsAffectedCount: normalizeCorsCount(merged.corsAffectedCount ?? prev.corsAffectedCount ?? 0),
                audioSettingsAvailable: merged.audioSettingsAvailable ?? prev.audioSettingsAvailable ?? true,
                audioSettingsReason: merged.audioSettingsReason ?? prev.audioSettingsReason ?? null,
                hasMedia: true,
                status: merged.status,
                lastMediaSeenAt: getNextLastMediaSeenAt(prev, true, merged.status),
                lastSeenAt: Date.now()
            });

            probed++;
        } catch {
            // ignore
        }
    }
}

function computeHasAudioActivity(state) {
    return state?.status === 'active' || state?.hasMedia === true;
}

const audioStateBroadcastTimers = new Map();
function broadcastAudioStateChanged(tabId) {
    if (!tabId) return;
    if (audioStateBroadcastTimers.has(tabId)) {
        clearTimeout(audioStateBroadcastTimers.get(tabId));
    }
    const t = setTimeout(() => {
        audioStateBroadcastTimers.delete(tabId);
        browser.runtime.sendMessage({
            type: Messages.TAB_AUDIO_STATE_CHANGED,
            payload: { tabId }
        }).catch(() => {});
    }, 100);
    audioStateBroadcastTimers.set(tabId, t);
}

/**
 * Send volume command to a specific tab
 * @param {number} tabId - Target tab ID
 * @param {number} volume - Volume percentage (0-500)
 */
async function setVolumeForTab(tabId, volume) {
    try {
        const safeVolume = normalizeVolume(volume, CONSTANTS.DEFAULT_VOLUME);

        // Update local state first
        const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        state.volume = safeVolume;
        if (state.muted) {
            state.volumeBeforeMute = safeVolume;
        }
        tabState.set(tabId, state);

        schedulePersistTabState(tabId);
        
        // Update icon
        debouncedUpdateIcon(tabId, safeVolume, state.corsAffectedCount);

        // Send volume to content scripts.
        // Prefer runtime messaging (reliably reaches the extension content-script context).
        // Keep executeScript as a fallback for environments where messaging fails.
        const payload = {
            requestedVolume: safeVolume,
            source: 'background:remote-tab-control',
            issuedAt: Date.now()
        };

        try {
            await browser.tabs.sendMessage(tabId, {
                type: Messages.SET_VOLUME,
                payload
            });
        } catch {
            // Fallback: attempt a direct injection call (may be required on some pages).
            await browser.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                func: (injectedPayload) => {
                    if (window.__volumeControlExtension__ && typeof window.__volumeControlExtension__.setVolume === 'function') {
                        window.__volumeControlExtension__.setVolume(injectedPayload);
                    }
                },
                args: [payload]
            });
        }

        broadcastAudioStateChanged(tabId);
        
        return { success: true };
    } catch (error) {
        console.error(`Failed to set volume for tab ${tabId}:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * Send compression settings to a specific tab
 * @param {number} tabId - Target tab ID
 * @param {Object} settings - Compression settings { enabled, threshold, ratio, knee }
 */
async function setCompressionForTab(tabId, settings) {
    try {
        const normalizedSettings = Protocol.normalizeCompressionSettings(settings);

        // Update local state first
        const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        state.compressionEnabled = normalizedSettings.enabled;
        state.compressionThreshold = normalizedSettings.threshold;
        state.compressionRatio = normalizedSettings.ratio;
        state.compressionKnee = normalizedSettings.knee;
        tabState.set(tabId, state);

        schedulePersistTabState(tabId);

        // Send compression settings to content scripts.
        // Prefer runtime messaging; keep executeScript as a fallback.
        try {
            await browser.tabs.sendMessage(tabId, {
                type: Messages.SET_COMPRESSION,
                payload: normalizedSettings
            });
        } catch {
            await browser.scripting.executeScript({
                target: { tabId: tabId, allFrames: true },
                func: (compressionSettings) => {
                    if (window.__volumeControlExtension__ && typeof window.__volumeControlExtension__.setCompressionSettings === 'function') {
                        window.__volumeControlExtension__.setCompressionSettings(compressionSettings);
                    }
                },
                args: [normalizedSettings]
            });
        }

        broadcastAudioStateChanged(tabId);
        
        return { success: true };
    } catch (error) {
        console.error(`Failed to set compression for tab ${tabId}:`, error);
        return { success: false, error: error.message };
    }
}

async function setGlobalBalanceForTab(tabId, settings) {
    try {
        const normalizedSettings = Protocol.normalizeGlobalBalanceSettings(settings);

        try {
            await browser.tabs.sendMessage(tabId, {
                type: Messages.SET_GLOBAL_BALANCE,
                payload: normalizedSettings
            });
        } catch {
            await browser.scripting.executeScript({
                target: { tabId, allFrames: true },
                func: (globalBalanceSettings) => {
                    if (window.__volumeControlExtension__ && typeof window.__volumeControlExtension__.setGlobalBalance === 'function') {
                        window.__volumeControlExtension__.setGlobalBalance(globalBalanceSettings);
                    }
                },
                args: [normalizedSettings]
            });
        }

        broadcastAudioStateChanged(tabId);
        return { success: true };
    } catch (error) {
        const isExpectedError = error?.message?.includes('Missing host permission') ||
            error?.message?.includes('No tab with id') ||
            error?.message?.includes('Invalid tab ID');

        if (!isExpectedError) {
            console.error(`Failed to set global balance for tab ${tabId}:`, error);
        }

        return { success: isExpectedError, error: error?.message };
    }
}

async function setMuteForTab(tabId, muted) {
    return setMuteForTabWithOptions(tabId, muted);
}

async function setMuteForTabWithOptions(tabId, muted, options = {}) {
    try {
        const nextMuted = Boolean(muted);
        const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        const explicitVolumeBeforeMute = Number.isFinite(Number(options.volumeBeforeMute))
            ? normalizeVolume(options.volumeBeforeMute, CONSTANTS.DEFAULT_VOLUME)
            : null;

        state.muted = nextMuted;
        if (nextMuted) {
            state.volumeBeforeMute = explicitVolumeBeforeMute ?? getDisplayedVolumeForState(state, CONSTANTS.DEFAULT_VOLUME);
        } else {
            delete state.volumeBeforeMute;
        }
        tabState.set(tabId, state);
        schedulePersistTabState(tabId);
        debouncedUpdateIcon(tabId, state.volume ?? CONSTANTS.DEFAULT_VOLUME, state.corsAffectedCount ?? 0);

        try {
            await browser.tabs.sendMessage(tabId, {
                type: Messages.SET_MUTE_STATE,
                payload: { muted: nextMuted }
            });
        } catch {
            await browser.scripting.executeScript({
                target: { tabId, allFrames: true },
                func: (payload) => {
                    if (window.__volumeControlExtension__ && typeof window.__volumeControlExtension__.setMuteState === 'function') {
                        window.__volumeControlExtension__.setMuteState(payload.muted);
                    }
                },
                args: [{ muted: nextMuted }]
            });
        }

        broadcastAudioStateChanged(tabId);
        return { success: true };
    } catch (error) {
        console.error(`Failed to set mute for tab ${tabId}:`, error);
        return { success: false, error: error.message };
    }
}

async function setExtensionEnabledForTab(tabId, enabled) {
    try {
        const nextEnabled = enabled !== false;
        const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        state.extensionEnabled = nextEnabled;
        tabState.set(tabId, state);
        schedulePersistTabState(tabId);
        debouncedUpdateIcon(tabId, state.volume ?? CONSTANTS.DEFAULT_VOLUME, state.corsAffectedCount ?? 0);

        try {
            await browser.tabs.sendMessage(tabId, {
                type: Messages.SET_EXTENSION_ENABLED,
                payload: { enabled: nextEnabled }
            });
        } catch {
            await browser.scripting.executeScript({
                target: { tabId, allFrames: true },
                func: (payload) => {
                    if (window.__volumeControlExtension__ && typeof window.__volumeControlExtension__.setExtensionEnabled === 'function') {
                        window.__volumeControlExtension__.setExtensionEnabled(payload.enabled);
                    }
                },
                args: [{ enabled: nextEnabled }]
            });
        }

        broadcastAudioStateChanged(tabId);
        return { success: true };
    } catch (error) {
        const isExpectedError = error?.message?.includes('Missing host permission') ||
            error?.message?.includes('No tab with id') ||
            error?.message?.includes('Invalid tab ID');

        if (!isExpectedError) {
            console.error(`Failed to set extension enabled state for tab ${tabId}:`, error);
        }

        return { success: isExpectedError, error: error?.message };
    }
}

async function setGlobalExtensionEnabled(enabled) {
    const nextEnabled = enabled !== false;
    const tabs = await browser.tabs.query({});

    await Promise.allSettled(
        tabs
            .filter((tab) => tab?.id)
            .map((tab) => setExtensionEnabledForTab(tab.id, nextEnabled))
    );

    return { success: true };
}

async function setGlobalBalance(settings) {
    const normalizedSettings = Protocol.normalizeGlobalBalanceSettings(settings);
    const tabs = await browser.tabs.query({});

    await Promise.allSettled(
        tabs
            .filter((tab) => tab?.id)
            .map((tab) => setGlobalBalanceForTab(tab.id, normalizedSettings))
    );

    return { success: true };
}

async function getActiveControllableTab() {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = tabs?.[0];
    if (!activeTab?.id) {
        return null;
    }
    if (!activeTab.url || !/^(https?|file):/i.test(activeTab.url)) {
        return null;
    }
    return activeTab;
}

async function resolveDiagnosticsTargetTab(tabId = null) {
    if (tabId !== null && tabId !== undefined && Number.isFinite(Number(tabId))) {
        const resolvedTab = await browser.tabs.get(Number(tabId)).catch(() => null);
        if (!resolvedTab?.id || !resolvedTab.url || !/^(https?|file):/i.test(resolvedTab.url)) {
            return null;
        }
        return resolvedTab;
    }

    return getActiveControllableTab();
}

async function runDiagnosticsCommandOnTab(tabId, commandName, args = []) {
    const targetTab = await resolveDiagnosticsTargetTab(tabId);
    if (!targetTab?.id) {
        throw new Error('No active controllable tab is available for diagnostics.');
    }

    const results = await browser.scripting.executeScript({
        target: { tabId: targetTab.id, allFrames: true },
        func: (requestedCommandName, requestedArgs) => {
            const locationHref = (() => {
                try {
                    return window.location?.href || 'unknown';
                } catch (_error) {
                    return 'unknown';
                }
            })();
            const frame = (() => {
                try {
                    return window === window.top ? 'top-level' : `iframe@${locationHref}`;
                } catch (_error) {
                    return 'iframe';
                }
            })();
            const command = window[requestedCommandName];

            try {
                if (typeof command === 'function') {
                    return {
                        ok: true,
                        commandName: requestedCommandName,
                        frame,
                        locationHref,
                        value: command(...requestedArgs)
                    };
                }

                return {
                    ok: false,
                    commandName: requestedCommandName,
                    frame,
                    locationHref,
                    error: `Command ${requestedCommandName} is not available in this frame.`
                };
            } catch (error) {
                return {
                    ok: false,
                    commandName: requestedCommandName,
                    frame,
                    locationHref,
                    error: error?.message || String(error)
                };
            }
        },
        args: [commandName, Array.isArray(args) ? args : [args]]
    });

    const frameResults = (results || []).map((result, index) => ({
        frameId: typeof result?.frameId === 'number' ? result.frameId : index,
        tabId: targetTab.id,
        tabTitle: targetTab.title || 'Unknown Tab',
        tabUrl: targetTab.url || '',
        ...(result?.result || {
            ok: false,
            commandName,
            frame: 'unknown',
            locationHref: targetTab.url || '',
            error: 'No diagnostics payload returned.'
        })
    }));

    return {
        tabId: targetTab.id,
        tabTitle: targetTab.title || 'Unknown Tab',
        tabUrl: targetTab.url || '',
        commandName,
        frames: frameResults
    };
}

function logDiagnosticsCommandResult(result) {
    const successCount = result.frames.filter((frame) => frame.ok).length;
    const failureCount = result.frames.length - successCount;

    console.log(
        `[VC Diagnostics] ${result.commandName} for tab ${result.tabId} (${result.tabTitle}) - ${successCount} ok, ${failureCount} failed`,
        result
    );

    result.frames.forEach((frame) => {
        if (frame.ok) {
            console.log(
                `[VC Diagnostics] frame ${frame.frameId} ${frame.frame} ${frame.locationHref}`,
                frame.value
            );
        } else {
            console.warn(
                `[VC Diagnostics] frame ${frame.frameId} ${frame.frame} failed: ${frame.error}`,
                frame
            );
        }
    });
}

function installBackgroundDiagnosticsConsoleHelpers() {
    const root = globalThis;

    root.vcDump = async (tabId = null) => {
        const result = await runDiagnosticsCommandOnTab(tabId, 'vcDump');
        logDiagnosticsCommandResult(result);
        return result;
    };

    root.vcExportDiagnostics = async (tabId = null) => {
        const result = await runDiagnosticsCommandOnTab(tabId, 'vcExportDiagnostics');
        logDiagnosticsCommandResult(result);
        return result;
    };

    root.vcEvents = async (tabId = null) => {
        const result = await runDiagnosticsCommandOnTab(tabId, 'vcEvents');
        logDiagnosticsCommandResult(result);
        return result;
    };

    root.vcDiagnostics = async (tabId = null) => {
        const result = await runDiagnosticsCommandOnTab(tabId, 'vcDiagnostics');
        logDiagnosticsCommandResult(result);
        return result;
    };

    root.vcSetDebugLevel = async (level, tabId = null) => {
        const result = await runDiagnosticsCommandOnTab(tabId, 'vcSetDebugLevel', [level]);
        logDiagnosticsCommandResult(result);
        return result;
    };

    root.vcEnableLogs = async (level = 3, tabId = null) => {
        const result = await runDiagnosticsCommandOnTab(tabId, 'vcEnableLogs', [level]);
        logDiagnosticsCommandResult(result);
        return result;
    };

    root.vcDisableLogs = async (tabId = null) => {
        const result = await runDiagnosticsCommandOnTab(tabId, 'vcDisableLogs');
        logDiagnosticsCommandResult(result);
        return result;
    };
}

installBackgroundDiagnosticsConsoleHelpers();

async function getFreshCommandState(tabId) {
    const currentState = tabState.get(tabId);
    const isStale = !currentState || (Date.now() - (currentState.lastSeenAt || 0)) > CONSTANTS.HYDRATE_TTL_MS;

    if (isStale) {
        await probeTabStatus(tabId).catch(() => false);
    }

    return tabState.get(tabId) || currentState || null;
}

async function handleVolumeCommand(command) {
    const activeTab = await getActiveControllableTab();
    if (!activeTab?.id) {
        return;
    }

    const state = await getFreshCommandState(activeTab.id) || {};
    const currentVolume = normalizeVolume(state.volume, CONSTANTS.DEFAULT_VOLUME);
    let nextVolume = currentVolume;

    if (command === 'volume-up') {
        nextVolume = normalizeVolume(currentVolume + 10, CONSTANTS.DEFAULT_VOLUME);
    } else if (command === 'volume-down') {
        nextVolume = normalizeVolume(currentVolume - 10, CONSTANTS.DEFAULT_VOLUME);
    } else if (command === 'volume-reset') {
        nextVolume = CONSTANTS.DEFAULT_VOLUME;
    } else {
        return;
    }

    await setVolumeForTab(activeTab.id, nextVolume);
}

async function handleToggleCompressionCommand() {
    const activeTab = await getActiveControllableTab();
    if (!activeTab?.id) {
        return;
    }

    const state = await getFreshCommandState(activeTab.id) || {};
    const nextEnabled = !Boolean(state.compressionEnabled);

    await setCompressionForTab(activeTab.id, {
        enabled: nextEnabled,
        threshold: state.compressionThreshold ?? CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD,
        ratio: state.compressionRatio ?? CONSTANTS.DEFAULT_COMPRESSION_RATIO,
        knee: state.compressionKnee ?? CONSTANTS.DEFAULT_COMPRESSION_KNEE
    });
}

async function handleToggleMuteCommand() {
    const activeTab = await getActiveControllableTab();
    if (!activeTab?.id) {
        return;
    }

    await probeTabStatus(activeTab.id).catch(() => false);
    const state = await getFreshCommandState(activeTab.id) || {};
    await setMuteForTabWithOptions(activeTab.id, !Boolean(state.muted), {
        volumeBeforeMute: getDisplayedVolumeForState(state, CONSTANTS.DEFAULT_VOLUME)
    });
}

async function handleCommand(command) {
    if (command === 'volume-up' || command === 'volume-down' || command === 'volume-reset') {
        await handleVolumeCommand(command);
        return;
    }

    if (command === 'toggle-compressor') {
        await handleToggleCompressionCommand();
        return;
    }

    if (command === 'toggle-mute') {
        await handleToggleMuteCommand();
    }
}

/**
 * Handle messages from content scripts and popup
 */
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === Messages.INSTALL_PAGE_MEDIA_BRIDGE) {
        (async () => {
            try {
                const tabId = sender.tab?.id;
                const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
                const installed = await installPageMediaBridge(tabId, frameId);
                sendResponse({ installed });
            } catch (error) {
                const unsupportedMainWorld = /Execution world|world\.MAIN|Invalid enumeration value/i.test(error?.message || '');
                if (!unsupportedMainWorld) {
                    console.warn('Failed to install MAIN-world media bridge:', error);
                }
                sendResponse({ installed: false, error: error?.message || String(error) });
            }
        })();
        return true;
    }

    if (message.type === Messages.STATUS_UPDATE && sender.tab && sender.tab.id) {
        const tabId = sender.tab.id;
        const payload = mergeCachedFrameStatusPayload(
            tabId,
            typeof sender.frameId === 'number' ? sender.frameId : 0,
            message.payload
        );
        const volume = normalizeVolume(payload.volume, CONSTANTS.DEFAULT_VOLUME);
        const corsCount = normalizeCorsCount(payload.corsAffectedCount);
        const status = payload.status;
        
        // Get current state for this tab
        const currentState = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        const prevAudioActivity = computeHasAudioActivity(currentState);

        // If user changes volume elsewhere after using mute toggle, clear muted state
        const nextMuted = Boolean(payload.muted ?? currentState.muted ?? false);
        const nextExtensionEnabled = payload.extensionEnabled !== false;
        const nextVolumeBeforeMute = nextMuted
            ? (currentState.muted
                ? (currentState.volumeBeforeMute ?? currentState.volume ?? volume)
                : (currentState.volume ?? volume))
            : undefined;
        
        // Determine if tab has media (for showing in Other Tabs list)
        const hasMedia = status === 'active' || status === 'inactive' || status === 'error' ||
                        (payload.elementCounts && payload.elementCounts.total > 0);
        
        // Update tracked state including tab info and compression state
        tabState.set(tabId, { 
            ...currentState,
            volume: volume, 
            extensionEnabled: nextExtensionEnabled,
            monoEnabled: payload.monoEnabled ?? currentState.monoEnabled ?? CONSTANTS.DEFAULT_MONO_ENABLED,
            balance: payload.balance ?? currentState.balance ?? CONSTANTS.DEFAULT_BALANCE,
            corsAffectedCount: corsCount,
            status: status,
            statusDetail: payload.statusDetail ?? currentState.statusDetail ?? null,
            hasMedia: hasMedia,
            muted: nextMuted,
            volumeBeforeMute: nextVolumeBeforeMute,
            lastSeenAt: Date.now(),
            lastMediaSeenAt: getNextLastMediaSeenAt(currentState, hasMedia, status),
            compressionEnabled: payload.compressionEnabled ?? currentState.compressionEnabled ?? false,
            compressionThreshold: payload.compressionThreshold ?? currentState.compressionThreshold ?? -18,
            compressionRatio: payload.compressionRatio ?? currentState.compressionRatio ?? 6,
            compressionKnee: payload.compressionKnee ?? currentState.compressionKnee ?? 3,
            audioSettingsAvailable: payload.audioSettingsAvailable ?? currentState.audioSettingsAvailable ?? true,
            audioSettingsReason: payload.audioSettingsReason ?? currentState.audioSettingsReason ?? null,
            title: sender.tab.title || currentState.title || 'Unknown Tab',
            favIconUrl: sender.tab.favIconUrl || currentState.favIconUrl || '',
            url: sender.tab.url || currentState.url || '',
            windowId: sender.tab.windowId
        });

        schedulePersistTabState(tabId);

        const nextAudioActivity = computeHasAudioActivity(tabState.get(tabId));
        if (prevAudioActivity !== nextAudioActivity) {
            broadcastAudioStateChanged(tabId);
        }

        const shouldUpdateIcon = !currentState.lastSeenAt ||
            currentState.volume !== volume ||
            currentState.corsAffectedCount !== corsCount ||
            Boolean(currentState.muted) !== nextMuted ||
            currentState.extensionEnabled !== nextExtensionEnabled ||
            currentState.status !== status ||
            currentState.hasMedia !== hasMedia;
        
        // Also paint on the first managed status transition, even when volume is still 100%.
        if (shouldUpdateIcon) {
            debouncedUpdateIcon(tabId, volume, corsCount);
        }
    }
    
    // Handle explicit volume update request from popup (for immediate updates)
    if (message.type === Messages.VOLUME_UPDATE) {
        // Tab ID can come from sender.tab (content script) or payload.tabId (popup)
        const tabId = sender.tab?.id ?? message.payload?.tabId;
        if (!tabId) return;
        
        const volume = normalizeVolume(message.payload?.volume, CONSTANTS.DEFAULT_VOLUME);
        const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        
        state.volume = volume;
        if (state.muted) {
            state.volumeBeforeMute = volume;
        }
        state.lastSeenAt = Date.now();
        tabState.set(tabId, state);

        schedulePersistTabState(tabId);
        
        // Use debounced update for smooth slider experience
        debouncedUpdateIcon(tabId, volume, state.corsAffectedCount);
    }
    
    // Handle request for tabs with audio (from popup)
    if (message.type === Messages.GET_AUDIO_TABS) {
        const excludeTabId = message.payload?.excludeTabId ?? null;
        const forceHydrate = Boolean(message.payload?.forceHydrate);
        (async () => {
            try {
                if (forceHydrate || isStateStale()) {
                    await hydrateTabStateFromOpenTabs();
                    if (forceHydrate) {
                        await hydrateMutedMediaCandidatesFromOpenTabs();
                    }
                }
                const tabs = await getTabsWithAudio(excludeTabId);
                sendResponse({ tabs });
            } catch (e) {
                console.error('GET_AUDIO_TABS failed:', e);
                sendResponse({ tabs: [] });
            }
        })();
        return true;
    }

    if (message.type === Messages.GET_TAB_STATUS) {
        const tabId = message.payload?.tabId;
        const forceProbe = Boolean(message.payload?.forceProbe);
        (async () => {
            try {
                const status = await getTabStatus(tabId, { forceProbe });
                sendResponse({ status });
            } catch (e) {
                console.error('GET_TAB_STATUS failed:', e);
                sendResponse({ status: getTabStatusPayloadFromState(tabState.get(tabId)) });
            }
        })();
        return true;
    }
    
    // Handle remote volume control request (from popup controlling other tabs)
    if (message.type === Messages.SET_REMOTE_TAB_VOLUME) {
        const targetTabId = message.payload?.tabId;
        const volume = message.payload?.volume ?? CONSTANTS.DEFAULT_VOLUME;
        
        if (targetTabId) {
            setVolumeForTab(targetTabId, volume).then(result => {
                sendResponse(result);
            });
            return true; // Keep channel open for async response
        }
    }
    
    // Handle remote compression control request (from popup controlling other tabs)
    if (message.type === Messages.SET_REMOTE_TAB_COMPRESSION) {
        const targetTabId = message.payload?.tabId;
        const settings = message.payload?.settings;
        
        if (targetTabId && settings) {
            setCompressionForTab(targetTabId, settings).then((result) => {
                sendResponse(result);
            });
            return true;
        }
    }

    if (message.type === Messages.SET_GLOBAL_EXTENSION_ENABLED) {
        const enabled = message.payload?.enabled !== false;
        setGlobalExtensionEnabled(enabled).then(sendResponse);
        return true;
    }

    if (message.type === Messages.SET_GLOBAL_BALANCE) {
        setGlobalBalance(message.payload).then(sendResponse);
        return true;
    }
    
    // Handle mute state update
    if (message.type === Messages.SET_TAB_MUTE_STATE) {
        const targetTabId = message.payload?.tabId;
        const muted = message.payload?.muted;
        const volumeBeforeMute = message.payload?.volumeBeforeMute;
        
        if (targetTabId !== undefined) {
            setMuteForTabWithOptions(targetTabId, muted, { volumeBeforeMute }).then(sendResponse);
        }
        return true;
    }
    
    // Handle request to focus/switch to a tab
    if (message.type === Messages.FOCUS_TAB) {
        const targetTabId = message.payload?.tabId;
        const windowId = message.payload?.windowId;
        
        if (targetTabId) {
            // First focus the window, then activate the tab
            const focusTab = async () => {
                try {
                    if (windowId) {
                        await browser.windows.update(windowId, { focused: true });
                    }
                    await browser.tabs.update(targetTabId, { active: true });
                    sendResponse({ success: true });
                } catch (error) {
                    sendResponse({ success: false, error: error.message });
                }
            };
            focusTab();
            return true; // Keep channel open for async response
        }
    }
});

/**
 * Clean up when tabs are closed
 */
browser.tabs.onRemoved.addListener((tabId) => {
    tabState.delete(tabId);
    removePersistedTabState(tabId);
    clearCachedFrameStatusPayloads(tabId);
    if (badgeUpdateTimers.has(tabId)) {
        clearTimeout(badgeUpdateTimers.get(tabId));
        badgeUpdateTimers.delete(tabId);
    }
    if (audioStateBroadcastTimers.has(tabId)) {
        clearTimeout(audioStateBroadcastTimers.get(tabId));
        audioStateBroadcastTimers.delete(tabId);
    }
    if (probeTimers.has(tabId)) {
        clearTimeout(probeTimers.get(tabId));
        probeTimers.delete(tabId);
    }
});

/**
 * Reset icon when tab URL changes (navigation) or update tab info
 */
// Ignore update events that cannot affect icon or tab-state metadata.
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.status && !changeInfo.title && !changeInfo.favIconUrl && typeof changeInfo.audible !== 'boolean') return;
    
    if (changeInfo.status === 'loading') {
        clearCachedFrameStatusPayloads(tabId);

        // Navigation can temporarily silence content scripts; keep last-known per-tab settings
        // so the toolbar icon doesn't incorrectly snap to 100%.
        const prev = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        tabState.set(tabId, {
            ...prev,
            title: tab?.title || prev.title || 'Unknown Tab',
            favIconUrl: tab?.favIconUrl || prev.favIconUrl || '',
            url: tab?.url || prev.url || '',
            windowId: tab?.windowId,
            status: prev.status || 'no-media',
            hasMedia: prev.hasMedia === true,
            lastSeenAt: Date.now()
        });

        schedulePersistTabState(tabId);
        updateIcon(tabId, prev.volume ?? CONSTANTS.DEFAULT_VOLUME, prev.corsAffectedCount ?? 0, { showDefault: true });

        // Let any open popup know list membership may change
        broadcastAudioStateChanged(tabId);
    }

    if (changeInfo.status === 'complete' && tab?.id && tab.url && /^(https?|file):/i.test(tab.url)) {
        const state = tabState.get(tabId);
        const needsProbe = !state || state.hasMedia !== true || (Date.now() - (state.lastSeenAt || 0)) > CONSTANTS.HYDRATE_TTL_MS;
        if (tab.active || needsProbe) {
            scheduleProbeTabStatus(tabId, 150);
        }
    }
    
    // Update tab info when title or favicon changes
    if (changeInfo.title || changeInfo.favIconUrl) {
        const state = tabState.get(tabId);
        if (state) {
            if (changeInfo.title) state.title = changeInfo.title;
            if (changeInfo.favIconUrl) state.favIconUrl = changeInfo.favIconUrl;
            state.url = tab.url || state.url;
            tabState.set(tabId, state);
        }
    }

    // Audible changes are a reliable signal even when content scripts are quiet (background/idle)
    if (typeof changeInfo.audible === 'boolean') {
        const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        const prevAudioActivity = computeHasAudioActivity(state);
        tabState.set(tabId, {
            ...state,
            title: tab.title || state.title || 'Unknown Tab',
            favIconUrl: tab.favIconUrl || state.favIconUrl || '',
            url: tab.url || state.url || '',
            windowId: tab.windowId,
            hasMedia: state.hasMedia === true || changeInfo.audible === true,
            status: changeInfo.audible ? 'active' : (state.status || 'no-media'),
            lastSeenAt: Date.now()
        });

        const nextAudioActivity = computeHasAudioActivity(tabState.get(tabId));
        if (prevAudioActivity !== nextAudioActivity) {
            broadcastAudioStateChanged(tabId);
        }

        if (changeInfo.audible === true && tab?.url && /^(https?|file):/i.test(tab.url)) {
            scheduleProbeTabStatus(tabId, 80);
        }
    }
});

/**
 * Update icon when switching tabs to show correct volume for that tab
 */
browser.tabs.onActivated.addListener(async (activeInfo) => {
    const tabId = activeInfo.tabId;
    let state = tabState.get(tabId);

    if (!state) {
        // Background-context restarts can wipe in-memory state; restore persisted state if available.
        try {
            await restoreTabStateFromStorage();
        } catch {
            // ignore
        }
        state = tabState.get(tabId);
    }

    if (state) {
        updateIcon(tabId, state.volume, state.corsAffectedCount, { showDefault: true });

        // If state is old (or tab was navigated), probe once on activation to re-sync.
        const age = Date.now() - (state.lastSeenAt || 0);
        if (age > CONSTANTS.HYDRATE_TTL_MS) {
            probeTabStatus(tabId).catch(() => {});
        }
        return;
    }

    // As a last resort, try to query the tab directly (covers first-run or missing storage).
    const probed = await probeTabStatus(tabId).catch(() => false);
    if (!probed) {
        updateIcon(tabId, CONSTANTS.DEFAULT_VOLUME, 0, { showDefault: false });
    }
});

browser.commands?.onCommand?.addListener((command) => {
    handleCommand(command).catch((error) => {
        console.warn('Volume command failed:', error);
    });
});

// Initialize base icon + restore persisted state so toolbar icon doesn't drift.
(async () => {
    try {
        const storedPreferences = await browser.storage.local.get([PreferenceKeys.EXTENSION_ENABLED]);
        const preferences = Protocol.normalizeExtensionPreferences(storedPreferences);

        await browser.action.setBadgeBackgroundColor({
            color: preferences.extensionEnabled === false
                ? NATIVE_BADGE_STYLE.disabledBackgroundColor
                : NATIVE_BADGE_STYLE.activeBackgroundColor
        });
        if (typeof browser.action.setBadgeTextColor === 'function') {
            await browser.action.setBadgeTextColor({ color: NATIVE_BADGE_STYLE.textColor });
        }
        await cleanupLegacyPreferenceStorage();
        await restoreTabStateFromStorage();

        // Set icon for active tabs immediately from restored state.
        const activeTabs = await browser.tabs.query({ active: true });
        for (const tab of activeTabs) {
            if (!tab?.id) continue;
            const state = tabState.get(tab.id);
            if (state) {
                updateIcon(tab.id, state.volume, state.corsAffectedCount, { showDefault: true });
                const age = Date.now() - (state.lastSeenAt || 0);
                if (age > CONSTANTS.HYDRATE_TTL_MS) {
                    probeTabStatus(tab.id).catch(() => {});
                }
            } else {
                updateIcon(tab.id, CONSTANTS.DEFAULT_VOLUME, 0, { showDefault: false });
                probeTabStatus(tab.id).catch(() => {});
            }
        }
    } catch (e) {
        console.warn('Background init failed:', e);
    }
})();
