# Screenshots — Enhanced Folders

Read by the `spicetify-screenshots` skill. Keep selectors and rects accurate; they are what
makes a capture run mechanical instead of exploratory.

Extension file: `enhanced-folders.js`
Storage key: `enhanced-folders:data` (`{ schemaVersion, folders: { <folderId>: { image, description, updatedAt } } }`)

## Fixtures

`screenshots/fixtures/folders.json` maps one throwaway folder name, **Road Trip**, to a
generated 354px JPEG data URL and a description. The image is drawn from scratch, so it
carries no third-party artwork.

The sidebar shot needs six throwaway folders: **Road Trip** plus **Late Night**, **Gym Mix**,
**Sunday Morning**, **Deep Focus** and **Throwbacks**. Their images are drawn in the page
with a `<canvas>` (gradients and simple shapes, exported with
`toDataURL('image/jpeg', 0.85)` at 354px), so they carry no third-party artwork either.

Data is keyed by folder ID, and the ID only exists once the folder does, so the session
creates the folder first and builds the seed from its ID. Merge the new entry into the
existing `enhanced-folders:data`; don't replace it.

## Capture session

1. **Snapshot before touching anything**, and keep the file until the restore is verified:

   ```
   node shoot.mjs snapshot "enhanced-folders:data" backup.json
   ```

2. Create the throwaway folder(s) at the top of the rootlist. Keep each returned URI. The
   second argument is required: calling it without one throws inside the API.

   ```js
   const { uri } = await Spicetify.Platform.RootlistAPI.createFolder('Road Trip', {})
   ```

3. Build the seed from `backup.json`, the fixture, and the folder IDs (the hex after
   `:folder:` in each URI), adding one entry per throwaway folder to the existing data. Then:

   ```
   node shoot.mjs restore seed.json
   node shoot.mjs viewport 1440 1000
   node shoot.mjs reload                 # REQUIRED: data is read at boot
   ```

4. For `edit-dialog.png`: open the dialog with a real right-click on the folder row, then
   `click "[role=menu] button" --text "Edit folder details"`.
5. For `preview.png`: the six folders land next to each other near the top of the list.
   Set the library width to 400px so a row is 384px wide and six rows make a square
   (`Spicetify.Platform.LocalStorageAPI.setItem('left-sidebar-default-state-width', 400)`;
   record the old value first and put it back afterwards). Scroll the sidebar's
   `[data-overlayscrollbars-viewport]` until the first throwaway row's top sits at y=300.

## Verification

```
node shoot.mjs verify "img.ef-folder-img" --min 6 --within "[role=grid] [role=row]"   # preview.png
node shoot.mjs verify ".ef-edit-img-preview" --min 1 --within ".ef-edit-modal"         # edit-dialog.png
```

## Shot list

| Output | Surface | Rect | README caption |
|---|---|---|---|
| `preview.png` | six decorated throwaway folder rows in the sidebar | `--rect 16,300,384,384 --scale 2` | Marketplace card and README hero |
| `edit-dialog.png` | Edit folder details dialog | `--rect 390,281,660,439 --scale 2` (the `.GenericModal` box inset by 2px, which drops the corners where the page behind shows through) | README Usage |

Never let the sidebar rect reach past the throwaway rows: the rows above and below are the
developer's own library. Check each row's title before capturing.

## Restore

1. Close the dialog with **Cancel**, never Save.
2. Delete each throwaway folder. `removeFolder` takes the **URI string**, unlike `renameFolder`, which
   takes `{ uri }`. From the minified source:
   `removeFolder(e){… applyModification({operation:"remove",contents:!0,rows:[e]})}` versus
   `renameFolder(e,t){… rows:[e.uri]}`. `contents: true` also deletes whatever is inside
   the folder, so check that it's empty first and never pass any other folder's URI:

   ```js
   const api = Spicetify.Platform.RootlistAPI
   const f = (await api.getContents()).items.find(i => i.uri === uri)
   if (f && !(f.items || []).length) await api.removeFolder(uri)
   ```

3. Put everything else back, including the library width if you changed it:

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

The Folders chip view lists every top-level folder, including the developer's own, so it is
not part of any shot.
