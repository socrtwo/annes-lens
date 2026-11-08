# Test corpus

Every format the app reads is covered by test files, and every test file is one the project may redistribute. There are two layers.

## 1. Fixtures in the repository (`tests/fixtures`, about 12 MB)

Made by the generator scripts in `scripts/gen-*-fixtures.py` from pictures the scripts draw, or taken from permissively licensed test suites with the license file beside them. Each generator also records what a reference implementation reads from the files (expected pictures, sampled values, positions), so the tests compare against another reader, not against the app itself. Regenerate a folder with its script; the scripts name the tools they need.

| Folder | What | Made with / taken from | License of the files |
|---|---|---|---|
| `jpeg`, `png` | baseline and progressive JPEG, every PNG color type and depth | libjpeg, libpng (Pillow) from drawn pictures | MIT (the project's own) |
| `tiff` | fax (RLE, G3, G4), planar, float, CMYK, Lab, ZSTD/LZMA/WebP strips, BigTIFF | libtiff (Pillow, tifffile) | MIT |
| `modern` | JPEG XL, AVIF (lossless, lossy, alpha, animated) | libjxl, libavif | MIT |
| `jpx` | JPEG 2000 (JP2, J2K, tiled, 16-bit, CMYK) and HTJ2K | OpenJPEG, OpenJPH | MIT |
| `exr` | OpenEXR, every compression | the OpenEXR library | MIT |
| `jpegls` | JPEG-LS codestreams, 2–16 bits, every interleave mode, mapping tables | CharLS (pyjpegls); tables injected by hand | MIT (CharLS is BSD-3-Clause) |
| `dicom` | transfer syntaxes, lookup tables, palettes, overlays, presentation states | pydicom's test files (MIT, `LICENSE-pydicom`) and files written with pydicom | MIT |
| `fits` | arrays, cubes, extensions, tile compression, WCS projections | numpy and astropy | MIT |
| `djvu` | IW44, JB2, bundled documents | DjVuLibre's encoders | MIT |
| `pdf` | vector pages, embedded JPEG/JPX/fax | reportlab-style writer; PDFium renders | MIT |
| `metafile` | WMF and EMF | written from the specification; LibreOffice renders | MIT |
| `eps` | DOS EPS previews | written here | MIT |
| `archives`, `rar` | ZIP/7z/tar/xz/bzip2/lzma; RAR 1.5–5.0 | Python's compressors, py7zr; libarchive's test archives (BSD-2-Clause, `LICENSE-libarchive`), rars (Apache-2.0, `LICENSE-rars`), rarfile (ISC, `LICENSE-rarfile`) | as stated |
| `flashpix` | FlashPix | ImageMagick's PerlMagick samples (`LICENSE-ImageMagick`) | ImageMagick License |
| `flic` | Autodesk FLI/FLC | written from the specification; ffmpeg decodes | MIT |
| `clipboard` | Windows .clp | written from the specification | MIT |
| `historic`, `retro` | Sun, SGI, Utah RLE, Atari ST, C64, GEM, MSP, PICT, MacPaint, IFF, Photo CD | ImageMagick, netpbm, written here | MIT |
| `psp` | Paint Shop Pro 5–9+ | written from Jasc's specification; GIMP reads | MIT |
| `iconlib` | icons in PE/NE programs and DLLs | MinGW windres/ld | MIT |
| `jbig` | JBIG (T.82) layers, JBIG2 | jbigkit, jbig2enc | MIT |
| `raw` | synthetic DNG (uncompressed, packed, lossless JPEG) | written here; LibRaw (rawpy) develops | MIT |
| `media` | MP4, MOV, 3GP, WebM, MKV, AVI, Ogg, FLAC, WAV, AIFF, MP3 | ffmpeg; ffprobe describes | MIT |
| `meta`, `color` | EXIF/XMP/IPTC samples, ICC profiles and LittleCMS references | written here; Pillow (LittleCMS) | MIT |
| `people` | portraits for face detection | public-domain White House photographs from Wikimedia Commons | public domain |
| `ai` | tiny ONNX models with the real models' shapes | written here | MIT |

Multipage and animated files are among them (TIFF, PDF, DjVu, GIF, APNG, animated WebP/AVIF/JXL, FLI/FLC, DICOM frames, FITS cubes), and damaged files for the recovery engine are made on the fly in the tests (truncated and corrupted copies in `tests/unit/recovery.test.ts` and the repair tests).

## 2. The downloadable corpus (`tests/corpus`, not committed)

Real camera files are large and belong to their photographers, so they are fetched, not committed, by `scripts/fetch-corpus.py`:

- **Camera RAW** from [raw.pixls.us](https://raw.pixls.us): the smallest sample of each format the app identifies (DNG, NEF, NRW, CR2, CR3, CRW, ARW, SRF, SR2, RAF, ORF, RW2, RWL, PEF, SRW, MRW, ERF, KDC, DCR, MOS, IIQ, X3F, 3FR, FFF…), **CC0 only** (the site also carries CC-BY-NC-SA files; those are skipped, since the project cannot take on their terms), each checked against the site's SHA-256.
- **FITS** sample files of NASA's FITS Support Office (public domain as US government works).
- **Damaged copies** of each (cut short at 60 %, a zeroed 4 KB block, flipped bytes in the second half) for the recovery engine.

`tests/corpus/manifest.json` records every file's URL, license, size and SHA-256. `tests/unit/corpus.test.ts` runs when the manifest is present: every RAW file must be identified as its family and yield an embedded preview; every family the RAW reader supports must read, and where a LibRaw reference exists its sensor values must be identical to LibRaw's at every visible pixel (the full sensor size, the Bayer pattern and the white level are checked too); the refused families must be refused with a reason; every FITS file must decode; every damaged file must either decode or fail with a plain error, within a time limit, never hang or crash. Run `python3 scripts/fetch-corpus.py` (about 400 MB; `--max-mb 8` for a quick subset), then `python3 scripts/fetch-corpus.py --refs` (needs `pip install rawpy numpy`; writes LibRaw's reading of each RAW file to `tests/corpus/ref/*.bin` and `tests/corpus/refs.json`, about 450 MB) and then `npx vitest run tests/unit/corpus.test.ts`.

## Policy

- Nothing enters the repository without the right to redistribute it: generated here, public domain, or a permissive license with its text beside the files.
- No files with people's private information: the DICOM fixtures are anonymized test data, the portraits are official public-domain photographs.
- Samples contributed by users through **Help ▸ Send a Sample File** are used to build readers; they are committed only when the sender has licensed them for it, otherwise a synthetic file is written from what was learned.
