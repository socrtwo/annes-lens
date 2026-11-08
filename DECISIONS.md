# Decisions

Working notes on judgment calls made while finishing the open items, so a reader can see what was decided and why.

## The checklist

- **No TODO.md exists** in the working tree, on this branch, on `main`, or in any other branch of the repository, and nothing refers to one. The only checklist with open boxes is `docs/ROADMAP.md`, which is the project's own to-do list. Its unchecked items were taken as the TODO list and are checked off there as each is finished: the classic-menu verification (M0), the openly licensed test corpus (M0), on-device generation (M7), and DICOM and FITS tools (M8).

## Order of work

1. **DICOM and FITS tools** first: the best-defined item, building on readers finished in the previous chunks.
2. **Test corpus**: a fetch script with a license manifest rather than files committed to the repository (see below).
3. **Classic menu verification**: against the programs' published documentation, since installed copies are not available here (see below).
4. **On-device generation** last: the largest item, with the model choice constrained by the project's license rule.

## Test corpus

- **Not committed.** Real camera files are 1–40 MB each; the corpus (376 MB) is fetched by `scripts/fetch-corpus.py` into `tests/corpus` (ignored by git) with a manifest of URL, license, size and SHA-256. The repository keeps the small generated fixtures.
- **CC0 only from raw.pixls.us.** The site also carries CC-BY-NC-SA samples; they are skipped, since the project should not take on attribution or non-commercial terms for test data. Every download is checked against the site's SHA-256.
- **NASA FITS samples** are public domain as US government works. No other external sources were added: the project's own generators already cover the other formats with files it owns.
- **Damaged files are made, not collected.** Cutting, zeroing and flipping the downloaded files gives reproducible damage for the recovery engine; the test accepts either a decoded picture or a plain error, never a hang or a crash.
- **One gap the corpus found was fixed** rather than listed: Kodak DCR/KDC, Epson ERF, Hasselblad 3FR/FFF and Phase One IIQ files carry no JPEG preview, only an uncompressed TIFF thumbnail, which the RAW preview path now shows. Minolta MRW has neither; it stays an identified file with a clear error until a RAW module exists.

## Classic menu verification

- **Documentation instead of installed copies.** No Windows or macOS programs can be installed here, so each layout was checked against the program's own published menu definitions and shortcut lists: IrfanView's official English-GB menu resource and hotkeys page, XnView MP 1.12.2's menu bars (author's statement and dated screenshots for the item lists), FastStone 8.5's menu definitions and help file, ACDSee Photo Studio Ultimate 2026's help, Picasa 3.9's own string tables and Google's shortcut list, Apple's Preview User Guide, the digiKam 8.8 manual. The research notes stayed outside the repository; this file records the outcome.
- **Where documentation was incomplete, the plan was left alone**: ACDSee's menu order is not documented (only membership), Preview's Window and Help menus are not described by Apple, and Microsoft no longer documents Windows Photo Viewer at all; the Windows Photo Viewer layout therefore stays as planned.
- **Menu arrangement**: seven layouts were rearranged to the documented menu bars: IrfanView (border/canvas size and Show Channel under Image, lossless JPEG and e-mail under Options, multipage navigation under View as in the program), XnView MP (a Metadata menu, no Window menu, Settings under Tools), FastStone (the Settings menu, lossless rotation under Tools, Red-Eye and JPEG Comment under Edit, border and watermark under Effects), ACDSee (a Panes menu; Modify, Zoom, Batch and Create as Tools submenus), Picasa 3 (the File, View, Folder, Picture, Create and Tools menus follow the program's string tables), Preview (New from Clipboard, Duplicate and Revert in File; Two Pages and Soft Proof in View; the Annotate submenu in Tools) and digiKam (Browse and Edit menus added; Import and Export after Tools; the editor's adjustments under Tools ▸ Image Editor). Anne's Lens commands the programs lack keep a sensible place in each layout rather than being dropped.
- **Default keys**: nine corrections from the documentation: Email Shift+M and Comment Ctrl+Shift+M (IrfanView; the plan had them crossed), Auto Crop Borders Ctrl+Shift+Y (IrfanView; Shift+X is XnView's Crop), Lossless Crop Ctrl+Shift+J (IrfanView), Random Picture Ctrl+M (IrfanView), Lossless Auto-Rotate by EXIF Ctrl+Alt+A (FastStone), People Ctrl+F6 (ACDSee). Two Anne's Lens keys moved out of the way: Go to Picture Number to Ctrl+J and Compare Pictures to Ctrl+Alt+Y (FastStone's P and XnView's Shift+C both collide with IrfanView keys the plan keeps).
- **Not adopted**: single-letter and Alt+letter defaults of other programs that would collide with IrfanView's letter keys or with menu mnemonics, and full-screen-only keys.

## On-device generation

- **Transformers.js rather than a hand-written pipeline.** Janus generates a picture as 576 image tokens from a 1.3-billion-parameter language model with classifier-free guidance, then decodes them; Transformers.js (Apache-2.0) implements that loop, the tokenizer and the chat template for the ONNX export. Driving ONNX Runtime directly would mean re-implementing all of it blind, without a GPU here. The runtime loads on demand like the others (the build's own copy for the desktop's strict Content Security Policy, the pinned CDN otherwise); its bundled ONNX Runtime files travel with it, since its version differs from the app's.
- **The model.** No text-to-image model exists today that is both permissively licensed and small enough for a browser (checked: Sana, Kandinsky, Würstchen, Infinity, OmniGen, Show-o are Apache-2.0 or MIT but need 2–8 GB and have no browser pipeline; SDXS, aMUSEd and the Stable Diffusion family carry OpenRAIL licenses). Janus-Pro-1B is the only one with a browser pipeline and a feasible size. The hub tags its ONNX export "MIT", which is the code license; the weights are under the DeepSeek Model License (commercial use allowed, use restrictions in its Attachment A). The project's rule for on-device models is permissive licenses only, so: the model is never bundled or fetched without an explicit choice, the download dialog names the license as it is and asks for acceptance, the documentation says so, and the default is swapped the day a permissive model of browser size appears. This is the one place the project departs from its rule, and it is recorded here for the maintainer to confirm or reverse.
- **Scope.** Prompt to picture only (384 × 384, up to four at once); edits, masks, variations and references stay with the picture services, as the model has no such inputs. Phones get the service with a warning rather than nothing (AI-PLAN.md planned desktop-only); the warning says what to expect.
- **Verification.** The plumbing (service, wizard, download dialog, generation, provenance, history) is covered by unit tests with a fake generator and the e2e test; `scripts/try-device-generation.mjs` runs the real model in Node against the same Transformers.js API so the integration can be checked end to end, which was done once here on the CPU.

## DICOM and FITS tools

- Four commands rather than a tool palette: Window / Level, DICOM Tags, FITS Stretch, FITS Header. They sit in the Image tab ("Scientific pictures") and the IrfanView-style Image menu; ids carry the tab's prefix as every command does.
- Display settings are **per file, in memory** (`decodeOptions.perEntry`), and the file is decoded again with them. They are not written to the file or saved across runs: a DICOM or FITS file's own values must stay what they were, and Save As writes the picture as shown, which is the usual way to keep a view.
- The CT presets are the common radiology values (brain 40/80, lung −600/1500, bone 400/1800 …); they are offered on every DICOM file, since the modality is not always filled in.
- The logarithmic and asinh stretches use SAOImage DS9's formulas (log₁₀(1 + 1000 t) / 3, asinh(10 t) / asinh(10)) so astronomers get the curves they know.
- The tag dump keeps every sequence's items (the reader normally keeps only the ones it uses) through a module flag set for the dump alone; the dictionary covers the modules pictures carry, not all of PS3.6, and names private tags "private".
- The dialogs accept arguments (`{ wc, ww, fn }`, `'full'`, `'file'`; `{ mode, percentiles | lo, hi }`, `'default'`) so scripts, macros and the tests can apply settings without the dialog.
