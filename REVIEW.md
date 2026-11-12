# Code review of the whole repository (commit 59af882)

Read-only review; nothing in the code was changed. Six reviewers covered the repository by area, and the
most serious findings were then re-read against the source or reproduced. **Reproduced** means a probe was
run and its output seen; **traced** means the path was followed through the code end to end; **plausible**
means not run and not fully traced. Nothing was run on Windows, macOS, iOS or an Android device.

Not read line by line: `qr.ts`, `ppmd.ts`, most of `rarunpack.ts` (fuzzed instead), `jbig.ts`,
`flashpix.ts`, `djvu.ts`, `pdf.ts`, `winres.ts`, and in `src/commands` the edit, image, adjust, effects,
geometry, create, albums, people, colorMgmt, suite, print files and most of `meta.ts` and `fileTools.ts`
(searched for sinks, writers and timers only). `src/color` and `picture/geometry.ts` were read and had no
findings.

## 0. What has been fixed since

The tables below are the review as written at commit 59af882. Fixed since then, with tests in
`tests/unit/dataloss.test.ts`, `hostile.test.ts`, `keys.test.ts`, `keystore.test.ts` and blocks in both e2e
suites. The crafted-file tests were run against the old code and hung or failed there. Not every fix has its
own test: the Android change (D5) is compiled by CI but not exercised, and D4, D7, D8, D14, D15 and D17 were
checked by reading and by the suites still passing, not by a test of their own.

- **Data loss: D1 to D17.** Batch, import, watch and catalog recipes never replace a file (a second file gets
  a " (2)" name, and the result says so); Save is bound to the window and picture it was started on, leaves the
  Before view first, replaces the right folder entry, and only writes back what the encoder keeps; lossless and
  AI results go to the picture they were made from; "could not be read" is no longer treated as "empty" for
  keys, watched folders and the catalog; unsaved-changes tracking no longer depends on the undo depth; Batch
  Rename, case-only rename, imported places and the Cull Mode overlay as described. From D11, a watched folder
  now acts on a new file only when two checks in a row see the same size (a file still being written waits).
- **Security: S1, S3.** File names, folder names and captions are escaped wherever they go into dialogs, and
  data embedded in generated pages' scripts cannot close the script element.
- **Security: S2.** Desktop permissions separate reading from writing. Saving, copying or moving into a folder and
  making a subfolder need a folder the user picked in a folder dialog or allows in a native question; going up the
  folder tree stops at the home folder; hidden files and folders are neither made nor entered; the app's settings
  folder (remembered folders, the External Tools program list) is never listed, read or written. Still as before, by
  design: the page can read pictures in any folder the tree reaches and, with Show All Files, the other visible
  files there. `tests/unit/desktopGrants.test.ts` runs the main process's handlers with Electron stubbed; all six of
  its tests fail on the old code.
- **Security: S6, S8, S9, S10.** No request can end a sharing server (`GET //`, malformed escapes: answered 400 or
  404). Album uploads are pictures only, streamed to disk, at most three at once and 500 per album, and discarded
  when sharing stops while they are on their way. Rooms and the phone remote end with the window that started them.
  The relay limits rooms (in all and per address) and guests per room; a guest that stops reading gets the latest
  state when it catches up, not a queue.
- **Security: S4.** Content Credentials no longer reads as "valid; signed by X" for any certificate. The details
  make two statements: *unchanged since it was signed* (hashes, signature, and now the certificate's own signature),
  and who signed, which is stated only for this device's own certificate (the same bytes as the keystore's). Any
  other name is shown as what the certificate says, not verified. There is still no list of trusted issuers.
- **Security: S5.** A script or plug-in running a command that reaches beyond the open picture and folder (other
  programs, the network, AI services, other files, batch jobs, settings, plug-ins) asks first, in a dialog the
  worker cannot answer, naming the command and its argument.
- **Security: S7.** PowerShell and AppleScript texts are fixed; names and numbers travel in environment variables and
  arguments (`electron/osscripts.cjs`). Not run on Windows or macOS: checked by a test of the command lines only.
- **Security: S12, S13.** CSV exports put an apostrophe before a value a spreadsheet would run as a formula (numbers
  such as a western longitude stay numbers), and the CSV import takes it off again. A service counts as local only
  when its whole host name is localhost or an IP address in the loopback, private or link-local ranges
  (`localhost.example.com` is remote); agreeing to send to one service no longer covers another.
- **Hangs on crafted files: R1 to R8.** 7z, xz, tar, OpenEXR, FITS (and Rice tiles), BMP, DDS, GIF code size,
  DICOM segmented palettes and presentation-state drawing all bound their counts and loops.
- **Memory on crafted files: R9, R11 to R16** (`src/codecs/limits.ts`). Palette counts are bounded by the bit depth
  and the file; TIFF pages and GIF frames together stay within a pixel budget (250 megapixels), with a warning naming
  what is left out; color-cycling frames the app makes itself have a smaller one; DICOM and FITS refuse a header that
  describes far more than the file holds; inflate has an output limit and does not allocate from a header's hint; zip,
  RAR, 7z and LZMA refuse entries over 512 MB (solid blocks over 1.5 GB); a TIFF directory holds at most 4 million
  values; EXR keeps only the planes it shows and PSD at most five; byte runs become text in pieces instead of one
  spread; a PICT line keeps one span per row instead of a grid over its box. Not done: decoding pages on demand
  instead of all at once (the budget is a stopgap for that). R17 and R18 are fixed (below).
- **Hangs: R10.** RAW sensor sizes are checked against the data present before anything is allocated (families, DNG,
  lossless JPEG).
- **Wrong results: W1, W2.** Interlaced GIFs; median cut with one dominant color.
- **Wrong results: W3, W4.** The TIFF horizontal predictor is undone for 16-, 32- and 64-bit samples in either byte
  order, and in a copy when the data is uncompressed (new fixtures written with tifffile). 32-bit BMP and TGA whose
  alpha is zero in every pixel open opaque; a PSD's extra channel is taken as transparency only when the layer count
  says so (my own PSD test had been written with the wrong assumption and was corrected).
- **Wrong results: W16 to W19, and S11.** XMP attribute values end at the quote they began with. Shift Dates and
  Remove Location replace the EXIF block alone (`replaceExif`), leaving the multi-picture index, extended XMP and
  content credentials where they were. Remove Location overwrites the GPS directory and its values (checked with
  Pillow: no GPS, the coordinates gone from the bytes, the file the same length). Strip removes PNG `caBX` and WebP
  `C2PA` chunks. The IPTC writer carries over the datasets it has no field for and cuts text between characters. An
  XMP packet too large for a JPEG segment is refused with a reason. Lossless transforms keep a motion photo's video,
  leave out a gain map with its index, and say which. Writing regions keeps the people named without a region.
  Not done: extended XMP for packets over 64 KB; a gain map is dropped by a lossless transform, not transformed.
- **Wrong results: W13.** RAW previews are turned upright by the RAW file's own orientation (IFD0 in the TIFF-based
  families, Olympus's and Panasonic's headers included; the MRW TTW block; the CR3 CMT1 box; a Leaf back's rotation
  angle; else the preview's EXIF). Developed pictures are marked as upright, so Auto-Rotate no longer turns them
  again. Checked against LibRaw: on the corpus (the one portrait file, a Leaf MOS, agrees) and on every TIFF-based
  corpus file patched to portrait. Not checked against LibRaw: CR3, RAF and MRW (no portrait sample).
- **Wrong results: W9.** WCS projection parameters are read from the latitude axis and the fiducial point, offset flag
  and PV-given LONPOLE/LATPOLE from the longitude axis, so DEC-first headers work; fiducial offsets are honoured; GLS
  with a reference latitude is read as wcslib rewrites it (SFL with the fiducial point there); TPV with DEC first uses
  wcslib's axis assignment. Six new astropy fixtures, all agreeing to 10 µas.
- **Wrong results: W10, W11, W14.** Implicit-VR presentation states (copies written by pydicom) read as the explicit
  ones do. 1-bit frames are unpacked at their bit offset (a pydicom-written 3 × 5 segmentation). The presentation
  state's picture is found under UID names and `.IMA` names, and each file's UID is read once.
- **Wrong results: W12.** Checked against the standard's text (PS3.3 C.10.6, C.10.4; PS3.4 N.2): the rotation is now
  applied before the horizontal flip (it was after), displayed-area corners may be any opposite pair, annotations in
  displayed-area units are drawn after the turn, and MONOCHROME1 is ignored under a presentation state. `gsps.png` is
  now computed in the standard's order and compared (it was generated from the app's own rules and never compared).
- **Wrong results: W5, W6.** Packed RAW layouts that were never checked against a real file are refused (Samsung's,
  Olympus's, Nikon's little-endian one) instead of decoded to noise; the support report runs the reader's own header
  path, so it cannot say yes to a file the reader refuses (compressed PEF, ORF and SRW, Canon sRAW); README and
  ROADMAP name the codings that were checked, not makers. The 14 corpus files still match LibRaw sample for sample.
- **Wrong results: W7, W8.** CSC on faces 3 and 4, and non-zenithal projections with the reference point at a
  celestial pole. New astropy fixtures cover every CSC face; with wcslib's single-precision order followed exactly,
  CSC now agrees with astropy to 4e-10 arcsecond on 2,600 random points, so its looser test tolerance is gone.
- **Interface: U3, U4, U7, U8, U14.** A typed "+" zooms in however the keyboard makes it (US Shift+=, the numpad, a
  layout with its own + key); Double Size moved to Shift with the numpad's +. A wheel notch is one step and a trackpad
  swipe with its inertia is one step; zoom by wheel or pinch follows the size of the movement. A window closed while
  its picture decodes drops it and starts nothing more, and a closed viewer's animation cannot start again. Removing
  a default key from one command leaves it to the others that share it. Menu entries that name a value instead of a
  command run their own command (12 entries in six menus answered "Unknown command", not only the three named here).
- **Interface: U11.** Following a shared view no longer loses the newest state, stops when its window is closed,
  asks one request at a time (more slowly while the host is unreachable); the relay's album page shows the thumbnails
  it has and offers nothing that would fail.
- **Interface: U1, U2, U5.** Esc closes the app only with that option on; the shortcut handler stands aside
  for a control reached with Tab, for lists and the map, for an open menu, and for a picture larger than the
  window (the arrows move it); release builds of the desktop app carry their runtimes, and staging fails
  without them.

- **Interface: U6, U9, U10, U12, U13.** Dialogs are modal: the page behind them is inert, Tab stays inside, and
  Enter that ends an IME composition no longer presses the default button; Android's back button closes the
  command palette first. Sharing several files to the Android app sends them all without a cyclic object, and
  "Edit with" (ACTION_EDIT) opens the file. Stop AI ends a request on the desktop and Android at once and the
  native side drops the connection. Desktop files cross the bridge as bytes, not base64 (Android keeps its 64 MB
  limit with its message); a second launch resolves relative names against its own working directory; turning
  portable mode off a second time picks a free name for the set-aside folder. The service worker precaches the
  release's own scripts, styles and icons under a cache named after them, drops earlier releases' caches,
  matches module requests despite `Vary: Origin`, and never stores an error page as the app (offline start is
  checked in the web e2e).

- **Wrong results: W15, W20 to W27.** HEIF and AVIF brands (`heis`, `hevc`, `avio`, `miaf`, `mif2`, ...) open as
  pictures, not video; a gzip stream is identified by what it holds (SVG, EMF, WMF, FITS) instead of being taken for
  SVG, and `.svgz` is unpacked before rendering. Seam insertion keeps the seam pixel before the blended one and maps
  seams back by undoing removals latest first. Blur, rotation, warps and remaps weight colors by alpha, so cut-outs
  keep clean edges. Batch names get `{exifdate}`, `{exiftime}`, `{make}`, `{model}`, `{w}`, `{h}` from the files,
  and the preview says when a file has no EXIF date. Export Animation puts pages of different sizes on one canvas
  of the largest width and height. Date fields are local days. Multipage ▸ Split writes TIFF through the app's own
  writer and reports why a file failed. APNG delays over 65.5 s keep their length; the TGA writer uses one typed
  buffer and refuses sizes TGA cannot store. Window / Level previews through the same path as opening, so it works
  for presentation states and baseline-JPEG DICOM.

- **Recovery and tooling: R17, R18, S14, S15, D11, section 6.** A damaged OpenEXR chunk is left black and counted
  instead of losing the picture; damaged fax lines are left white (G3 resumes at the next EOL, G4 keeps the lines
  before the damage); bzip2, LZMA, LZMA2 and xz errors keep what was unpacked, so a damaged .tar.gz/.tar.bz2/.tar.xz
  lists the files before the damage, a TIFF strip keeps its rows before it, and a 7z block's files that lie before it
  still open (that 7z path has no damaged fixture yet). Carving passes each JPEG once (32 MB with 400 JPEGs: about
  30 s before). Workflows pin every third-party action to a commit SHA, pass the `tag` input through the environment
  and check its form, take `[release]` only from the owner's pushes, keep write access in the jobs that publish,
  and refuse a tagged Android release without the release keystore. `window.qn` and the `__qn*` hooks exist only
  in builds made with `npm run build:test`; release builds expose nothing. Both end-to-end suites run in CI
  (`.github/workflows/e2e.yml`), and `npm run typecheck` checks `electron/*.cjs` (`tsconfig.electron.json`).

Everything else below is still open.

## 1. Data loss and wrong files written (fix first)

| # | Where | What happens | Status |
|---|---|---|---|
| D1 | `src/commands/batch.ts:201-218`, `electron/main.cjs:405` | Batch outputs overwrite same-named files without asking. With the defaults (same format, `{name}`) and the source folder as destination every original is replaced; Undo Last Batch then deletes those paths permanently (`unlinkSync`, not the trash). | traced |
| D2 | `src/commands/file.ts:149, 236-247` | `saveTab(app, tab)` encodes `app.picture`, the active window, and writes it to `tab`'s file. With Synchronize Windows on, answering Save for a dirty second window writes window 1's pixels into window 2's file. | reproduced |
| D3 | `src/app.ts:103-130` | Before/After swaps the original pages into the picture; Save while "Before" is showing writes the unedited picture and clears the history. Undo/redo while it shows desynchronize the stack. | reproduced (state), traced (save) |
| D4 | `src/commands/platformFile.ts:99-126` | Import from Camera overwrites existing destination files (numbering restarts at 1 each run; duplicates are only checked in the destination root). With delete-after-import the earlier pictures are gone. | traced |
| D5 | `QuillNativePlugin.java:613-617, 639` | Android `createInFolder`/`findChild` always use the picked tree's root, not the subfolder. Imports and backups land in the root, and a same-named file there is deleted first. | traced, re-read |
| D6 | `src/commands/file.ts:255-276` | Saving from the "Save changes?" prompt after Next replaces the wrong folder entry (`entries[folder.index]` after the index moved): the list becomes a, a, c. | reproduced |
| D7 | `src/commands/lossless.ts:22-36, 127, 143` | Lossless write-back re-reads `app.picture` after its dialog; if the picture changed meanwhile (phone remote, watch, sync) A's bytes go into B's file. No keep-original copy, no confirmation on crop write-back. | traced |
| D8 | `src/ai/index.ts:131-143`, `aiEdit.ts` | An AI result is applied to whatever picture is active when the job finishes (10–60 s later), not the one it was started on. | traced |
| D9 | `src/commands/file.ts:241-247`, `registry.ts:579` | Plain Save rewrites animated WebP as one frame, and PAM/PGM-16/PFM as 8-bit PPM under the old extension, without asking. | traced |
| D10 | `src/ai/keystore.ts:104-118` | "Keys not loaded" is treated as "no keys": declining the unlock prompt and then any `savePrefs` deletes the stored encrypted key record. Same shape on the desktop after a failed `secretGet`. | reproduced |
| D11 | `src/picture/watch.ts:36-52`, `electron/main.cjs:222` | A failed folder listing is stored as an empty folder, so when a NAS or drive returns every picture counts as new and the watch action runs on the whole folder. The desktop lists the parent when the folder is missing. | traced |
| D12 | `src/picture/catalog.ts:66, 98-121` | A rescan while the drive is unplugged deletes that folder's catalog items and thumbnails. | traced |
| D13 | `src/app.ts:98-99, 132` | `dirty` is `undoStack.length > 0` with a 30-step cap: after 31 edits and 30 undos the picture still differs from disk but can be left without the prompt. The stack keeps up to 30 full-size snapshots (about 96 MB each at 24 MP). | traced |
| D14 | `src/commands/batch.ts:296-316` | Batch Rename can strand files under hidden `.ql-batch-…` names when a target collides with an unmarked file; the rollback error is swallowed. | plausible |
| D15 | `electron/main.cjs:378` | The case-only-rename exception lets `photo.jpg` → `Photo.JPG` silently replace an existing `Photo.JPG` on case-sensitive file systems. | reproduced (logic) |
| D16 | `src/prefs.ts:270, 299-301`, `metaGeo.ts:140` | Imported places live in the localStorage prefs record; past the quota every later save fails silently and all settings changes are lost on reload. | reproduced |
| D17 | `src/commands/organize.ts:51-53` | Cull Mode replaces `prefs.osdTemplate` in place; closing without Esc persists "CULL …" as the user's template. | read |

## 2. Security

| # | Where | What happens | Status |
|---|---|---|---|
| S1 | `src/commands/batch.ts:238, 291` → `ui/dialog.ts:119`; `index.html` | File names go into the batch preview as HTML. A zip entry or shared-album item named `<img src=x onerror=…>.jpg` executes script on the web and Capacitor builds, which have no CSP (settings, unencrypted AI keys, folder handles). The desktop CSP blocks the handler but not the markup. Same pattern at `ai/index.ts:155`, `aiUnderstand.ts:210`, `file.ts:553`, and error-message previews. | reproduced |
| S2 | `electron/main.cjs:148, 259-264, 405-410, 543-549` | The grant model collapses once one picture is open: `parentFolder` grants upward with no ceiling, `listSubfolders` grants every child, `createInFolder`/move/copy need only a read grant and overwrite. A compromised renderer (see S1, S5) can read `~/.ssh`, write `~/.bashrc`, and plant `programs.json`. Not reachable by an ordinary user action. | reproduced with a stubbed Electron; re-read |
| S3 | `create2.ts:45, 131`, `picture/slideshow.ts:113-120` | Web Gallery and HTML Slideshow embed captions in `<script>` through `JSON.stringify` without escaping `</script>`. A picture whose title or EXIF date holds `</script><script>…` puts that script into the exported page. | reproduced |
| S4 | `src/meta/c2pa.ts:323-359`, `der.ts:107` | Content Credentials verification says "valid; signed by X" for any embedded certificate: no trust anchor, no check of the certificate's signature or dates. A forged "Reuters" certificate reads as valid. | reproduced |
| S5 | `src/dev/scriptHost.ts:97-104` | Scripts and plug-ins can call any command with any argument, including dialog-free ones: install more plug-ins, `view.shareView {quiet, relay: attacker}`, run an already-approved external program with chosen arguments. The UI text promises less. | traced |
| S6 | `scripts/relay.mjs:25`, `electron/netshare.cjs:96, 117, 120`, `remote.cjs:40` | `GET //` (no token needed) throws in `new URL` and kills the relay process; in the app it is an uncaught exception in main. A malformed `%` in `thumb/…` does the same with a token. | reproduced |
| S7 | `electron/main.cjs:456-488, 536` | Paths are interpolated into PowerShell single-quoted strings escaping only `'`; U+2018/2019 also close such strings. A file named `a’);Start-Process calc;#.jpg` would run code from File ▸ Properties. AppleScript strings do not escape `\`. | plausible (language rules; not run) |
| S8 | `electron/netshare.cjs:125-139` | Album uploads accept any file type and count, buffer 64 MB each in memory, and a late upload is still written after sharing stopped. | reproduced |
| S9 | `electron/main.cjs:228-256, 711` | Share rooms and the phone remote outlive the window: after View ▸ Frameless (which recreates the window) the UI shows sharing off while the room keeps serving and accepting uploads. | traced |
| S10 | `relay.mjs:32-46`, all three servers | Anyone can create unlimited 8 MB relay rooms; event-stream writes ignore backpressure (20 stalled guests and a minute of panning: +325 MB). | measured |
| S11 | `metaEdit.ts:111-119, 172, 216-223` | Remove Location only deletes the GPS IFD pointer; the coordinates stay in the file. Strip leaves PNG `caBX` and WebP `C2PA` chunks, which carry the AI prompt and a source thumbnail. | reproduced |
| S12 | `export.ts:60`, `meta.ts:397, 540` | CSV exports do not neutralize cells starting with `= + - @`. | reproduced |
| S13 | `src/ai/index.ts:32, 149-161` | The "local address" test is a prefix match (`http://localhost.example.com` counts as local and skips the remote-send confirmation); consent is one flag per session, not per service. | read |
| S14 | `.github/workflows/*` | Third-party actions by mutable tag in jobs holding `contents: write` and the signing keystore; any push whose message contains `[release]` publishes; `inputs.tag` interpolated into bash; a missing keystore is only a warning. | read |
| S15 | `src/main.ts:33-66` | `window.qn` and about thirty `__qn*` test hooks ship in production, which makes any injection trivially exploitable. | read |

## 3. Untrusted files: hangs, crashes, memory

All of these take a small crafted or damaged file. Hangs matter most because decoding runs on the main
thread: the app freezes with no way to cancel.

| # | Where | Trigger | Status |
|---|---|---|---|
| R1 | `sevenzip.ts:140-144, 33` | 50-byte 7z with a self-referencing packed header loops forever; 43-byte file with a huge count aborts with heap exhaustion. | reproduced |
| R2 | `lzma.ts:207-210` | 24-byte `.xz` spins for minutes (index count unchecked; `readVli` returns 0 past the end). Reached from tar.xz and TIFF LZMA strips. | reproduced |
| R3 | `tar.ts:13, 30` | Negative size field moves the cursor backwards: endless loop to heap exhaustion. | reproduced |
| R4 | `exr.ts:43` | Negative attribute size: `decodeExr` never returns (24-byte file). | reproduced |
| R5 | `fits.ts:61, 83`, `fitsTiles.ts:30` | Negative `NAXISn` or Rice `BLOCKSIZE` 0: endless loop. | reproduced |
| R6 | `bmp.ts:58`, `dds.ts:75, 54`, `bmp.ts:46`, `gif.ts:138` | Channel mask 0xFFFFFFFF hangs BMP and DDS; mip count, `biClrUsed` and GIF code size used as loop bounds. | reproduced |
| R7 | `dicom.ts:637-652` | Segmented-palette indirect segments recurse exponentially (64 bytes: 3 s; 16 segments: tens of minutes). | reproduced |
| R8 | `dicom.ts:801-823, 729` | Presentation-state lines are stepped per unit of length with no clipping (a point at 1e30 never finishes); polygon shutters cost vertices × pixels. | reproduced |
| R9 | `metafile.ts:63-64`, `workstation.ts:139` | Palette loops bounded by a header count: 4 billion pushes from one DIB header. | traced / reproduced |
| R10 | `src/raw/families.ts`, `ljpeg.ts:65`, `dng.ts:70, 124` | RAW readers allocate and loop width × height from header fields regardless of the data present (48-byte MRW: 144 M samples, 2.1 s), and the bit readers return zeros past the end instead of failing. | reproduced |
| R11 | `tiff.ts:84-103`, `gif.ts:31, 103` | Every page and frame is decoded eagerly to its own RGBA raster: a 1 MB 40-page fax TIFF takes 1.3 GB; the loop allows 500 pages. | reproduced |
| R12 | `dicom.ts:448`, `fits.ts:119`, `retro.ts:119`, others | Pixel caps too generous or missing: 1.2 KB DICOM → 1.29 GB; 842-byte IFF with color cycling → 256 frames, 1 GB. | reproduced |
| R13 | `zip.ts:74`, `inflate.ts:67`, `rarunpack.ts`, `lzma.ts`, `psd.ts`, `exr.ts:343` | Sizes from headers trusted for allocation; no decompressor has an output cap (305 KB → 300 MB). EXR allocates a float plane per channel though four are shown. | reproduced (zip, inflate, rar, lzma) |
| R14 | `tiff.ts:41-66` (`readIfd`, also used by EXIF) | Up to 4,096 tags × 1 M values materialized as `number[]`; a 1 MB TIFF takes 828 MB of heap. | reproduced |
| R15 | `tiff.ts:90`, `pnm.ts:27, 32`, `metaEdit.ts:10, 246`, `families.ts:34`, `dng.ts:30` | `String.fromCharCode(...bytes)` overflows the stack: a 200,000-character ImageDescription (ordinary in OME-TIFF) fails the file; the provenance check fails for every HEIC/AVIF/MP4 over about 1 MB. | reproduced |
| R16 | `pict.ts:184-199` | Each Line opcode allocates a grid the size of its bounding box: 60 lines, 7 s, +351 MB. | reproduced |
| R17 | `exr.ts:360-369`, `ccitt.ts`, `bzip2.ts`, `lzma.ts` | One damaged chunk aborts the whole picture with raw engine errors, unlike the PNG/JPEG/TIFF paths that keep what decoded. | reproduced (fuzz) |
| R18 | `carve.ts:58-63` | Carving is O(bytes × hits): 32 MB with 400 JPEGs takes 27 s. | measured |

## 4. Wrong results

| # | Where | What is wrong | Status |
|---|---|---|---|
| W1 | `gif.ts:89, 126` | Interlaced GIFs are decoded with the row permutation applied backwards; rows come out scrambled. No test covers interlace. | reproduced |
| W2 | `palette.ts:36-39` | `medianCut` stops entirely when one box cannot be split: a screenshot that is 60 % white quantizes to one color. Affects GIF export and Reduce Colors. | reproduced |
| W3 | `tiff.ts:247-253` | Horizontal predictor on 16-bit big-endian TIFFs is undone little-endian; 32-bit predictor data is not undone at all; uncompressed data is un-predicted in the caller's buffer. | reproduced (MM 16-bit) |
| W4 | `bmp.ts:85-87`, `tga.ts:92-94`, `psd.ts:113` | "All-zero alpha means opaque" never takes effect: 32-bit BMP (what the clipboard writes) and TGA with zero alpha bytes decode fully transparent; PSD uses the first extra channel as transparency even when it is a saved selection. | reproduced |
| W5 | `src/raw/families.ts:452-459` | The packed 12-bit branch decodes layouts it was never checked against instead of refusing. A real Samsung NX1000 file decodes to garbage with no error (99 % of samples differ from LibRaw). A synthetic Olympus packed file does the same. | reproduced on a real file |
| W6 | `src/raw/families.ts:610-618`, README, ROADMAP | `rawSupport` says ok for files the reader then refuses (modern Olympus ORF, Pentax PEF from the K10D on, most Samsung SRW). Develop RAW is enabled and fails. The README, ROADMAP and my last report listed these makers as supported without saying only the old uncompressed layouts work. | reproduced |
| W7 | `wcs.ts:411-412` | CSC inverse has the wrong sign on faces 3 and 4: Dec +22.4 where astropy gives −22.4. The fixtures did not cover those faces. | reproduced |
| W8 | `wcs.ts:132` | Non-zenithal projections with `CRVAL2 = ±90` are 180° off in RA. | reproduced |
| W9 | `wcs.ts:70, 314` | With Dec as the first axis, PV parameters are read from the wrong axis; GLS with `CRVAL2 ≠ 0` and fiducial offsets are not honored. | reproduced |
| W10 | `dicom.ts:280` | Implicit-VR presentation states (the default transfer syntax) are read as garbage: float and signed values are parsed as unsigned shorts. | reproduced |
| W11 | `dicom.ts:457` | 1-bit multi-frame data is sliced at byte boundaries; segmentation objects are wrong from frame 2 on unless rows × cols is a multiple of 8. | reproduced |
| W12 | `dicom.ts:783-796, 580` | Presentation-state flip/rotation order and MONOCHROME1 polarity may differ from the standard; `gsps.png` was generated from the app's own rules, so the test cannot tell. | plausible |
| W13 | `registry.ts:378` | RAW previews are never auto-rotated (portrait NEF/CR2/ARW open sideways); developed pictures are rotated but not marked, so Auto-Rotate turns them again. | traced |
| W14 | `registry.ts:276-280` | Presentation-state sibling lookup skips files named by UID or `.IMA`, and reads and parses up to 500 siblings in full each time. | traced |
| W15 | `media.ts:37`, `registry.ts:153, 186` | HEIF/AVIF files with major brand `heis`, `hevc`, `avio`, `miaf` sniff as video; every gzip stream not named .emz/.wmz/.fits.gz sniffs as SVG, and `.svgz` is never gunzipped. | reproduced (sniff) |
| W16 | `meta/xmp.ts:63, 110, 193` | Attribute regexes stop at either quote: `photoshop:City="Coeur d'Alene"` reads as "Coeur d", and writing another field then produces malformed XML. | reproduced |
| W17 | `metaEdit.ts:197, 220`; `iptc.ts:98-104`; `metaEdit.ts:44` | Remove Location and Shift Dates drop MPF, extended XMP and APP11 segments (breaks Ultra HDR and motion photos); `writeIptc` deletes every dataset it does not know and truncates inside UTF-8 characters; an XMP packet over 64 KB is silently replaced by nothing while the UI says "written". | reproduced |
| W18 | `jpegLossless.ts:111, 597` | Lossless transforms drop everything after the first EOI (gain maps, motion-photo video) with no warning. | reproduced |
| W19 | `meta/xmp.ts:223-236` | Writing regions replaces `PersonInImage` with the region names only. | reproduced |
| W20 | `picture/seam.ts:40-41, 63` | Content-aware widening writes the interpolated pixel before the seam pixel and maps seams back in the wrong order (zigzag edges). | reproduced |
| W21 | `adjust.ts:193-206`, `effects.ts:28-34`, `geometry.ts:26`, `merge.ts:118` | Blur and bilinear sampling average non-premultiplied RGBA: dark fringes on cut-outs. | reproduced |
| W22 | `batch.ts:173, 237, 290` | `{exifdate}`, `{make}`, `{model}`, `{w}`, `{h}` are advertised but never supplied; "rename by EXIF date" silently uses the modified date. | reproduced |
| W23 | `export.ts:100-123` | Export Animation assumes every frame has the first frame's size. | traced |
| W24 | `organize.ts:79` | Filter Bar dates are parsed as UTC, picture dates are local. | read |
| W25 | `batchSteps.ts:225, 238` | Batch Multipage ▸ Split offers TIFF, which has no encoder: every file fails without a reason. | traced |
| W26 | `pngenc.ts:55`, `tga.ts:138-151` | APNG frame delays over 65 s wrap; `encodeTga` builds a `number[]` (45 MP throws). | reproduced |
| W27 | `scientific.ts:102-104` | Window/Level preview fails for pictures opened through a presentation state and for baseline-JPEG DICOM. | traced |

## 5. Interface and platform

| # | Where | What happens | Status |
|---|---|---|---|
| U1 | `commands/file.ts:437-440` | On the desktop Esc closes the app whatever the "Esc closes the app" option says (default off). | traced, re-read |
| U2 | `ui/shell.ts:44, 555-581` | The global key handler runs in the capture phase ahead of every widget: arrows in the thumbnail grid move two pictures, Enter/Space on a focused button runs Full Screen or Next instead of the button, Enter on a menu item does not pick it, left/right never pan. The app cannot be driven by keyboard outside dialogs. | reproduced (jsdom) |
| U3 | `platformFile.ts:169, 265`, `specialViews.ts:141` | Three menus build entries whose id is not a command: Hide/Unhide, Import with Rules and Stereo View modes all answer "Unknown command". Hidden pictures cannot be unhidden from the UI. | traced, re-read |
| U4 | `util/keys.ts:12-16` | "+" never zooms in (numpad and non-US layouts get nothing; US Shift+= runs Double Size, an edit). | reproduced |
| U5 | `.github/workflows/release.yml:79` | Release builds run `npm run build` without `QN_ORT_LOCAL=1`, so shipped installers carry no local runtimes and the desktop CSP blocks the CDN: PDF, OCR, JPEG XL/AVIF fallback, DjVu, JPEG 2000 fail in released builds. The inline `VAR=1 cmd` scripts also fail under Windows cmd. | traced, re-read |
| U6 | `QuillNativePlugin.java:1232-1243` | Sharing two or more pictures to the Android app builds a cyclic JSON object: crash while running, nothing opens on a cold start. | traced, re-read |
| U7 | `ui/viewer.ts:372-386` | Wheel handling ignores delta size: one trackpad swipe skips 20–40 pictures. | traced |
| U8 | `app.ts:152-171` | A tab closed while decoding keeps running; a destroyed viewer's animation timer refreshes the app forever. | reproduced |
| U9 | `public/sw.js` | The service worker precaches only the shell; offline after one visit the script 404s; old chunks are never pruned; non-OK responses are cached as `index.html`. | read |
| U10 | `ui/dialog.ts:100-173` | Dialogs do not trap focus or make the background inert; Enter is not guarded during IME composition; Android Back with the command palette open leaves the app. | reproduced (focus) |
| U11 | `commands/netshare.ts:104-116`, `netshare.cjs:62-75` | A followed view can stick on a stale picture (a state dropped while busy still advances the signature); polling never stops if the follow window is closed while the host is idle; requests pile up when the host is unreachable; the relay serves an album page whose thumbnails, downloads and uploads all 404. | traced / reproduced |
| U12 | `ai/transport.ts:25`, `native.ts:364` | Stop AI cannot cancel a request on the desktop or Android; the paid generation completes and AI commands stay blocked until the timeout. | traced |
| U13 | `main.cjs:128-133, 716`, `AndroidManifest.xml:30` | Files cross the bridge as one base64 string (videos over about 400 MB cannot open); `second-instance` ignores the working directory; `ACTION_EDIT` is registered but not handled; portable mode off fails the second time. | reproduced / read |
| U14 | `app.ts:226` | Removing a default key from one command unbinds every command sharing it. | read |

## 6. Tests and tooling

- **Neither end-to-end suite runs in CI**; typecheck and unit tests run only inside the Android workflow.
  78 of 235 source modules are imported by no unit test, among them `file.ts`, `meta.ts`, `shell.ts`,
  `viewer.ts`, `dialog.ts`, `app.ts`. `electron/*.cjs` has no tests and is outside the typecheck.
- The web e2e drives the app through `qn.exec` 323 times and about a dozen real keys, which is why U1, U2
  and U4 were invisible to it. It is one 2,565-line script with 41 fixed sleeps, and it writes runtimes
  and fixtures into `dist/`.
- The corpus tests skip silently when the corpus is absent, which is always in CI. Some fixtures are
  generated from the app's own rules (`gsps.png`, the NEOchrome cycling file), so they cannot catch a
  misreading of the format.
- The unit tests themselves are sound: all 560 `it` blocks assert something and codecs are compared with
  independent references.

## 7. Corrections to my own last round

These are in code or statements from commit 59af882:

- W5, W6: the RAW coverage claim was too broad and one layout decodes wrongly. The corpus had one sample
  per maker; I generalized from it.
- W7: CSC faces 3 and 4. My fixtures only exercised the faces that happened to be right.
- R10: the RAW readers have no size checks.
- S6, S8, S9, S10, U11: the sharing servers and the follow logic.
- Unverified: `homecomputer.ts:111` may read NEOchrome's lower color limit from the wrong nibble; the
  fixture was written with the same assumption as the reader. *Since:* the format description could not be fetched
  from this environment, so the question is still open; the reader now takes the range from the smaller to the larger
  nibble, which is the same colors under either reading. A second attempt also failed: the format pages
  (fileformats.archiveteam.org, textfiles.com, atari-wiki.com) are not reachable from here, and RECOIL, the one
  independent reader available, decodes NEO pictures without their color cycling.

## 8. Structural causes and what would remove whole classes

1. **Commands re-read `app.picture`, `app.tab` and `folder.index` after an await** (D2, D6, D7, D8). Pass a
   captured `{ tab, picture, entry }` and check `tab.picture === picture` before any write.
2. **No single guarded write path** (D1, D4, D5, D14, D15). One module: exclusive create by default,
   explicit overwrite only with keep-original, temp-then-rename, verify before deleting a source, journal
   only created files, trash instead of unlink.
3. **Raw HTML sinks** (S1, S3, S12). Make `setPreview` and dialog `html` fields take nodes, share one set
   of escapers for generated HTML/CSV, add a CSP to the web build, remove the production test hooks.
4. **No bounds-checked reader or resource budget in the decoders** (all of section 3). A cursor that throws
   past the end and must advance, an `alloc()` with a byte budget, a max-output cap on every decompressor,
   lazy pages and frames, and decoding in a worker with a watchdog.
5. **"Unknown" treated as "empty"** (D10, D11, D12, D16). Stores, watches and the catalog must not write
   state they failed to read.
6. **One key router with focus scopes** (U1, U2, U4, U10, U14), testable in jsdom.
7. **Metadata edited by strip-and-rebuild** (S11, W16, W17, W19). A segment/chunk list model with "replace
   this block, keep the rest", XMP parsed as XML, IPTC as an ordered dataset list.
8. **Path authorization spread across handlers** (S2). One module with user-chosen roots, realpath
   containment and separate read/write capability, tested with a stubbed Electron.
9. **CI**: a PR-gating workflow with typecheck, unit, build, both e2e suites and lint; actions pinned by
   SHA; a scheduled corpus run that fails when skipped.
10. **Line length**: 507 lines over 300 characters in the UI and command code alone. Stack traces, diffs,
    blame, coverage and breakpoints all resolve to a line holding five to ten statements; U1 and S1 are
    each one such line. One mechanical formatting commit with `.git-blame-ignore-revs` would fix it.
