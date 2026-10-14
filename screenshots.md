# Screenshots — Enhanced Folders

Read by the `spicetify-screenshots` skill. Keep selectors and rects accurate; they are what
makes a capture run mechanical instead of exploratory.

Extension file: `enhanced-folders.js`
Storage key: `enhanced-folders:data` (`{ schemaVersion, folders: { <folderId>: { image, description, updatedAt } } }`)

## Fixtures

`screenshots/fixtures/folders.json` maps four throwaway folder names (Road Trip, Focus,
Workout, Late Night) to a generated 354px JPEG data URL and a description. The images are
drawn from scratch, so they carry no third-party artwork.

Data is keyed by folder ID, and IDs only exist once the folders do, so a session creates the
folders first and builds the seed from their IDs:

```js
// create at the top of the rootlist; the second argument is required
await Spicetify.Platform.RootlistAPI.createFolder('Road Trip', {})
```

Merge the new entries into the existing `enhanced-folders:data` rather than replacing it.

## Capture session

```
node shoot.mjs snapshot "enhanced-folders:data" backup.json
# create the four folders, then restore a seed built from fixtures/folders.json + their IDs
node shoot.mjs viewport 1440 1000
node shoot.mjs reload                 # REQUIRED: data is read at boot
```

Open the dialog with a real right-click on the folder row, then
`click "[role=menu] button" --text "Edit folder details"`.

## Verification

```
node shoot.mjs verify ".ef-edit-img-preview" --min 1 --within ".ef-edit-modal"
```

## Shot list

| Output | Surface | Rect | README caption |
|---|---|---|---|
| `preview.png` | Edit folder details dialog | `--rect 390,281,660,439 --scale 2` (the `.GenericModal` box inset by 2px, which drops the corners where the page behind shows through) | Marketplace card and README hero |

## Known gaps

On Spotify 1.3.4.258 the sidebar decoration and the Folders chip view don't render:
`findArtworkSlot` matches none of its selectors on folder rows (the icon box has only hashed
classes), and the Folders view fails with "library list not found". That's why the preview
shows the dialog rather than a decorated sidebar. Re-shoot the sidebar once those are fixed.

## Restore

Cancel the dialog (never Save), then:

```js
// for each throwaway folder; they are empty, so removing contents is a no-op
await Spicetify.Platform.RootlistAPI.removeFolder(uri)
```

```
node shoot.mjs reset-viewport ; node shoot.mjs restore backup.json ; node shoot.mjs reload
```
