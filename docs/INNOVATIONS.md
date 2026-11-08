# Innovations survey

> **Plan.** This document surveys picture viewers and organizers, past and present, records what each one brought to the job, and names the Anne's Lens feature and command ids that adopt the idea, or says why it is skipped. Command ids match [COMMANDS-PLAN.md](COMMANDS-PLAN.md); milestones (M1–M8) match [ROADMAP.md](ROADMAP.md). Product names are used nominatively, to say where an idea came from; see [LEGAL.md](LEGAL.md).

Dates are given to the year where they are well established and as decades or "later versions" where sources differ. Corrections are welcome.

## How to read this

Each entry has two parts:
- **Introduced:** what the program brought to viewing and organizing pictures (not necessarily first ever, but where the idea became widely known).
- **Anne's Lens:** the feature that adopts it, with command ids and milestone, or the reason it is skipped.

---

## 1. The model: IrfanView

### IrfanView (Irfan Skiljan, 1996–; 4.x through 4.75 at the time of writing)

- **Introduced:** the fast, small, keyboard-driven viewer that opens almost anything. One window, one picture, a single key for each frequent action (O open, S save as, T thumbnails, W slideshow, B batch, I information, L/R rotate, H/V flip, Ctrl+R resize, Shift+G color corrections, Shift+U auto-adjust, Shift+S sharpen, Shift+J lossless JPEG, Ctrl+Y crop), a plug-in architecture that grew the format list into the hundreds, a batch conversion and rename dialog with an ordered set of advanced operations, lossless JPEG transformations, a thumbnail window, a paint pane, RAW pixel import, hex view, multipage TIFF handling, slideshows that could be saved as standalone programs, screen capture, TWAIN batch scanning, a "copy shop" print mode, an effects browser with live previews, Photoshop-compatible 8BF filter support, command-line switches for scripting, and an INI file that made it portable.
- **Anne's Lens:** IrfanView is the reference for the viewer window, the keys and the default classic menu layout (**IrfanView style**, `view.menuLayout(irfanview)`; see [MENUS-PLAN.md](MENUS-PLAN.md)). Every IrfanView main-window and thumbnail-window function in the survey has a command (origin column *IrfanView* in COMMANDS-PLAN.md). Notable ones:
  - **Batch Conversion and Rename** (`batch.convert`) with **Batch Steps** (`batch.actions`) and the rename patterns (`batch.rename`). M3.
  - **Lossless JPEG Transformations** (`image.losslessJpeg`, `image.losslessCrop`). M2.
  - **Open RAW Pixel Data** (`file.openRawPixels`) and **Open as Hex** (`file.openHex`). M2.
  - **Effects Browser** (`fx.browser`) and **Plug-in Filters (8BF)** (`fx.plugins8bf`, Windows desktop only, each plug-in in its own process). M4, M8.
  - **Print Copies and Posters** (`file.copyShop`), **Batch Scanning** (`file.batchScan`), **Screen Capture** (`file.capture`), **Join Side by Side** (`create.panoramaJoin`), **Extract All Frames** and icons from programs (`create.extractFrames`, `create.extractEmbedded`). M2–M5.
  - **Command-line options** (`dev.cliHelp`) for the desktop build, in the spirit of IrfanView's switches (open, convert, resize, rotate, capture, slideshow, batch) but with its own syntax. M5.
  - **Portable Mode** (`file.portableMode`) and an IrfanView-style key list import in **Export / Import Settings**. M1.
  - *Skipped:* saving slideshows as executables or screensavers. Distributing runnable programs made from pictures is a malware vector and does not exist on phones; **Export as HTML Slideshow** (`show.exportHtml`) and **Slideshow Video** (`create.movie`) replace it.

---

## 2. Early viewers and converters (DOS, Windows 3.x, classic Mac)

### LView / LView Pro (Leonardo Haddad Loureiro, early 1990s)

- **Introduced:** one of the first small shareware viewers for Windows 3.x that also edited: crop, resize, color balance, gamma, and conversion between GIF, JPEG and BMP in a few hundred kilobytes.
- **Anne's Lens:** the idea that a viewer edits lightly without becoming a paint program: the **Image** and **Adjust** tabs. M2–M3.

### Graphic Workshop (Alchemy Mindworks, DOS 1990, Windows later)

- **Introduced:** a file-manager-like list of pictures with conversion between dozens of formats, transparent-color handling for GIF, icon and wallpaper output, and catalog sheets.
- **Anne's Lens:** **Transparent Color** (`image.transparentColor`), **Export as Icon** (`file.export.icon`), **Contact Sheet** (`create.contactSheet`). M3–M5.

### Kodak/Wang Imaging for Windows (Windows 95–2000)

- **Introduced:** a viewer for scanned documents: multipage TIFF, annotations (highlighter, text, rubber stamps) that stayed separate from the picture, scanning, and thumbnail views of pages.
- **Anne's Lens:** **Pages and Frames** tab (`pages.*`), **Markup Board** with editable markup until flattened (`edit.markup`, `edit.flattenMarkup`), **Deskew** (`image.deskew`). M2, M4.

### ThumbsPlus (Cerious Software, 1990s–)

- **Introduced:** a picture database before "digital asset management" was a common phrase: thumbnails cached in a database, keywords, duplicate finding by content, and batch operations from the catalog.
- **Anne's Lens:** **Use Catalog** (`browse.catalog`), **Keywords** (`meta.keywords`), **Find Duplicates** (`browse.findDuplicates`). M4–M5.

### QuickTime PictureViewer and the classic Mac viewers (1990s)

- **Introduced:** the system-level viewer that opened anything the system's codecs could decode, and simple rotate/zoom.
- **Anne's Lens:** decoding goes through the platform's codecs where they are better than the app's own (HEIC on Apple platforms and recent Android, for example); see [ARCHITECTURE-PLAN.md](ARCHITECTURE-PLAN.md). M2.

---

## 3. The Windows viewer generation (late 1990s–2000s)

### ACDSee (1994–)

- **Introduced:** speed as the selling point (ACDSee 32 opened JPEGs faster than anything else), then a full manager: a browser with folder tree, preview pane, categories, ratings and color labels in a catalog database, calendar browsing, and, in later versions, separate Manage, View, Develop and Edit modes; "Light EQ" local-tone adjustment.
- **Anne's Lens:**
  - **Browser** with folder tree, preview and info panes (`browse.browser`, `browse.folderTree`, `view.infoPane`). M3.
  - **Rating**, **Color Label**, **Timeline** (`browse.rate`, `browse.colorLabel`, `browse.timeline`). M4.
  - **Tone Equalizer** (`adjust.toneEqualizer`), under a generic name. M4.
  - The four "modes" become the ribbon tabs plus the **ACDSee style** menu layout; there is no modal switch. M3.

### Windows Picture and Fax Viewer / Windows Photo Viewer (2001–)

- **Introduced:** the viewer most people knew because it came with the system: a filmstrip-free single picture with zoom, rotate, print wizard with layouts (wallet, 4×6, contact sheet), e-mail with automatic resizing, and burn-to-disc.
- **Anne's Lens:** **Print Layouts** (`file.printLayouts`), **Email** with resize (`file.email`), **Web and Email Sizes** (`batch.webPresets`), the **Windows Photo Viewer style** layout. Burning discs is skipped (rarely available); **Back Up Library** (`tools.backup`) covers the need. M2–M5.

### XnView (Pierre-Emmanuel Gougelet, 1998–; XnView MP 2009–)

- **Introduced:** IrfanView-class format support (500+ read formats via its own code and plug-ins) in a browser-style interface; categories, ratings, color labels, a filter bar; batch processing built as a list of *actions* that can be saved; batch rename with metadata tokens; duplicate and similar-picture finding; compare; a strip and contact-sheet generator; metadata editing for IPTC and XMP; the cross-platform MP rewrite.
- **Anne's Lens:**
  - **Recipe Editor** (`batch.recipe`): XnView's saved action lists, with each recipe also a command. M3.
  - **Filter Bar**, **Group By**, **Select by Pattern** (`browse.filter`, `browse.groupBy`, `browse.selectPattern`). M4.
  - **Find Similar Pictures** (`browse.findSimilar`) with a threshold. M5.
  - **Estimate JPEG Quality** (`image.jpegQuality`) from quantization tables. M2.
  - **Information Overlay** with templates (`view.osd`, `view.osdTemplate`). M3.
  - The **XnView style** layout. M3.

### FastStone Image Viewer (2004–)

- **Introduced:** a full-screen-first viewer with toolbars that appear when the pointer touches a screen edge (EXIF on the right, file browser on the left, editing at the bottom), compare up to four pictures side by side with synchronized zoom, a "draw board" for arrows and text, clone and heal brushes, a magnifier loupe, Lighting (shadows and highlights), slideshows with 150+ transitions and music, quick move to favorite folders, and an image strip and contact sheet maker.
- **Anne's Lens:**
  - **Edge panels in full screen**: in full screen, the Info pane, Filmstrip and Browse panes slide in from the right, bottom and left edges (an Options setting; on touch, edge swipes). M3.
  - **Compare Pictures** (`view.compare`), **Loupe** (`view.loupe`), **Markup Board** (`edit.markup`), **Clone Stamp** and **Healing Brush** (`paint.clone`, `paint.heal`), **Quick Move** (`file.quickMove`). M3–M5.
  - The **FastStone style** layout. M3.

### Picasa (Lifescape, then Google, 2002/2004–2016)

- **Introduced:** an organizer that watched folders instead of importing (the *Folder Manager*), one-click fixes (*I'm Feeling Lucky*, *Fill Light*, *Warmify*, *Straighten*, *Redeye*), playful effects (Film Grain, Soft Focus, Glow, Focal B&W, Graduated Tint), non-destructive edits kept beside the original with *Undo all*, starred pictures, face grouping (*People*), geotagging (*Places*), collages, movies and backups.
- **Anne's Lens:**
  - **Folder Manager** and watched folders (`browse.folderManager`, `browse.watchFolder`). M4.
  - **One-Click Enhance** (`adjust.enhance`), **Fill Light** (`adjust.fillLight`), **Warmify** (`adjust.warmify`), the Picasa effects in the Effects tab (`fx.filmGrain`, `fx.softFocus`, `fx.glow`, `fx.focalBW`, `fx.graduatedTint`). M4.
  - Non-destructive edits with **Revert to Original** (`adjust.revertOriginal`); see the edit stack in ARCHITECTURE-PLAN.md. M4.
  - **People** (`browse.people`) and **Map** (`browse.map`). M6.
  - **Collage** and **Slideshow Video** (`create.collage`, `create.movie`). M5–M6.
  - The **Picasa style** layout. M3.

### Windows Live Photo Gallery (2007–2017)

- **Introduced:** face tagging with detection, *Photo Fuse* (choose the best face of each person from a burst of group shots), *Auto Collage*, panorama stitching with automatic alignment, and geotag display.
- **Anne's Lens:** **Combine Group Shots** (`ai.combineGroupShots`, same-person only; see AI-PLAN.md), **Stitch Panorama** (`create.panoramaStitch`), **Collage** (`create.collage`). M6–M7.

---

## 4. Open-source viewers and organizers

### digiKam (KDE, 2001–)

- **Introduced:** a professional-grade open-source manager: albums and tags in a database, face recognition, a geolocation editor with GPX correlation, a *Light Table* for comparing, a *Batch Queue Manager* with saved workflows, metadata templates, sidecar handling, search by sketch and by similarity, an *image quality sorter* that scores blur and noise, and maintenance tools.
- **Anne's Lens:** **Batch Queue** (`batch.queue`), **Geotag from GPS Track** (`meta.geotagGpx`), **Metadata Template** (`meta.template`), **Write Sidecar or Embed** (`meta.sidecarMode`), **Search by Sketch** (`browse.searchSketch`), **Sort by Quality** (`browse.qualitySort`), **Light Table** (`browse.lightTable`), **Catalog Maintenance** (`browse.maintenance`), the **digiKam style** layout. M4–M6.

### gThumb, Eye of GNOME / Loupe, Gwenview, Shotwell (GNOME and KDE)

- **Introduced:** desktop-integrated viewers with catalogs, duplicate finding, web albums and contact sheets (gThumb); gesture-first, minimal viewing (Loupe); non-destructive edits in an organizer (Shotwell).
- **Anne's Lens:** **Web Gallery** (`create.webGallery`), **Find Duplicates**; the minimal chrome of **Frameless Window** and **Collapse the Ribbon**. M3–M5.

### Geeqie (GQview, 1999–)

- **Introduced:** fast viewing for photographers on Linux: pan view of whole folders, duplicate detection by similarity, collections, stereo-pair viewing, synchronized windows, and sidecar groups (RAW+JPEG).
- **Anne's Lens:** **Stereo View** (`view.stereo`), **Stack Bursts and Versions** (`browse.stacks`), **Albums** (`browse.albums`). M5–M6.

### nomacs (2011–)

- **Introduced:** synchronizing several viewer windows (even across computers on a network) so they zoom, pan and navigate together, a frameless mode, mosaic and batch plug-ins.
- **Anne's Lens:** **Synchronize Windows** (`view.syncWindows`, same device) and **Frameless Window** (`view.frameless`). Network sync is skipped for now. M5.

### ImageGlass, qView, JPEGView, Honeyview (2010s–)

- **Introduced:** modern minimal Windows viewers: a color picker with copyable values and checkerboard transparency (ImageGlass), the near-zero chrome of qView, JPEGView's automatic local density correction, and Honeyview's reading of pictures straight from ZIP/RAR/7z archives with two-page, right-to-left comic modes and GPS bookmarks.
- **Anne's Lens:** **Pixel Information** and **Copy Color Under Pointer** (`view.pixelInfo`, `view.copyColor`), **Transparency Display** (`view.alphaDisplay`), **Display Adjustments** (`view.displayAdjust`), **Open Archive as Folder** (`browse.openArchive`), **Two-Page View** and **Right-to-Left Reading** (`view.twoPage`, `view.rtl`), **Next Folder** (`view.nextFolder`). M3–M5. RAR is read only where a permissively licensed decoder exists; otherwise the file is identified and the user is told why it cannot be opened.

---

## 5. Photographers' viewers and culling tools

### FastPictureViewer, FastRawViewer and Photo Mechanic (2000s–)

- **Introduced:** culling at camera speed: GPU display of the embedded RAW preview, one key per decision (keep, reject, rate, move to a folder), auto-advance, focus peaking and clipping overlays to judge sharpness and exposure without developing the RAW.
- **Anne's Lens:** **Cull Mode** (`browse.cull`), **Pick / Reject / Unflag** (`browse.pick`, `browse.reject`, `browse.unflag`), **Quick Move to Folder 1–9** (`file.quickMove`), **Show Embedded Preview** and **Use Embedded Preview by Default** (`raw.preview`, `raw.preferPreview`), **Focus Peaking** (`view.focusPeaking`), **Clipping Warnings** (`view.clipping`). M4–M5.

### Lightroom Classic (Library and Develop) and similar organizers

- **Introduced:** catalog-based, non-destructive development: flags and ratings, smart collections, copy/paste of develop settings, presets, before/after, import presets with renaming and metadata, soft proofing, and stacking.
- **Anne's Lens:** **Smart Albums** (`browse.smartAlbum`), **Copy Adjustments** / **Paste Adjustments** (`adjust.copySettings`, `adjust.pasteSettings`), **Save Adjustment Preset** (`adjust.savePreset`), **Before / After** (`adjust.beforeAfter`), **Import with Rules** (`file.importRules`), **Soft Proof** (`image.softProof`), **Develop RAW** (`raw.develop`). Anne's Lens is a viewer first, so its develop controls stay in dialogs and the Adjust tab rather than a separate module. M4–M6.

---

## 6. The system photo apps (2010s–)

### Microsoft Photos (2015–)

- **Introduced:** a modern system viewer and editor with filmstrip, favorites and albums, adjustment sliders, markup, spot fix, and (2023–) on-device and cloud AI: generative erase, background blur, removal and replacement, super resolution, restyle.
- **Anne's Lens:** **Filmstrip** (`view.filmstrip`), **Revert to Original** (`adjust.revertOriginal`), **Erase Object**, **Remove / Replace / Blur Background**, **Upscale**, **Restyle** (`ai.erase`, `ai.removeBackground`, `ai.replaceBackground`, `ai.blurBackground`, `ai.upscale`, `ai.restyle`); the **Windows Photo Viewer style** layout covers both generations. M3, M7.

### Apple Preview, Photos and iPhoto (2001–)

- **Introduced:** Preview's markup toolbar (sketch, shapes, text, signature, *Instant Alpha* color removal), inspector with EXIF and a location map, import from cameras and scanners, export to PDF, and later Live Text and background removal; Photos' Memories, Duplicates album, hidden album, adjustments (Light, Color, Black & White, Selective Color, Curves, Levels, Definition, Vignette), Visual Look Up and Clean Up.
- **Anne's Lens:** **Signature** (`edit.signature`), **Info Pane** (`view.infoPane`), **Recognize Text** (`tools.ocr`), **Select Subject** (`ai.selectSubject`), **Selective Color** (`adjust.selectiveColor`), **Clarity** (`adjust.clarity`), **Identify** (`ai.identify`), **Hide Picture** (`file.hide`), the **Preview style** layout. Instant Alpha's idea is covered by **Replace Color** and **Select by Color Range** (`image.replaceColor`, `edit.selectColor`). M3–M7.

### Google Photos and Android galleries (2015–)

- **Introduced:** search by what is in a picture without any tagging, automatic albums, motion photos, photo spheres, casting, and AI edits (object erasing, unblur, portrait light, best-take group shots).
- **Anne's Lens:** **Search by Content** (`ai.searchContent`, on-device index), **Motion Photo** (`view.motionPhoto`), **360° View** (`view.sphere`), **Cast to Display** (`file.cast`), **Unblur** and **Relight** (`ai.deblur`, `ai.relight`), **Combine Group Shots**. M5–M7.

---

## 7. Generative AI and archive tools (2022–)

### Generative picture services and editors

- **Introduced:** pictures from text, editing by instruction, masked fill, outpainting, reference-guided styles, and upscaling, offered through public APIs and local tools (Stable Diffusion front ends such as ComfyUI).
- **Anne's Lens:** the **AI** tab's Generate and Edit groups ([AI-PLAN.md](AI-PLAN.md)), with service adapters chosen by capability, Content Credentials on every result, and **Compare Providers** (`ai.generateCompare`) to send one prompt to several services and keep the best. M7.

### Archive and genealogy tools (handwriting transcription, photo dating, restoration)

- **Introduced:** machine transcription of historical handwriting, estimates of when an old photograph was taken, and AI colorization and repair offered by family-history services.
- **Anne's Lens:** **Transcribe Handwriting** (`ai.transcribe`), **Estimate Date** (`ai.estimateDate`, written only to a separate estimate field), **Colorize** and **Repair Damage** (saved as labeled new versions), and the non-AI **Restore Old Photo** wizard (`tools.restoreWizard`). M7.

---

## 8. New in Anne's Lens

These were not found in the viewers surveyed (some exist in other kinds of software). Each is a command like any other.

| Feature | Command | Why |
|---|---|---|
| Recover pictures from any file | `file.recoverAny` | Carves pictures out of disk images, phone backups, caches, damaged archives and documents, using the suite's recovery heritage (Immortal Zip, Word Recovery, Universal File Repair Tool) |
| Open and Repair for pictures | `file.openRepair` | Truncated JPEGs shown to the last good row, PNG chunks with bad CRCs accepted, damaged TIFF directories rebuilt, embedded previews used when the main picture is gone; see [RECOVERY-PLAN.md](RECOVERY-PLAN.md) |
| Undo file operations | `file.undoFileOp` | A journal makes renames, moves and deletes undoable, like edits |
| Preview batch (dry run) and Undo last batch | `batch.dryRun`, `batch.undo` | See names, sizes and conflicts before writing; take a batch back afterwards |
| Print at true size | `file.printTrueSize` | One-time calibration so scale-sensitive prints (patterns, maps, documents) come out right |
| Before/after slider and difference overlay | `view.compareSplit`, `view.diffOverlay` | Judge an edit or two versions precisely |
| Keep position across pictures | `view.keepPosition` | Compare the same detail across a burst or a scan series |
| Pixel grid, rulers, measure with scale | `view.pixelGrid`, `view.rulers`, `view.measure` | Pixel work, documents, maps and specimens |
| Color-blindness simulation, grayscale preview | `view.colorBlindSim`, `view.grayscalePreview` | Accessibility checks for graphics and slides |
| Privacy Check before sharing | `meta.privacyCheck` | Finds location, serial numbers, names in captions and stale embedded thumbnails that differ from the picture |
| Content Credentials viewer | `meta.provenance` | Shows what a file says about how it was made, including AI |
| Checksums and fixity reports | `meta.checksum`, `meta.fixity` | Digital-preservation practice for family and institutional archives |
| Source citations and person links | `meta.citation`, `meta.personLink` | Genealogy: keep the citation with the scan, and tie face regions to person records |
| Document Cleanup and Crop Page from Photo | `tools.docCleanup`, `edit.cropPage` | Phone photos of records into clean, flat, legible scans |
| Restore Old Photo wizard | `tools.restoreWizard` | Dust, scratches, fading, descreening, with optional AI steps clearly labeled |
| Print Check | `tools.preflight` | Effective DPI at print size, color mode and gamut before sending to a printer or a publisher |
| Icon Set and Comparison Picture | `create.icon`, `create.comparison` | Web and app icons from one picture; side-by-side figures for reports |
| Focus Stack and Exposure Merge | `create.focusStack`, `create.hdr` | Common photographic merges without a separate program |
| Classic menu layouts over one command library | `view.menuLayout`, `file.customizeMenus` | People keep the menus they learned (IrfanView, XnView, FastStone, ACDSee, Picasa, Preview, digiKam, Photo Viewer) and still reach every command |
| Suite hand-offs | `file.export.folio`, `file.export.stage`, `file.export.pen`, `file.export.press`, `tools.ocrToPen`, `create.photoBook` | Pictures with captions, alt text and citations go to the other Anne's Office apps intact |

## Considered and skipped

| Idea | Seen in | Why skipped |
|---|---|---|
| Slideshows saved as .exe or screensaver | IrfanView, FastStone | Runnable files made from pictures are a malware vector and do not exist on phones; HTML and video exports replace them |
| Burn to CD/DVD | Windows Photo Viewer, Picasa | Rarely available hardware; Back Up Library covers the need |
| Network-synchronized viewers | nomacs | Synchronize Windows on one device; Share View on the Network and Follow a Shared View across devices (the desktop's local server behind a token, or the self-hosted relay); Share Album and Open Shared Album the same way (docs/NETSHARE.md) |
| Uploading to specific photo-sharing sites | Picasa, digiKam, many | Sites and their APIs change too often; the system share sheet reaches every installed app |
| Pixel-based "AI detector" | various web tools | Unreliable; Anne's Lens reports a file's own provenance instead (AI-PLAN.md) |
| Reading Photoshop layers for editing | XnView (composite only), others | Layered .psd is shown as its composite; Anne's Lens is not a layer editor |
| Running G'MIC or GIMP filters inside the app | some viewers via plug-ins | Licensing (GPL) does not fit the MIT-licensed suite; **External Tools** can send a picture to them |
