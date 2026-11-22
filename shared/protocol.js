(function(root) {
    const CONSTANTS = Object.freeze({
        MIN_VOLUME: 0,
        MAX_VOLUME: 500,
        DEFAULT_VOLUME: 100,
        DEFAULT_MONO_ENABLED: false,
        DEFAULT_BALANCE: 0,
        BALANCE_MIN: -100,
        BALANCE_MAX: 100,
        DEFAULT_COMPRESSION_THRESHOLD: -18,
        DEFAULT_COMPRESSION_RATIO: 6,
        DEFAULT_COMPRESSION_KNEE: 3,
        COMPRESSION_THRESHOLD_MIN: -50,
        COMPRESSION_THRESHOLD_MAX: -10,
        COMPRESSION_RATIO_MIN: 2,
        COMPRESSION_RATIO_MAX: 12,
        COMPRESSION_KNEE_MIN: 0,
        COMPRESSION_KNEE_MAX: 20
    });

    const PreferenceKeys = Object.freeze({
        EXTENSION_ENABLED: 'extensionEnabled',
        DEFAULT_COMPRESSION_ENABLED: 'defaultCompressionEnabled',
        DEFAULT_MONO_ENABLED: 'defaultMonoEnabled',
        DEFAULT_BALANCE_ENABLED: 'defaultBalanceEnabled',
        DEFAULT_BALANCE: 'defaultBalance'
    });

    const VolumeControlMode = Object.freeze({
        UNMANAGED: 'unmanaged',
        MANAGED: 'managed'
    });

    const VolumeControlSource = Object.freeze({
        EXTENSION: 'extension',
        PLAYER_USER: 'player-user',
        PLAYER_INITIAL: 'player-initial',
        RESTORED: 'restored',
        LEGACY: 'legacy'
    });

    const Messages = Object.freeze({
        STATUS_UPDATE: 'STATUS_UPDATE',
        FRAME_STATUS_REMOVED: 'FRAME_STATUS_REMOVED',
        GET_STATUS: 'GET_STATUS',
        GET_TAB_STATUS: 'GET_TAB_STATUS',
        GET_TAB_VOLUME_CONTROL: 'GET_TAB_VOLUME_CONTROL',
        COMMIT_TAB_VOLUME_CONTROL: 'COMMIT_TAB_VOLUME_CONTROL',
        TAB_VOLUME_CONTROL_UPDATED: 'TAB_VOLUME_CONTROL_UPDATED',
        REPORT_PLAYER_VOLUME_INTENT: 'REPORT_PLAYER_VOLUME_INTENT',
        PLAYER_VOLUME_INTENT: 'PLAYER_VOLUME_INTENT',
        SET_VOLUME: 'SET_VOLUME',
        SET_COMPRESSION: 'SET_COMPRESSION',
        SET_AUDIO_SETTINGS: 'SET_AUDIO_SETTINGS',
        SET_GLOBAL_BALANCE: 'SET_GLOBAL_BALANCE',
        SET_MUTE_STATE: 'SET_MUTE_STATE',
        VOLUME_UPDATE: 'VOLUME_UPDATE',
        GET_AUDIO_TABS: 'GET_AUDIO_TABS',
        SET_REMOTE_TAB_VOLUME: 'SET_REMOTE_TAB_VOLUME',
        SET_REMOTE_TAB_COMPRESSION: 'SET_REMOTE_TAB_COMPRESSION',
        SET_TAB_MUTE_STATE: 'SET_TAB_MUTE_STATE',
        SET_EXTENSION_ENABLED: 'SET_EXTENSION_ENABLED',
        SET_GLOBAL_EXTENSION_ENABLED: 'SET_GLOBAL_EXTENSION_ENABLED',
        FOCUS_TAB: 'FOCUS_TAB',
        TAB_AUDIO_STATE_CHANGED: 'TAB_AUDIO_STATE_CHANGED'
    });

    const STATUS_PRIORITY = Object.freeze({
        disabled: 5,
        active: 4,
        error: 3,
        inactive: 2,
        'no-media': 1
    });

    // Higher = more settled / preferred when top-level status priority is equal.
    // Transitional details (setting-up / connecting) must lose to a healthy Connected payload.
    const STATUS_DETAIL_PRIORITY = Object.freeze({
        'manual-disabled': 60,
        limited: 55,
        paused: 40,
        error: 30,
        'no-source': 20,
        detecting: 15,
        'setting-up': 5,
        connecting: 5
    });
    const NATIVE_PERCENT_SNAP_EPSILON = 1e-7;

    function statusDetailPriority(statusDetail) {
        if (statusDetail == null) {
            return 50;
        }
        return STATUS_DETAIL_PRIORITY[statusDetail] ?? 25;
    }

    function statusPayloadHasMedia(payload) {
        const source = payload && typeof payload === 'object' ? payload : {};
        return source.status === 'active' ||
            source.status === 'inactive' ||
            source.status === 'error' ||
            (source.elementCounts && Number(source.elementCounts.total) > 0);
    }

    /**
     * Prefer an explicit next value (including null) over a previous sticky value.
     * Only fall back when the next value is undefined / missing.
     */
    function coalesceExplicit(nextValue, previousValue, fallback = null) {
        if (nextValue !== undefined) {
            return nextValue;
        }
        return previousValue !== undefined ? previousValue : fallback;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function parseFiniteNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    function normalizeVolume(value, fallback = CONSTANTS.DEFAULT_VOLUME) {
        const candidate = parseFiniteNumber(value);
        if (candidate === undefined) {
            return fallback;
        }
        return clamp(Math.round(candidate), CONSTANTS.MIN_VOLUME, CONSTANTS.MAX_VOLUME);
    }

    function floorWithNearIntegerSnap(value) {
        const nearestInteger = Math.round(value);
        return Math.abs(value - nearestInteger) <= NATIVE_PERCENT_SNAP_EPSILON
            ? nearestInteger
            : Math.floor(value);
    }

    /**
     * Convert HTMLMediaElement.volume (0..1) to a whole native percent.
     * Floor real fractional steps so the extension never displays the next
     * percent before the player reaches it, while snapping tiny IEEE-754 noise
     * around exact hundredths back to the intended integer.
     */
    function nativeVolumeToPercent(value, fallback = CONSTANTS.DEFAULT_VOLUME) {
        const candidate = parseFiniteNumber(value);
        if (candidate === undefined) {
            return clamp(normalizeVolume(fallback), CONSTANTS.MIN_VOLUME, CONSTANTS.DEFAULT_VOLUME);
        }

        const scaled = clamp(candidate, 0, 1) * CONSTANTS.DEFAULT_VOLUME;
        const wholePercent = floorWithNearIntegerSnap(scaled);
        return clamp(wholePercent, CONSTANTS.MIN_VOLUME, CONSTANTS.DEFAULT_VOLUME);
    }

    function normalizeObservedVolume(value, fallback = CONSTANTS.DEFAULT_VOLUME) {
        const candidate = parseFiniteNumber(value);
        if (candidate === undefined) {
            return clamp(normalizeVolume(fallback), CONSTANTS.MIN_VOLUME, CONSTANTS.DEFAULT_VOLUME);
        }
        return clamp(
            floorWithNearIntegerSnap(candidate),
            CONSTANTS.MIN_VOLUME,
            CONSTANTS.DEFAULT_VOLUME
        );
    }

    function normalizeBalance(value, fallback = CONSTANTS.DEFAULT_BALANCE) {
        const candidate = parseFiniteNumber(value);
        if (candidate === undefined) {
            return fallback;
        }
        return clamp(Math.round(candidate), CONSTANTS.BALANCE_MIN, CONSTANTS.BALANCE_MAX);
    }

    function normalizeCorsCount(value) {
        const candidate = parseFiniteNumber(value);
        if (candidate === undefined || candidate <= 0) {
            return 0;
        }
        return Math.max(0, Math.floor(candidate));
    }

    function sanitizeVolumeInput(value) {
        return String(value || '').replace(/\D/g, '');
    }

    function summarizeObjectPayload(payload) {
        if (!payload || typeof payload !== 'object') {
            return payload;
        }

        const summary = {};
        for (const key of Object.keys(payload)) {
            const value = payload[key];
            if (value === null) {
                summary[key] = null;
            } else if (typeof value === 'object') {
                summary[key] = '[object]';
            } else {
                summary[key] = value;
            }
        }
        return summary;
    }

    function parseVolumeCommandPayload(payload) {
        if (typeof payload === 'object' && payload !== null) {
            const requested = payload.requestedVolume ?? payload.volume ?? payload.value ?? payload.percent ?? payload.target ?? payload.amount;
            return {
                requestedVolume: parseFiniteNumber(requested),
                source: payload.reason || payload.source || payload.from || 'unspecified',
                summary: summarizeObjectPayload(payload)
            };
        }

        return {
            requestedVolume: parseFiniteNumber(payload),
            source: 'direct-call',
            summary: payload
        };
    }

    function normalizeCompressionSettings(settings, options = {}) {
        const { partial = false } = options;
        const source = settings && typeof settings === 'object' ? settings : {};
        const normalized = partial
            ? {}
            : {
                enabled: false,
                threshold: CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD,
                ratio: CONSTANTS.DEFAULT_COMPRESSION_RATIO,
                knee: CONSTANTS.DEFAULT_COMPRESSION_KNEE
            };

        if (Object.prototype.hasOwnProperty.call(source, 'enabled')) {
            normalized.enabled = Boolean(source.enabled);
        }

        if (Object.prototype.hasOwnProperty.call(source, 'threshold')) {
            const threshold = parseFiniteNumber(source.threshold);
            normalized.threshold = threshold === undefined
                ? CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD
                : clamp(Math.round(threshold), CONSTANTS.COMPRESSION_THRESHOLD_MIN, CONSTANTS.COMPRESSION_THRESHOLD_MAX);
        }

        if (Object.prototype.hasOwnProperty.call(source, 'ratio')) {
            const ratio = parseFiniteNumber(source.ratio);
            normalized.ratio = ratio === undefined
                ? CONSTANTS.DEFAULT_COMPRESSION_RATIO
                : clamp(Math.round(ratio), CONSTANTS.COMPRESSION_RATIO_MIN, CONSTANTS.COMPRESSION_RATIO_MAX);
        }

        if (Object.prototype.hasOwnProperty.call(source, 'knee')) {
            const knee = parseFiniteNumber(source.knee);
            normalized.knee = knee === undefined
                ? CONSTANTS.DEFAULT_COMPRESSION_KNEE
                : clamp(Math.round(knee), CONSTANTS.COMPRESSION_KNEE_MIN, CONSTANTS.COMPRESSION_KNEE_MAX);
        }

        return normalized;
    }

    function normalizeGlobalBalanceSettings(settings, options = {}) {
        const { partial = false } = options;
        const source = settings && typeof settings === 'object' ? settings : {};
        const normalized = partial
            ? {}
            : {
                enabled: false,
                balance: CONSTANTS.DEFAULT_BALANCE
            };

        if (Object.prototype.hasOwnProperty.call(source, 'enabled')) {
            normalized.enabled = Boolean(source.enabled);
        }

        if (Object.prototype.hasOwnProperty.call(source, 'balance')) {
            normalized.balance = normalizeBalance(source.balance, CONSTANTS.DEFAULT_BALANCE);
        }

        return normalized;
    }

    function normalizeExtensionPreferences(settings) {
        const source = settings && typeof settings === 'object' ? settings : {};

        return {
            extensionEnabled: typeof source[PreferenceKeys.EXTENSION_ENABLED] === 'boolean'
                ? source[PreferenceKeys.EXTENSION_ENABLED]
                : true,
            defaultCompressionEnabled: Boolean(source[PreferenceKeys.DEFAULT_COMPRESSION_ENABLED]),
            defaultMonoEnabled: Boolean(source[PreferenceKeys.DEFAULT_MONO_ENABLED]),
            defaultBalanceEnabled: Boolean(source[PreferenceKeys.DEFAULT_BALANCE_ENABLED]),
            defaultBalance: normalizeBalance(source[PreferenceKeys.DEFAULT_BALANCE], CONSTANTS.DEFAULT_BALANCE)
        };
    }

    function resolveInitialPageState(input = {}) {
        const session = input.session && typeof input.session === 'object' ? input.session : {};
        const preferences = normalizeExtensionPreferences(input.preferences);

        const monoWasStored = Boolean(session.monoWasStored);
        const balanceWasStored = Boolean(session.balanceWasStored);
        const compressionWasStored = Boolean(session.compressionWasStored);

        const monoEnabled = monoWasStored
            ? Boolean(session.monoEnabled)
            : Boolean(preferences.defaultMonoEnabled);
        const balance = preferences.defaultBalanceEnabled
            ? normalizeBalance(preferences.defaultBalance, CONSTANTS.DEFAULT_BALANCE)
            : (balanceWasStored
                ? normalizeBalance(session.balance, CONSTANTS.DEFAULT_BALANCE)
                : CONSTANTS.DEFAULT_BALANCE);
        const compressionEnabled = compressionWasStored
            ? Boolean(session.compressionEnabled)
            : Boolean(preferences.defaultCompressionEnabled);

        return {
            extensionEnabled: preferences.extensionEnabled !== false,
            monoEnabled,
            balance,
            compressionEnabled,
            monoInitialised: monoWasStored || Boolean(preferences.defaultMonoEnabled),
            balanceInitialised: balanceWasStored,
            compressionInitialised: compressionWasStored || Boolean(preferences.defaultCompressionEnabled)
        };
    }

    function normalizeAudioSettings(settings, options = {}) {
        const { partial = false } = options;
        const source = settings && typeof settings === 'object' ? settings : {};
        const normalized = partial
            ? {}
            : {
                monoEnabled: CONSTANTS.DEFAULT_MONO_ENABLED,
                balance: CONSTANTS.DEFAULT_BALANCE
            };

        if (Object.prototype.hasOwnProperty.call(source, 'monoEnabled')) {
            normalized.monoEnabled = Boolean(source.monoEnabled);
        }

        if (Object.prototype.hasOwnProperty.call(source, 'balance')) {
            normalized.balance = normalizeBalance(source.balance, CONSTANTS.DEFAULT_BALANCE);
        }

        return normalized;
    }

    function normalizeAudioSettingsAvailability(value, fallback = true) {
        if (typeof value === 'boolean') {
            return value;
        }
        return fallback;
    }

    function createUnmanagedVolumeControl(fallbackVolume = CONSTANTS.DEFAULT_VOLUME) {
        return {
            mode: VolumeControlMode.UNMANAGED,
            targetVolume: normalizeVolume(fallbackVolume, CONSTANTS.DEFAULT_VOLUME),
            source: null,
            revision: 0
        };
    }

    function createManagedVolumeControl(targetVolume, source, revision = 1) {
        return {
            mode: VolumeControlMode.MANAGED,
            targetVolume: normalizeVolume(targetVolume, CONSTANTS.DEFAULT_VOLUME),
            source: source || VolumeControlSource.EXTENSION,
            revision: Math.max(1, Math.floor(Number(revision) || 1))
        };
    }

    function normalizeVolumeControl(input, fallbackVolume = CONSTANTS.DEFAULT_VOLUME) {
        const source = input && typeof input === 'object' ? input : {};
        const fallback = createUnmanagedVolumeControl(fallbackVolume);

        if (source.mode === VolumeControlMode.MANAGED) {
            return createManagedVolumeControl(
                source.targetVolume ?? fallback.targetVolume,
                source.source ?? VolumeControlSource.EXTENSION,
                source.revision ?? 1
            );
        }

        return {
            mode: VolumeControlMode.UNMANAGED,
            targetVolume: normalizeVolume(source.targetVolume ?? fallback.targetVolume, fallback.targetVolume),
            source: null,
            revision: Math.max(0, Math.floor(Number(source.revision) || 0))
        };
    }

    function isManagedVolumeControl(control) {
        return Boolean(control && control.mode === VolumeControlMode.MANAGED);
    }

    function volumeControlsEqual(left, right) {
        return Boolean(
            left &&
            right &&
            left.mode === right.mode &&
            left.targetVolume === right.targetVolume &&
            left.source === right.source &&
            Math.floor(Number(left.revision) || 0) === Math.floor(Number(right.revision) || 0)
        );
    }

    function shouldAcceptVolumeControlUpdate(current, incoming, options = {}) {
        const allowEqualDifferent = options.allowEqualDifferent !== false;
        if (!incoming || typeof incoming !== 'object') {
            return false;
        }
        if (!current) {
            return true;
        }
        const currentRevision = Math.floor(Number(current.revision) || 0);
        const incomingRevision = Math.floor(Number(incoming.revision) || 0);
        if (incomingRevision > currentRevision) {
            return true;
        }
        if (incomingRevision < currentRevision) {
            return false;
        }
        if (volumeControlsEqual(current, incoming)) {
            return true;
        }
        return allowEqualDifferent;
    }

    function volumeControlToOwnership(control) {
        if (!isManagedVolumeControl(control)) {
            return 'unowned';
        }
        switch (control.source) {
            case VolumeControlSource.PLAYER_USER:
                return 'player-user';
            case VolumeControlSource.PLAYER_INITIAL:
                return 'player-initial';
            case VolumeControlSource.RESTORED:
            case VolumeControlSource.LEGACY:
                return 'restored';
            case VolumeControlSource.EXTENSION:
            default:
                return 'extension';
        }
    }

    function resolveAuthoritativeVolume(volumeControl, telemetryVolume, fallback = CONSTANTS.DEFAULT_VOLUME) {
        if (isManagedVolumeControl(volumeControl)) {
            return volumeControl.targetVolume;
        }
        if (Number.isFinite(Number(telemetryVolume))) {
            return normalizeVolume(telemetryVolume, fallback);
        }
        return normalizeVolume(fallback, CONSTANTS.DEFAULT_VOLUME);
    }

    function normalizeStatusPayload(payload, fallback = {}) {
        const source = payload && typeof payload === 'object' ? payload : {};
        const defaults = fallback && typeof fallback === 'object' ? fallback : {};
        const observedVolume = source.observedVolume !== undefined
            ? normalizeObservedVolume(source.observedVolume, defaults.observedVolume ?? defaults.volume ?? CONSTANTS.DEFAULT_VOLUME)
            : undefined;

        return {
            status: source.status || defaults.status || 'inactive',
            statusDetail: coalesceExplicit(source.statusDetail, defaults.statusDetail, null),
            volume: normalizeVolume(source.volume, defaults.volume ?? CONSTANTS.DEFAULT_VOLUME),
            observedVolume,
            extensionEnabled: typeof source.extensionEnabled === 'boolean'
                ? source.extensionEnabled
                : (typeof defaults.extensionEnabled === 'boolean' ? defaults.extensionEnabled : true),
            muted: Boolean(source.muted ?? defaults.muted ?? false),
            monoEnabled: source.monoEnabled ?? defaults.monoEnabled ?? CONSTANTS.DEFAULT_MONO_ENABLED,
            balance: normalizeBalance(source.balance, defaults.balance ?? CONSTANTS.DEFAULT_BALANCE),
            compressionEnabled: source.compressionEnabled ?? defaults.compressionEnabled ?? false,
            compressionThreshold: source.compressionThreshold ?? defaults.compressionThreshold ?? CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD,
            compressionRatio: source.compressionRatio ?? defaults.compressionRatio ?? CONSTANTS.DEFAULT_COMPRESSION_RATIO,
            compressionKnee: source.compressionKnee ?? defaults.compressionKnee ?? CONSTANTS.DEFAULT_COMPRESSION_KNEE,
            audioSettingsAvailable: normalizeAudioSettingsAvailability(
                source.audioSettingsAvailable,
                defaults.audioSettingsAvailable ?? true
            ),
            audioSettingsReason: coalesceExplicit(source.audioSettingsReason, defaults.audioSettingsReason, null),
            corsAffectedCount: normalizeCorsCount(source.corsAffectedCount ?? defaults.corsAffectedCount),
            elementCounts: source.elementCounts ?? defaults.elementCounts
        };
    }

    function isPreferredStatusPayload(candidate, current) {
        const candidatePriority = STATUS_PRIORITY[candidate.status] || 0;
        const currentPriority = STATUS_PRIORITY[current.status] || 0;
        if (candidatePriority !== currentPriority) {
            return candidatePriority > currentPriority;
        }

        const candidateActive = Number(candidate.elementCounts?.active) || 0;
        const currentActive = Number(current.elementCounts?.active) || 0;
        if (candidateActive !== currentActive) {
            return candidateActive > currentActive;
        }

        const candidateDetailPriority = statusDetailPriority(candidate.statusDetail);
        const currentDetailPriority = statusDetailPriority(current.statusDetail);
        if (candidateDetailPriority !== currentDetailPriority) {
            return candidateDetailPriority > currentDetailPriority;
        }

        const candidateTotal = Number(candidate.elementCounts?.total) || 0;
        const currentTotal = Number(current.elementCounts?.total) || 0;
        return candidateTotal > currentTotal;
    }

    function mergeStatusPayloads(payloads, fallback = {}, volumeControl = null) {
        const defaults = normalizeStatusPayload(undefined, fallback);
        const normalizedPayloads = (payloads || [])
            .map((payload) => normalizeStatusPayload(payload?.payload ?? payload, defaults));

        if (normalizedPayloads.length === 0) {
            const empty = { ...defaults };
            if (isManagedVolumeControl(volumeControl)) {
                empty.volume = volumeControl.targetVolume;
            }
            return empty;
        }

        let bestPayload = normalizedPayloads[0];
        for (const payload of normalizedPayloads.slice(1)) {
            if (isPreferredStatusPayload(payload, bestPayload)) {
                bestPayload = payload;
            }
        }

        const merged = normalizeStatusPayload(bestPayload, defaults);
        const preferredObserved = bestPayload.observedVolume ?? bestPayload.volume;
        if (Number.isFinite(Number(preferredObserved))) {
            merged.observedVolume = normalizeVolume(preferredObserved, merged.volume);
        }
        merged.corsAffectedCount = normalizedPayloads.reduce(
            (maxCount, payload) => Math.max(maxCount, payload.corsAffectedCount || 0),
            merged.corsAffectedCount || 0
        );
        merged.elementCounts = {
            total: normalizedPayloads.reduce(
                (total, payload) => total + (payload.elementCounts?.total || 0),
                0
            ),
            active: normalizedPayloads.reduce(
                (total, payload) => total + (Number(payload.elementCounts?.active) || 0),
                0
            )
        };

        const mediaPayloads = normalizedPayloads.filter(statusPayloadHasMedia);
        const blockingPayload = mediaPayloads.find((payload) => payload.audioSettingsAvailable === false && payload.audioSettingsReason);

        merged.audioSettingsAvailable = mediaPayloads.length === 0
            ? true
            : mediaPayloads.some((payload) => payload.audioSettingsAvailable !== false);

        if (!merged.audioSettingsAvailable) {
            merged.audioSettingsReason = blockingPayload?.audioSettingsReason ?? merged.audioSettingsReason ?? null;
        } else {
            merged.audioSettingsReason = null;
        }

        merged.extensionEnabled = !normalizedPayloads.some((payload) => payload.extensionEnabled === false);

        // The preferred frame can be a muted autoplay/ad frame; any frame with audible
        // playback means the tab is not muted.
        if ((payloads || []).some((payload) => (payload?.payload ?? payload)?.audible === true)) {
            merged.muted = false;
        }

        merged.volume = resolveAuthoritativeVolume(
            volumeControl,
            merged.observedVolume ?? merged.volume,
            defaults.volume ?? CONSTANTS.DEFAULT_VOLUME
        );

        return merged;
    }

    function normalizeAudioTab(tab) {
        const source = tab && typeof tab === 'object' ? tab : {};
        return {
            tabId: source.tabId,
            title: source.title || '',
            favIconUrl: source.favIconUrl || '',
            url: source.url || '',
            volume: normalizeVolume(source.volume, CONSTANTS.DEFAULT_VOLUME),
            extensionEnabled: typeof source.extensionEnabled === 'boolean' ? source.extensionEnabled : true,
            monoEnabled: Boolean(source.monoEnabled),
            balance: normalizeBalance(source.balance, CONSTANTS.DEFAULT_BALANCE),
            muted: Boolean(source.muted),
            volumeBeforeMute: source.volumeBeforeMute,
            compressionEnabled: Boolean(source.compressionEnabled),
            compressionThreshold: source.compressionThreshold ?? CONSTANTS.DEFAULT_COMPRESSION_THRESHOLD,
            compressionRatio: source.compressionRatio ?? CONSTANTS.DEFAULT_COMPRESSION_RATIO,
            compressionKnee: source.compressionKnee ?? CONSTANTS.DEFAULT_COMPRESSION_KNEE,
            corsAffectedCount: normalizeCorsCount(source.corsAffectedCount),
            lastMediaSeenAt: source.lastMediaSeenAt,
            windowId: source.windowId,
            status: source.status || 'no-media'
        };
    }

    root.VCProtocol = Object.freeze({
        CONSTANTS,
        PreferenceKeys,
        Messages,
        VolumeControlMode,
        VolumeControlSource,
        STATUS_PRIORITY,
        createUnmanagedVolumeControl,
        createManagedVolumeControl,
        normalizeVolumeControl,
        isManagedVolumeControl,
        volumeControlsEqual,
        shouldAcceptVolumeControlUpdate,
        volumeControlToOwnership,
        resolveAuthoritativeVolume,
        normalizeVolume,
        nativeVolumeToPercent,
        normalizeBalance,
        normalizeCorsCount,
        sanitizeVolumeInput,
        summarizeObjectPayload,
        parseVolumeCommandPayload,
        normalizeCompressionSettings,
        normalizeGlobalBalanceSettings,
        normalizeExtensionPreferences,
        resolveInitialPageState,
        normalizeAudioSettings,
        normalizeStatusPayload,
        statusPayloadHasMedia,
        coalesceExplicit,
        statusDetailPriority,
        mergeStatusPayloads,
        normalizeAudioTab
    });
})(globalThis);