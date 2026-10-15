# Screenshots — Enhanced Folders

Read by the `spicetify-screenshots` skill. Keep selectors and rects accurate; they are what
makes a capture run mechanical instead of exploratory.

Extension file: `enhanced-folders.js`
Storage key: `enhanced-folders:data` (`{ schemaVersion, folders: { <folderId>: { image, description, updatedAt } } }`)

## Fixtures

`screenshots/fixtures/folders.json` maps one throwaway folder name, **Road Trip**, to a
generated 354px JPEG data URL and a description. The image is drawn from scratch, so it
carries no third-party artwork.

Data is keyed by folder ID, and the ID only exists once the folder does, so the session
creates the folder first and builds the seed from its ID. Merge the new entry into the
existing `enhanced-folders:data`; don't replace it.

## Capture session

1. **Snapshot before touching anything**, and keep the file until the restore is verified:

   ```
   node shoot.mjs snapshot "enhanced-folders:data" backup.json
   ```

2. Create the throwaway folder at the top of the rootlist. Keep the returned URI. The
   second argument is required: calling it without one throws inside the API.

   ```js
   const { uri } = await Spicetify.Platform.RootlistAPI.createFolder('Road Trip', {})
   ```

3. Build the seed from `backup.json`, the fixture, and the folder ID (the hex after
   `:folder:` in the URI). Then:

   ```
   node shoot.mjs restore seed.json
   node shoot.mjs viewport 1440 1000
   node shoot.mjs reload                 # REQUIRED: data is read at boot
   ```

4. Open the dialog with a real right-click on the folder row, then
   `click "[role=menu] button" --text "Edit folder details"`.

## Verification

```
node shoot.mjs verify ".ef-edit-img-preview" --min 1 --within ".ef-edit-modal"
```

## Shot list

| Output | Surface | Rect | README caption |
|---|---|---|---|
| `preview.png` | Edit folder details dialog | `--rect 390,281,660,439 --scale 2` (the `.GenericModal` box inset by 2px, which drops the corners where the page behind shows through) | Marketplace card and README hero |

## Restore

1. Close the dialog with **Cancel**, never Save.
2. Delete the folder. `removeFolder` takes the **URI string**, unlike `renameFolder`, which
   takes `{ uri }`. From the minified source:
   `removeFolder(e){… applyModification({operation:"remove",contents:!0,rows:[e]})}` versus
   `renameFolder(e,t){… rows:[e.uri]}`. `contents: true` also deletes whatever is inside
   the folder, so check that it's empty first and never pass any other folder's URI:

   ```js
   const api = Spicetify.Platform.RootlistAPI
   const f = (await api.getContents()).items.find(i => i.uri === uri)
   if (f && !(f.items || []).length) await api.removeFolder(uri)
   ```

3. Put everything else back:

   ```
   node shoot.mjs reset-viewport ; node shoot.mjs restore backup.json ; node shoot.mjs reload
   ```

4. Check that the rootlist item count matches the count before step 2, and that
   `enhanced-folders:data` is byte-identical to `backup.json`.

### If a session is interrupted

The client is left with the throwaway folder and the seeded data. From a fresh CDP session:

- Find the folder by name with `getContents()`, filtering on `type === 'folder'`,
  `name === 'Road Trip'` and no items. Delete it as in step 2.
- Run `restore backup.json`, then `reset-viewport` and `reload`. If `backup.json` is gone,
  delete only the throwaway folder's key from `enhanced-folders:data`. Its entry is the only
  one this session added, and the extension's stale-entry cleanup also drops it on the next
  boot once the folder is gone.

## Known gaps

On Spotify 1.3.4.258 the sidebar decoration and the Folders chip view don't render
([#7](https://github.com/yusufaf/spicetify-enhanced-folders/issues/7)). That's why the
preview shows the dialog rather than a decorated sidebar. Re-shoot the sidebar once #7 is
fixed.
