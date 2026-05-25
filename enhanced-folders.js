// @ts-check
/**
 * Spicetify Enhanced Folders
 * Add custom images and descriptions to Spotify playlist folders.
 *
 * Status: scaffold / bootstrap stub. v1 feature implementation pending.
 */

(async function main() {
  "use strict";

  //#region Constants
  const LOG_PREFIX = "[Enhanced Folders]";
  const ACTIVE_FLAG = "__enhancedFoldersActive";
  const STORAGE_KEY = "enhanced-folders:data";
  const SCHEMA_VERSION = 1;
  const STYLE_ID = "enhanced-folders-style";
  //#endregion

  //#region Wait for Spicetify
  while (
    !window.Spicetify ||
    !Spicetify.CosmosAsync ||
    !Spicetify.ContextMenu ||
    !Spicetify.URI ||
    !Spicetify.Platform ||
    !Spicetify.LocalStorage ||
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

  //#region Storage (stub)
  /** @returns {{ schemaVersion: number, folders: Record<string, { image?: string, description?: string }> }} */
  function loadAll() {
    try {
      const raw = Spicetify.LocalStorage.get(STORAGE_KEY);
      if (!raw) return { schemaVersion: SCHEMA_VERSION, folders: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return { schemaVersion: SCHEMA_VERSION, folders: {} };
      }
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        // Future: migrations
        console.warn(`${LOG_PREFIX} unknown schema ${parsed.schemaVersion}; resetting`);
        return { schemaVersion: SCHEMA_VERSION, folders: {} };
      }
      return parsed;
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to load storage`, err);
      return { schemaVersion: SCHEMA_VERSION, folders: {} };
    }
  }
  //#endregion

  //#region Context menu (stub — opens placeholder notification)
  const editDetailsItem = new Spicetify.ContextMenu.Item(
    "Edit details",
    (uris) => {
      const uri = uris[0];
      Spicetify.showNotification(
        `Enhanced Folders: edit details for ${uri} (modal not yet implemented)`
      );
    },
    (uris) => uris.length === 1 && Spicetify.URI.isFolder(uris[0]),
    "edit"
  );
  editDetailsItem.register();
  //#endregion

  //#region Bootstrap complete
  const state = loadAll();
  console.log(
    `${LOG_PREFIX} Booted. Schema v${state.schemaVersion}, ${
      Object.keys(state.folders).length
    } stored folder(s).`
  );
  //#endregion
})();
