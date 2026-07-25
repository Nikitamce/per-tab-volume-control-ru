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

    const Messages = Object.freeze({
        STATUS_UPDATE: 'STATUS_UPDATE',
        GET_STATUS: 'GET_STATUS',
        GET_TAB_STATUS: 'GET_TAB_STATUS',
        INSTALL_PAGE_MEDIA_BRIDGE: 'INSTALL_PAGE_MEDIA_BRIDGE',
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

    function statusPayloadHasMedia(payload) {
        const source = payload && typeof payload === 'object' ? payload : {};
        return source.status === 'active' ||
            source.status === 'inactive' ||
            source.status === 'error' ||
            (source.elementCounts && Number(source.elementCounts.total) > 0);
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

    function normalizeStatusPayload(payload, fallback = {}) {
        const source = payload && typeof payload === 'object' ? payload : {};
        const defaults = fallback && typeof fallback === 'object' ? fallback : {};

        return {
            status: source.status || defaults.status || 'inactive',
            statusDetail: source.statusDetail ?? defaults.statusDetail ?? null,
            volume: normalizeVolume(source.volume, defaults.volume ?? CONSTANTS.DEFAULT_VOLUME),
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
            audioSettingsReason: source.audioSettingsReason ?? defaults.audioSettingsReason ?? null,
            corsAffectedCount: normalizeCorsCount(source.corsAffectedCount ?? defaults.corsAffectedCount),
            elementCounts: source.elementCounts ?? defaults.elementCounts
        };
    }

    function mergeStatusPayloads(payloads, fallback = {}) {
        const defaults = normalizeStatusPayload(undefined, fallback);
        const normalizedPayloads = (payloads || [])
            .map((payload) => normalizeStatusPayload(payload?.payload ?? payload, defaults));

        if (normalizedPayloads.length === 0) {
            return { ...defaults };
        }

        let bestPayload = normalizedPayloads[0];
        let bestPriority = STATUS_PRIORITY[bestPayload.status] || 0;
        let bestElementCount = bestPayload.elementCounts?.total || 0;

        for (const payload of normalizedPayloads.slice(1)) {
            const priority = STATUS_PRIORITY[payload.status] || 0;
            const elementCount = payload.elementCounts?.total || 0;
            if (priority > bestPriority || (priority === bestPriority && elementCount > bestElementCount)) {
                bestPayload = payload;
                bestPriority = priority;
                bestElementCount = elementCount;
            }
        }

        const merged = normalizeStatusPayload(bestPayload, defaults);
        merged.corsAffectedCount = normalizedPayloads.reduce(
            (maxCount, payload) => Math.max(maxCount, payload.corsAffectedCount || 0),
            merged.corsAffectedCount || 0
        );
        merged.elementCounts = {
            total: normalizedPayloads.reduce(
                (total, payload) => total + (payload.elementCounts?.total || 0),
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
        }

        merged.extensionEnabled = !normalizedPayloads.some((payload) => payload.extensionEnabled === false);

        return merged;
    }

    function normalizeAudioTab(tab) {
        const source = tab && typeof tab === 'object' ? tab : {};
        return {
            tabId: source.tabId,
            title: source.title || 'Unknown Tab',
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
        STATUS_PRIORITY,
        normalizeVolume,
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
        mergeStatusPayloads,
        normalizeAudioTab
    });
})(globalThis);