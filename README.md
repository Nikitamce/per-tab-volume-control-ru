# Per-Tab Volume Control (RU) — Громкость по вкладкам

**Language / Язык:** **English** | [Русский](README.ru.md)

Firefox extension that controls **volume per browser tab** (up to **500%**), with mute, stereo balance, mono, and a dynamics compressor.  
This repository is a **Russian-localized** build based on **Per-Tab Volume Control 5.1.0**.

---

## Features

| Feature | Description |
|--------|-------------|
| **Per-tab volume** | Independent level for each tab, **0–500%** |
| **Mute** | Silence the current tab without changing system volume |
| **L/R balance** | Pan audio left/right |
| **Mono** | Collapse stereo to mono |
| **Compressor** | Tame loud peaks (threshold + ratio) |
| **Other tabs** | Control volume / mute / compressor for other tabs that have audio |
| **Global defaults** | Default compressor, mono, and balance for new / reloaded pages |
| **Keyboard shortcuts** | Volume up/down, reset, mute, compressor (customizable in Firefox) |
| **Light / dark theme** | Toggle in the popup header |
| **Russian UI** | Fully translated popup, settings, status messages, and command labels |

---

## Install (Firefox / Nightly)

This package is **not signed by Mozilla**. You can still use it as follows.

### Option A — Temporary install (easiest for testing)

1. Open Firefox **Nightly**, **Developer Edition**, or regular Firefox.
2. Go to `about:debugging` → **This Firefox**.
3. Click **Load Temporary Add-on…**.
4. Select either:
   - `manifest.json` from this repository root, or
   - `dist/per-tab-volume-control-ru-5.1.0.xpi`.
5. The toolbar icon appears; click it to open the popup.

Temporary add-ons are removed when Firefox restarts (you can load again the same way).

### Option B — Permanent unsigned install (advanced)

Only on profiles where unsigned add-ons are allowed, for example:

- Firefox Nightly / Developer Edition with  
  `xpinstall.signatures.required` set to `false` in `about:config`, or  
- enterprise / policy-managed browsers.

Then install the `.xpi` from **Add-ons Manager** or drag-and-drop.

> **Note:** On release Firefox for general users, Mozilla still requires add-on signing for permanent installs.

### Option C — Build your own XPI

From the repository root (PowerShell example with correct ZIP path separators):

```powershell
# Paths inside the XPI must use forward slashes (/), not Windows backslashes.
# See scripts in the repo notes or repack with System.IO.Compression as used for dist/.
```

Or load the **folder** via `about:debugging` without packaging.

---

## Usage

1. Open a site with HTML5 audio/video (YouTube, local players, etc.).
2. Click the extension icon.
3. Move the **volume slider** (0–500%) or type a percentage.
4. Optional:
   - **Mute** — silence this tab  
   - **Mono** — mono mix  
   - **Balance** — Л (L) / П (R) pan  
   - **Compressor** — enable and tune threshold / ratio  
   - **Other tabs** — manage other audible tabs  
5. **Settings** (gear icon):
   - Open Firefox keyboard shortcut page  
   - Enable / disable the extension globally  
   - Global compressor / mono / balance defaults  

### Default keyboard shortcuts

| Action | Default shortcut |
|--------|------------------|
| Volume up | `Alt+Shift+Up` |
| Volume down | `Alt+Shift+Down` |
| Reset volume | `Alt+Shift+R` |
| Mute / unmute | `Alt+Shift+M` |
| Toggle compressor | `Alt+Shift+C` |

Change them in Firefox: **Settings → Extensions → Manage Extension Shortcuts**, or via the in-popup **Keyboard shortcuts** screen.

---

## Permissions

| Permission | Why |
|------------|-----|
| `activeTab` / `tabs` | Identify tabs and apply per-tab settings |
| `scripting` | Inject / talk to content scripts on pages |
| `storage` | Remember volume and preferences |
| `<all_urls>` | Control media on websites you visit |

The extension does **not** send your browsing data to a remote server for this localization build (no analytics added here).

---

## Repository layout

```
.
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Background script
├── shared/                # Shared protocol helpers
├── content_scripts/       # Page audio pipeline
├── popup/                 # UI (HTML/CSS/JS, Russian)
├── icons/                 # Toolbar icons
└── dist/
    └── per-tab-volume-control-ru-5.1.0.xpi   # Packaged build
```

---

## Version

| Item | Value |
|------|--------|
| Base version | **5.1.0** |
| Localization | Russian UI |
| Extension ID | `@per-tab-volume-control-release-ru` |

---

## Credits & license

- Original extension concept: **Per-Tab Volume Control** (volume up to 500% per tab for Firefox).
- This repository contains a **Russian translation / localization** and packaging for temporary or self-hosted install.
- If the original project ships under a specific open-source license, that license continues to apply to unmodified portions. See [LICENSE](LICENSE).

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| **“File not found” for `popup/popup.html`** | The XPI was packed with Windows `\` paths. Use the `dist/*.xpi` from this repo (forward slashes) or load `manifest.json` from the folder. |
| Popup shows “Cannot detect audio” | Page is restricted (`about:`, AMO, etc.) or needs a reload after install. |
| Compressor / mono / balance greyed out | Site uses a limited native path (CORS / capture); volume and mute may still work. |
| Temporary add-on gone after restart | Expected for temporary installs — load it again from `about:debugging`. |

---

## Contributing

Issues and PRs improving the Russian UI, docs, or packaging are welcome.
