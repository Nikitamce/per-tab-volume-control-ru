/**
 * Background script
 * Handles extension icon updates with real-time volume badge display.
 * Also tracks tabs with active audio for cross-tab volume control.
 */

const Protocol = globalThis.VCProtocol;
const I18n = globalThis.VCI18n;
const { Messages, PreferenceKeys } = Protocol;
const EXTENSION_DISPLAY_NAME = 'Per-Tab Volume Control';

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
// Dirty tab ids map to the generation of their latest mark. A flush clears an id only when its
// generation is unchanged since the state was serialised, so a re-dirtied id is never dropped.
const persistDirtyTabIds = new Map();
let persistGeneration = 0;
let persistFlushChain = Promise.resolve();
let tabStateRestorePromise = null;
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
        // Always an explicit control (unmanaged revision 0 for a tab without one), so a restore can
        // tell a telemetry-only tab from an entry written before explicit controls existed (ISS-003).
        volumeControl: getTabVolumeControl(state),
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
        // A record without a stamp stays without one: stamping Date.now here would make a
        // reverted husk look fresh after a cold wake and defeat the staleness checks. Readers
        // already treat a missing stamp as stale, and the format stays additive (G11).
        lastSeenAt: (typeof state.lastSeenAt === 'number') ? state.lastSeenAt : undefined,
        lastMediaSeenAt: (typeof state.lastMediaSeenAt === 'number') ? state.lastMediaSeenAt : undefined,
        hasMedia: Boolean(state.hasMedia),
        status: state.status
    };
}

function markTabStateDirty(tabId) {
    persistGeneration += 1;
    persistDirtyTabIds.set(String(tabId), persistGeneration);
}

function armPersistTimer() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        flushPersistedTabState().catch((error) => {
            console.error('persist tab state failed:', error);
        });
    }, CONSTANTS.STATE_PERSIST_DEBOUNCE_MS);
}

function schedulePersistTabState(tabId) {
    if (!tabId) return;
    markTabStateDirty(tabId);
    armPersistTimer();
}

async function flushPersistedTabState() {
    const run = async () => {
        if (persistDirtyTabIds.size === 0) {
            return;
        }

        const existing = (await storageArea.get(CONSTANTS.STATE_STORAGE_KEY))[CONSTANTS.STATE_STORAGE_KEY] || {};
        // Snapshot in the same synchronous step that serialises, so the recorded generation
        // describes exactly the state that is written.
        const written = new Map(persistDirtyTabIds);
        for (const id of written.keys()) {
            const tabId = Number(id);
            const state = tabState.get(tabId);
            if (state) {
                existing[id] = serializeTabStateForStorage(state);
            } else {
                delete existing[id];
            }
        }

        await storageArea.set({ [CONSTANTS.STATE_STORAGE_KEY]: existing });
        for (const [id, generation] of written) {
            if (persistDirtyTabIds.get(id) === generation) {
                persistDirtyTabIds.delete(id);
            }
        }
        // Ids re-dirtied during the write are retained; make sure a later flush picks them up.
        // A failed write throws above, so a failing store is never retried in a loop.
        if (persistDirtyTabIds.size > 0) {
            armPersistTimer();
        }
    };

    persistFlushChain = persistFlushChain.then(run, run);
    return persistFlushChain;
}

async function removePersistedTabState(tabId) {
    const run = async () => {
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
    };
    persistFlushChain = persistFlushChain.then(run, run);
    return persistFlushChain;
}

// Chained read-modify-write so the restore prune cannot interleave with, or overwrite, a flush.
// Errors propagate to the caller so a failed prune keeps restore uncached and retryable.
function prunePersistedTabState(closedKeys) {
    const run = async () => {
        const existing = (await storageArea.get(CONSTANTS.STATE_STORAGE_KEY))[CONSTANTS.STATE_STORAGE_KEY] || {};
        let removed = false;
        for (const key of closedKeys) {
            if (Object.prototype.hasOwnProperty.call(existing, key)) {
                delete existing[key];
                removed = true;
            }
        }
        if (removed) {
            await storageArea.set({ [CONSTANTS.STATE_STORAGE_KEY]: existing });
        }
    };
    persistFlushChain = persistFlushChain.then(run, run);
    return persistFlushChain;
}

function pickPreferredVolumeControl(liveControl, persistedControl) {
    const live = liveControl
        ? Protocol.normalizeVolumeControl(liveControl)
        : null;
    const persisted = persistedControl
        ? Protocol.normalizeVolumeControl(persistedControl)
        : null;
    if (!live) {
        return persisted;
    }
    if (!persisted) {
        return live;
    }
    const liveRevision = Math.floor(Number(live.revision) || 0);
    const persistedRevision = Math.floor(Number(persisted.revision) || 0);
    return liveRevision >= persistedRevision ? live : persisted;
}

// Values a writer gives a record it creates before the restore has run. They carry no knowledge
// of the tab, so a persisted value always outranks them in the restore merge.
const TAB_STATE_SEED_DEFAULTS = Object.freeze({
    volume: CONSTANTS.DEFAULT_VOLUME,
    corsAffectedCount: 0,
    status: 'no-media',
    hasMedia: false
});

// Field-wise merge of a record written since wake (`live`) with its persisted snapshot. Fields the
// live writer set win, fields it left absent or at a seed default come from the snapshot, and the
// volume control follows `pickPreferredVolumeControl` so a managed target also sets the volume.
function mergeRestoredTabState(live, persisted) {
    const merged = { ...persisted };
    for (const [key, value] of Object.entries(live)) {
        if (value === undefined) continue;
        const isSeedDefault = Object.prototype.hasOwnProperty.call(TAB_STATE_SEED_DEFAULTS, key) &&
            value === TAB_STATE_SEED_DEFAULTS[key];
        if (isSeedDefault && persisted[key] !== undefined) continue;
        merged[key] = value;
    }
    merged.volumeControl = pickPreferredVolumeControl(live.volumeControl, persisted.volumeControl);
    if (Protocol.isManagedVolumeControl(merged.volumeControl)) {
        merged.volume = merged.volumeControl.targetVolume;
    }
    return merged;
}

// ISS-003: an entry written by a build that predates explicit controls has no `volumeControl` key
// and a managed target in `volume`. Only that shape migrates, once, to a managed LEGACY revision 1
// control. Every current build writes the key (an unmanaged control for plain telemetry), so an entry
// that has the key is never migrated and page telemetry cannot be promoted by a wake. The migrated
// control lives on the restored record and is written back by its next ordinary flush.
function migrateKeylessPersistedVolumeControl(persisted) {
    if (Object.prototype.hasOwnProperty.call(persisted, 'volumeControl')) {
        return persisted;
    }
    const volume = normalizeVolume(persisted.volume, CONSTANTS.DEFAULT_VOLUME);
    if (volume === CONSTANTS.DEFAULT_VOLUME) {
        return persisted;
    }
    return {
        ...persisted,
        volumeControl: Protocol.createManagedVolumeControl(volume, Protocol.VolumeControlSource.LEGACY, 1)
    };
}

async function restoreTabStateFromStorage() {
    await persistFlushChain.catch(() => {});
    const stored = (await storageArea.get(CONSTANTS.STATE_STORAGE_KEY))[CONSTANTS.STATE_STORAGE_KEY] || {};
    const tabs = await browser.tabs.query({});
    const openIds = new Set(tabs.filter(t => t?.id).map(t => String(t.id)));

    // Prune stored entries for closed tabs
    const closedKeys = [];
    for (const key of Object.keys(stored)) {
        if (!openIds.has(key)) {
            delete stored[key];
            closedKeys.push(key);
        }
    }

    // Seed in-memory state. Live commits since wake win over persisted snapshots.
    for (const tab of tabs) {
        if (!tab?.id) continue;
        const key = String(tab.id);
        const prev = tabState.get(tab.id) || {};
        const storedEntry = stored[key];
        if (!storedEntry) continue;
        const persisted = migrateKeylessPersistedVolumeControl(storedEntry);

        const merged = mergeRestoredTabState(prev, persisted);
        merged.title = tab.title || prev.title || '';
        merged.favIconUrl = tab.favIconUrl || prev.favIconUrl || '';
        merged.url = tab.url || prev.url || '';
        merged.windowId = tab.windowId;
        tabState.set(tab.id, merged);
    }

    if (closedKeys.length > 0) {
        await prunePersistedTabState(closedKeys);
    }
}

function ensureTabStateRestored() {
    if (!tabStateRestorePromise) {
        tabStateRestorePromise = restoreTabStateFromStorage().catch((error) => {
            tabStateRestorePromise = null;
            throw error;
        });
    }
    return tabStateRestorePromise;
}

// Restore barrier for every entry that reads or writes `tabState` and must still run when storage
// fails. A rejected restore is logged and not cached (see ensureTabStateRestored), so a later
// caller retries it while this command carries on with the in-memory state.
async function ensureTabStateRestoredOrLog() {
    try {
        await ensureTabStateRestored();
        return true;
    } catch (error) {
        console.warn('Tab state restore failed; continuing with in-memory state:', error);
        return false;
    }
}

// ISS-005: ids of tabs closed during this session. Firefox does not reuse a tab id within a
// session, so an async writer that resumes after a close can skip by id alone, with no
// `tabs.get` round trip. The set is bounded; the oldest id is dropped first.
const RECENTLY_CLOSED_TAB_CAP = 200;
const recentlyClosedTabIds = new Set();

function markTabClosed(tabId) {
    recentlyClosedTabIds.delete(tabId);
    recentlyClosedTabIds.add(tabId);
    while (recentlyClosedTabIds.size > RECENTLY_CLOSED_TAB_CAP) {
        recentlyClosedTabIds.delete(recentlyClosedTabIds.values().next().value);
    }
}

function isTabClosed(tabId) {
    return recentlyClosedTabIds.has(tabId);
}

// ISS-005: background mute and enable commands being delivered to a tab, counted per tab. While a
// delivery is in flight the record already holds the commanded value, so page telemetry that was
// captured earlier must not overwrite `muted`, `volumeBeforeMute` or `extensionEnabled`. The guard
// ends with the delivery: a later STATUS_UPDATE (a player-UI unmute arrives only that way) applies.
const commandDeliveriesInFlight = new Map();

function beginCommandDelivery(tabId) {
    commandDeliveriesInFlight.set(tabId, (commandDeliveriesInFlight.get(tabId) || 0) + 1);
}

function endCommandDelivery(tabId) {
    const remaining = (commandDeliveriesInFlight.get(tabId) || 0) - 1;
    if (remaining > 0) {
        commandDeliveriesInFlight.set(tabId, remaining);
    } else {
        commandDeliveriesInFlight.delete(tabId);
    }
}

function isCommandDeliveryInFlight(tabId) {
    return commandDeliveriesInFlight.has(tabId);
}

function isContentScriptSender(sender) {
    return Boolean(sender?.tab);
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

function getTabVolumeControl(state) {
    if (!state) {
        return Protocol.createUnmanagedVolumeControl();
    }
    if (state.volumeControl) {
        return Protocol.normalizeVolumeControl(state.volumeControl, state.volume);
    }
    // A record without a stored control is unmanaged whatever its volume: `volume` is page telemetry
    // there, and telemetry is never promoted to a managed target (ISS-003).
    return Protocol.createUnmanagedVolumeControl(normalizeVolume(state.volume, CONSTANTS.DEFAULT_VOLUME));
}

function resolveTabAuthoritativeVolume(state, telemetryVolume) {
    const volumeControl = getTabVolumeControl(state);
    return Protocol.resolveAuthoritativeVolume(
        volumeControl,
        telemetryVolume,
        state?.volume ?? CONSTANTS.DEFAULT_VOLUME
    );
}

async function commitTabVolumeControl(tabId, control, options = {}) {
    if (isTabClosed(tabId)) {
        // A late commit for a closed tab must not re-create its record.
        return { accepted: false, control: Protocol.createUnmanagedVolumeControl() };
    }
    const immediate = options.immediate !== false;
    const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
    const current = getTabVolumeControl(state);
    const normalized = Protocol.normalizeVolumeControl(control, state.volume);

    if (Protocol.volumeControlsEqual(current, normalized)) {
        return { accepted: true, control: current, unchanged: true };
    }

    if (!Protocol.shouldAcceptVolumeControlUpdate(current, normalized, { allowEqualDifferent: false })) {
        return { accepted: false, control: current };
    }

    // Snapshot before mutating, so a failed immediate flush can put the prior record back
    // instead of leaving a control the page was never told about (G2: the revert only applies
    // while the record still holds exactly this commit, so a newer win is never undone).
    const priorFields = snapshotVolumeCommitFields(state);
    state.volumeControl = normalized;
    if (Protocol.isManagedVolumeControl(normalized)) {
        state.volume = normalized.targetVolume;
        if (state.muted) {
            state.volumeBeforeMute = normalized.targetVolume;
        }
    }
    state.lastSeenAt = Date.now();
    tabState.set(tabId, state);

    markTabStateDirty(tabId);
    if (immediate) {
        try {
            await flushPersistedTabState();
        } catch (error) {
            // The in-memory record changed before the write failed and the command is not
            // delivered on this path, so undo the commit instead of claiming an unstored
            // control. A newer control that landed meanwhile is left alone (G2).
            await revertUndeliveredVolumeCommit(tabId, normalized, priorFields);
            throw error;
        }
    } else {
        schedulePersistTabState(tabId);
    }

    if (options.updateIcon !== false) {
        debouncedUpdateIcon(tabId, state.volume, state.corsAffectedCount ?? 0);
    }

    return { accepted: true, control: normalized };
}

function mergeFrameStatusPayloads(framePayloads, tabId) {
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
    const volumeControl = tabId ? getTabVolumeControl(tabState.get(tabId)) : null;
    return Protocol.mergeStatusPayloads(framePayloads, defaults, volumeControl);
}

const frameStatusCache = new Map();

// Cached frame payloads carry when they were last reported, so a recovered main frame can tell a
// live sibling from one that went silent (a missed removal or a probe that found no frames).
function mergeCachedFrameStatusPayload(tabId, frameId, framePayload) {
    let frameMap = frameStatusCache.get(tabId);
    if (!frameMap) {
        frameMap = new Map();
        frameStatusCache.set(tabId, frameMap);
    }

    frameMap.set(frameId, { payload: framePayload, receivedAt: Date.now() });
    return mergeFrameStatusPayloads(Array.from(frameMap.values()), tabId);
}

function replaceCachedFrameStatusPayloads(tabId, framePayloads) {
    const frameMap = new Map();
    const now = Date.now();
    (framePayloads || []).forEach((framePayload, index) => {
        const frameId = typeof framePayload?.frameId === 'number' ? framePayload.frameId : index;
        frameMap.set(frameId, { payload: framePayload?.payload ?? framePayload, receivedAt: now });
    });
    frameStatusCache.set(tabId, frameMap);
}

function clearCachedFrameStatusPayloads(tabId) {
    frameStatusCache.delete(tabId);
}

function removeCachedFrameStatusPayload(tabId, frameId) {
    const frameMap = frameStatusCache.get(tabId);
    if (!frameMap) {
        return false;
    }

    const removed = frameMap.delete(frameId);
    if (frameMap.size === 0) {
        frameStatusCache.delete(tabId);
    }
    return removed;
}

function mergedStatusHasMedia(merged) {
    return Boolean(Protocol.statusPayloadHasMedia(merged));
}

// ISS-006: a record that already saw media (or native-only elements) carries knowledge that the
// frame cache lost when the event page was suspended.
function recordHadMedia(state) {
    return state?.hasMedia === true || normalizeCorsCount(state?.corsAffectedCount) > 0;
}

// A main-frame report that carries healthy media of its own. Used to spot a merge that still
// claims a limitation the main frame does not report.
function isHealthyMainFramePayload(own) {
    if (!own || typeof own !== 'object') return false;
    if (own.status !== 'active' && own.status !== 'inactive') return false;
    if (own.statusDetail === 'limited') return false;
    if (normalizeCorsCount(own.corsAffectedCount) !== 0) return false;
    return true;
}

// Drops cached frames other than `exceptFrameId` that last reported longer than a hydrate
// interval ago. Fresh siblings (a live multi-frame player) are kept. Returns what was dropped.
function evictStaleCachedFramePayloads(tabId, exceptFrameId) {
    const frameMap = frameStatusCache.get(tabId);
    if (!frameMap) return false;
    const now = Date.now();
    let dropped = false;
    for (const [cachedFrameId, entry] of frameMap) {
        if (cachedFrameId === exceptFrameId) continue;
        const receivedAt = typeof entry?.receivedAt === 'number' ? entry.receivedAt : now;
        if (now - receivedAt > CONSTANTS.HYDRATE_TTL_MS) {
            frameMap.delete(cachedFrameId);
            dropped = true;
        }
    }
    if (frameMap.size === 0) {
        frameStatusCache.delete(tabId);
    }
    return dropped;
}

// Every status that reports media refreshes the stamp, so continuous playback never ages out of
// `getTabsWithAudio` while a tab that stopped reporting media does, after `RECENT_MEDIA_TTL_MS`.
function getNextLastMediaSeenAt(previousState, hasMedia) {
    return hasMedia ? Date.now() : previousState?.lastMediaSeenAt;
}

// Folds a `tabs` audible signal into the media fields. Silence is not proof that media is gone:
// frames that reported media keep it, but the audible-derived `active` is dropped and the caller
// schedules a probe. `fresh` is true when the result comes from current evidence, so only then
// may it refresh `lastMediaSeenAt`.
function resolveAudibleHint(tabId, prev, audible) {
    if (audible) {
        return { hasMedia: true, status: 'active', fresh: true };
    }
    const frames = frameStatusCache.get(tabId);
    const fromFrames = Boolean(frames && frames.size > 0);
    const hasMedia = fromFrames
        ? mergedStatusHasMedia(mergeFrameStatusPayloads(Array.from(frames.values()), tabId))
        : (prev.status !== 'active' && prev.hasMedia === true);
    const status = prev.status === 'active'
        ? (hasMedia ? 'inactive' : 'no-media')
        : (prev.status || 'no-media');
    return { hasMedia, status, fresh: fromFrames };
}

async function probeTabStatus(tabId) {
    await ensureTabStateRestoredOrLog();
    if (isTabClosed(tabId)) return null;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab?.id) return null;
    if (!tab.url || !/^(https?|file):/i.test(tab.url)) return null;

    try {
        const framePayloads = await getFrameStatusPayloads(tab.id);
        if (framePayloads.length === 0) return null;
        // The tab can close while the frames are queried; a late result must not re-create it.
        if (isTabClosed(tab.id)) return null;
        replaceCachedFrameStatusPayloads(tab.id, framePayloads);
        const merged = mergeFrameStatusPayloads(framePayloads, tab.id);
        const hasMedia = mergedStatusHasMedia(merged);
        const prev = tabState.get(tab.id) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        const commandInFlight = isCommandDeliveryInFlight(tab.id);
        const nextVolume = resolveTabAuthoritativeVolume(prev, merged.observedVolume ?? merged.volume);
        const nextCors = normalizeCorsCount(merged.corsAffectedCount);

        tabState.set(tab.id, {
            ...prev,
            title: tab.title || prev.title || '',
            favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
            url: tab.url || prev.url || '',
            windowId: tab.windowId,
            volume: nextVolume,
            // Telemetry captured before a command in flight must not revert the commanded value.
            extensionEnabled: commandInFlight
                ? (prev.extensionEnabled ?? true)
                : (merged.extensionEnabled ?? prev.extensionEnabled ?? true),
            muted: commandInFlight ? (prev.muted ?? false) : (merged.muted ?? prev.muted ?? false),
            monoEnabled: merged.monoEnabled ?? prev.monoEnabled,
            balance: merged.balance ?? prev.balance,
            corsAffectedCount: nextCors,
            status: merged.status,
            // Explicit null must clear transitional details like "setting-up".
            statusDetail: Protocol.coalesceExplicit(merged.statusDetail, prev.statusDetail, null),
            hasMedia,
            compressionEnabled: merged.compressionEnabled ?? prev.compressionEnabled,
            compressionThreshold: merged.compressionThreshold ?? prev.compressionThreshold,
            compressionRatio: merged.compressionRatio ?? prev.compressionRatio,
            compressionKnee: merged.compressionKnee ?? prev.compressionKnee,
            audioSettingsAvailable: merged.audioSettingsAvailable ?? prev.audioSettingsAvailable ?? true,
            audioSettingsReason: (merged.audioSettingsAvailable ?? prev.audioSettingsAvailable ?? true)
                ? null
                : Protocol.coalesceExplicit(merged.audioSettingsReason, prev.audioSettingsReason, null),
            lastMediaSeenAt: getNextLastMediaSeenAt(prev, hasMedia),
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
    const volumeControl = getTabVolumeControl(state);
    return Protocol.normalizeStatusPayload({
        status: state?.status || 'inactive',
        statusDetail: state?.statusDetail ?? null,
        volume: resolveTabAuthoritativeVolume(state, state?.volume),
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

    return String(safeVolume);
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
        const translate = (key, subs) => (I18n?.t ? I18n.t(key, subs) : key);
        const translatePlural = (baseKey, count, subs) => (
            I18n?.tPlural
                ? I18n.tPlural(baseKey, count, subs)
                : `${baseKey}.other`
        );
        let title = translate('toolbar.title', {
            name: EXTENSION_DISPLAY_NAME,
            volume: Math.round(displayVolume)
        });
        if (state?.muted && state?.extensionEnabled !== false) {
            title += translate('toolbar.mutedSuffix');
        }
        // Only show the native-only warning when it actually matters to the user (boost > 100%)
        if (safeCors > 0 && displayVolume > CONSTANTS.DEFAULT_VOLUME) {
            title += `\n${translatePlural('toolbar.corsWarning', safeCors, { count: safeCors })}`;
        }
        await browser.action.setTitle({
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
    if (!tabId || isTabClosed(tabId)) {
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

// ISS-006: a frame went away and the cache holds nothing for the tab (the event page was woken
// since the cache was filled). The record is only readable after the restore (G3); when it saw
// media the frames are asked again, because the removed frame may have been the one that held it.
async function scheduleProbeForColdFrameRemoval(tabId) {
    await ensureTabStateRestoredOrLog();
    if (isTabClosed(tabId) || frameStatusCache.has(tabId)) return;
    if (tabState.get(tabId)?.hasMedia === true) {
        scheduleProbeTabStatus(tabId, 50);
    }
}

/**
 * Get all tabs with audio (status === 'active' OR 'inactive' with media)
 * @param {number} excludeTabId - Tab ID to exclude (usually the current tab)
 * @returns {Array} Array of tab info objects
 */
async function getTabsWithAudio(excludeTabId = null) {
    await ensureTabStateRestoredOrLog();
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
                title: state.title || '',
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
            // The query snapshot can predate a close.
            if (isTabClosed(tab.id)) continue;

            const state = tabState.get(tab.id) || {};
            const audibleSeenAt = Date.now();
            tabsWithAudio.push(Protocol.normalizeAudioTab({
                tabId: tab.id,
                title: tab.title || state.title || '',
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
                lastMediaSeenAt: audibleSeenAt,
                windowId: tab.windowId,
                status: state.status || 'active'
            }));

            included.add(tab.id);

            // Ensure state exists for this tab so subsequent refreshes are stable
            tabState.set(tab.id, {
                ...state,
                title: tab.title || state.title || '',
                favIconUrl: tab.favIconUrl || state.favIconUrl || '',
                url: tab.url || state.url || '',
                windowId: tab.windowId,
                hasMedia: true,
                status: state.status || 'active',
                lastMediaSeenAt: audibleSeenAt,
                lastSeenAt: audibleSeenAt
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
    await ensureTabStateRestoredOrLog();
    const tabs = await browser.tabs.query({});
    const now = Date.now();

    // First pass: at least capture basic tab metadata + audible hint
    for (const tab of tabs) {
        if (!tab?.id || isTabClosed(tab.id)) continue;
        const prev = tabState.get(tab.id) || {};
        // A silent snapshot says nothing new about a tab whose frames already reported: keep what
        // they said. Otherwise fold the audible flag in without a sticky OR.
        const keepReportedMedia = tab.audible !== true && frameStatusCache.has(tab.id);
        const hint = keepReportedMedia
            ? { hasMedia: prev.hasMedia === true, status: prev.status || 'no-media', fresh: false }
            : resolveAudibleHint(tab.id, prev, tab.audible === true);

        tabState.set(tab.id, {
            ...prev,
            title: tab.title || prev.title || '',
            favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
            url: tab.url || prev.url || '',
            windowId: tab.windowId,
            extensionEnabled: prev.extensionEnabled ?? true,
            hasMedia: hint.hasMedia,
            status: hint.status,
            lastMediaSeenAt: hint.fresh ? getNextLastMediaSeenAt(prev, hint.hasMedia) : prev.lastMediaSeenAt,
            lastSeenAt: prev.lastSeenAt || now
        });
    }

    // Second pass: rebuild via executeScript (covers iframe players). A tab is skipped only when
    // its record reports media and cached frame statuses back that (a live STATUS_UPDATE or an
    // earlier probe), which is fresher than a probe. Every other http tab is probed, whether or
    // not some other tab has media.

    // Use bounded concurrency to avoid spikes when many tabs are open.
    const HYDRATE_BATCH_SIZE = 10;
    await runInBatches(tabs, HYDRATE_BATCH_SIZE, async (tab) => {
        if (!tab?.id || isTabClosed(tab.id)) return;
        if (!tab.url || !/^(https?|file):/i.test(tab.url)) return;
        const hadFrameStatuses = frameStatusCache.has(tab.id);
        if (hadFrameStatuses && tabState.get(tab.id)?.hasMedia === true) return;

        try {
            const framePayloads = await getFrameStatusPayloads(tab.id);
            if (framePayloads.length === 0) return;
            // The tab can close, or a live STATUS_UPDATE can arrive, while the frames are queried;
            // either way this older result must not be written.
            if (isTabClosed(tab.id) || (!hadFrameStatuses && frameStatusCache.has(tab.id))) return;
            // ISS-006: remember every frame, so a later single-frame STATUS_UPDATE merges with its
            // siblings and a pass that follows skips this tab. The cache is never persisted.
            replaceCachedFrameStatusPayloads(tab.id, framePayloads);
            const merged = mergeFrameStatusPayloads(framePayloads, tab.id);

            const prev = tabState.get(tab.id) || {};
            const hasMedia = mergedStatusHasMedia(merged);
            const prevControl = getTabVolumeControl(prev);
            const keepManagedVolume = Protocol.isManagedVolumeControl(prevControl);
            const commandInFlight = isCommandDeliveryInFlight(tab.id);

            tabState.set(tab.id, {
                ...prev,
                volume: keepManagedVolume
                    ? (prev.volume ?? CONSTANTS.DEFAULT_VOLUME)
                    : (merged.volume ?? prev.volume ?? 100),
                extensionEnabled: commandInFlight
                    ? (prev.extensionEnabled ?? true)
                    : (merged.extensionEnabled ?? prev.extensionEnabled ?? true),
                monoEnabled: merged.monoEnabled ?? prev.monoEnabled,
                balance: merged.balance ?? prev.balance,
                corsAffectedCount: merged.corsAffectedCount ?? prev.corsAffectedCount ?? 0,
                compressionEnabled: merged.compressionEnabled ?? prev.compressionEnabled,
                compressionThreshold: merged.compressionThreshold ?? prev.compressionThreshold,
                compressionRatio: merged.compressionRatio ?? prev.compressionRatio,
                compressionKnee: merged.compressionKnee ?? prev.compressionKnee,
                audioSettingsAvailable: merged.audioSettingsAvailable ?? prev.audioSettingsAvailable ?? true,
                audioSettingsReason: (merged.audioSettingsAvailable ?? prev.audioSettingsAvailable ?? true)
                    ? null
                    : Protocol.coalesceExplicit(merged.audioSettingsReason, prev.audioSettingsReason, null),
                hasMedia,
                status: merged.status,
                statusDetail: Protocol.coalesceExplicit(merged.statusDetail, prev.statusDetail, null),
                lastMediaSeenAt: getNextLastMediaSeenAt(prev, hasMedia),
                lastSeenAt: Date.now()
            });
        } catch {
            // Ignore restricted pages or transient errors
        }
    });
}

async function hydrateMutedMediaCandidatesFromOpenTabs(limit = 15) {
    await ensureTabStateRestoredOrLog();
    // When popup forces hydrate, also probe a small set of non-audible tabs to catch muted-but-playing media.
    const tabs = await browser.tabs.query({ currentWindow: true });
    let probed = 0;

    for (const tab of tabs) {
        if (probed >= limit) break;
        if (!tab?.id || isTabClosed(tab.id)) continue;
        if (!tab.url || !/^(https?|file):/i.test(tab.url)) continue;
        if (tab.audible) continue; // already covered

        const recordBeforeProbe = tabState.get(tab.id);
        const prevBeforeProbe = recordBeforeProbe || {};
        if (prevBeforeProbe.hasMedia === true) continue;
        if (prevBeforeProbe.lastMediaSeenAt && (Date.now() - prevBeforeProbe.lastMediaSeenAt) < CONSTANTS.RECENT_MEDIA_TTL_MS) continue;

        try {
            const framePayloads = await getFrameStatusPayloads(tab.id);
            if (framePayloads.length === 0) continue;
            if (isTabClosed(tab.id)) continue;
            // Every status writer replaces the record object, so a different object means a write
            // landed during the await. That write is newer than this probe and wins.
            if (tabState.get(tab.id) !== recordBeforeProbe) continue;

            // ISS-006: see hydrateTabStateFromOpenTabs. A live write would have replaced the record.
            replaceCachedFrameStatusPayloads(tab.id, framePayloads);
            const merged = mergeFrameStatusPayloads(framePayloads, tab.id);
            const hasMedia = mergedStatusHasMedia(merged);

            if (!hasMedia) continue;

            // Re-read immediately before the write: in-place edits (setters) since the probe started
            // are kept, including `extensionEnabled` and the compression fields.
            const prev = tabState.get(tab.id) || {};
            const prevControl = getTabVolumeControl(prev);
            const keepManagedVolume = Protocol.isManagedVolumeControl(prevControl);

            tabState.set(tab.id, {
                ...prev,
                title: tab.title || prev.title || '',
                favIconUrl: tab.favIconUrl || prev.favIconUrl || '',
                url: tab.url || prev.url || '',
                windowId: tab.windowId,
                volume: keepManagedVolume
                    ? (prev.volume ?? CONSTANTS.DEFAULT_VOLUME)
                    : normalizeVolume(merged.volume ?? prev.volume ?? CONSTANTS.DEFAULT_VOLUME, CONSTANTS.DEFAULT_VOLUME),
                monoEnabled: merged.monoEnabled ?? prev.monoEnabled,
                balance: merged.balance ?? prev.balance,
                corsAffectedCount: normalizeCorsCount(merged.corsAffectedCount ?? prev.corsAffectedCount ?? 0),
                audioSettingsAvailable: merged.audioSettingsAvailable ?? prev.audioSettingsAvailable ?? true,
                audioSettingsReason: (merged.audioSettingsAvailable ?? prev.audioSettingsAvailable ?? true)
                    ? null
                    : Protocol.coalesceExplicit(merged.audioSettingsReason, prev.audioSettingsReason, null),
                hasMedia: true,
                status: merged.status,
                statusDetail: Protocol.coalesceExplicit(merged.statusDetail, prev.statusDetail, null),
                lastMediaSeenAt: getNextLastMediaSeenAt(prev, true),
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

// Resolves true when a content script received the command, false when the fallback found no
// content script API in any frame. Rejects when the tab cannot be reached at all. Mute and enable
// callers tolerate a missing API and ignore the result; `setVolumeForTab` reverts on it (ISS-007).
async function deliverToTab(tabId, message, fallbackFnName, fallbackArgs) {
    try {
        await browser.tabs.sendMessage(tabId, message);
        return true;
    } catch {
        const results = await browser.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: (name, args) => {
                const api = window.__volumeControlExtension__;
                if (api && typeof api[name] === 'function') {
                    api[name](...args);
                    return true;
                }
                return false;
            },
            args: [fallbackFnName, fallbackArgs]
        });
        return Array.isArray(results) && results.some((result) => result?.result === true);
    }
}

// Delivers a mute or enable command and holds the in-flight guard for exactly that long.
async function deliverCommandToTab(tabId, message, fallbackFnName, fallbackArgs) {
    beginCommandDelivery(tabId);
    try {
        await deliverToTab(tabId, message, fallbackFnName, fallbackArgs);
    } finally {
        endCommandDelivery(tabId);
    }
}

// ISS-007: record fields a volume commit writes (`commitTabVolumeControl`), captured before the
// commit so a failed delivery can put them back.
const VOLUME_COMMIT_FIELDS = ['volume', 'volumeControl', 'volumeBeforeMute', 'lastSeenAt'];

function snapshotVolumeCommitFields(state) {
    const snapshot = {};
    for (const field of VOLUME_COMMIT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(state, field)) {
            snapshot[field] = state[field];
        }
    }
    return snapshot;
}

// Undoes a volume commit whose command never reached the page, so the record never claims a managed
// target the page did not receive. A newer control that landed meanwhile wins: the revert applies
// only while the record still holds exactly the control this call committed.
async function revertUndeliveredVolumeCommit(tabId, committedControl, priorFields) {
    const state = tabState.get(tabId);
    if (!state || !Protocol.volumeControlsEqual(getTabVolumeControl(state), committedControl)) {
        return false;
    }
    for (const field of VOLUME_COMMIT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(priorFields, field)) {
            state[field] = priorFields[field];
        } else {
            delete state[field];
        }
    }
    markTabStateDirty(tabId);
    debouncedUpdateIcon(tabId, state.volume ?? CONSTANTS.DEFAULT_VOLUME, state.corsAffectedCount ?? 0);
    try {
        await flushPersistedTabState();
    } catch (error) {
        // The dirty mark stays, so the next flush retries the write.
        console.warn(`Failed to persist the reverted volume for tab ${tabId}:`, error);
    }
    return true;
}

// ISS-007: volume sends to one tab run one after the other. Each send then snapshots exactly the
// record the previous send left, so a failed delivery always reverts to a state the page received
// and two overlapping failures cannot strand an undelivered control.
const volumeSendChains = new Map();

/**
 * Send volume command to a specific tab
 * @param {number} tabId - Target tab ID
 * @param {number} volume - Volume percentage (0-500)
 */
function setVolumeForTab(tabId, volume, options = {}) {
    const previous = volumeSendChains.get(tabId) || Promise.resolve();
    const run = previous.then(() => setVolumeForTabNow(tabId, volume, options));
    const tail = run.catch(() => {});
    volumeSendChains.set(tabId, tail);
    tail.then(() => {
        if (volumeSendChains.get(tabId) === tail) {
            volumeSendChains.delete(tabId);
        }
    });
    return run;
}

async function setVolumeForTabNow(tabId, volume, options = {}) {
    try {
        await ensureTabStateRestoredOrLog();
        if (isTabClosed(tabId)) {
            return { success: false, error: 'Tab closed' };
        }
        const safeVolume = normalizeVolume(volume, CONSTANTS.DEFAULT_VOLUME);
        const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        const currentControl = getTabVolumeControl(state);
        const nextRevision = Math.max(1, Math.floor(Number(currentControl.revision) || 0) + 1);
        const source = options.source || Protocol.VolumeControlSource.EXTENSION;
        const control = Protocol.createManagedVolumeControl(safeVolume, source, nextRevision);
        // Same synchronous step as the commit's mutation, so the snapshot is exactly the prior record.
        const priorFields = snapshotVolumeCommitFields(state);
        let commitResult;
        try {
            commitResult = await commitTabVolumeControl(tabId, control, { immediate: true });
        } catch (error) {
            // The record changed before the write failed; the command is not delivered, so undo it.
            await revertUndeliveredVolumeCommit(tabId, control, priorFields);
            throw error;
        }
        if (commitResult?.accepted === false) {
            return { success: false, control: commitResult.control };
        }
        const nextState = tabState.get(tabId) || state;

        debouncedUpdateIcon(tabId, nextState.volume, nextState.corsAffectedCount);

        const payload = {
            requestedVolume: safeVolume,
            source: options.messageSource || 'background:remote-tab-control',
            issuedAt: Date.now()
        };

        let delivered = false;
        let deliveryError = null;
        try {
            delivered = await deliverToTab(tabId, {
                type: Messages.SET_VOLUME,
                payload
            }, 'setVolume', [payload]);
        } catch (error) {
            deliveryError = error;
        }

        if (!delivered) {
            await revertUndeliveredVolumeCommit(tabId, commitResult.control, priorFields);
            broadcastAudioStateChanged(tabId);
            if (deliveryError) {
                throw deliveryError;
            }
            return {
                success: false,
                error: 'Page controls unreachable',
                control: getTabVolumeControl(tabState.get(tabId))
            };
        }

        broadcastAudioStateChanged(tabId);

        return { success: true, control: commitResult.control };
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
        await ensureTabStateRestoredOrLog();
        if (isTabClosed(tabId)) {
            return { success: false, error: 'Tab closed' };
        }
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
        await deliverToTab(tabId, {
            type: Messages.SET_COMPRESSION,
            payload: normalizedSettings
        }, 'setCompressionSettings', [normalizedSettings]);

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

        await deliverToTab(tabId, {
            type: Messages.SET_GLOBAL_BALANCE,
            payload: normalizedSettings
        }, 'setGlobalBalance', [normalizedSettings]);

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
        await ensureTabStateRestoredOrLog();
        if (isTabClosed(tabId)) {
            return { success: false, error: 'Tab closed' };
        }
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

        await deliverCommandToTab(tabId, {
            type: Messages.SET_MUTE_STATE,
            payload: { muted: nextMuted }
        }, 'setMuteState', [nextMuted]);

        broadcastAudioStateChanged(tabId);
        return { success: true };
    } catch (error) {
        console.error(`Failed to set mute for tab ${tabId}:`, error);
        return { success: false, error: error.message };
    }
}

async function setExtensionEnabledForTab(tabId, enabled) {
    try {
        await ensureTabStateRestoredOrLog();
        if (isTabClosed(tabId)) {
            // Same outcome as a delivery to a tab that is already gone (see the catch below).
            return { success: true };
        }
        const nextEnabled = enabled !== false;
        const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        state.extensionEnabled = nextEnabled;
        tabState.set(tabId, state);
        schedulePersistTabState(tabId);
        debouncedUpdateIcon(tabId, state.volume ?? CONSTANTS.DEFAULT_VOLUME, state.corsAffectedCount ?? 0);

        await deliverCommandToTab(tabId, {
            type: Messages.SET_EXTENSION_ENABLED,
            payload: { enabled: nextEnabled }
        }, 'setExtensionEnabled', [nextEnabled]);

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

async function getStoredExtensionEnablePreferences() {
    const stored = await browser.storage.local.get([
        PreferenceKeys.EXTENSION_ENABLED,
        PreferenceKeys.DISABLED_SITES
    ]);
    return Protocol.normalizeExtensionPreferences(stored);
}

async function setGlobalExtensionEnabled(enabled) {
    const nextEnabled = enabled !== false;
    const preferences = await getStoredExtensionEnablePreferences();
    const tabs = await browser.tabs.query({});

    await Promise.allSettled(
        tabs
            .filter((tab) => tab?.id)
            .map((tab) => {
                const effective = nextEnabled && !Protocol.isSiteDisabled(tab.url, preferences.disabledSites);
                return setExtensionEnabledForTab(tab.id, effective);
            })
    );

    return { success: true };
}

async function setSiteExtensionEnabled(siteKey, enabled) {
    const normalizedKey = String(siteKey || '').trim().toLowerCase();
    if (!normalizedKey) {
        return { success: false, error: 'Missing siteKey' };
    }

    const nextSiteEnabled = enabled !== false;
    const preferences = await getStoredExtensionEnablePreferences();
    const nextDisabledSet = new Set(preferences.disabledSites);
    if (nextSiteEnabled) {
        nextDisabledSet.delete(normalizedKey);
    } else {
        nextDisabledSet.add(normalizedKey);
    }
    const nextDisabledSites = Protocol.normalizeDisabledSites(Array.from(nextDisabledSet));

    await browser.storage.local.set({
        [PreferenceKeys.DISABLED_SITES]: nextDisabledSites
    });

    const effectiveForSite = preferences.extensionEnabled !== false && nextSiteEnabled;
    const tabs = await browser.tabs.query({});
    await Promise.allSettled(
        tabs
            .filter((tab) => tab?.id && Protocol.getSiteKeyFromUrl(tab.url) === normalizedKey)
            .map((tab) => setExtensionEnabledForTab(tab.id, effectiveForSite))
    );

    return { success: true, disabledSites: nextDisabledSites };
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
        tabTitle: targetTab.title || '',
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
        tabTitle: targetTab.title || '',
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
    // Step from the managed target; telemetry only decides when the tab has no managed control.
    const currentVolume = resolveTabAuthoritativeVolume(state, state.volume);
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
        volumeBeforeMute: resolveTabAuthoritativeVolume(state, state.volume)
    });
}

async function handleCommand(command) {
    // The single barrier for every shortcut: they read `tabState`, which is empty after a wake.
    await ensureTabStateRestoredOrLog();

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

async function handleStatusUpdateMessage(message, sender) {
    const tabId = sender.tab.id;
    await ensureTabStateRestored();
    // A message that was waiting for the restore may belong to a tab that has since closed.
    if (isTabClosed(tabId)) return;
    const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
    // ISS-006: without cached frames the merge below sees only this frame. The cache is empty on a
    // new tab and after an event-page wake, which this code cannot tell apart, so a partial merge is
    // assumed only when a frame other than the top frame reports or the record already saw media.
    const hadCachedFrames = frameStatusCache.has(tabId);
    let payload = mergeCachedFrameStatusPayload(tabId, frameId, message.payload);

    // A recovered main frame clears a stale limited overlay: when frame 0 reports healthy media
    // while the merge still claims a limitation it does not report, the contradicting entries
    // come from siblings that went silent (a missed removal, or a probe that found no frames).
    // Siblings that reported within a hydrate interval are live multi-frame media and are kept;
    // a probe reconciles whatever the eviction leaves behind.
    if (frameId === 0 && isHealthyMainFramePayload(message.payload)) {
        const contradicts = (payload.statusDetail === 'limited' && message.payload?.statusDetail !== 'limited') ||
            (normalizeCorsCount(payload.corsAffectedCount) > 0 &&
                normalizeCorsCount(message.payload?.corsAffectedCount) === 0);
        if (contradicts && evictStaleCachedFramePayloads(tabId, frameId)) {
            payload = mergeFrameStatusPayloads(Array.from(frameStatusCache.get(tabId).values()), tabId);
            scheduleProbeTabStatus(tabId, 80);
        }
    }

    const currentState = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
    const partialColdMerge = !hadCachedFrames && (frameId !== 0 || recordHadMedia(currentState));
    const reportedHasMedia = mergedStatusHasMedia(payload);
    // A frame that reports no media must not erase what the record knew about other frames; the
    // probe scheduled below replaces these preserved values with the full merge.
    const preserveMedia = partialColdMerge && !reportedHasMedia && recordHadMedia(currentState);
    const corsCount = preserveMedia
        ? Math.max(normalizeCorsCount(payload.corsAffectedCount), normalizeCorsCount(currentState.corsAffectedCount))
        : normalizeCorsCount(payload.corsAffectedCount);
    const keepPriorStatus = preserveMedia && payload.status === 'no-media' &&
        (currentState.status === 'active' || currentState.status === 'inactive');
    const status = keepPriorStatus ? currentState.status : payload.status;

    const prevAudioActivity = computeHasAudioActivity(currentState);
    const volumeControl = getTabVolumeControl(currentState);
    const volume = resolveTabAuthoritativeVolume(
        currentState,
        preserveMedia ? currentState.volume : (payload.observedVolume ?? payload.volume)
    );

    // While a background mute or enable command is being delivered the record already holds the
    // commanded value, so this telemetry (captured before the page applied it) must not revert it.
    // Once the delivery is done the page's report applies again, which is how a player-UI unmute
    // reaches the record.
    const commandInFlight = isCommandDeliveryInFlight(tabId);

    // If user changes volume elsewhere after using mute toggle, clear muted state
    const nextMuted = commandInFlight
        ? Boolean(currentState.muted)
        : Boolean(payload.muted ?? currentState.muted ?? false);
    const nextExtensionEnabled = commandInFlight && typeof currentState.extensionEnabled === 'boolean'
        ? currentState.extensionEnabled
        : payload.extensionEnabled !== false;
    const nextVolumeBeforeMute = commandInFlight
        ? currentState.volumeBeforeMute
        : (nextMuted
            ? (currentState.muted
                ? (currentState.volumeBeforeMute ?? currentState.volume ?? volume)
                : (currentState.volume ?? volume))
            : undefined);

    // Determine if tab has media (for showing in Other Tabs list)
    const hasMedia = reportedHasMedia || (preserveMedia && currentState.hasMedia === true);

    // Update tracked state including tab info and compression state
    tabState.set(tabId, {
        ...currentState,
        volume,
        // Keep a real managed control; otherwise mirror telemetry as unmanaged revision 0.
        volumeControl: Protocol.isManagedVolumeControl(volumeControl)
            ? volumeControl
            : Protocol.createUnmanagedVolumeControl(volume),
        extensionEnabled: nextExtensionEnabled,
        monoEnabled: payload.monoEnabled ?? currentState.monoEnabled ?? CONSTANTS.DEFAULT_MONO_ENABLED,
        balance: payload.balance ?? currentState.balance ?? CONSTANTS.DEFAULT_BALANCE,
        corsAffectedCount: corsCount,
        status: status,
        // Explicit null must clear transitional details like "setting-up".
        statusDetail: Protocol.coalesceExplicit(payload.statusDetail, currentState.statusDetail, null),
        hasMedia: hasMedia,
        muted: nextMuted,
        volumeBeforeMute: nextVolumeBeforeMute,
        lastSeenAt: Date.now(),
        // Only what this frame reported is fresh evidence; a preserved flag is not.
        lastMediaSeenAt: getNextLastMediaSeenAt(currentState, reportedHasMedia),
        compressionEnabled: payload.compressionEnabled ?? currentState.compressionEnabled ?? false,
        compressionThreshold: payload.compressionThreshold ?? currentState.compressionThreshold ?? -18,
        compressionRatio: payload.compressionRatio ?? currentState.compressionRatio ?? 6,
        compressionKnee: payload.compressionKnee ?? currentState.compressionKnee ?? 3,
        audioSettingsAvailable: payload.audioSettingsAvailable ?? currentState.audioSettingsAvailable ?? true,
        audioSettingsReason: (payload.audioSettingsAvailable ?? currentState.audioSettingsAvailable ?? true)
            ? null
            : Protocol.coalesceExplicit(payload.audioSettingsReason, currentState.audioSettingsReason, null),
        title: sender.tab.title || currentState.title || '',
        favIconUrl: sender.tab.favIconUrl || currentState.favIconUrl || '',
        url: sender.tab.url || currentState.url || '',
        windowId: sender.tab.windowId
    });

    schedulePersistTabState(tabId);

    const nextAudioActivity = computeHasAudioActivity(tabState.get(tabId));
    if (prevAudioActivity !== nextAudioActivity) {
        broadcastAudioStateChanged(tabId);
    }

    const nextState = tabState.get(tabId);
    const previousDisplayVolume = getDisplayedVolumeForState(currentState);
    const nextDisplayVolume = getDisplayedVolumeForState(nextState);
    const shouldUpdateIcon = !currentState.lastSeenAt ||
        currentState.volume !== volume ||
        previousDisplayVolume !== nextDisplayVolume ||
        currentState.volumeControl?.revision !== nextState.volumeControl?.revision ||
        currentState.volumeControl?.targetVolume !== nextState.volumeControl?.targetVolume ||
        currentState.corsAffectedCount !== corsCount ||
        Boolean(currentState.muted) !== nextMuted ||
        currentState.extensionEnabled !== nextExtensionEnabled ||
        currentState.status !== status ||
        currentState.statusDetail !== nextState.statusDetail ||
        currentState.hasMedia !== hasMedia;

    // Also paint on the first managed status transition, even when volume is still 100%.
    if (shouldUpdateIcon) {
        debouncedUpdateIcon(tabId, volume, corsCount);
    }

    if (partialColdMerge) {
        scheduleProbeTabStatus(tabId, 80);
    }
}

/**
 * Run an async message handler and always answer, so a thrown error never leaves
 * the sender waiting on a channel that was kept open with `return true`.
 */
function respondAsync(sendResponse, label, task) {
    Promise.resolve()
        .then(task)
        .then(sendResponse, (error) => {
            console.error(`${label} failed:`, error);
            sendResponse({ success: false, error: error?.message || String(error) });
        });
    return true;
}

/**
 * Handle messages from content scripts and popup
 */
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === Messages.REPORT_PLAYER_VOLUME_INTENT) {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ relayed: false });
            return;
        }
        const requestedPhase = message.payload?.phase;
        const phase = ['start', 'move', 'end', 'cancel'].includes(requestedPhase)
            ? requestedPhase
            : 'pulse';

        browser.tabs.sendMessage(tabId, {
            type: Messages.PLAYER_VOLUME_INTENT,
            payload: {
                issuedAt: Date.now(),
                originFrameId: typeof sender.frameId === 'number' ? sender.frameId : 0,
                phase,
                gestureId: message.payload?.gestureId == null
                    ? null
                    : String(message.payload.gestureId).slice(0, 128),
                sequence: Math.max(0, Math.floor(Number(message.payload?.sequence) || 0))
            }
        }).then(
            () => sendResponse({ relayed: true }),
            () => sendResponse({ relayed: false })
        );
        return true;
    }

    if (message.type === Messages.GET_TAB_VOLUME_CONTROL) {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ control: Protocol.createUnmanagedVolumeControl() });
            return;
        }
        (async () => {
            try {
                await ensureTabStateRestored();
                const state = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
                sendResponse({ control: getTabVolumeControl(state) });
            } catch (error) {
                sendResponse({ control: Protocol.createUnmanagedVolumeControl() });
            }
        })();
        return true;
    }

    if (message.type === Messages.COMMIT_TAB_VOLUME_CONTROL) {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ accepted: false });
            return;
        }
        (async () => {
            try {
                await ensureTabStateRestored();
                const result = await commitTabVolumeControl(tabId, message.payload?.control, { immediate: true });
                if (result?.accepted && result.control && result.unchanged !== true) {
                    void browser.tabs.sendMessage(tabId, {
                        type: Messages.TAB_VOLUME_CONTROL_UPDATED,
                        payload: {
                            control: result.control,
                            originFrameId: typeof sender.frameId === 'number' ? sender.frameId : 0
                        }
                    }).catch(() => {});
                }
                sendResponse(result);
            } catch (error) {
                sendResponse({ accepted: false, error: error?.message || String(error) });
            }
        })();
        return true;
    }

    if (message.type === Messages.FRAME_STATUS_REMOVED && sender.tab?.id) {
        const tabId = sender.tab.id;
        const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
        const hadCachedFrames = frameStatusCache.has(tabId);
        if (removeCachedFrameStatusPayload(tabId, frameId)) {
            scheduleProbeTabStatus(tabId, 50);
        } else if (!hadCachedFrames) {
            scheduleProbeForColdFrameRemoval(tabId).catch(() => {});
        }
        return;
    }

    if (message.type === Messages.STATUS_UPDATE && sender.tab && sender.tab.id) {
        handleStatusUpdateMessage(message, sender).catch((error) => {
            console.error('STATUS_UPDATE failed:', error);
        });
        return;
    }
    
    // Retired (ISS-007): nothing sends VOLUME_UPDATE any more. A volume command must be delivered
    // to the page by `setVolumeForTab`; committing a managed control here would claim a volume the
    // page never received. The constant stays in the protocol for compatibility, and the message is
    // ignored without a response, like STATUS_UPDATE.
    if (message.type === Messages.VOLUME_UPDATE) {
        return;
    }

    if (message.type === Messages.GET_AUDIO_TABS) {
        if (isContentScriptSender(sender)) {
            return;
        }
        const excludeTabId = message.payload?.excludeTabId ?? null;
        const forceHydrate = Boolean(message.payload?.forceHydrate);
        (async () => {
            try {
                await ensureTabStateRestored();
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
        if (isContentScriptSender(sender)) {
            return;
        }
        const tabId = message.payload?.tabId;
        const forceProbe = Boolean(message.payload?.forceProbe);
        (async () => {
            try {
                await ensureTabStateRestored();
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
        if (isContentScriptSender(sender)) {
            return;
        }
        const targetTabId = message.payload?.tabId;
        const volume = message.payload?.volume ?? CONSTANTS.DEFAULT_VOLUME;
        
        if (targetTabId) {
            return respondAsync(sendResponse, 'SET_REMOTE_TAB_VOLUME', async () => {
                await ensureTabStateRestored();
                return setVolumeForTab(targetTabId, volume, {
                    source: Protocol.VolumeControlSource.EXTENSION,
                    messageSource: message.payload?.source || 'background:remote-tab-control'
                });
            });
        }
    }

    if (message.type === Messages.SET_REMOTE_TAB_COMPRESSION) {
        if (isContentScriptSender(sender)) {
            return;
        }
        const targetTabId = message.payload?.tabId;
        const settings = message.payload?.settings;
        
        if (targetTabId && settings) {
            return respondAsync(sendResponse, 'SET_REMOTE_TAB_COMPRESSION', async () => {
                await ensureTabStateRestored();
                return setCompressionForTab(targetTabId, settings);
            });
        }
    }

    if (message.type === Messages.SET_GLOBAL_EXTENSION_ENABLED) {
        if (isContentScriptSender(sender)) {
            return;
        }
        const enabled = message.payload?.enabled !== false;
        return respondAsync(sendResponse, 'SET_GLOBAL_EXTENSION_ENABLED', async () => {
            await ensureTabStateRestored();
            return setGlobalExtensionEnabled(enabled);
        });
    }

    if (message.type === Messages.SET_SITE_EXTENSION_ENABLED) {
        if (isContentScriptSender(sender)) {
            return;
        }
        const siteKey = message.payload?.siteKey;
        const enabled = message.payload?.enabled !== false;
        return respondAsync(sendResponse, 'SET_SITE_EXTENSION_ENABLED', async () => {
            await ensureTabStateRestored();
            return setSiteExtensionEnabled(siteKey, enabled);
        });
    }

    if (message.type === Messages.SET_GLOBAL_BALANCE) {
        if (isContentScriptSender(sender)) {
            return;
        }
        return respondAsync(sendResponse, 'SET_GLOBAL_BALANCE', async () => {
            await ensureTabStateRestored();
            return setGlobalBalance(message.payload);
        });
    }

    if (message.type === Messages.SET_TAB_MUTE_STATE) {
        if (isContentScriptSender(sender)) {
            return;
        }
        const targetTabId = message.payload?.tabId;
        const muted = message.payload?.muted;
        const volumeBeforeMute = message.payload?.volumeBeforeMute;
        
        if (targetTabId === undefined) {
            sendResponse({ success: false, error: 'Missing tabId' });
            return;
        }
        return respondAsync(sendResponse, 'SET_TAB_MUTE_STATE', async () => {
            await ensureTabStateRestored();
            return setMuteForTabWithOptions(targetTabId, muted, { volumeBeforeMute });
        });
    }

    if (message.type === Messages.FOCUS_TAB) {
        if (isContentScriptSender(sender)) {
            return;
        }
        const targetTabId = message.payload?.tabId;
        const windowId = message.payload?.windowId;

        if (targetTabId) {
            (async () => {
                try {
                    if (windowId) {
                        await browser.windows.update(windowId, { focused: true });
                    }
                    await browser.tabs.update(targetTabId, { active: true });
                    sendResponse({ success: true });
                } catch (error) {
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }
    }
});

/**
 * Clean up when tabs are closed
 */
async function handleTabRemoved(tabId) {
    // Record the close first and synchronously, so every async writer that resumes from now on
    // skips this id; the restore below may still be in flight after a cold wake.
    markTabClosed(tabId);
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

    // The record is read and deleted only after the restore, so a restore that is still running
    // cannot seed a closed tab back in (G3). The stored entry goes through the same persist chain.
    await ensureTabStateRestoredOrLog();
    tabState.delete(tabId);
    await removePersistedTabState(tabId);
}

browser.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId).catch((error) => {
        console.warn('tabs.onRemoved handling failed:', error);
    });
});

/**
 * Reset icon when tab URL changes (navigation) or update tab info
 */
// Ignore update events that cannot affect icon or tab-state metadata.
async function handleTabUpdated(tabId, changeInfo, tab) {
    if (!changeInfo.status && !changeInfo.title && !changeInfo.favIconUrl && typeof changeInfo.audible !== 'boolean') return;
    if (isTabClosed(tabId)) return;

    // Everything below reads or writes `tabState`, which is empty until the restore has run (G3).
    await ensureTabStateRestoredOrLog();
    if (isTabClosed(tabId)) return;

    if (changeInfo.status === 'loading') {
        clearCachedFrameStatusPayloads(tabId);

        const enablePrefs = await getStoredExtensionEnablePreferences().catch(() => ({
            extensionEnabled: true,
            disabledSites: []
        }));
        const shouldBeEnabled = enablePrefs.extensionEnabled !== false &&
            !Protocol.isSiteDisabled(tab?.url, enablePrefs.disabledSites);

        // Navigation can temporarily silence content scripts; keep last-known per-tab settings
        // so the toolbar icon doesn't incorrectly snap to 100%.
        const prev = tabState.get(tabId) || { volume: CONSTANTS.DEFAULT_VOLUME, corsAffectedCount: 0 };
        tabState.set(tabId, {
            ...prev,
            title: tab?.title || prev.title || '',
            favIconUrl: tab?.favIconUrl || prev.favIconUrl || '',
            url: tab?.url || prev.url || '',
            windowId: tab?.windowId,
            extensionEnabled: shouldBeEnabled,
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
        const hint = resolveAudibleHint(tabId, state, changeInfo.audible);
        tabState.set(tabId, {
            ...state,
            title: tab.title || state.title || '',
            favIconUrl: tab.favIconUrl || state.favIconUrl || '',
            url: tab.url || state.url || '',
            windowId: tab.windowId,
            hasMedia: hint.hasMedia,
            status: hint.status,
            lastMediaSeenAt: hint.fresh ? getNextLastMediaSeenAt(state, hint.hasMedia) : state.lastMediaSeenAt,
            lastSeenAt: Date.now()
        });

        const nextAudioActivity = computeHasAudioActivity(tabState.get(tabId));
        if (prevAudioActivity !== nextAudioActivity) {
            broadcastAudioStateChanged(tabId);
        }

        // Going silent is not proof that the media is gone: ask the frames what they now report.
        if (tab?.url && /^(https?|file):/i.test(tab.url)) {
            scheduleProbeTabStatus(tabId, changeInfo.audible ? 80 : 120);
        }
    }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    handleTabUpdated(tabId, changeInfo, tab).catch((error) => {
        console.warn('tabs.onUpdated handling failed:', error);
    });
});

/**
 * Update icon when switching tabs to show correct volume for that tab
 */
browser.tabs.onActivated.addListener(async (activeInfo) => {
    const tabId = activeInfo.tabId;

    // Background-context restarts wipe in-memory state; the restore runs before any read (G3).
    await ensureTabStateRestoredOrLog();
    if (isTabClosed(tabId)) return;
    const state = tabState.get(tabId);

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

browser.tabs.onCreated?.addListener?.((tab) => {
    // Creation is positive evidence the id is live: a reused id must not stay closed-guarded.
    if (tab?.id) {
        recentlyClosedTabIds.delete(tab.id);
    }
});

browser.tabs.onAttached?.addListener?.((tabId) => {
    // Attaching across windows keeps the id and proves the tab is open.
    if (tabId) {
        recentlyClosedTabIds.delete(tabId);
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
        if (I18n?.init) {
            await I18n.init();
            I18n.startStorageSync?.();
            I18n.subscribe?.(() => {
                tabState.forEach((state, tabId) => {
                    updateIcon(
                        tabId,
                        state?.volume ?? CONSTANTS.DEFAULT_VOLUME,
                        state?.corsAffectedCount ?? 0,
                        { showDefault: true }
                    );
                });
            });
        }

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
        await ensureTabStateRestored();

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

