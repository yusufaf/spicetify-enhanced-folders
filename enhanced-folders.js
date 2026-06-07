// @ts-check
// x-release-please-start-version
// VERSION: 1.0.0
// x-release-please-end-version
/**
 * Spicetify Enhanced Folders
 * Add custom images and descriptions to Spotify playlist folders.
 */

(async function main() {
  "use strict";

  //#region Constants
  const LOG_PREFIX = "[Enhanced Folders]";
  const ACTIVE_FLAG = "__enhancedFoldersActive";
  const STORAGE_KEY = "enhanced-folders:data";
  const SCHEMA_VERSION = 1;
  const STYLE_ID = "enhanced-folders-styles";
  const DECOR_ATTR = "data-ef-decorated";
  const IMAGE_TARGET_SIZE = 354; // px, square JPEG
  const IMAGE_JPEG_QUALITY = 0.85;
  const MAX_DESCRIPTION_LEN = 1000;

  //#endregion

  //#region Wait for Spicetify
  while (
    !window.Spicetify ||
    !Spicetify.CosmosAsync ||
    !Spicetify.ContextMenu ||
    !Spicetify.URI ||
    !Spicetify.Platform ||
    !Spicetify.LocalStorage ||
    !Spicetify.PopupModal ||
    !Spicetify.showNotification
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  //#endregion

  //#region Single-load guard
  if (window[ACTIVE_FLAG]) {
    console.warn(`${LOG_PREFIX} already loaded — skipping.`);
    return;
  }
  window[ACTIVE_FLAG] = true;
  //#endregion

  //#region Utilities
  /** @param {string} str */
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  /** Extract folder ID from a folder URI like `spotify:user:foo:folder:abc` or `spotify:folder:abc`. */
  function folderIdFromUri(uri) {
    if (!uri) return null;
    const m = String(uri).match(/folder:([0-9a-f]+)/i);
    return m ? m[1] : null;
  }

  function isFolderUri(uri) {
    try {
      return uri && Spicetify.URI.isFolder(uri);
    } catch {
      return /folder:[0-9a-f]+/i.test(String(uri || ""));
    }
  }
  //#endregion

  //#region Storage
  /** @typedef {{ image?: string, description?: string, updatedAt?: number }} FolderData */
  /** @typedef {{ schemaVersion: number, folders: Record<string, FolderData> }} Store */

  /** @returns {Store} */
  function loadAll() {
    try {
      const raw = Spicetify.LocalStorage.get(STORAGE_KEY);
      if (!raw) return { schemaVersion: SCHEMA_VERSION, folders: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return { schemaVersion: SCHEMA_VERSION, folders: {} };
      }
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        console.warn(
          `${LOG_PREFIX} unknown schema ${parsed.schemaVersion}; resetting`
        );
        return { schemaVersion: SCHEMA_VERSION, folders: {} };
      }
      if (!parsed.folders || typeof parsed.folders !== "object") {
        parsed.folders = {};
      }
      return parsed;
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to load storage`, err);
      return { schemaVersion: SCHEMA_VERSION, folders: {} };
    }
  }

  /** @param {Store} store */
  function saveAll(store) {
    try {
      Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(store));
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to save storage`, err);
      Spicetify.showNotification(
        "Enhanced Folders: failed to save (storage full?)",
        true
      );
    }
  }

  /** @param {string} folderId @returns {FolderData} */
  function getFolderData(folderId) {
    const store = loadAll();
    return store.folders[folderId] || {};
  }

  /** @param {string} folderId @param {FolderData} data */
  function setFolderData(folderId, data) {
    const store = loadAll();
    const existing = store.folders[folderId] || {};
    store.folders[folderId] = {
      ...existing,
      ...data,
      updatedAt: Date.now(),
    };
    // Strip empty fields so we don't bloat storage
    if (!store.folders[folderId].image) delete store.folders[folderId].image;
    if (!store.folders[folderId].description)
      delete store.folders[folderId].description;
    if (
      !store.folders[folderId].image &&
      !store.folders[folderId].description
    ) {
      delete store.folders[folderId];
    }
    saveAll(store);
  }

  /** @param {string} folderId */
  function deleteFolderData(folderId) {
    const store = loadAll();
    delete store.folders[folderId];
    saveAll(store);
  }
  //#endregion

  //#region Rootlist enumeration (Platform.RootlistAPI — Cosmos sp://core-playlist is gone)
  /** @typedef {{ uri: string, name: string }} FolderMeta */

  /** @type {Map<string, FolderMeta> | null} */
  let _folderCache = null;
  let _folderCacheTime = 0;
  /** @type {Promise<Map<string, FolderMeta>> | null} */
  let _folderInflight = null;
  const FOLDER_CACHE_TTL_MS = 30_000;

  /**
   * Returns map of folderId -> { uri, name }. Cached for 30s so we don't
   * thrash the API on every MutationObserver tick.
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<Map<string, FolderMeta>>}
   */
  async function fetchFolderMap(opts = {}) {
    if (
      !opts.force &&
      _folderCache &&
      Date.now() - _folderCacheTime < FOLDER_CACHE_TTL_MS
    ) {
      return _folderCache;
    }
    if (_folderInflight) return _folderInflight;

    _folderInflight = (async () => {
      const map = new Map();
      try {
        const api = Spicetify.Platform?.RootlistAPI;
        if (!api?.getContents) {
          throw new Error("Spicetify.Platform.RootlistAPI.getContents missing");
        }
        const root = await api.getContents();
        walkNode(root, map);
        _folderCache = map;
        _folderCacheTime = Date.now();
      } catch (err) {
        console.error(`${LOG_PREFIX} fetchFolderMap failed`, err);
        if (!_folderCache) _folderCache = map;
      } finally {
        _folderInflight = null;
      }
      return _folderCache || map;
    })();

    return _folderInflight;
  }

  function walkNode(node, map) {
    if (!node || typeof node !== "object") return;
    if (node.type === "folder" && node.uri) {
      const id = folderIdFromUri(node.uri);
      if (id) map.set(id, { uri: node.uri, name: node.name || "" });
    }
    const children = node.items || node.rows || node.children || [];
    for (const c of children) walkNode(c, map);
  }

  /** Drop stored entries whose folders no longer exist. */
  async function cleanUpStaleEntries() {
    const map = await fetchFolderMap({ force: true });
    if (map.size === 0) return; // bail to avoid wiping data on a transient failure
    const store = loadAll();
    let removed = 0;
    for (const id of Object.keys(store.folders)) {
      if (!map.has(id)) {
        delete store.folders[id];
        removed += 1;
      }
    }
    if (removed > 0) {
      saveAll(store);
      console.log(`${LOG_PREFIX} cleaned up ${removed} stale entr(y/ies).`);
    }
  }
  //#endregion

  //#region Image processing
  /**
   * Resize an uploaded image to a square JPEG data URL.
   * @param {File} file
   * @returns {Promise<string>} full data URL ("data:image/jpeg;base64,...")
   */
  function fileToResizedDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error("Image decode failed"));
        img.onload = () => {
          try {
            const size = IMAGE_TARGET_SIZE;
            const canvas = document.createElement("canvas");
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Canvas 2D unavailable");
            const minDim = Math.min(img.width, img.height);
            const sx = (img.width - minDim) / 2;
            const sy = (img.height - minDim) / 2;
            ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
            resolve(canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY));
          } catch (err) {
            reject(err);
          }
        };
        img.src = String(e.target?.result || "");
      };
      reader.readAsDataURL(file);
    });
  }
  //#endregion

  //#region Folder rename
  /**
   * Rename a folder via Spicetify.Platform.RootlistAPI.
   *
   * The minified source of RootlistAPI.renameFolder (revealed at boot via
   * .toString()) is:
   *
   *   async renameFolder(e, t) {
   *     await this.applyModification({
   *       operation: "set",
   *       attributes: { name: t },
   *       rows: [e.uri]
   *     });
   *   }
   *
   * Two args: first is an OBJECT carrying `.uri`, second is the new name
   * string. The bespoke-alpha autogen typed it as one arg — that was wrong.
   *
   * Primary call mirrors the source exactly. Fallback inlines the same
   * applyModification payload in case a future Spotify version drops the
   * wrapper but keeps applyModification's modification grammar.
   *
   * @param {string} uri
   * @param {string} newName
   * @returns {Promise<Error | null>}
   */
  async function tryRenameFolder(uri, newName) {
    const root = Spicetify.Platform?.RootlistAPI;
    if (!root) return new Error("Spicetify.Platform.RootlistAPI unavailable");

    /** @type {Array<[string, () => any]>} */
    const attempts = [
      [
        "renameFolder({uri}, name)",
        () => root.renameFolder?.({ uri }, newName),
      ],
      [
        // Same payload renameFolder builds internally — direct call.
        "applyModification({operation:set, attributes:{name}, rows:[uri]})",
        () =>
          root.applyModification?.({
            operation: "set",
            attributes: { name: newName },
            rows: [uri],
          }),
      ],
    ];

    let lastErr = null;
    let triedCount = 0;
    for (const [label, fn] of attempts) {
      let ret;
      try {
        ret = fn();
      } catch (err) {
        console.warn(`${LOG_PREFIX} ${label} threw synchronously`, err);
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      if (ret === undefined) continue;
      triedCount += 1;
      try {
        await ret;
        console.log(`${LOG_PREFIX} rename succeeded via ${label}`);
        return null;
      } catch (err) {
        console.warn(`${LOG_PREFIX} ${label} rejected`, err);
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (triedCount === 0) {
      console.warn(
        `${LOG_PREFIX} no rename entry-point exists on RootlistAPI on this Spotify version`
      );
    }
    return lastErr || new Error("No working rename method found");
  }
  //#endregion

  //#region Edit details modal
  /** @param {string} folderUri */
  async function openEditDetailsModal(folderUri) {
    const folderId = folderIdFromUri(folderUri);
    if (!folderId) {
      Spicetify.showNotification("Enhanced Folders: invalid folder URI", true);
      return;
    }

    const folderMap = await fetchFolderMap();
    const folderMeta = folderMap.get(folderId);
    const folderName = folderMeta?.name || "Folder";
    const existing = getFolderData(folderId);
    /** @type {string | null} */
    let pendingImage = existing.image || null;

    const content = document.createElement("div");
    content.className = "ef-edit-modal";
    content.innerHTML = `
      <div class="ef-edit-row">
        <div class="ef-edit-image-section">
          <div class="ef-edit-image-wrapper" title="Click to change image">
            ${
              pendingImage
                ? `<img class="ef-edit-img-preview" src="${escapeHtml(pendingImage)}" alt="">`
                : '<div class="ef-edit-img-preview ef-edit-img-placeholder"><svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" aria-hidden="true"><path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7.414l2 2H21a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3zm1-2h16V6h-8.414l-2-2H4v16z"></path></svg></div>'
            }
            <div class="ef-edit-img-overlay">
              <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M17.318 1.975a3.329 3.329 0 1 1 4.707 4.707L8.451 20.256c-.49.49-1.1.867-1.767 1.109l-4.45 1.527a.75.75 0 0 1-.94-.94l1.519-4.431c.247-.676.63-1.292 1.126-1.794zm3.646 1.061a1.829 1.829 0 0 0-2.586 0L4.804 16.61a3.5 3.5 0 0 0-.764 1.216l-.95 2.769 2.789-.955a3.5 3.5 0 0 0 1.2-.752z"></path></svg>
              <span>Choose photo</span>
            </div>
          </div>
          <input type="file" class="ef-edit-file-input" accept="image/jpeg,image/png,image/gif,image/webp" hidden>
          <button type="button" class="ef-edit-remove-image" ${pendingImage ? "" : "hidden"}>Remove image</button>
        </div>
        <div class="ef-edit-fields">
          <label class="ef-edit-label" for="ef-edit-name">Name</label>
          <input id="ef-edit-name" class="ef-edit-input ef-edit-name-input" type="text" maxlength="100" value="${escapeHtml(folderName)}" placeholder="Folder name">
          <label class="ef-edit-label" for="ef-edit-desc">Description</label>
          <textarea id="ef-edit-desc" class="ef-edit-input ef-edit-textarea" maxlength="${MAX_DESCRIPTION_LEN}" placeholder="Add a description (shown on hover)">${escapeHtml(existing.description || "")}</textarea>
        </div>
      </div>
      <div class="ef-edit-actions">
        <button type="button" class="ef-edit-cancel">Cancel</button>
        <button type="button" class="ef-edit-save">Save</button>
      </div>
      <p class="ef-edit-disclaimer">Image and description are stored locally on this device only. Folder IDs are not synced across Spotify installs — use Export to back up. Rename uses Spotify's built-in folder rename.</p>
    `;

    const imgWrapper = content.querySelector(".ef-edit-image-wrapper");
    const fileInput = /** @type {HTMLInputElement} */ (
      content.querySelector(".ef-edit-file-input")
    );
    const removeBtn = /** @type {HTMLButtonElement} */ (
      content.querySelector(".ef-edit-remove-image")
    );
    const descArea = /** @type {HTMLTextAreaElement} */ (
      content.querySelector("#ef-edit-desc")
    );

    imgWrapper?.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", async (evt) => {
      const file = /** @type {HTMLInputElement} */ (evt.target).files?.[0];
      if (!file) return;
      try {
        const dataUrl = await fileToResizedDataUrl(file);
        pendingImage = dataUrl;
        const preview = content.querySelector(".ef-edit-img-preview");
        if (preview && preview.tagName === "IMG") {
          /** @type {HTMLImageElement} */ (preview).src = dataUrl;
        } else if (preview) {
          const img = document.createElement("img");
          img.className = "ef-edit-img-preview";
          img.alt = "";
          img.src = dataUrl;
          preview.replaceWith(img);
        }
        removeBtn.hidden = false;
      } catch (err) {
        console.error(`${LOG_PREFIX} image processing failed`, err);
        Spicetify.showNotification("Failed to process image", true);
      } finally {
        fileInput.value = "";
      }
    });

    removeBtn?.addEventListener("click", () => {
      pendingImage = null;
      const preview = content.querySelector(".ef-edit-img-preview");
      if (preview) {
        const placeholder = document.createElement("div");
        placeholder.className = "ef-edit-img-preview ef-edit-img-placeholder";
        placeholder.innerHTML =
          '<svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" aria-hidden="true"><path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7.414l2 2H21a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3zm1-2h16V6h-8.414l-2-2H4v16z"></path></svg>';
        preview.replaceWith(placeholder);
      }
      removeBtn.hidden = true;
    });

    content.querySelector(".ef-edit-cancel")?.addEventListener("click", () => {
      Spicetify.PopupModal.hide();
    });

    const nameInput = /** @type {HTMLInputElement} */ (
      content.querySelector("#ef-edit-name")
    );

    content.querySelector(".ef-edit-save")?.addEventListener("click", async () => {
      const description = descArea.value.trim();
      const newName = nameInput.value.trim();

      let renameError = null;
      let renamed = false;
      if (newName && newName !== folderName) {
        renameError = await tryRenameFolder(
          folderMeta?.uri || folderUri,
          newName
        );
        renamed = !renameError;
      }

      setFolderData(folderId, {
        image: pendingImage || undefined,
        description: description || undefined,
      });
      // Invalidate cache so next decorate pass picks up the new name
      _folderCache = null;
      Spicetify.PopupModal.hide();
      if (renameError) {
        Spicetify.showNotification(
          "Saved — but rename via Spotify's Rename instead (API unavailable)",
          true
        );
      } else if (renamed) {
        Spicetify.showNotification("Saved & renamed");
      } else {
        Spicetify.showNotification("Saved");
      }
      decorateAllFolders();
      refreshFoldersViewAfterDataChange();
    });

    Spicetify.PopupModal.display({
      title: "Edit folder details",
      content,
      isLarge: true,
    });
  }
  //#endregion

  //#region Settings modal (profile dropdown)
  function openSettingsModal() {
    const store = loadAll();
    const count = Object.keys(store.folders).length;
    const content = document.createElement("div");
    content.className = "ef-settings-modal";
    content.innerHTML = `
      <div class="ef-settings-section">
        <h3 class="ef-settings-heading">Folder customizations</h3>
        <p class="ef-settings-text">
          ${count} folder${count === 1 ? "" : "s"} customized.
          Right-click any folder in the sidebar and choose <strong>Edit folder details</strong> to set an image or description.
        </p>
      </div>
      <div class="ef-settings-section">
        <h3 class="ef-settings-heading">Backup &amp; sync</h3>
        <p class="ef-settings-text">
          Folder IDs are unique to this Spotify install, so customizations don't sync across devices automatically. Export to back them up or move between machines.
        </p>
        <div class="ef-settings-actions">
          <button type="button" class="ef-settings-btn ef-settings-export">Export folder data</button>
          <button type="button" class="ef-settings-btn ef-settings-import">Import folder data</button>
        </div>
      </div>
      <div class="ef-settings-section">
        <h3 class="ef-settings-heading">Maintenance</h3>
        <div class="ef-settings-actions">
          <button type="button" class="ef-settings-btn ef-settings-cleanup">Clean up deleted folders</button>
          <button type="button" class="ef-settings-btn ef-settings-redecorate">Re-render sidebar</button>
        </div>
      </div>
    `;

    content
      .querySelector(".ef-settings-export")
      ?.addEventListener("click", () => openExportModal());
    content
      .querySelector(".ef-settings-import")
      ?.addEventListener("click", () => openImportModal());
    content
      .querySelector(".ef-settings-cleanup")
      ?.addEventListener("click", async () => {
        const before = Object.keys(loadAll().folders).length;
        await cleanUpStaleEntries();
        const after = Object.keys(loadAll().folders).length;
        const removed = before - after;
        Spicetify.showNotification(
          removed > 0
            ? `Removed ${removed} stale entr${removed === 1 ? "y" : "ies"}`
            : "Nothing to clean up"
        );
      });
    content
      .querySelector(".ef-settings-redecorate")
      ?.addEventListener("click", () => {
        decorateAllFolders();
        refreshFoldersViewAfterDataChange();
        Spicetify.showNotification("Re-rendered sidebar");
      });

    Spicetify.PopupModal.display({
      title: "Enhanced Folders",
      content,
      isLarge: false,
    });
  }
  //#endregion

  //#region Export / Import
  function openExportModal() {
    const store = loadAll();
    const json = JSON.stringify(store, null, 2);
    const content = document.createElement("div");
    content.className = "ef-export-modal";
    content.innerHTML = `
      <p class="ef-edit-label">Your folder customizations (${
        Object.keys(store.folders).length
      } folder${Object.keys(store.folders).length === 1 ? "" : "s"}):</p>
      <textarea class="ef-edit-input ef-edit-textarea" rows="10" readonly></textarea>
      <div class="ef-edit-actions">
        <button type="button" class="ef-edit-cancel">Close</button>
        <button type="button" class="ef-export-copy">Copy to clipboard</button>
        <button type="button" class="ef-export-download">Download .json</button>
      </div>
    `;
    /** @type {HTMLTextAreaElement} */
    (content.querySelector("textarea")).value = json;

    content.querySelector(".ef-edit-cancel")?.addEventListener("click", () =>
      Spicetify.PopupModal.hide()
    );
    content
      .querySelector(".ef-export-copy")
      ?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(json);
          Spicetify.showNotification("Copied to clipboard");
        } catch {
          Spicetify.showNotification("Copy failed — select and copy manually", true);
        }
      });
    content.querySelector(".ef-export-download")?.addEventListener("click", () => {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `enhanced-folders-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });

    Spicetify.PopupModal.display({
      title: "Export folder data",
      content,
      isLarge: true,
    });
  }

  function openImportModal() {
    const content = document.createElement("div");
    content.className = "ef-import-modal";
    content.innerHTML = `
      <p class="ef-edit-label">Paste exported JSON below, or load a file. Merges with existing data.</p>
      <textarea class="ef-edit-input ef-edit-textarea" rows="10" placeholder='{"schemaVersion":1,"folders":{...}}'></textarea>
      <input type="file" class="ef-import-file-input" accept="application/json,.json" hidden>
      <div class="ef-edit-actions">
        <button type="button" class="ef-edit-cancel">Cancel</button>
        <button type="button" class="ef-import-load-file">Load file…</button>
        <button type="button" class="ef-import-replace">Replace all</button>
        <button type="button" class="ef-edit-save ef-import-merge">Merge</button>
      </div>
    `;
    const textarea = /** @type {HTMLTextAreaElement} */ (
      content.querySelector("textarea")
    );
    const fileInput = /** @type {HTMLInputElement} */ (
      content.querySelector(".ef-import-file-input")
    );

    content
      .querySelector(".ef-import-load-file")
      ?.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (evt) => {
      const file = /** @type {HTMLInputElement} */ (evt.target).files?.[0];
      if (!file) return;
      try {
        textarea.value = await file.text();
      } catch (err) {
        Spicetify.showNotification("Failed to read file", true);
      } finally {
        fileInput.value = "";
      }
    });

    const doImport = (replace) => {
      const text = textarea.value.trim();
      if (!text) {
        Spicetify.showNotification("Paste or load JSON first", true);
        return;
      }
      /** @type {Store} */
      let incoming;
      try {
        incoming = JSON.parse(text);
      } catch {
        Spicetify.showNotification("Invalid JSON", true);
        return;
      }
      if (
        !incoming ||
        incoming.schemaVersion !== SCHEMA_VERSION ||
        !incoming.folders
      ) {
        Spicetify.showNotification("Unrecognized data shape", true);
        return;
      }
      const current = loadAll();
      const merged = replace
        ? { schemaVersion: SCHEMA_VERSION, folders: { ...incoming.folders } }
        : {
            schemaVersion: SCHEMA_VERSION,
            folders: { ...current.folders, ...incoming.folders },
          };
      saveAll(merged);
      const count = Object.keys(incoming.folders).length;
      Spicetify.PopupModal.hide();
      Spicetify.showNotification(
        `${replace ? "Replaced" : "Merged"} ${count} folder${count === 1 ? "" : "s"}`
      );
      decorateAllFolders();
      refreshFoldersViewAfterDataChange();
    };

    content
      .querySelector(".ef-edit-cancel")
      ?.addEventListener("click", () => Spicetify.PopupModal.hide());
    content
      .querySelector(".ef-import-replace")
      ?.addEventListener("click", () => doImport(true));
    content
      .querySelector(".ef-import-merge")
      ?.addEventListener("click", () => doImport(false));

    Spicetify.PopupModal.display({
      title: "Import folder data",
      content,
      isLarge: true,
    });
  }
  //#endregion

  //#region Sidebar decoration
  /** Compose the set of URI formats Spotify might key its listrow-title id by. */
  function uriVariants(uri) {
    const out = new Set();
    if (uri) out.add(uri);
    const id = folderIdFromUri(uri);
    if (id) {
      out.add(`spotify:folder:${id}`);
      const user = Spicetify.Platform?.username;
      if (user) out.add(`spotify:user:${user}:folder:${id}`);
    }
    return [...out];
  }

  /**
   * Find the sidebar row element for a folder URI. Spotify tags each row with
   * an inner element `#listrow-title-<uri>`, but the URI prefix (user-scoped
   * vs plain) varies between API surfaces, so we try several variants.
   * @returns {HTMLElement | null}
   */
  function findRowForUri(uri) {
    for (const variant of uriVariants(uri)) {
      // getElementById bypasses CSS.escape quirks with `:` in IDs
      const titleEl = document.getElementById(`listrow-title-${variant}`);
      if (titleEl) {
        const row = titleEl.closest(
          '.main-yourLibraryX-listItem, li, [role="treeitem"], [role="row"]'
        );
        if (row) return /** @type {HTMLElement} */ (row);
      }
    }
    return null;
  }

  /** Locate the artwork box inside a folder row (where the icon currently lives). */
  function findArtworkSlot(rowEl) {
    /** @type {string[]} */
    const candidates = [
      ".x-entityImage-imageContainer",
      ".main-cardImage-imageWrapper",
      ".main-yourLibraryX-listItemArtwork",
      ".main-yourLibraryX-rowImage",
      '[data-testid="entity-image"]',
    ];
    for (const sel of candidates) {
      const el = rowEl.querySelector(sel);
      if (el) return /** @type {HTMLElement} */ (el);
    }
    return null;
  }

  function decorateRow(rowEl, data) {
    // Tooltip
    if (data.description) {
      rowEl.setAttribute("title", data.description);
    } else {
      rowEl.removeAttribute("title");
    }

    if (data.image) {
      const slot = findArtworkSlot(rowEl);
      if (!slot) return; // no artwork box on this row layout — skip silently

      // Force a positioning context so our absolutely-positioned <img> is
      // sized to THIS slot, not some larger positioned ancestor.
      if (getComputedStyle(slot).position === "static") {
        slot.style.position = "relative";
      }
      // Tame any overflow so we don't bleed past the artwork box
      if (getComputedStyle(slot).overflow === "visible") {
        slot.style.overflow = "hidden";
      }

      let img = /** @type {HTMLImageElement | null} */ (
        slot.querySelector(":scope > img.ef-folder-img")
      );
      if (!img) {
        img = document.createElement("img");
        img.className = "ef-folder-img";
        img.alt = "";
        slot.appendChild(img);
      }
      if (img.getAttribute("src") !== data.image) img.src = data.image;
      slot.classList.add("ef-has-image");
    } else {
      // Description-only: strip any prior image
      rowEl
        .querySelectorAll(".ef-folder-img")
        .forEach((n) => n.remove());
      rowEl
        .querySelectorAll(".ef-has-image")
        .forEach((n) => n.classList.remove("ef-has-image"));
    }
    rowEl.setAttribute(DECOR_ATTR, "1");
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let _decorateTimer = null;
  function scheduleDecorate() {
    if (_decorateTimer) return;
    _decorateTimer = setTimeout(() => {
      _decorateTimer = null;
      decorateAllFolders();
    }, 150);
  }

  async function decorateAllFolders() {
    const store = loadAll();
    const ids = Object.keys(store.folders);
    if (ids.length === 0) return;
    const folderMap = await fetchFolderMap();
    let matched = 0;
    for (const id of ids) {
      const meta = folderMap.get(id);
      if (!meta) continue;
      const row = findRowForUri(meta.uri);
      if (!row) continue;
      decorateRow(row, store.folders[id]);
      matched += 1;
    }
    if (matched === 0 && folderMap.size > 0) {
      console.debug(
        `${LOG_PREFIX} no rows matched for ${ids.length} stored folder(s) — parent folder may be collapsed.`
      );
    }
  }
  //#endregion

  //#region Folders filter — tree builder
  /** @typedef {{ uri: string, name: string, image?: string }} PlaylistNode */
  /** @typedef {{ uri: string, name: string, folders: FolderNode[], playlists: PlaylistNode[] }} FolderNode */

  const FOLDER_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7.414l2 2H21a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3zm1-2h16V6h-8.414l-2-2H4v16z"></path></svg>`;
  const PLAYLIST_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6V3zm0 13.667H4.5a1.5 1.5 0 1 0 1.5 1.5v-1.5zm13 0h-1.5a1.5 1.5 0 1 0 1.5 1.5v-1.5z"></path></svg>`;

  /** @param {any} node */
  function pickNodeImage(node) {
    return (
      node?.images?.[0]?.url ||
      node?.image ||
      node?.imageUrl ||
      node?.imgUrl ||
      undefined
    );
  }

  /**
   * Recursively convert a rootlist node into our FolderNode shape, preserving
   * hierarchy (folders + playlists per level). `walkNode` (above) only extracts
   * flat folder leaves; this keeps the tree for inline-expand rendering.
   * @param {any} node
   * @returns {FolderNode}
   */
  function buildFolderNode(node) {
    /** @type {FolderNode[]} */
    const folders = [];
    /** @type {PlaylistNode[]} */
    const playlists = [];
    const children = node?.items || node?.rows || node?.children || [];
    for (const c of children) {
      if (!c || typeof c !== "object" || !c.uri) continue;
      if (c.type === "folder") {
        folders.push(buildFolderNode(c));
      } else if (c.type === "playlist" || /:playlist:/i.test(String(c.uri))) {
        playlists.push({
          uri: c.uri,
          name: c.name || "",
          image: pickNodeImage(c),
        });
      }
    }
    return {
      uri: node?.uri || "",
      name: node?.name || "",
      folders,
      playlists,
    };
  }

  /** @returns {Promise<FolderNode[]>} top-level folders only */
  async function getTopLevelFolders() {
    const api = Spicetify.Platform?.RootlistAPI;
    if (!api?.getContents) {
      throw new Error("Spicetify.Platform.RootlistAPI.getContents missing");
    }
    const root = await api.getContents();
    return buildFolderNode(root).folders;
  }

  /** @type {FolderNode[] | null} */
  let _folderTreeCache = null;
  /** @param {boolean} [force] */
  async function ensureFolderTree(force) {
    if (!force && _folderTreeCache) return _folderTreeCache;
    _folderTreeCache = await getTopLevelFolders();
    return _folderTreeCache;
  }
  //#endregion

  //#region Folders filter — chip + view state
  let foldersFilterActive = false;
  /** Folder URIs currently expanded in the folders view. */
  const _expandedFolders = new Set();
  /** @type {HTMLElement | null} */
  let _hiddenListRoot = null;

  const LIST_ROOT_SELECTORS = [
    ".main-yourLibraryX-libraryRootlist",
    '[data-testid="rootlist"]',
    ".main-yourLibraryX-libraryItemContainer",
    ".main-yourLibraryX-listItemContainer",
  ];

  // Spotify's filter chips are react-aria listbox options, NOT buttons. The
  // stable hooks are the Encore design-system markers: the bar is a
  // role="listbox" labelled "Filter options", each chip carries
  // data-encore-id="chip", and selection is the e-10451-legacy-chip--selected
  // class (+ inner --selected / encore-inverted-light-set). We clone a real
  // chip option so ours is visually native, and toggle those same classes for
  // the active look.
  const CHIP_SELECTED_CLASS = "e-10451-legacy-chip--selected";
  const CHIP_INNER_SELECTED_CLASSES = [
    "e-10451-legacy-chip__inner--selected",
    "encore-inverted-light-set",
  ];

  /** @returns {HTMLElement | null} the filter chip bar (react-aria listbox) */
  function findChipBar() {
    return /** @type {HTMLElement | null} */ (
      document.querySelector('[role="listbox"][aria-label="Filter options"]') ||
        document.querySelector('[aria-label="Filter options"]')
    );
  }

  /**
   * Pick a native chip option wrapper to clone — prefer an unselected one so
   * the clone starts in the default (non-green) look.
   * @param {HTMLElement} bar
   * @returns {HTMLElement | null}
   */
  function pickChipTemplate(bar) {
    const chips = bar.querySelectorAll('[data-encore-id="chip"]');
    /** @type {HTMLElement | null} */
    let fallback = null;
    for (const c of chips) {
      const he = /** @type {HTMLElement} */ (c);
      const opt = /** @type {HTMLElement | null} */ (
        he.closest('[role="option"]')
      );
      if (!opt) continue;
      if (!fallback) fallback = opt;
      if (he.getAttribute("aria-checked") !== "true") return opt;
    }
    return fallback;
  }

  function findListRoot() {
    for (const sel of LIST_ROOT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return /** @type {HTMLElement} */ (el);
    }
    return null;
  }

  /** Replace the first non-empty text node in `el` with `label`, clear the rest. */
  function setChipLabel(el, label) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    let set = false;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.trim()) {
        node.nodeValue = set ? "" : label;
        set = true;
      }
    }
    if (!set) el.textContent = label;
  }

  /** Toggle the native "selected" look on our cloned chip option. */
  function applyChipActiveVisual(optEl, active) {
    const chipDiv = optEl.querySelector('[data-encore-id="chip"]') || optEl;
    chipDiv.classList.toggle(CHIP_SELECTED_CLASS, active);
    chipDiv.setAttribute("aria-checked", active ? "true" : "false");
    const inner = optEl.querySelector('[class*="legacy-chip__inner"]');
    if (inner) {
      for (const cls of CHIP_INNER_SELECTED_CLASSES) {
        inner.classList.toggle(cls, active);
      }
    }
    optEl.classList.toggle("ef-folders-chip-active", active);
  }

  /** Inject (or re-inject) the "Folders" chip into the native filter bar. */
  function injectFoldersChip() {
    const bar = findChipBar();
    if (!bar) return; // bar not in DOM (collapsed sidebar / search view) — no-op
    if (bar.querySelector(".ef-folders-chip-option")) return; // already present

    const tmpl = pickChipTemplate(bar);
    if (!tmpl) return; // no native chip to model ours on

    // Clone a whole chip option (wrapper → chip → label span) so it's native.
    const opt = /** @type {HTMLElement} */ (tmpl.cloneNode(true));
    opt.classList.add("ef-folders-chip-option");
    opt.removeAttribute("id");
    opt.removeAttribute("data-key");
    opt.setAttribute("tabindex", "-1");

    const chipDiv = /** @type {HTMLElement} */ (
      opt.querySelector('[data-encore-id="chip"]') || opt
    );
    chipDiv.classList.add("ef-folders-chip");
    chipDiv.setAttribute("aria-label", "Folders");

    const inner = opt.querySelector('[class*="legacy-chip__inner"]') || chipDiv;
    setChipLabel(/** @type {HTMLElement} */ (inner), "Folders");
    applyChipActiveVisual(opt, foldersFilterActive);

    opt.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFoldersView();
      },
      true
    );
    bar.appendChild(opt);

    // Any click on a native chip (or the clear-filter "X") drops our mode —
    // native filters dissolve folders, so the two are mutually exclusive.
    if (!(/** @type {any} */ (bar).__efChipListener)) {
      /** @type {any} */ (bar).__efChipListener = true;
      bar.addEventListener(
        "click",
        (e) => {
          const t = /** @type {HTMLElement} */ (e.target);
          if (
            foldersFilterActive &&
            !(t.closest && t.closest(".ef-folders-chip-option"))
          ) {
            deactivateFoldersView();
          }
        },
        true
      );
    }
  }

  function reflectChipState() {
    document.querySelectorAll(".ef-folders-chip-option").forEach((opt) => {
      applyChipActiveVisual(/** @type {HTMLElement} */ (opt), foldersFilterActive);
    });
  }

  function toggleFoldersView() {
    if (foldersFilterActive) deactivateFoldersView();
    else activateFoldersView();
  }

  /** @param {{ rebuild?: boolean }} [opts] */
  function activateFoldersView(opts = {}) {
    const root = findListRoot();
    if (!root || !root.parentElement) {
      Spicetify.showNotification("Enhanced Folders: library list not found", true);
      return;
    }
    foldersFilterActive = true;
    root.style.display = "none";
    _hiddenListRoot = root;

    let view = /** @type {HTMLElement | null} */ (
      document.querySelector(".ef-folders-view")
    );
    const fresh = !view;
    if (!view) {
      view = document.createElement("div");
      view.className = "ef-folders-view";
      root.parentElement.insertBefore(view, root.nextSibling);
    }
    view.hidden = false;
    reflectChipState();
    renderFoldersView(view, { rebuild: opts.rebuild ?? fresh });
  }

  function deactivateFoldersView() {
    foldersFilterActive = false;
    // Unhide whichever node is currently the list root (React may have swapped
    // it while we had the old one hidden).
    if (_hiddenListRoot) {
      _hiddenListRoot.style.display = "";
      _hiddenListRoot = null;
    }
    const current = findListRoot();
    if (current) current.style.display = "";
    // Remove our view entirely so no stale overlay lingers; recreated on toggle.
    document.querySelectorAll(".ef-folders-view").forEach((v) => v.remove());
    reflectChipState();
  }

  /** Re-assert hidden list + mounted view after React re-renders the sidebar. */
  function maintainFoldersView() {
    if (!foldersFilterActive) return;
    const view = document.querySelector(".ef-folders-view");
    const root = findListRoot();
    // React rebuilt the list root (new node, visible) or dropped our view.
    if ((root && root.style.display !== "none") || !view) {
      activateFoldersView({ rebuild: false });
    }
  }

  /** Invalidate caches + refresh the view after a data edit (rename/image). */
  function refreshFoldersViewAfterDataChange() {
    _folderTreeCache = null;
    if (foldersFilterActive) renderFoldersView(null, { rebuild: true });
  }
  //#endregion

  //#region Folders filter — view render
  /** @param {string} uri */
  function navigateToUri(uri) {
    try {
      /** @type {string | null} */
      let path = null;
      try {
        const u = Spicetify.URI.fromString(uri);
        path = u?.toURLPath ? u.toURLPath(true) : null;
      } catch {
        /* fall through to manual parse */
      }
      if (!path) {
        const parts = String(uri).split(":"); // spotify:playlist:ID
        if (parts.length >= 3) path = `/${parts[1]}/${parts[2]}`;
      }
      if (path) Spicetify.Platform.History.push(path);
    } catch (err) {
      console.warn(`${LOG_PREFIX} navigate failed`, err);
    }
  }

  /**
   * @param {HTMLElement} container
   * @param {FolderNode} folder
   * @param {number} depth
   */
  function renderFolderRow(container, folder, depth) {
    const id = folderIdFromUri(folder.uri);
    const stored = id ? getFolderData(id) : {};
    const expanded = _expandedFolders.has(folder.uri);
    const childCount = folder.folders.length + folder.playlists.length;

    const row = document.createElement("button");
    row.type = "button";
    row.className = "ef-folders-row ef-folders-folder-row";
    row.style.paddingLeft = `${8 + depth * 16}px`;
    row.innerHTML = `
      <span class="ef-folders-caret ${expanded ? "ef-open" : ""}" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8.47 4.97a.75.75 0 0 1 1.06 0l6 6a.75.75 0 0 1 0 1.06l-6 6a.75.75 0 1 1-1.06-1.06L13.94 11.5 8.47 6.03a.75.75 0 0 1 0-1.06z"></path></svg></span>
      <span class="ef-folders-art">${
        stored.image
          ? `<img src="${escapeHtml(stored.image)}" alt="">`
          : FOLDER_SVG
      }</span>
      <span class="ef-folders-meta">
        <span class="ef-folders-name">${escapeHtml(folder.name)}</span>
        <span class="ef-folders-sub">${childCount} item${
      childCount === 1 ? "" : "s"
    }</span>
      </span>`;
    row.addEventListener("click", () => {
      if (_expandedFolders.has(folder.uri))
        _expandedFolders.delete(folder.uri);
      else _expandedFolders.add(folder.uri);
      renderFoldersView(); // re-render from cache, preserves expansion set
    });
    container.appendChild(row);

    if (expanded) {
      for (const sub of folder.folders) renderFolderRow(container, sub, depth + 1);
      for (const pl of folder.playlists)
        renderPlaylistRow(container, pl, depth + 1);
    }
  }

  /**
   * @param {HTMLElement} container
   * @param {PlaylistNode} pl
   * @param {number} depth
   */
  function renderPlaylistRow(container, pl, depth) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ef-folders-row ef-folders-playlist-row";
    row.style.paddingLeft = `${8 + depth * 16}px`;
    row.innerHTML = `
      <span class="ef-folders-caret" aria-hidden="true"></span>
      <span class="ef-folders-art">${
        pl.image ? `<img src="${escapeHtml(pl.image)}" alt="">` : PLAYLIST_SVG
      }</span>
      <span class="ef-folders-meta">
        <span class="ef-folders-name">${escapeHtml(pl.name)}</span>
      </span>`;
    row.addEventListener("click", () => navigateToUri(pl.uri));
    container.appendChild(row);
  }

  /**
   * @param {HTMLElement | null} [view]
   * @param {{ rebuild?: boolean }} [opts]
   */
  async function renderFoldersView(view, opts = {}) {
    view =
      view ||
      /** @type {HTMLElement | null} */ (
        document.querySelector(".ef-folders-view")
      );
    if (!view) return;

    /** @type {FolderNode[]} */
    let folders = [];
    try {
      folders = await ensureFolderTree(opts.rebuild);
    } catch (err) {
      console.warn(`${LOG_PREFIX} folders view build failed`, err);
    }

    view.innerHTML = "";
    const header = document.createElement("div");
    header.className = "ef-folders-view-header";
    header.textContent = `FOLDERS (${folders.length})`;
    view.appendChild(header);

    if (folders.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ef-folders-empty";
      empty.textContent = "No folders in your library.";
      view.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "ef-folders-list";
    for (const f of folders) renderFolderRow(list, f, 0);
    view.appendChild(list);
  }
  //#endregion

  //#region CSS
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Sidebar image overlay.
         The <img> is absolutely positioned to fill the artwork slot. JS
         forces position:relative + overflow:hidden on the slot at decoration
         time so the image is always sized to that slot specifically — never
         escapes to a larger positioned ancestor. */
      .ef-folder-img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: inherit;
        z-index: 2;
        pointer-events: none;
        display: block;
      }
      /* Hide the default folder SVG/placeholder underneath our image */
      .ef-has-image > svg,
      .ef-has-image > [class*="placeholder"],
      .ef-has-image > [class*="Placeholder"] {
        visibility: hidden;
      }

      /* ─── Edit details modal ─── */
      .ef-edit-modal { display: flex; flex-direction: column; gap: 12px; min-width: 480px; }
      .ef-edit-row { display: flex; gap: 20px; align-items: flex-start; }
      .ef-edit-image-section {
        flex: 0 0 200px;
        display: flex; flex-direction: column; gap: 8px;
      }
      .ef-edit-image-wrapper {
        width: 200px; height: 200px;
        border-radius: 6px; overflow: hidden;
        cursor: pointer; position: relative;
        background: var(--spice-card, hsla(0, 0%, 100%, 0.08));
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      }
      .ef-edit-img-preview { width: 100%; height: 100%; object-fit: cover; display: block; color: var(--spice-subtext, hsla(0,0%,100%,0.4)); }
      .ef-edit-img-placeholder { display: flex; align-items: center; justify-content: center; }
      .ef-edit-img-overlay {
        position: absolute; inset: 0;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 8px; background: rgba(0, 0, 0, 0.6);
        opacity: 0; transition: opacity 0.2s; color: #fff;
        font-size: 14px; font-weight: 600;
      }
      .ef-edit-image-wrapper:hover .ef-edit-img-overlay { opacity: 1; }
      .ef-edit-remove-image {
        padding: 6px 12px; background: transparent;
        color: var(--spice-subtext, #b3b3b3);
        border: 1px solid var(--spice-button-disabled, hsla(0,0%,100%,0.2));
        border-radius: 16px;
        cursor: pointer; font-size: 12px;
      }
      .ef-edit-remove-image:hover { color: var(--spice-text, #fff); border-color: var(--spice-text, #fff); }

      /* Right column matches image height so textarea bottom aligns with image bottom */
      .ef-edit-fields {
        flex: 1 1 auto; min-width: 0;
        height: 200px;
        display: flex; flex-direction: column;
        gap: 6px;
      }
      .ef-edit-label {
        color: var(--spice-subtext, #b3b3b3);
        font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.08em;
        margin: 0;
      }
      .ef-edit-input {
        width: 100%; padding: 8px 12px;
        background: var(--spice-card, hsla(0, 0%, 100%, 0.06));
        border: 1px solid var(--spice-button-disabled, hsla(0, 0%, 100%, 0.18));
        border-radius: 4px;
        color: var(--spice-text, #fff);
        font-size: 14px; font-family: inherit;
        box-sizing: border-box;
      }
      .ef-edit-name-input { font-size: 15px; font-weight: 600; }
      .ef-edit-textarea {
        resize: none;          /* let flex size it */
        flex: 1 1 auto;
        min-height: 0;
      }
      .ef-edit-input:focus {
        outline: none;
        border-color: var(--spice-button, #1ed760);
        background: var(--spice-main, hsla(0,0%,100%,0.15));
      }

      /* ─── Action button row (shared across all EF modals) ─── */
      .ef-edit-actions {
        display: flex; flex-direction: row;
        gap: 8px; justify-content: flex-end; align-items: center;
        flex-wrap: nowrap;
        margin-top: 4px;
      }
      .ef-edit-cancel, .ef-edit-save,
      .ef-export-copy, .ef-export-download,
      .ef-import-replace, .ef-import-load-file, .ef-import-merge,
      .ef-settings-btn {
        padding: 8px 22px;
        border-radius: 999px;
        font-size: 14px; font-weight: 700;
        cursor: pointer; white-space: nowrap;
        font-family: inherit;
        transition: transform 0.1s, background 0.1s, border-color 0.1s;
      }
      .ef-edit-cancel {
        background: transparent;
        border: 1px solid var(--spice-button-disabled, hsla(0,0%,100%,0.3));
        color: var(--spice-text, #fff);
      }
      .ef-edit-cancel:hover { border-color: var(--spice-text, #fff); transform: scale(1.03); }

      .ef-edit-save, .ef-export-copy, .ef-export-download, .ef-import-merge {
        background: var(--spice-button, #1ed760);
        border: none; color: var(--spice-button-text, #000);
      }
      .ef-edit-save:hover, .ef-export-copy:hover, .ef-export-download:hover,
      .ef-import-merge:hover { transform: scale(1.04); }

      .ef-import-replace { background: hsla(0, 70%, 55%, 1); border: none; color: #fff; }
      .ef-import-replace:hover { background: hsla(0, 70%, 60%, 1); transform: scale(1.04); }

      .ef-import-load-file, .ef-settings-btn {
        background: transparent;
        border: 1px solid var(--spice-button-disabled, hsla(0,0%,100%,0.3));
        color: var(--spice-text, #fff);
      }
      .ef-import-load-file:hover, .ef-settings-btn:hover {
        border-color: var(--spice-text, #fff);
        background: var(--spice-card, hsla(0,0%,100%,0.06));
      }

      .ef-edit-disclaimer {
        margin: 4px 0 0;
        color: var(--spice-subtext, #b3b3b3);
        font-size: 11px; line-height: 1.4;
      }

      /* ─── Settings modal (profile dropdown entry) ─── */
      .ef-settings-modal {
        display: flex; flex-direction: column;
        gap: 18px; padding: 4px 0;
        min-width: 320px;
        color: var(--spice-text, #fff);
      }
      .ef-settings-section { display: flex; flex-direction: column; gap: 6px; }
      .ef-settings-heading {
        margin: 0 0 4px;
        color: var(--spice-subtext, #b3b3b3);
        font-size: 13px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .ef-settings-text {
        margin: 0;
        color: var(--spice-text, #fff);
        font-size: 13px; line-height: 1.5;
      }
      .ef-settings-text strong { color: var(--spice-text, #fff); font-weight: 600; }
      .ef-settings-actions {
        display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px;
      }

      /* ─── Export / Import modals ─── */
      .ef-export-modal, .ef-import-modal {
        display: flex; flex-direction: column; gap: 10px;
        min-width: 480px;
      }
      .ef-export-modal .ef-edit-textarea, .ef-import-modal .ef-edit-textarea {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px; min-height: 220px;
        resize: vertical;
      }

      /* ─── Folders filter chip ─── */
      /* Cloned from a real native chip; the active/selected look is driven by
         toggling Spotify's own e-10451-legacy-chip--selected classes (see
         applyChipActiveVisual), so no custom colors are needed here. */
      .ef-folders-chip-option { cursor: pointer; }
      .ef-folders-chip-option .ef-folders-chip { cursor: pointer; }

      /* ─── Folders filter view (replaces native list while active) ─── */
      .ef-folders-view {
        display: flex; flex-direction: column;
        height: 100%; min-height: 0;
        overflow-y: auto; overflow-x: hidden;
        padding: 4px 8px 8px;
        box-sizing: border-box;
        color: var(--spice-text, #fff);
      }
      .ef-folders-view-header {
        color: var(--spice-subtext, #b3b3b3);
        font-size: 11px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.08em;
        padding: 8px 8px 6px;
      }
      .ef-folders-empty {
        color: var(--spice-subtext, #b3b3b3);
        font-size: 13px; padding: 12px 8px;
      }
      .ef-folders-list { display: flex; flex-direction: column; gap: 2px; }
      .ef-folders-row {
        display: flex; align-items: center; gap: 10px;
        width: 100%; padding: 6px 8px;
        background: transparent; border: none;
        border-radius: 6px; cursor: pointer;
        color: var(--spice-text, #fff);
        font-family: inherit; text-align: left;
      }
      .ef-folders-row:hover { background: var(--spice-card, hsla(0, 0%, 100%, 0.08)); }
      .ef-folders-caret {
        flex: 0 0 16px; display: flex; align-items: center; justify-content: center;
        color: var(--spice-subtext, #b3b3b3);
        transition: transform 0.15s ease;
      }
      .ef-folders-caret.ef-open { transform: rotate(90deg); }
      .ef-folders-art {
        flex: 0 0 40px; width: 40px; height: 40px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 4px; overflow: hidden;
        background: var(--spice-card, hsla(0, 0%, 100%, 0.08));
        color: var(--spice-subtext, hsla(0, 0%, 100%, 0.5));
      }
      .ef-folders-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .ef-folders-meta { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
      .ef-folders-name {
        font-size: 14px; font-weight: 500;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ef-folders-sub {
        font-size: 11px; color: var(--spice-subtext, #b3b3b3);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ef-folders-playlist-row .ef-folders-art { flex-basis: 32px; width: 32px; height: 32px; }
    `;
    document.head.appendChild(style);
  }
  //#endregion

  //#region Context menu + profile menu registration
  new Spicetify.ContextMenu.Item(
    "Edit folder details",
    (uris) => openEditDetailsModal(uris[0]),
    (uris) => uris.length === 1 && isFolderUri(uris[0]),
    "edit"
  ).register();

  // Profile dropdown entry (matches house style: Album Length, Listening List, Enhanced Pins)
  if (Spicetify?.Menu?.Item) {
    new Spicetify.Menu.Item("Enhanced Folders", false, openSettingsModal).register();
  }
  //#endregion

  //#region Observer + bootstrap
  injectStyles();

  // Initial paint + chip
  scheduleDecorate();
  injectFoldersChip();

  // Keep injected chrome (Folders chip) mounted and the folders view asserted
  // across React re-renders. Debounced separately from decoration.
  /** @type {ReturnType<typeof setTimeout> | null} */
  let _chromeTimer = null;
  function scheduleChrome() {
    if (_chromeTimer) return;
    _chromeTimer = setTimeout(() => {
      _chromeTimer = null;
      injectFoldersChip();
      maintainFoldersView();
    }, 150);
  }

  // Re-decorate on sidebar mutations. Observe the whole library nav so chip-bar
  // mutations (above the rootlist) are caught too; fall back narrower.
  const observer = new MutationObserver(() => {
    scheduleDecorate();
    scheduleChrome();
  });
  const observerRoot =
    document.querySelector('nav[aria-label="Your Library"]') ||
    document.querySelector(".main-yourLibraryX-libraryRootlist") ||
    document.querySelector('[data-testid="rootlist"]') ||
    document.body;
  observer.observe(observerRoot, { childList: true, subtree: true });

  // Re-decorate on navigation
  try {
    Spicetify.Platform.History.listen(() => {
      scheduleDecorate();
      scheduleChrome();
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} History.listen unavailable`, err);
  }

  // Clean up stale entries once on boot
  cleanUpStaleEntries().catch((err) =>
    console.warn(`${LOG_PREFIX} cleanup failed`, err)
  );

  const state = loadAll();
  console.log(
    `${LOG_PREFIX} Booted. Schema v${state.schemaVersion}, ${
      Object.keys(state.folders).length
    } stored folder(s).`
  );
  //#endregion
})();
