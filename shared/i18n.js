/**
 * Runtime i18n engine for Per-Tab Volume Control.
 * Dropdown-switchable UI language with English fallback. Zero dependencies.
 */
(function(root) {
    const STORAGE_KEY = 'uiLanguage';
    const DEFAULT_PREF = 'auto';
    const FALLBACK_LANGUAGE = 'en';

    const SUPPORTED_LANGUAGES = Object.freeze([
        Object.freeze({ code: 'en', nativeLabel: 'English' }),
        Object.freeze({ code: 'es', nativeLabel: 'Español' }),
        Object.freeze({ code: 'de', nativeLabel: 'Deutsch' }),
        Object.freeze({ code: 'fr', nativeLabel: 'Français' }),
        Object.freeze({ code: 'ru', nativeLabel: 'Русский' }),
        Object.freeze({ code: 'zh-CN', nativeLabel: '简体中文' })
    ]);

    const SUPPORTED_CODES = Object.freeze(SUPPORTED_LANGUAGES.map((entry) => entry.code));

    const catalogCache = Object.create(null);
    const listeners = new Set();

    let preference = DEFAULT_PREF;
    let activeLanguage = FALLBACK_LANGUAGE;
    let initialized = false;
    let storageSyncStarted = false;
    let pluralRulesCache = Object.create(null);

    function isSupportedCode(code) {
        return typeof code === 'string' && SUPPORTED_CODES.includes(code);
    }

    function normalizePreference(value) {
        if (value === DEFAULT_PREF || value === null || value === undefined || value === '') {
            return DEFAULT_PREF;
        }
        return isSupportedCode(value) ? value : DEFAULT_PREF;
    }

    function getBrowserUiLanguage() {
        try {
            if (typeof browser !== 'undefined' && browser.i18n && typeof browser.i18n.getUILanguage === 'function') {
                return String(browser.i18n.getUILanguage() || '');
            }
        } catch {
            // Ignore missing i18n API in non-extension contexts.
        }

        try {
            if (typeof navigator !== 'undefined' && navigator.language) {
                return String(navigator.language);
            }
        } catch {
            // Ignore.
        }

        return FALLBACK_LANGUAGE;
    }

    function resolveLanguage(pref) {
        const normalizedPref = normalizePreference(pref);
        if (normalizedPref !== DEFAULT_PREF) {
            return normalizedPref;
        }

        const uiLanguage = getBrowserUiLanguage().trim();
        if (!uiLanguage) {
            return FALLBACK_LANGUAGE;
        }

        if (isSupportedCode(uiLanguage)) {
            return uiLanguage;
        }

        const lowerExact = uiLanguage.toLowerCase();
        const exactMatch = SUPPORTED_CODES.find((code) => code.toLowerCase() === lowerExact);
        if (exactMatch) {
            return exactMatch;
        }

        const base = uiLanguage.split(/[-_]/)[0];
        if (isSupportedCode(base)) {
            return base;
        }

        const lowerBase = String(base || '').toLowerCase();
        const baseMatch = SUPPORTED_CODES.find((code) => code.toLowerCase() === lowerBase);
        return baseMatch || FALLBACK_LANGUAGE;
    }

    function interpolate(template, subs) {
        if (!subs || typeof subs !== 'object') {
            return template;
        }

        return String(template).replace(/\{(\w+)\}/g, (match, token) => {
            if (Object.prototype.hasOwnProperty.call(subs, token)) {
                const value = subs[token];
                return value === undefined || value === null ? '' : String(value);
            }
            return match;
        });
    }

    async function fetchCatalog(code) {
        if (!isSupportedCode(code)) {
            throw new Error(`Unsupported language code: ${code}`);
        }

        if (catalogCache[code]) {
            return catalogCache[code];
        }

        let url;
        try {
            url = browser.runtime.getURL(`locales/${code}.json`);
        } catch (err) {
            throw new Error(`Unable to resolve locale URL for ${code}: ${err.message}`);
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load locale ${code}: HTTP ${response.status}`);
        }

        const catalog = await response.json();
        if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
            throw new Error(`Invalid locale catalog for ${code}`);
        }

        catalogCache[code] = Object.freeze({ ...catalog });
        return catalogCache[code];
    }

    async function ensureLoaded(code) {
        const target = isSupportedCode(code) ? code : FALLBACK_LANGUAGE;
        if (!catalogCache[FALLBACK_LANGUAGE]) {
            await fetchCatalog(FALLBACK_LANGUAGE);
        }
        if (target !== FALLBACK_LANGUAGE && !catalogCache[target]) {
            try {
                await fetchCatalog(target);
            } catch {
                // Keep English fallback when a non-English catalog fails.
            }
        }
        return catalogCache[target] || catalogCache[FALLBACK_LANGUAGE];
    }

    function lookupRaw(key, language) {
        const catalog = catalogCache[language];
        if (catalog && Object.prototype.hasOwnProperty.call(catalog, key) && catalog[key] !== '') {
            return catalog[key];
        }
        return undefined;
    }

    function t(key, subs) {
        if (typeof key !== 'string' || key === '') {
            return '';
        }

        let template = lookupRaw(key, activeLanguage);
        if (template === undefined) {
            template = lookupRaw(key, FALLBACK_LANGUAGE);
        }
        if (template === undefined) {
            return key;
        }

        return interpolate(template, subs);
    }

    function getPluralRules(language) {
        if (!pluralRulesCache[language]) {
            try {
                pluralRulesCache[language] = new Intl.PluralRules(language);
            } catch {
                pluralRulesCache[language] = new Intl.PluralRules(FALLBACK_LANGUAGE);
            }
        }
        return pluralRulesCache[language];
    }

    function tPlural(baseKey, count, subs) {
        const numericCount = Number(count);
        const safeCount = Number.isFinite(numericCount) ? numericCount : 0;
        const category = getPluralRules(activeLanguage).select(safeCount);
        const categoryKey = `${baseKey}.${category}`;
        const otherKey = `${baseKey}.other`;

        let template = lookupRaw(categoryKey, activeLanguage);
        if (template === undefined) {
            template = lookupRaw(otherKey, activeLanguage);
        }
        if (template === undefined) {
            template = lookupRaw(categoryKey, FALLBACK_LANGUAGE);
        }
        if (template === undefined) {
            template = lookupRaw(otherKey, FALLBACK_LANGUAGE);
        }
        if (template === undefined) {
            return categoryKey;
        }

        return interpolate(template, { ...(subs || {}), count: safeCount });
    }

    function applyAttribute(element, attrName, key) {
        if (!key) {
            return;
        }
        element.setAttribute(attrName, t(key));
    }

    function applyToDocument(root) {
        const scope = root || (typeof document !== 'undefined' ? document : null);
        if (!scope || typeof scope.querySelectorAll !== 'function') {
            return;
        }

        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.setAttribute('lang', activeLanguage);
        }

        scope.querySelectorAll('[data-i18n]').forEach((element) => {
            const key = element.getAttribute('data-i18n');
            if (key) {
                element.textContent = t(key);
            }
        });

        scope.querySelectorAll('[data-i18n-title]').forEach((element) => {
            applyAttribute(element, 'title', element.getAttribute('data-i18n-title'));
        });

        scope.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
            applyAttribute(element, 'aria-label', element.getAttribute('data-i18n-aria-label'));
        });

        scope.querySelectorAll('[data-i18n-alt]').forEach((element) => {
            applyAttribute(element, 'alt', element.getAttribute('data-i18n-alt'));
        });

        scope.querySelectorAll('[data-i18n-tooltip]').forEach((element) => {
            applyAttribute(element, 'data-tooltip', element.getAttribute('data-i18n-tooltip'));
        });
    }

    function notifyListeners() {
        listeners.forEach((listener) => {
            try {
                listener(activeLanguage, preference);
            } catch (err) {
                console.error('VCI18n listener failed:', err);
            }
        });
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    async function readStoredPreference() {
        try {
            const result = await browser.storage.local.get(STORAGE_KEY);
            return normalizePreference(result?.[STORAGE_KEY]);
        } catch {
            return DEFAULT_PREF;
        }
    }

    async function init(options = {}) {
        preference = await readStoredPreference();
        if (options.preference !== undefined) {
            preference = normalizePreference(options.preference);
        }

        activeLanguage = resolveLanguage(preference);
        await ensureLoaded(activeLanguage);
        initialized = true;
        return {
            preference,
            language: activeLanguage
        };
    }

    async function setLanguage(nextPreference) {
        const normalized = normalizePreference(nextPreference);
        preference = normalized;
        activeLanguage = resolveLanguage(normalized);
        await ensureLoaded(activeLanguage);

        try {
            await browser.storage.local.set({ [STORAGE_KEY]: preference });
        } catch (err) {
            console.error('Failed to persist uiLanguage preference:', err);
        }

        if (typeof document !== 'undefined') {
            applyToDocument(document);
        }

        notifyListeners();
        return {
            preference,
            language: activeLanguage
        };
    }

    function startStorageSync() {
        if (storageSyncStarted) {
            return;
        }

        try {
            if (!browser?.storage?.onChanged?.addListener) {
                return;
            }

            browser.storage.onChanged.addListener((changes, areaName) => {
                if (areaName !== 'local' || !changes || !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
                    return;
                }

                const nextPreference = normalizePreference(changes[STORAGE_KEY]?.newValue);
                if (nextPreference === preference && resolveLanguage(nextPreference) === activeLanguage) {
                    return;
                }

                preference = nextPreference;
                activeLanguage = resolveLanguage(preference);
                ensureLoaded(activeLanguage).then(() => {
                    if (typeof document !== 'undefined') {
                        applyToDocument(document);
                    }
                    notifyListeners();
                }).catch((err) => {
                    console.error('Failed to sync uiLanguage change:', err);
                });
            });

            storageSyncStarted = true;
        } catch (err) {
            console.error('Failed to start uiLanguage storage sync:', err);
        }
    }

    function getPreference() {
        return preference;
    }

    function getLanguage() {
        return activeLanguage;
    }

    function isInitialized() {
        return initialized;
    }

    root.VCI18n = Object.freeze({
        STORAGE_KEY,
        DEFAULT_PREF,
        FALLBACK_LANGUAGE,
        SUPPORTED_LANGUAGES,
        SUPPORTED_CODES,
        resolveLanguage,
        normalizePreference,
        ensureLoaded,
        init,
        setLanguage,
        t,
        tPlural,
        applyToDocument,
        subscribe,
        startStorageSync,
        getPreference,
        getLanguage,
        isInitialized
    });
})(globalThis);
