"""TIFF files with the horizontal predictor (Predictor 2) in the forms the reader got wrong, written with tifffile:
16-bit samples in a big-endian file, 32-bit unsigned samples in either byte order, and
the same 32-bit data without the predictor to compare with. pred.png is the 8-bit picture the 16-bit files hold
(their samples are its values times 257).

Run from the repository root:  python3 scripts/gen-tiff-predictor-fixtures.py
Needs numpy, tifffile, imagecodecs, Pillow.
"""
import os
import numpy as np
import tifffile
from PIL import Image

OUT = 'tests/fixtures/tiff'
W, H = 64, 48
rng = np.random.default_rng(11)
y, x = np.mgrid[0:H, 0:W]
rgb = np.stack([(x * 4) % 256, (y * 5 + x) % 256, rng.integers(0, 256, size=(H, W))], -1).astype(np.uint8)
Image.fromarray(rgb).save(os.path.join(OUT, 'pred.png'))
rgb16 = rgb.astype(np.uint16) * 257
tifffile.imwrite(os.path.join(OUT, 'pred-be16.tif'), rgb16, photometric='rgb', compression='zlib', predictor=True, byteorder='>')
tifffile.imwrite(os.path.join(OUT, 'pred-le16.tif'), rgb16, photometric='rgb', compression='zlib', predictor=True, byteorder='<')
# 32-bit unsigned heights (a ramp with noise, values past 2^16 so every byte of a sample matters).
gray32 = (x.astype(np.uint32) * 70000 + y.astype(np.uint32) * 1300 + rng.integers(0, 5000, size=(H, W)).astype(np.uint32))
for order, name in (('<', 'le'), ('>', 'be')):
    tifffile.imwrite(os.path.join(OUT, f'pred-{name}32.tif'), gray32, photometric='minisblack', compression='zlib', predictor=True, byteorder=order)
tifffile.imwrite(os.path.join(OUT, 'nopred-le32.tif'), gray32, photometric='minisblack', compression='zlib', byteorder='<')
for n in ['pred-be16.tif', 'pred-le16.tif', 'pred-le32.tif', 'pred-be32.tif', 'nopred-le32.tif']:
    with tifffile.TiffFile(os.path.join(OUT, n)) as t:
        p = t.pages[0]
        print(n, t.byteorder, p.dtype, p.predictor, p.compression, np.array_equal(p.asarray(), rgb16 if '16' in n else gray32))
