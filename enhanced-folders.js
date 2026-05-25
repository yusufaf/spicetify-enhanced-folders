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

  /** @type {string[]} sidebar root containers to observe (first match wins) */
  const SIDEBAR_ROOT_SELECTORS = [
    ".main-yourLibraryX-libraryRootlist",
    '[data-testid="rootlist"]',
    'nav[aria-label="Your Library"]',
  ];

  /** @type {string[]} candidate selectors for a folder row in the sidebar */
  const FOLDER_ROW_SELECTORS = [
    "li.main-useDropTarget-folder",
    'li[role="treeitem"][aria-labelledby*="folder"]',
    'div[role="row"][aria-labelledby*="folder"]',
  ];
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

  //#region Rootlist enumeration
  /** @returns {Promise<Map<string, string>>} map of folderId -> folder name */
  async function fetchFolderMap() {
    const map = new Map();
    try {
      const rootlist = await Spicetify.CosmosAsync.get(
        "sp://core-playlist/v1/rootlist"
      );
      walkRows(rootlist?.rows || [], map);
    } catch (err) {
      console.error(`${LOG_PREFIX} fetchFolderMap failed`, err);
    }
    return map;
  }

  function walkRows(rows, map) {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (row.type === "folder") {
        const id = folderIdFromUri(row.link || row.uri);
        if (id) map.set(id, row.name || "");
        if (Array.isArray(row.rows)) walkRows(row.rows, map);
      }
    }
  }

  /** Drop stored entries whose folders no longer exist. */
  async function cleanUpStaleEntries() {
    const map = await fetchFolderMap();
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

  //#region Edit details modal
  /** @param {string} folderUri */
  async function openEditDetailsModal(folderUri) {
    const folderId = folderIdFromUri(folderUri);
    if (!folderId) {
      Spicetify.showNotification("Enhanced Folders: invalid folder URI", true);
      return;
    }

    const folderMap = await fetchFolderMap();
    const folderName = folderMap.get(folderId) || "Folder";
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
          <label class="ef-edit-label">Folder</label>
          <div class="ef-edit-foldername">${escapeHtml(folderName)}</div>
          <label class="ef-edit-label" for="ef-edit-desc">Description</label>
          <textarea id="ef-edit-desc" class="ef-edit-input ef-edit-textarea" rows="5" maxlength="${MAX_DESCRIPTION_LEN}" placeholder="Add a description (shown on hover)">${escapeHtml(existing.description || "")}</textarea>
          <div class="ef-edit-actions">
            <button type="button" class="ef-edit-cancel">Cancel</button>
            <button type="button" class="ef-edit-save">Save</button>
          </div>
        </div>
      </div>
      <p class="ef-edit-disclaimer">Image and description are stored locally on this device only. Folder IDs are not synced across Spotify installs — use Export to back up.</p>
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

    content.querySelector(".ef-edit-save")?.addEventListener("click", () => {
      const description = descArea.value.trim();
      setFolderData(folderId, {
        image: pendingImage || undefined,
        description: description || undefined,
      });
      Spicetify.PopupModal.hide();
      Spicetify.showNotification(`Updated: ${folderName}`);
      decorateAllFolders(); // immediate re-render
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
  /** @type {Map<string, string>} cached name -> folderId (built each decoration pass) */
  let _nameToIdCache = new Map();

  function findSidebarRoot() {
    for (const sel of SIDEBAR_ROOT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body; // fallback so observer still works
  }

  /** Returns array of folder row elements (best-effort across Spotify versions). */
  function findFolderRowElements() {
    const root = findSidebarRoot();
    /** @type {Element[]} */
    const results = [];
    const seen = new Set();
    for (const sel of FOLDER_ROW_SELECTORS) {
      root.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      });
    }
    return results;
  }

  /** Try to derive a folder ID for a given sidebar row element. */
  function rowToFolderId(rowEl) {
    // Strategy 1: any descendant link's href contains "spotify:folder:" or "/folder/"
    const link = rowEl.querySelector('a[href*="folder"], [href*="folder"]');
    if (link) {
      const href = link.getAttribute("href") || "";
      const id = folderIdFromUri(href) || (href.match(/folder\/([0-9a-f]+)/i) || [])[1];
      if (id) return id;
    }
    // Strategy 2: aria-labelledby references an element whose id/text contains the URI
    const labelledBy = rowEl.getAttribute("aria-labelledby") || "";
    const idFromAria = folderIdFromUri(labelledBy);
    if (idFromAria) return idFromAria;
    // Strategy 3: name match — read row text, look up via cache built from rootlist
    const text = rowEl.textContent?.trim() || "";
    if (text && _nameToIdCache.has(text)) return _nameToIdCache.get(text);
    return null;
  }

  /** Find or create the image slot inside a folder row. */
  function getOrCreateImageSlot(rowEl) {
    // Prefer Spotify's own image container
    const existing =
      rowEl.querySelector(".x-entityImage-imageContainer") ||
      rowEl.querySelector(".main-cardImage-imageWrapper") ||
      rowEl.querySelector('[data-testid="entity-image"]');
    if (existing) return /** @type {HTMLElement} */ (existing);
    // Otherwise inject our own container before the first child
    let slot = rowEl.querySelector(".ef-injected-image-slot");
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "ef-injected-image-slot";
      rowEl.insertBefore(slot, rowEl.firstChild);
    }
    return /** @type {HTMLElement} */ (slot);
  }

  function decorateRow(rowEl, data) {
    const slot = getOrCreateImageSlot(rowEl);
    // Tooltip via title attribute
    if (data.description) {
      rowEl.setAttribute("title", data.description);
    } else {
      rowEl.removeAttribute("title");
    }
    // Image overlay
    let img = slot.querySelector("img.ef-folder-img");
    if (data.image) {
      if (!img) {
        img = document.createElement("img");
        img.className = "ef-folder-img";
        img.alt = "";
        slot.appendChild(img);
      }
      if (img.getAttribute("src") !== data.image) {
        img.setAttribute("src", data.image);
      }
      slot.classList.add("ef-has-image");
    } else {
      if (img) img.remove();
      slot.classList.remove("ef-has-image");
    }
    rowEl.setAttribute(DECOR_ATTR, "1");
  }

  function undecorateRow(rowEl) {
    rowEl.removeAttribute("title");
    rowEl.removeAttribute(DECOR_ATTR);
    rowEl.querySelectorAll(".ef-folder-img").forEach((n) => n.remove());
    rowEl
      .querySelectorAll(".ef-injected-image-slot")
      .forEach((n) => n.remove());
    rowEl
      .querySelectorAll(".x-entityImage-imageContainer, .main-cardImage-imageWrapper")
      .forEach((n) => n.classList.remove("ef-has-image"));
  }

  let _decorateScheduled = false;
  function scheduleDecorate() {
    if (_decorateScheduled) return;
    _decorateScheduled = true;
    requestAnimationFrame(async () => {
      _decorateScheduled = false;
      await decorateAllFolders();
    });
  }

  async function decorateAllFolders() {
    const store = loadAll();
    if (Object.keys(store.folders).length === 0) return;
    // Refresh name->id cache for fallback matching
    const folderMap = await fetchFolderMap();
    _nameToIdCache = new Map();
    for (const [id, name] of folderMap.entries()) {
      if (name) _nameToIdCache.set(name, id);
    }
    const rows = findFolderRowElements();
    if (rows.length === 0) {
      console.debug(
        `${LOG_PREFIX} no folder rows matched — selectors may have drifted.`
      );
      return;
    }
    for (const row of rows) {
      const id = rowToFolderId(row);
      if (!id) continue;
      const data = store.folders[id];
      if (data) {
        decorateRow(row, data);
      } else if (row.hasAttribute(DECOR_ATTR)) {
        undecorateRow(row);
      }
    }
  }
  //#endregion

  //#region CSS
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Sidebar overlay */
      .ef-injected-image-slot {
        width: 32px;
        height: 32px;
        flex-shrink: 0;
        border-radius: 4px;
        overflow: hidden;
        position: relative;
        margin-right: 8px;
      }
      .ef-folder-img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 4px;
        z-index: 1;
        pointer-events: none;
      }
      .x-entityImage-imageContainer.ef-has-image > svg,
      .main-cardImage-imageWrapper.ef-has-image > svg {
        display: none;
      }

      /* Edit details modal */
      .ef-edit-modal { display: flex; flex-direction: column; gap: 16px; }
      .ef-edit-row { display: flex; gap: 20px; align-items: stretch; }
      .ef-edit-image-section {
        flex: 0 0 200px; display: flex; flex-direction: column; gap: 8px;
      }
      .ef-edit-image-wrapper {
        width: 200px; height: 200px; border-radius: 6px; overflow: hidden;
        cursor: pointer; position: relative;
        background: hsla(0, 0%, 100%, 0.08);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      }
      .ef-edit-img-preview { width: 100%; height: 100%; object-fit: cover; display: block; color: hsla(0,0%,100%,0.4); }
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
        padding: 6px 12px; background: transparent; color: var(--spice-subtext, #b3b3b3);
        border: 1px solid hsla(0,0%,100%,0.2); border-radius: 16px;
        cursor: pointer; font-size: 12px;
      }
      .ef-edit-remove-image:hover { color: #fff; border-color: #fff; }

      .ef-edit-fields {
        flex: 1 1 auto; display: flex; flex-direction: column;
        gap: 10px; min-width: 0;
      }
      .ef-edit-label {
        color: var(--spice-subtext, #b3b3b3);
        font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.08em;
        margin: 0 0 2px;
      }
      .ef-edit-foldername {
        color: #fff; font-size: 16px; font-weight: 600;
        margin: -4px 0 8px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ef-edit-input {
        width: 100%; padding: 8px 12px;
        background: hsla(0, 0%, 100%, 0.1); border: 1px solid transparent;
        border-radius: 4px; color: #fff; font-size: 14px;
        font-family: inherit; box-sizing: border-box;
      }
      .ef-edit-textarea { resize: vertical; min-height: 120px; flex: 1 1 auto; }
      .ef-edit-input:focus { outline: none; border-color: var(--spice-button, #1db954); background: hsla(0,0%,100%,0.15); }

      .ef-edit-actions {
        display: flex; flex-direction: row;
        gap: 8px; justify-content: flex-end; align-items: center;
        flex-wrap: nowrap;
        margin-top: auto; padding-top: 8px;
      }
      .ef-edit-cancel, .ef-edit-save,
      .ef-export-copy, .ef-export-download,
      .ef-import-replace, .ef-import-load-file,
      .ef-settings-btn {
        padding: 8px 20px;
        border-radius: 500px;
        font-size: 14px; font-weight: 700;
        cursor: pointer; white-space: nowrap;
        font-family: inherit;
        transition: transform 0.1s, background 0.1s, border-color 0.1s;
      }
      .ef-edit-cancel {
        background: transparent;
        border: 1px solid hsla(0,0%,100%,0.3);
        color: #fff;
      }
      .ef-edit-cancel:hover { border-color: #fff; transform: scale(1.03); }
      .ef-edit-save, .ef-export-copy, .ef-export-download, .ef-import-merge {
        background: var(--spice-button, #1db954);
        border: none; color: #000;
      }
      .ef-edit-save:hover, .ef-export-copy:hover, .ef-export-download:hover,
      .ef-import-merge:hover { transform: scale(1.04); }
      .ef-import-replace {
        background: hsla(0, 70%, 55%, 1);
        border: none; color: #fff;
      }
      .ef-import-replace:hover { background: hsla(0, 70%, 60%, 1); transform: scale(1.04); }
      .ef-import-load-file, .ef-settings-btn {
        background: hsla(0,0%,100%,0.1);
        border: 1px solid hsla(0,0%,100%,0.15);
        color: #fff;
      }
      .ef-import-load-file:hover, .ef-settings-btn:hover {
        background: hsla(0,0%,100%,0.18); border-color: hsla(0,0%,100%,0.3);
      }

      .ef-edit-disclaimer {
        margin: 0;
        color: var(--spice-subtext, #b3b3b3);
        font-size: 11px; line-height: 1.4;
      }

      /* Settings modal */
      .ef-settings-modal { display: flex; flex-direction: column; gap: 20px; padding: 4px 0; }
      .ef-settings-section { display: flex; flex-direction: column; gap: 8px; }
      .ef-settings-heading {
        margin: 0; color: #fff; font-size: 13px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.08em;
      }
      .ef-settings-text {
        margin: 0; color: var(--spice-subtext, #b3b3b3);
        font-size: 13px; line-height: 1.5;
      }
      .ef-settings-actions {
        display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;
      }

      /* Export/Import modal */
      .ef-export-modal, .ef-import-modal { display: flex; flex-direction: column; gap: 12px; }
      .ef-export-modal .ef-edit-textarea, .ef-import-modal .ef-edit-textarea {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px; min-height: 200px;
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

  // Re-decorate on sidebar mutations
  const observer = new MutationObserver(() => scheduleDecorate());
  const startObserver = () => {
    const root = findSidebarRoot();
    observer.observe(root, { childList: true, subtree: true });
  };
  startObserver();

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
  //#endregion
})();
