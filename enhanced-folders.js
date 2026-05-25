// @ts-check
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
  /** Enumerate own + prototype method names on an object. */
  function listMethods(obj) {
    const names = new Set();
    let cur = obj;
    while (cur && cur !== Object.prototype) {
      for (const k of Reflect.ownKeys(cur)) {
        if (typeof k === "string" && k !== "constructor") {
          try {
            if (typeof obj[k] === "function") names.add(k);
          } catch {}
        }
      }
      cur = Object.getPrototypeOf(cur);
    }
    return [...names].sort();
  }

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
      if (!slot) {
        // Cannot decorate without an artwork container — emit one debug line
        // per row (deduped) so console isn't spammed.
        if (!rowEl.hasAttribute("data-ef-warned")) {
          rowEl.setAttribute("data-ef-warned", "1");
          console.debug(
            `${LOG_PREFIX} no artwork container in row; image not applied. Row:`,
            rowEl
          );
        }
        return;
      }

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

  function undecorateRow(rowEl) {
    rowEl.removeAttribute("title");
    rowEl.removeAttribute(DECOR_ATTR);
    rowEl.removeAttribute("data-ef-warned");
    rowEl.querySelectorAll(".ef-folder-img").forEach((n) => n.remove());
    rowEl.querySelectorAll(".ef-has-image").forEach((n) => {
      n.classList.remove("ef-has-image");
      // Leave inline position/overflow styles — harmless if container kept
    });
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

  // Initial paint
  scheduleDecorate();

  // Re-decorate on sidebar mutations. Scope the observer to the library
  // rootlist if it exists (cheaper); otherwise fall back to document.body.
  const observer = new MutationObserver(() => scheduleDecorate());
  const observerRoot =
    document.querySelector(".main-yourLibraryX-libraryRootlist") ||
    document.querySelector('[data-testid="rootlist"]') ||
    document.querySelector('nav[aria-label="Your Library"]') ||
    document.body;
  observer.observe(observerRoot, { childList: true, subtree: true });

  // Re-decorate on navigation
  try {
    Spicetify.Platform.History.listen(() => scheduleDecorate());
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
  // Probe Spicetify.Platform so users can see what's actually available
  // on their Spotify version. Joins method arrays into a single string
  // so DevTools shows them inline instead of collapsing to `Array(N)`.
  try {
    const platform = Spicetify.Platform || {};
    for (const name of ["RootlistAPI", "PlaylistAPI", "LibraryAPI"]) {
      if (!platform[name]) continue;
      const methods = listMethods(platform[name]);
      console.log(
        `${LOG_PREFIX} ${name} (${methods.length} methods): ${methods.join(", ")}`
      );
    }
    // Source of renameFolder reveals param shape even when minified.
    const rf = platform.RootlistAPI?.renameFolder;
    if (typeof rf === "function") {
      console.log(
        `${LOG_PREFIX} renameFolder.toString(): ${rf.toString().slice(0, 500)}`
      );
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Platform probe failed`, err);
  }
  //#endregion
})();
