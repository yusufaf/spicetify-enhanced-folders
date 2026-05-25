# Spicetify Enhanced Folders

Add custom images and descriptions to Spotify playlist folders — the metadata Spotify never exposed natively.

> Status: **early scaffold** — v1 implementation in progress.

## Features

- Custom image per playlist folder (replaces the default folder icon in the sidebar)
- Custom description per folder, surfaced as a hover tooltip
- "Edit details" entry in the folder right-click context menu
- Export / import all folder customizations as JSON (workaround for the fact that folder IDs are client-local and don't sync across devices)
- Theme-agnostic — works on the default Spotify UI, no theme dependency

## How It Works

Spotify treats playlist folders as client-side rootlist nodes; they have no first-class metadata API and no native edit dialog. This extension:

1. Enumerates folders via `Spicetify.CosmosAsync.get("sp://core-playlist/v1/rootlist")`
2. Registers an `Edit details` item in the folder context menu via `Spicetify.ContextMenu`
3. Persists per-folder image (base64 JPEG, resized to ~354px) and description in `Spicetify.LocalStorage`, keyed by folder ID
4. Decorates the sidebar via DOM injection + `MutationObserver`, swapping the default folder SVG for the user's image

## Installation

### Prerequisites
- [Spicetify CLI](https://spicetify.app/docs/getting-started) installed and applied at least once

### Steps

**Windows:**
```bash
# Clone or download enhanced-folders.js
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

## Usage

Right-click any playlist folder in the sidebar → **Edit folder details** → upload an image, type a description, save.

| Action | Where |
| --- | --- |
| Edit folder image + description | Folder right-click → Edit folder details |
| Export / import folder data | Profile dropdown (top-right avatar) → Enhanced Folders |
| Clean up stale entries | Profile dropdown → Enhanced Folders → Clean up deleted folders |
| Re-render sidebar | Profile dropdown → Enhanced Folders → Re-render sidebar |

## Settings

Open the profile dropdown (top-right avatar) → **Enhanced Folders** for backup/sync and maintenance actions.

## Troubleshooting

- **Image not appearing:** Spotify selectors drift between client versions. Open DevTools (`Ctrl+Shift+J`) and check the console for `Enhanced Folders:` warnings about missing selectors. File an issue with your Spotify version.
- **Customizations missing on another device:** Folder IDs are local to each Spicetify install — they don't sync. Use the export/import option to move data between machines.
- **Lost data after Spotify reinstall:** Same reason — back up via export regularly.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgments

- [SunsetTechuila/imaged-folders](https://github.com/SunsetTechuila/imaged-folders) — prior art for folder images (now archived); selector patterns referenced here
- [Dribbblish theme](https://github.com/spicetify/spicetify-themes/tree/master/Dribbblish) — first to introduce folder images, theme-locked
