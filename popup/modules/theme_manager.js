/**
 * Theme Manager for Popup
 */

window.Popup = window.Popup || {};

window.Popup.ThemeManager = {
    applyThemeAttribute: function(theme) {
        document.documentElement.setAttribute('data-theme', theme);
    },

    applyTheme: function(theme) {
        this.applyThemeAttribute(theme);
        browser.storage.local.set({ theme }).catch(e => {
            console.error("Failed to save theme preference:", e);
        });
    },

    loadTheme: async function() {
        try {
            const result = await browser.storage.local.get('theme');
            this.applyThemeAttribute(result.theme || 'light');
        } catch (e) {
            console.error("Failed to load theme preference:", e);
            this.applyThemeAttribute('light');
        }
    }
};
