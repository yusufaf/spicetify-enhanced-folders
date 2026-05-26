# Spicetify Enhanced Folders

Add custom images, descriptions, and inline rename to Spotify playlist folders — the metadata Spotify never exposed natively.

[![Release](https://img.shields.io/github/v/release/yusufaf/spicetify-enhanced-folders?sort=semver)](https://github.com/yusufaf/spicetify-enhanced-folders/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- **Custom image per folder** — replaces the default folder icon in the sidebar with any image you upload (auto-cropped to a 354px JPEG, ~150 KB)
- **Custom description** — free-text per folder, shown as a hover tooltip on the sidebar row
- **Inline rename** — change the folder name from the same dialog (uses `Spicetify.Platform.RootlistAPI.renameFolder`, no need to open Spotify's separate Rename dialog)
- **One context-menu entry** — right-click any folder → **Edit folder details**; image picker + description + name fields in one modal
- **Profile-dropdown settings panel** — Export / Import folder data as JSON, clean up stale entries, force re-render
- **Theme-aware** — uses Spice CSS variables so the UI matches the active Spicetify theme (parity with Album Length, Listening List, Enhanced Pins)
- **Robust against Spotify UI churn** — multi-strategy URI lookup and selector fallbacks; debounced `MutationObserver` so sidebar re-renders don't thrash

## How It Works

Spotify treats playlist folders as client-side rootlist nodes; they have no first-class metadata API and no native edit dialog. This extension:

1. Enumerates folders via `Spicetify.Platform.RootlistAPI.getContents()` (the modern Platform API — the legacy `sp://core-playlist/v1/rootlist` Cosmos endpoint no longer resolves in current Spotify)
2. Registers an `Edit folder details` item in the folder context menu via `Spicetify.ContextMenu`
3. Persists per-folder image (base64 JPEG, square-cropped to ~354px) and description in `Spicetify.LocalStorage`, keyed by folder ID
4. Decorates the sidebar by finding each folder row via its `#listrow-title-<uri>` element, then overlaying the user's image inside the existing artwork container (forces `position: relative` on the slot at decoration time so the absolutely-positioned image stays bounded)
5. Renames via the protobuf-backed `RootlistAPI.renameFolder({uri}, name)` modification, which dispatches a rootlist-changed event that Spotify's React tree picks up automatically — no manual refresh needed

## Installation

### Prerequisites
- [Spicetify CLI](https://spicetify.app/docs/getting-started) installed and applied at least once
- Spotify desktop client (Web Player is not currently supported)

### Steps

**Windows (PowerShell or Git Bash):**
```bash
# Grab enhanced-folders.js from the latest release
copy enhanced-folders.js "%APPDATA%\spicetify\Extensions\"
spicetify config extensions enhanced-folders.js
spicetify apply
```

**macOS / Linux:**
```bash
cp enhanced-folders.js ~/.config/spicetify/Extensions/
spicetify config extensions enhanced-folders.js
spicetify apply
```

Spotify will restart with the extension loaded. Confirm in DevTools (`Ctrl+Shift+J`, requires `spicetify enable-devtools`) — look for `[Enhanced Folders] Booted.` in the console.

## Usage

Right-click any playlist folder in the sidebar → **Edit folder details** → upload an image, type a description, optionally rename, save.

| Action | Where |
| --- | --- |
| Edit folder image / description / name | Folder right-click → **Edit folder details** |
| Export folder data as JSON | Profile dropdown (top-right avatar) → **Enhanced Folders** → Export |
| Import folder data | Profile dropdown → **Enhanced Folders** → Import (Merge or Replace) |
| Clean up entries for deleted folders | Profile dropdown → **Enhanced Folders** → Clean up deleted folders |
| Force a sidebar re-render | Profile dropdown → **Enhanced Folders** → Re-render sidebar |

## Backup & Sync

Folder IDs are local to each Spicetify install — they don't sync across devices via Spotify. To move customizations between machines, **Export** to JSON on the source machine and **Import** on the target.

The export format is a single JSON document keyed by folder ID:

```json
{
  "schemaVersion": 1,
  "folders": {
    "bcc91019a404b0f3": {
      "image": "data:image/jpeg;base64,/9j/...",
      "description": "Workout playlists",
      "updatedAt": 1748131200000
    }
  }
}
```

## Troubleshooting

- **Image isn't appearing in the sidebar** — open DevTools (`Ctrl+Shift+J`). If you see `[Enhanced Folders] no rows matched for N stored folder(s)`, the parent folder might be collapsed — expand it. If decoration consistently fails after a Spotify update, file an issue with your Spotify version and a snippet of a folder row's HTML.
- **Rename toast says "API unavailable"** — the `RootlistAPI.renameFolder` signature changed in your Spotify version. File an issue with your Spotify version; image/description save will still work.
- **Customizations missing on another device** — expected. Folder IDs are local. Use Export / Import.
- **Lost data after Spotify reinstall** — same reason. Back up via Export regularly.

## Compatibility

Tested against Spotify desktop on Windows with the YourLibraryX sidebar (list view). Selectors used:
- Row lookup: `#listrow-title-<uri>` → `.closest('.main-yourLibraryX-listItem, li, [role="treeitem"]')`
- Artwork slot: `.x-entityImage-imageContainer` / `.main-cardImage-imageWrapper` / `.main-yourLibraryX-listItemArtwork` / `[data-testid="entity-image"]` (first match wins)
- Rootlist enumeration: `Spicetify.Platform.RootlistAPI.getContents()`
- Rename: `Spicetify.Platform.RootlistAPI.renameFolder({uri}, newName)`

If Spotify renames these classes in a future build, decoration will silently no-op (no errors thrown) and the issue will be a selector update.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgments

- [SunsetTechuila/imaged-folders](https://github.com/SunsetTechuila/imaged-folders) — prior art for folder images (now archived); selector patterns referenced here
- [Dribbblish theme](https://github.com/spicetify/spicetify-themes/tree/master/Dribbblish) — first to introduce folder images, theme-locked
- [bespoke-alpha/stdlib](https://github.com/bespoke-alpha/stdlib) — auto-generated Spotify Platform type definitions, invaluable for reverse-engineering `renameFolder`'s signature
