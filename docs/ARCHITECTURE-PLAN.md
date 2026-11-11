# Architecture plan

> **This is the plan; milestone 1 follows it.** What exists after M1: `src/main.ts`, `src/app.ts`, `src/prefs.ts`, `src/commands/` (registry plus the file, edit, image, view, pages, meta, dev and help modules), `src/ui/` (shell, ribbon layout and classic menus generated from the plan, customize dialogs, backstage, viewer), `src/picture/` (folder, model, loader with prefetch), `src/codecs/` (sniffing, platform decoding, GIF, TIFF, BMP, ICO, container info), `src/meta/exif.ts`, `src/platform/native.ts`, the Electron main process and the Android plugin. The design mirrors what the sister apps already ship (Anne's Pen, Anne's Grid, Anne's Stage, Anne's Folio), so that the suite shares one shell and one set of conventions. Details change as the code is written; this file will be replaced by `docs/ARCHITECTURE.md` once the layout settles.

## Summary

Anne's Lens will be a TypeScript web application built with **Vite** and tested with **vitest**. The Android and iOS releases will package it with **Capacitor 8**, the Windows, macOS and Linux releases with **Electron**, and the same build will run in a browser as an installable, offline-capable **PWA**. It shares the suite shell: command registry, ribbon, Quick Access Bar, customizable tabs and keyboard, command search, macro recorder, AI setup and providers, the recovery engine's generic parts, and the platform layer. New to the suite are the **classic menu bar** (shared with Anne's Loom's implementation), a **picture pipeline** built for speed, and a **catalog**.

The non-negotiable requirement taken from IrfanView is speed: the next picture must appear as fast as the key repeats. The design below is organized around that.

## Intended source layout

```
src/
  main.ts                 entry: command registry, App + Shell, launch-file handling, back button, CLI arguments (desktop)
  app.ts                  App (windows, open pictures, exec(), recording) and PictureTab (picture, view state, edit stack, history)
  prefs.ts                per-device preferences: QAT (QAT_STANDARD, QAT_EXTRAS, addAllQatChoices), custom tabs, menus,
                          keymap, macros, external editors, quick-move folders, AI settings (keys are not stored here)
  commands/
    registry.ts           Command interface and registry: the single source for ribbon, menus, QAT, keys, macros, search
    *.ts                  command modules by area (file, edit, paint, image, adjust, fx, browse, meta, batch, create,
                          pages, frames, raw, view, show, tools, ai, dev, help)
  ui/
    shell.ts, ribbon.ts   shared with the suite
    classicMenus.ts       menu layouts generated from docs/commands-plan.json at build time; Customize Menus
    viewer.ts             the picture surface: zoom, pan, fit modes, overlays, edge panels, touch gestures
    browser.ts            folder tree, thumbnail grid (virtualized), filmstrip, panes
    dialogs/              resize, color corrections, batch, save options, metadata editors, recovery report…
  picture/
    model.ts              Picture: pages/frames, pixel buffers by format (u8, u16, f32), color profile, metadata, edit stack
    buffer.ts             tiled pixel storage for very large pictures (tiles of 512×512, paged to disk on desktop)
    pipeline.ts           decode → orient → color-manage → scale → display; cancellable, prioritized
    edits.ts              non-destructive edit stack (adjustments as parameters; destructive steps as before-images)
    ops/                  resize kernels, rotate, crop, color, convolution, effects, dithering, quantization, seam carving,
                          panorama join/stitch, focus stack, exposure fusion — CPU (WASM SIMD) and GPU (WebGPU/WebGL) paths
    paint.ts              paint and markup layers; flatten
  codecs/
    registry.ts           content sniffing and codec selection (platform codec, built-in, optional module)
    jpeg/                 decoder with tolerant mode, lossless transforms (DCT-domain), quality estimate, writer
    png/ gif/ webp/ avif/ jxl/ tiff/ bmp/ ico/ psd/ … one folder per format family
    raw/                  container parsing and embedded previews; DNG developer and the camera-family readers (own code)
    module-loader.ts      optional modules (HEIC, AVIF encoder): download, verify hash, license, load
  meta/                   EXIF, IPTC-IIM, XMP (read/write, sidecars), ICC, C2PA manifests, maker notes, region tags
  catalog/                SQLite (WASM on the web, native on mobile/desktop): files, folders, thumbnails, metadata index,
                          ratings, labels, albums, faces, embeddings, fixity records; watch folders
  batch/                  recipes, queue, dry run, journal (undo for file operations and batches)
  show/                   slideshow player, transitions, HTML export, phone remote (shared with Anne's Stage)
  recover/                recovery engine (shared parts + picture-specific methods, carving); see RECOVERY-PLAN.md
  ai/                     providers, client, settings, picture adapters, on-device models, ensemble — shared core
  platform/native.ts      JS side of the QuillNative Capacitor plugin and the Electron bridge; browser fallbacks
android/ ios/ electron/   native packaging
tests/
  unit/                   vitest: codecs (round trips, golden pixels), ops, metadata, recovery corpus, commands catalog
  e2e/                    browser smoke test (Playwright), as in the sister apps
scripts/
  gen-plan.py             (now) planning documents; later replaced by `npm run catalog`
```

## Key design decisions

- **Commands are data.** Ribbon, classic menus, Quick Access Bar, context menus, keyboard shortcuts, macros, batch recipes and command search refer to command ids. A command declares its id, label, icon, tab and group (or *not in tabs*), shortcut, enablement test, argument type and `run(app, arg?)`. `docs/commands-plan.json` is the checklist: a unit test fails if the registry lacks a planned command or if any menu layout names an unknown id. This is how "no missing commands" is enforced.
- **Speed first.** Decoding runs in a pool of workers. When a picture is shown, the next and previous pictures (in the current sort order and direction of travel) are decoded in the background at screen resolution; JPEGs decode at reduced scale (1/2, 1/4, 1/8 via DCT scaling) when that is enough for the screen, then refine. RAW files show their embedded preview first. Thumbnails are cached in the catalog (or a cache folder when the catalog is off) keyed by path, size and modification time. Target: under 50 ms to show the next 24-megapixel JPEG on a mid-range desktop after prefetch, and no frame drops while panning.
- **Large pictures are tiled.** Pictures above a size threshold are held in tiles with a pyramid of reduced levels, so a 30,000-pixel panorama or scan opens instantly at screen size and zooms smoothly.
- **Precision.** Pixel buffers keep the source bit depth (8, 16 or 32-bit float per channel). Adjustments run in linear light where it matters (resizing, blurs, exposure) and in the picture's color space otherwise; output is converted and dithered once at save.
- **Non-destructive by default, destructive when asked.** Adjust-tab commands are parameters in an edit stack that can be changed later and are saved as an XMP sidecar or as a new version, with the original kept (*Revert to Original*). Classic IrfanView-style destructive edits (paint, resize, effects) work as expected and are undoable through before-images. Options decide whether *Save* writes into the file (as IrfanView does) or keeps edits beside it.
- **Lossless where possible.** JPEG rotations, flips and crops operate on DCT coefficients; metadata edits rewrite only the metadata segments; *Save* of an unedited picture with changed metadata never re-encodes pixels.
- **Metadata is never silently lost.** Writers carry EXIF, IPTC, XMP and ICC across formats where the destination allows, and the save dialog lists what cannot be kept.
- **Catalog optional.** Everything works on plain folders. The catalog adds speed (search, People, Map, Timeline, similar pictures) and is a single SQLite file that can be moved, backed up or deleted without touching pictures.
- **Untrusted input.** Picture files are the main attack surface of a viewer. Every decoder runs in a worker with no access to the DOM, file system or network; WASM decoders are fuzzed in CI (corpus plus mutation); size limits guard against decompression bombs; SVGs render with scripts and external references disabled; 8BF plug-ins (Windows) run in a separate process with a timeout.

## Classic menus

`ui/classicMenus.ts` is generated from `docs/commands-plan.json` (layouts: IrfanView, IrfanView Thumbnails, XnView, FastStone, ACDSee, Windows Photo Viewer, Picasa, Preview, digiKam, all combined, complete). The menu bar renders natively on macOS (Electron application menu) and as an in-window bar elsewhere; on phones it becomes a single **☰** menu with the same tree. Each item shows its current shortcut. Customize Menus stores user layouts in the same JSON shape.

## Platform specifics

| Platform | File access | Codecs | Extras |
|---|---|---|---|
| Android | Storage Access Framework; MediaStore for the gallery view; *Open with* and *Share to* for every supported type | platform HEIC/AVIF; built-ins for the rest | camera import, wallpaper/lock screen, contact photo, cast |
| iOS/iPadOS | document picker, Photos library (with permission), Files provider | ImageIO for HEIC/RAW previews | Photos library browsing, share extension |
| Windows | full file system; Recycle Bin; file associations | WIC where installed; built-ins | TWAIN/WIA scanning, 8BF plug-ins, screen capture, wallpaper, command line, portable mode |
| macOS | full file system; Trash | ImageIO | ICA scanning, screen capture, application menu |
| Linux (incl. Raspberry Pi OS) | full file system; Trash (freedesktop) | built-ins | SANE scanning, screen capture where the compositor allows |
| Web | File System Access API where available, otherwise open/download | built-ins (WASM) | installable PWA, offline |

**Desktop file permissions.** The Electron main process decides what the page may touch, on the assumption that the page could be made to misbehave (by a crafted file or a script). Reading and writing are separate:

- *Reading.* A picture opened through a dialog, the command line or the OS grants that file (read and write) and its folder (list and read pictures). From there the page can move up and down the folder tree (Next/Previous Folder, the Folder Tree) and read the pictures it finds, with three limits: going up stops at the home folder; hidden folders (names starting with a dot) are never entered; the app's own settings folder is never listed or read.
- *Writing.* Saving, copying or moving a file into a folder, making a subfolder, or changing an existing picture or `.xmp` sidecar that was not opened one by one needs the folder to be writable. A folder chosen in a folder dialog is; any other asks once in a native dialog, which the page cannot answer for the user, and the answer lasts until the app closes. A remembered folder (catalog, favorites, watches, backup targets) is writable again after a restart only if it was writable when it was remembered.
- *Never.* Files and folders whose names start with a dot are not created (shell start-up files, settings folders); Batch Rename's own short-lived names are the one exception. Nothing is written into the app's settings folder, which holds the remembered folders and the list of programs External Tools may start.

What remains readable by design: pictures in any folder the tree can reach, and, with Show All Files, the other visible files there. `tests/unit/desktopGrants.test.ts` exercises these rules through the IPC handlers with Electron stubbed.

## Builds and CI

The same workflows as the sister apps: `android.yml` type-checks, tests and builds the web app and an APK on every push; `release.yml` builds Android (APK, AAB), iOS (unsigned .ipa), Windows (x64/ARM installer and portable), macOS (universal), Linux (AppImage and .deb for x64, arm64, armv7l) and the web, and publishes them from a `v*` tag, a manual run, or a `[release]` commit. `scripts/termux-build.sh` builds the APK on the phone, as in Anne's Folio.

## Performance and correctness tests

- golden-pixel tests for every codec and operation (tolerance per operation), against reference outputs produced with open tools;
- round-trip tests for metadata (EXIF, IPTC, XMP, ICC) across every writable format;
- a speed benchmark (next-picture latency, thumbnail throughput) run in CI with a regression threshold;
- the recovery corpus from RECOVERY-PLAN.md;
- fuzzing of every decoder.
