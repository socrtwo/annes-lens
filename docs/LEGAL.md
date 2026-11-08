# Clean-room, trademark and licensing notes

This file records how Anne's Lens will provide the complete command set of the major picture viewers while avoiding other vendors' trademarks and copyrights. It summarizes the practice the other Anne's Office apps follow; it is not legal advice. Milestone 1 is built under these rules; this file states them for the rest of the plan.

## What is reproduced, and why it is safe

- **Functionality and command names.** Viewer operations (Rotate Left, Resize/Resample, Batch Conversion, Lossless JPEG Transformations, Contact Sheet, Slideshow) are functional ideas, and their names are ordinary descriptive words used across the industry. Functionality is not protected by copyright, and descriptive terms are not trademarks for those functions.
- **Menu arrangements.** The classic menu layouts ([MENUS-PLAN.md](MENUS-PLAN.md)) reproduce how commands are *grouped* in familiar programs, so people can find them, under Anne's Lens's own labels, ordering details, tooltips and help text. Grouping commands under File, Edit, Image, Options and View is a common, functional arrangement. No menu text, dialog layout, help file or tooltip is copied.
- **Keyboard shortcuts.** Long-standing single-key conventions (O to open, R and L to rotate, Space for next) are functional conventions users rely on; all of them can be rebound.
- **File formats.** Formats are implemented from public specifications (JPEG/JFIF, PNG, GIF, TIFF 6.0, WebP, AVIF/HEIF (ISO/IEC 23008-12), JPEG XL, JPEG 2000, OpenEXR, DNG, PDF, SVG, EXIF/DCF, IPTC, XMP, ICC, C2PA) and from open-source references with permissive licenses. Undocumented formats are read only as far as public, clean-room information allows.
- **Plug-in compatibility.** Hosting Photoshop-compatible 8BF filters uses the publicly documented plug-in interface; no Adobe code is included.

## What is deliberately not reproduced

- No vendor logos, icons, splash screens, color schemes or trade dress. Command icons will be Google's Material Symbols (Apache 2.0); the app icon is original and part of the suite family.
- No vendor names in the app's own name or interface, except as the *names of menu layouts* in View ▸ Classic Menu Layout ("IrfanView style"), which identify an arrangement (nominative use), and in file-type lists to identify formats. Brand-specific feature names are replaced with generic terms:

| Vendor term | Anne's Lens term |
|---|---|
| Copy Shop (IrfanView) | Print Copies and Posters |
| I'm Feeling Lucky (Picasa) | One-Click Enhance |
| Light EQ (ACDSee) | Tone Equalizer |
| Instant Alpha (Preview) | Replace Color / Select by Color Range |
| Live Text (Apple), Lens (Google), Copy text from picture (Microsoft) | Recognize Text (OCR) |
| Visual Look Up (Apple) | Identify |
| Magic Eraser, Clean Up, Generative erase | Erase Object |
| Photo Unblur, Portrait Light | Unblur, Relight |
| Best Take, Photo Fuse | Combine Group Shots |
| Magic Editor, Reimagine, Generative Fill (as a brand) | Edit by Instruction, Generative Fill (generic description) |
| Draw Board (FastStone) | Markup Board |
| Light Table, Batch Queue Manager (digiKam) | Light Table, Batch Queue (generic) |
| Copilot and other assistant brand names | AI tab |
| Content Credentials | used as the C2PA standard's published term |

- No copied help text, sample pictures, effects presets, frames, slideshow music, transitions or icons. Effects are implemented from their mathematical descriptions; presets, frames and sounds are original or openly licensed.
- No reverse engineering of license checks or DRM; no decoding of formats whose only documentation is leaked or decompiled code.

## Nominative use

Anne's Lens's documentation names other products (IrfanView, XnView, FastStone Image Viewer, ACDSee, Windows Photo Viewer, Microsoft Photos, Windows Live Photo Gallery, Picasa, Google Photos, Preview, Apple Photos, iPhoto, digiKam, nomacs, gThumb, Geeqie, ImageGlass, Honeyview, JPEGView, FastPictureViewer, FastRawViewer, Photo Mechanic, Lightroom Classic, PhotoScape, ThumbsPlus, Graphic Workshop, LView Pro, Kodak/Wang Imaging, Photoshop and others) only to identify file formats, plug-in interfaces and menu arrangements, or to credit where an idea came from ("Batch Steps, inspired by IrfanView"). This is nominative use; it does not imply affiliation, sponsorship or endorsement. The names are trademarks of their respective owners, including:

- IrfanView is a trademark of Irfan Skiljan.
- XnView is a trademark of Pierre-Emmanuel Gougelet.
- FastStone is a trademark of FastStone Soft.
- ACDSee is a trademark of ACD Systems International Inc.
- Windows, Microsoft Photos and Windows Live are trademarks of Microsoft Corporation.
- Picasa and Google Photos are trademarks of Google LLC.
- Preview, Photos, iPhoto, Live Text and Visual Look Up are trademarks of Apple Inc.
- Photoshop and Lightroom are trademarks of Adobe Inc.
- Other names belong to their respective owners.

## Third-party components (planned)

The final list will be generated from `package.json` and the WASM build manifests into a third-party notices file at build time, as in the sister apps. Only permissive licenses are accepted in the base app:

| Component | License |
|---|---|
| libjpeg-turbo (WASM build) | IJG / BSD-3-Clause / zlib |
| libpng, zlib | libpng / zlib |
| libwebp, libjxl, dav1d, OpenJPEG | BSD |
| UTIF-style TIFF code and pako | MIT |
| pdf.js (PDF pages, and its image decoders for JPEG 2000 and JBIG2 files and FlashPix's JPEG tiles), with its WebAssembly decoders: OpenJPEG (JPEG 2000), PDFium's JBIG2, qcms, QuickJS | Apache 2.0; BSD-2-Clause; BSD-3-Clause; MIT; MIT |
| ONNX Runtime Web, Transformers.js | MIT, Apache 2.0 |
| tesseract.js and Tesseract | Apache 2.0 |
| SQLite (WASM) | public domain |
| Material Symbols | Apache 2.0 |
| fzstd (Zstandard decoding in TIFF) | MIT |
| jxl-oxide (JPEG XL decoding where the platform has none) | MIT or Apache 2.0 |
| OpenJPH, as Cornerstone's codec-openjph build (OpenEXR HTJ2K compression) | BSD-2-Clause; MIT |
| OpenJPEG, as Cornerstone's codec-openjpeg build (JPEG 2000 pixel data in DICOM files at full precision) | BSD-2-Clause; MIT |
| djvu-rs (DjVu; written from the public DjVu v3 specification, no DjVuLibre code), with the Rust crates linked into its WebAssembly (listed with their licenses in the third-party notices) | MIT; MIT, and the Unicode License v3 (unicode-ident) |
| jSquash AVIF decoder (from Squoosh): libavif, libaom's AV1 decoder, libyuv | Apache 2.0; BSD-2-Clause; BSD-2-Clause with the AOMedia Patent License 1.0; BSD-3-Clause |
| world-atlas (Natural Earth country outlines for the offline map) | ISC; Natural Earth data public domain |
| OpenStreetMap map tiles (online, Browse ▸ Map) | map data © OpenStreetMap contributors, ODbL; credited on the map; tile usage policy followed (identifying User-Agent on the desktop, no bulk downloading) |
| Capacitor, Electron, electron-builder | MIT |
| On-device models | each model's own license, shown before download; permissive for the built-in jobs (MODNet, Depth Anything V2 Small, LaMa, Swin2SR: Apache-2.0; CLIP, YuNet: MIT; SFace: Apache-2.0). The optional picture generator, DeepSeek's Janus-Pro-1B (ONNX from onnx-community), is MIT code with weights under the DeepSeek Model License, which has use restrictions (its Attachment A); it is never bundled or fetched on its own, and the download dialog shows the license for the user to accept. Transformers.js (Apache-2.0) is the runtime, loaded on demand |
| YuNet face detection, SFace face recognition (Browse ▸ People; OpenCV Zoo via huggingface.co/opencv) | MIT; Apache 2.0 |

**Optional modules** (separate downloads, dynamically loaded, license shown first, never required): RAW development (LibRaw, LGPL-2.1 or CDDL-1.0), HEIC decoding where the platform lacks it (libheif LGPL-3.0 with an HEVC decoder; patent notice). Their source and license texts are linked from Help ▸ About, and they can be replaced by the user, as the LGPL requires.

**Not used:** DjVuLibre and djvu.js (GPL; DjVu is read by djvu-rs, MIT), Ghostscript (AGPL), G'MIC and GIMP code (GPL), dcraw-derived GPL code, RARLAB's unRAR code (RAR and CBR archives are read by the app's own decoder, which contains none of it; Anne's Lens does not create RAR archives), non-commercial-only model weights.

## Sample files sent by users

Some formats (CorelDRAW and Corel PHOTO-PAINT today) are recognized but cannot be opened, because no file of the kind was available to build a reader from. When such a file is opened, Anne's Lens offers **Help ▸ Send a Sample File**. The app uploads nothing and has no server: the file leaves the device only through the user's own mail program (the share sheet on phones, otherwise a prepared message the user attaches the file to), addressed to the developer at socrtwo@gmail.com. Before that, the user must tick an agreement to these terms, shown in full in the dialog:

- The sender confirms owning the file, or having the right to share it for this purpose, and that it holds nothing confidential, private or personal they would not want a stranger to see.
- The file is used only to make Anne's Lens read files of its kind (it may be opened with other software and examined byte by byte), kept only as long as that work takes, and never sold, passed on or used for anything else.
- Only if the sender also ticks the public-test-suite permission may the file, or a reduced copy, be published in this repository under the MIT license, where anyone can see, copy and use it; otherwise it stays private and is deleted when the work is done.
- No payment, credit or reply is owed; permission can be withdrawn and deletion asked for at any time by writing to the address above, except for copies already published.

Files kept in the test suite under that permission are listed in this section with the sender's consent noted; none has been received yet. The message also records the sender's program name, notes, and the permissions given.

## Content Credentials

The C2PA manifests the app writes follow the C2PA technical specification (the Coalition for Content Provenance and Authenticity publishes it openly) and the standards it builds on (JUMBF, CBOR, COSE, X.509), implemented in the app's own code and checked against the C2PA reference library (c2pa-python, MIT or Apache 2.0) during development; the library is not shipped. The signing certificate is self-signed on the device, so validators call the signer untrusted while confirming the hashes and signature; the app says the same. No certificate authority, trust list or timestamp service is involved.

## Medical pictures

Anne's Lens opens DICOM files so that people can look at their own scans. It is not a medical device, has not been assessed as one, and shows every DICOM page with the notice that it is for viewing only, not for diagnosis or treatment decisions. The window, rescale and palette are applied as the standard describes (PS3.3 C.11.2 and C.7.6.3), and lossy pixel data is marked as such in the details; nothing is calibrated, and no measurement in the app is a clinical measurement. The patient details the file carries are shown to its holder in the details pane and are never sent anywhere.

## Online services

Anne's Lens works offline. Online services are called only when the user invokes the matching command (sending a sample file goes through the user's own mail program, see above): the chosen AI services (AI tab), model and format-module downloads, map tiles (Browse ▸ Map; OpenStreetMap tile usage policy respected, offline outline or another tile server selectable), Open URL, and update checks (desktop and APK builds, opt-in). The phone remote (desktop) is a server on the local network only, reachable through a random address, and stops when turned off or when the app quits. Picture metadata, including location, is stripped from anything sent to an AI service unless the command needs it.

## Test pictures

The People tests use five official White House portraits from Wikimedia Commons (Barack Obama, Joe Biden, Kamala Harris, and the 2009 and 2012 joint portraits of Obama and Biden). They are works of the United States federal government and in the public domain; `scripts/gen-people-fixtures.py` lists their sources. Face recognition runs only when the user turns People on, only on the device, and its data stays in the app's storage until Forget all faces.

The WMF and EMF test files are made by `scripts/gen-metafile-fixtures.py`: two written record by record by the script, and LibreOffice's own exports of a drawing made for the tests (`drawing.svg`). LibreOffice (MPL 2.0) is used only on the developer's machine to export those files and render the reference pictures; nothing from it ships in the app, whose metafile interpreter is its own code.

The RAR tests use archives from libarchive's test suite (BSD-2-Clause; `tests/fixtures/rar/LICENSE-libarchive`), fetched at a pinned commit by `scripts/gen-rar-fixtures.py`, which also fetches archives made with RAR 1.54 and RAR 2.50 by the rars project (Apache-2.0; `LICENSE-rars`) and one from Python rarfile's tests (ISC; `LICENSE-rarfile`), and writes two stored comic archives of its own. No RAR compressor was used to make any test file.

The DjVu test files are made by `scripts/gen-djvu-fixtures.py` with DjVuLibre's encoders (c44, cjb2, djvumake, djvm, djvused; GPL) and minidjvu (GPL) from pictures the script draws, and the expected pictures are DjVuLibre's own renderings (ddjvu). Those tools run only on the developer's machine; nothing from them ships in the app.

The FlashPix tests use ImageMagick's PerlMagick sample files (ImageMagick License; `tests/fixtures/flashpix/LICENSE-ImageMagick`), made with Kodak's FlashPix toolkit, fetched at a pinned commit by `scripts/gen-flashpix-fixtures.py`; Pillow (with olefile) and libjpeg provide the expected pictures; the view-transform test files are written into copies of them by the script (with `scripts/cfbwrite.py`, a small compound-file writer) from the FlashPix Format Specification (Eastman Kodak, 1996), with expected pictures from numpy for the geometric transforms. The FLI/FLC, clipboard, JBIG and JBIG2 test files are written by `scripts/gen-flic-fixtures.py`, `scripts/gen-clipboard-fixtures.py` and `scripts/gen-jbig-fixtures.py` (the JBIG files with jbigkit's pbmtojbg, GPL), with expected pictures from Pillow, ffmpeg (LGPL/GPL), jbigkit's jbgtopbm and jbig2dec (AGPL). These tools run only on the developer's machine; nothing from them ships in the app. The JBIG decoder is written from ITU-T T.82 itself (the Recommendation is published free of charge by the ITU); its QM-coder probability table and its deterministic-prediction tables are the ones the Recommendation prints, the latter checked against the hit counts it states.

The Paint Shop Pro test files are written by `scripts/gen-psp-fixtures.py` from the PSP file format description (Jasc's specification grants a license to develop software that reads the format), and GIMP's PSP reader (GPL) provides the expected pictures; GIMP runs only on the developer's machine and nothing from it ships in the app.

The icon-library test files are made by `scripts/gen-iconlib-fixtures.py`: resource-only DLLs built with MinGW's binutils (windres, ld; GPL) from icons made with icoutils' icotool (GPL), and a 16-bit icon library written by the script; icoutils' wrestool provides the expected icon files. These tools run only on the developer's machine; nothing from them ships in the app.

The test files for the workstation and home-computer formats and PICT are made by `scripts/gen-historic-fixtures.py`: written by the script from the formats' descriptions, or by ImageMagick, netpbm and Pillow, which also provide the expected pictures (each decodes with its own code: ImageMagick's PICT, Sun and SGI readers, netpbm's rasttopnm, rletopnm, gemtopnm, pi1toppm, pi3topbm, neotoppm and sputoppm, Pillow's MSP reader). These tools run only on the developer's machine; nothing from them ships in the app, whose readers are its own code.

The DICOM test files are, in part, pydicom's test files (MIT; `tests/fixtures/dicom/LICENSE-pydicom`, copied by `scripts/gen-dicom-fixtures.py` from the installed package), which pydicom's authors downsized and cleaned of anything that looks like a real patient name, and in part files the same script writes with pydicom (window/level, MONOCHROME1, signed samples, frames, JPEG and JPEG 2000 made with Pillow, a palette, a raw data set). The expected pictures come from pydicom's pixel decoding (through Pillow, GDCM (BSD), CharLS through pyjpegls (BSD-3-Clause) and pylibjpeg-libjpeg (GPL; used only as a reference decoder on the developer's machine for the 12-bit JPEG) with the standard's display rules applied in the script. The reader was written from the DICOM standard (PS3.5 and PS3.3), not from any decoder's code. The JPEG-LS decoder was written from ITU-T T.87; its test codestreams (`tests/fixtures/jpegls`) are encoded by CharLS through pyjpegls in `scripts/gen-jpegls-fixtures.py`, with CharLS's decoding as the expected samples.

The FITS test files are written by `scripts/gen-fits-fixtures.py` with numpy from the FITS standard, with ImageMagick confirming the display orientation, and the tile-compressed ones by `scripts/gen-fits-tiled-fixtures.py` with astropy (BSD-3-Clause), whose own reading of them gives the expected values. The reader was written from the standard; the tile decoders (Rice, PLIO, H-compress, the dither sequence) from the standard's section 10 and the published algorithms, with CFITSIO (NASA's open-source library, a permissive license) consulted for the exact bit-level conventions and re-expressed in the app's own code. The world coordinate code was written from the WCS papers (Greisen & Calabretta 2002; Calabretta & Greisen 2002; Shupe et al. 2005 for SIP); its test files are written by `scripts/gen-wcs-fixtures.py` with astropy, whose wcslib positions are the expected values.

PPMd (used by 7z and by RAR's text compression) is the app's own implementation of Dmitry Shkarin's PPMd variant H, an algorithm he placed in the public domain. The 7z PPMd test archives are made with py7zr and pyppmd on the developer's machine; nothing from them ships in the app.
