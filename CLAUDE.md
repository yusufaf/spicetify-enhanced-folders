# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Spicetify (Spotify desktop) extension that adds custom images, descriptions, and inline rename to Spotify playlist folders — metadata Spotify exposes no native API for. All runtime code lives in `enhanced-folders.js`. There is **no build step and no bundler**; the file shipped is the file run.

## Commands

```bash
# Install/load the extension locally (manual test loop — there is no dev server)
cp enhanced-folders.js ~/.config/spicetify/Extensions/   # macOS/Linux
copy enhanced-folders.js "%APPDATA%\spicetify\Extensions\"  # Windows
spicetify config extensions enhanced-folders.js          # first time only
spicetify apply                                          # reload Spotify with changes

pnpm install            # installs husky + commitlint (dev only; no runtime deps)
pnpm test               # placeholder — prints "no tests", always passes
```

- **There is no automated test suite.** `pnpm test` is a stub the pre-commit hook runs. Verification is manual: `spicetify apply`, then open DevTools (`Ctrl+Shift+J`, needs `spicetify enable-devtools`) and look for `[Enhanced Folders]`-prefixed console output. Boot success logs `[Enhanced Folders] Booted.`
- **Commits are linted.** `commit-msg` husky hook runs commitlint with `@commitlint/config-conventional` — use Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) or the commit is rejected.
- **Releases are automated** via release-please (`release-type: simple`). Don't hand-edit version numbers or `CHANGELOG.md`; merging conventional commits to `main` drives the release PR. Version lives in `package.json` + `.release-please-manifest.json`.

## Architecture

`enhanced-folders.js` is one IIFE, organized into `//#region` blocks (keep this convention). Flow:

1. **Boot guard** — polls `while (!window.Spicetify || ...)` until the needed Spicetify APIs exist, then sets a `window.__enhancedFoldersActive` flag to prevent double-load.
2. **Storage** — all user data persists in `Spicetify.LocalStorage` under one key (`enhanced-folders:data`), shape `{ schemaVersion, folders: { [folderId]: { image, description, updatedAt } } }`. `setFolderData` strips empty fields and deletes fully-empty entries to avoid bloat. Bump `SCHEMA_VERSION` only with a migration story — mismatched schemas are **reset, not migrated**.
3. **Rootlist enumeration** — folders are discovered via `Spicetify.Platform.RootlistAPI.getContents()` walked recursively (`walkNode`). The legacy Cosmos endpoint `sp://core-playlist/v1/rootlist` is gone in current Spotify — do not reintroduce it. The folder map (`folderId → {uri, name}`) is cached 30s with an in-flight promise dedupe so the MutationObserver doesn't thrash the API.
4. **Sidebar decoration** — the core fragile part. For each stored folder, `findRowForUri` locates the DOM row via `#listrow-title-<uri>` (trying multiple URI prefix variants — plain `spotify:folder:` vs user-scoped), then `findArtworkSlot` finds the icon container by a fallback list of selectors. `decorateRow` overlays the user image as an absolutely-positioned `<img class="ef-folder-img">`, forcing `position: relative` + `overflow: hidden` on the slot at decoration time so the image stays bounded to that slot. Description becomes the row's `title` tooltip. Re-decoration is debounced (`scheduleDecorate`, 150ms) and driven by a `MutationObserver` scoped to the library rootlist plus `Platform.History` navigation events.
5. **Rename** — `tryRenameFolder` calls `RootlistAPI.renameFolder({uri}, name)` (an **object** carrying `.uri` as arg 1, name string as arg 2 — verified from the minified source via `.toString()`; the bespoke-alpha autogen types were wrong), with a fallback to the inlined `applyModification` payload. Failure is non-fatal: image/description still save.
6. **UI** — three modal surfaces built as raw DOM + `innerHTML`, all themed via `--spice-*` CSS variables (injected once under `#enhanced-folders-styles`): the **Edit folder details** modal (registered on folder right-click via `Spicetify.ContextMenu.Item`), and the **Enhanced Folders** settings modal with Export/Import/cleanup/re-render (registered in the profile dropdown via `Spicetify.Menu.Item`).

## Conventions & gotchas

- `// @ts-check` is on — keep the JSDoc type annotations valid; type errors surface in editors.
- **Decoration must fail silently.** When Spotify renames a CSS class, selector lookups should no-op (no thrown errors) — the only consequence is a missing image, surfaced as a `console.debug`. Preserve this; never let a decoration miss throw.
- Any user-supplied string injected into `innerHTML` goes through `escapeHtml` first. Keep this when adding fields.
- Uploaded images are center-cropped to a square `IMAGE_TARGET_SIZE` (354px) JPEG at `IMAGE_JPEG_QUALITY` (0.85) via canvas before storage — base64 lives in LocalStorage, so keep images small.
- Folder IDs are local to each Spicetify install and never sync via Spotify; Export/Import JSON is the only cross-device path. Don't assume IDs are portable.
- When touching selectors, update the **Compatibility** section of `README.md` to match — it documents the exact selectors as the contract for issue triage.
