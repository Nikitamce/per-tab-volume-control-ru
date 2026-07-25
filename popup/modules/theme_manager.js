/**
 * Theme Manager for Popup
 */

window.Popup = window.Popup || {};

window.Popup.ThemeManager = {
    applyTheme: function(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        browser.storage.local.set({ theme }).catch(e => {
            console.error("Failed to save theme preference:", e);
        });
    },

    loadTheme: function() {
        browser.storage.local.get('theme').then(result => {
            this.applyTheme(result.theme || 'light');
        }).catch(e => {
            console.error("Failed to load theme preference:", e);
            this.applyTheme('light');
        });
    }
};
