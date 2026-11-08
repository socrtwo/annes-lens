"""DICOM test fixtures: a selection of pydicom's test files (MIT; see tests/fixtures/dicom/LICENSE-pydicom) covering the
transfer syntaxes and pixel layouts, plus files written here with pydicom (window/level, MONOCHROME1, signed samples,
multiple frames, encapsulated JPEG and JPEG 2000 made with Pillow, a palette, a raw dataset without the Part 10 header).
The expected pictures are 8-bit PNGs computed from pydicom's pixel decoding (Pillow, GDCM and pylibjpeg as decoders)
with the display rules of the standard (PS3.3 C.11.2.1.2: the LINEAR window function; MONOCHROME1 inverted; the full
range of the frame when no window is given; PALETTE COLOR through its lookup tables).

Run from the repository root:  python3 scripts/gen-dicom-fixtures.py
"""
import io, json, os, shutil
import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import ExplicitVRLittleEndian, ImplicitVRLittleEndian, JPEGBaseline8Bit, JPEG2000Lossless, RLELossless, JPEGLSLossless, JPEGLSNearLossless, generate_uid
from pydicom.sequence import Sequence
from pydicom.pixels import apply_color_lut, apply_modality_lut, apply_voi_lut, apply_voi
import jpeg_ls
from PIL import Image

OUT = 'tests/fixtures/dicom'
PYD = os.path.join(os.path.dirname(pydicom.__file__), 'data', 'test_files')
os.makedirs(OUT, exist_ok=True)

# pydicom's files: (name, what it covers)
PYDICOM_FILES = [
    ('CT_small.dcm', 'explicit VR LE, 16-bit signed CT with a rescale and no window'),
    ('MR_small.dcm', 'explicit VR LE, 16-bit MR with a window'),
    ('MR_small_implicit.dcm', 'implicit VR LE'),
    ('MR_small_bigendian.dcm', 'explicit VR big endian'),
    ('MR_small_RLE.dcm', 'RLE lossless, 16 bits'),
    ('MR_small_jp2klossless.dcm', 'JPEG 2000 lossless, 16 bits'),
    ('MR_small_jpeg_ls_lossless.dcm', 'JPEG-LS lossless, 16 bits, LSE presets'),
    ('JPEGLSNearLossless_08.dcm', 'JPEG-LS near-lossless, 8 bits'),
    ('JPEGLSNearLossless_16.dcm', 'JPEG-LS near-lossless, 16 bits, LSE presets'),
    ('SC_rgb_jls_lossy_line.dcm', 'JPEG-LS near-lossless, RGB line interleaved'),
    ('SC_rgb_jls_lossy_sample.dcm', 'JPEG-LS near-lossless, RGB sample interleaved'),
    ('examples_overlay.dcm', '12-bit with an overlay plane (separate data)'),
    ('693_J2KI.dcm', 'JPEG 2000 lossy, 14 bits stored, CT window'),
    ('image_dfl.dcm', 'deflated explicit VR LE, 8 bits'),
    ('JPGExtended.dcm', 'JPEG extended (process 2 and 4), 12 bits'),
    ('SC_rgb_jpeg_gdcm.dcm', 'JPEG lossless (process 14, SV1), RGB'),
    ('SC_rgb_dcmtk_+eb+cy+np.dcm', 'JPEG baseline, YBR_FULL_422'),
    ('SC_rgb_dcmtk_+eb+cr.dcm', 'JPEG baseline, RGB without a color transform'),
    ('SC_rgb_jpeg.dcm', 'JPEG baseline, labelled RGB but YCbCr-coded with a JFIF header'),
    ('SC_rgb_rle_16bit_2frame.dcm', 'RLE lossless, RGB 16 bits, 2 frames'),
    ('SC_rgb_small_odd.dcm', 'RGB with an odd row length (padding)'),
    ('SC_ybr_full_422_uncompressed.dcm', 'uncompressed YBR_FULL_422'),
    ('ExplVR_BigEnd.dcm', 'explicit VR big endian, RGB'),
    ('examples_palette.dcm', 'PALETTE COLOR, 16-bit lookup tables'),
    ('liver_1frame.dcm', '1 bit per pixel (a segmentation)'),
    ('rtdose.dcm', '32-bit unsigned, 15 frames, implicit VR'),
]


def window(values, center, width, fn='LINEAR'):
    """PS3.3 C.11.2.1.2.1 (LINEAR and LINEAR_EXACT) and C.11.2.1.3.1 (SIGMOID), to 0..255."""
    x = values.astype(np.float64)
    if fn == 'SIGMOID':
        return np.clip(np.round(255 / (1 + np.exp(-4 * (x - center) / width))), 0, 255)
    if fn == 'LINEAR_EXACT':
        lo, hi = center - width / 2, center + width / 2
        y = (x - lo) / width * 255
    else:
        lo, hi = center - 0.5 - (width - 1) / 2, center - 0.5 + (width - 1) / 2
        y = ((x - (center - 0.5)) / (width - 1) + 0.5) * 255
    y = np.where(x <= lo, 0, np.where(x > hi, 255, y))
    return np.clip(np.round(y), 0, 255)


def first(v):
    return float(v[0]) if isinstance(v, pydicom.multival.MultiValue) else float(v)


def expected_frames(ds, arr):
    """8-bit pictures (H×W×3 uint8) for every frame, by the app's display rules."""
    pi = ds.PhotometricInterpretation
    frames = int(ds.get('NumberOfFrames', 1) or 1)
    if arr.ndim == 2 or (arr.ndim == 3 and pi in ('RGB', 'YBR_FULL', 'YBR_FULL_422', 'PALETTE COLOR') and arr.shape[-1] == 3 and frames == 1):
        arr = arr[None]
    out = []
    for f in range(frames):
        a = arr[f]
        if pi == 'PALETTE COLOR':
            rgb = apply_color_lut(a, ds)
            if rgb.dtype != np.uint8:
                rgb = np.round(rgb.astype(np.float64) * 255 / 65535).astype(np.uint8)
            out.append(rgb)
            continue
        if pi.startswith('MONOCHROME'):
            v = apply_modality_lut(a, ds).astype(np.float64) if 'ModalityLUTSequence' in ds else a.astype(np.float64)
            if 'ModalityLUTSequence' not in ds and 'RescaleSlope' in ds and 'RescaleIntercept' in ds:
                v = v * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
            if 'VOILUTSequence' in ds:  # the app prefers the file's lookup table and scales its output by the table's largest entry
                item = ds.VOILUTSequence[0]
                lut = np.frombuffer(item.LUTData, '<u2' if int(item.LUTDescriptor[2]) > 8 or len(item.LUTData) >= 2 * (int(item.LUTDescriptor[0]) or 65536) else np.uint8)
                firstv = int(item.LUTDescriptor[1]); firstv = firstv - 65536 if firstv > 32767 else firstv
                idx = np.clip(np.round(v).astype(np.int64) - firstv, 0, len(lut) - 1)
                y = np.round(lut[idx].astype(np.float64) / max(1, int(lut.max())) * 255)
            elif 'WindowCenter' in ds and 'WindowWidth' in ds and ds.WindowCenter is not None and ds.WindowWidth is not None and first(ds.WindowWidth) >= 1:
                y = window(v, first(ds.WindowCenter), first(ds.WindowWidth), str(ds.get('VOILUTFunction', 'LINEAR') or 'LINEAR'))
            else:
                lo, hi = v.min(), v.max()
                y = np.zeros_like(v) if hi <= lo else np.round((v - lo) / (hi - lo) * 255)
            if pi == 'MONOCHROME1':
                y = 255 - y
            g = y.astype(np.uint8)
            rgb = np.stack([g, g, g], -1)
            for group in range(0x6000, 0x6020, 2):
                if (group, 0x3000) in ds or (group, 0x0010) in ds:
                    if (group, 0x3000) in ds:
                        ov = ds.overlay_array(group)
                    else:  # embedded in the pixel words (retired): the bit at Overlay Bit Position
                        words = np.frombuffer(ds.PixelData, '<u2').reshape(-1, int(ds.Rows), int(ds.Columns))
                        ov = ((words[f] >> int(ds[group, 0x0102].value)) & 1).astype(np.uint8)
                    if ov.ndim == 3:
                        ov = ov[f] if f < ov.shape[0] else np.zeros(ov.shape[1:], np.uint8)
                    r0, c0 = [int(x) - 1 for x in ds[group, 0x0050].value]
                    for oy in range(ov.shape[0]):
                        yy = oy + r0
                        if 0 <= yy < rgb.shape[0]:
                            xs = np.nonzero(ov[oy])[0] + c0
                            xs = xs[(xs >= 0) & (xs < rgb.shape[1])]
                            rgb[yy, xs] = 255
            out.append(rgb)
            continue
        out.append(a.astype(np.uint8) if a.dtype == np.uint8 else (a.astype(np.uint32) * 255 // ((1 << int(ds.BitsStored)) - 1)).astype(np.uint8))
    return out


def save_expected(name, ds, arr):
    ex = expected_frames(ds, arr)
    base = name[:-4]
    for i, rgb in enumerate(ex):
        if len(ex) > 1 and i not in (0, len(ex) - 1):
            continue
        Image.fromarray(rgb, 'RGB').save(os.path.join(OUT, f'{base}.f{i}.png' if len(ex) > 1 else f'{base}.png'), optimize=True)
    return {'frames': len(ex), 'width': int(ex[0].shape[1]), 'height': int(ex[0].shape[0]), 'pi': ds.PhotometricInterpretation, 'ts': str(ds.file_meta.TransferSyntaxUID) if hasattr(ds, 'file_meta') and 'TransferSyntaxUID' in ds.file_meta else None, 'comment': str(ds.get('ImageComments', ''))}


manifest = {}
rng = np.random.default_rng(11)
for name, what in PYDICOM_FILES:
    shutil.copyfile(os.path.join(PYD, name), os.path.join(OUT, name))
    ds = pydicom.dcmread(os.path.join(OUT, name))
    manifest[name] = {'what': what, **save_expected(name, ds, ds.pixel_array)}


def base_ds(ts, rows, cols, pi, samples=1, bits=16, stored=None, signed=0, frames=1):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ts
    ds.file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.7'  # Secondary Capture
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid(entropy_srcs=[str(rows), str(cols), pi, str(ts), str(frames)])
    ds.SOPClassUID = ds.file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
    ds.SpecificCharacterSet = 'ISO_IR 192'
    ds.PatientName = 'Lens^Anne'
    ds.PatientID = 'AL-0001'
    ds.StudyDate = '20240311'
    ds.Modality = 'OT'
    ds.Manufacturer = "Anne's Lens test fixtures"
    ds.Rows, ds.Columns = rows, cols
    ds.SamplesPerPixel = samples
    ds.PhotometricInterpretation = pi
    if samples == 3:
        ds.PlanarConfiguration = 0
    ds.BitsAllocated = bits
    ds.BitsStored = stored or bits
    ds.HighBit = ds.BitsStored - 1
    ds.PixelRepresentation = signed
    if frames > 1:
        ds.NumberOfFrames = frames
    return ds


def gradient(rows, cols, scale, offset=0):
    yy, xx = np.mgrid[0:rows, 0:cols]
    return (offset + (xx * 3 + yy * 7) * scale).astype(np.int64)


def write(name, ds, arr=None, **save):
    path = os.path.join(OUT, name)
    ds.save_as(path, enforce_file_format=True, **save)
    back = pydicom.dcmread(path)
    manifest[name] = {'what': ds.get('ImageComments', ''), **save_expected(name, back, back.pixel_array)}


# A CT-like picture: 12 bits stored in 16, unsigned, rescale to Hounsfield units, a window (center 40, width 400),
# a second window pair after the first (only the first is used).
ds = base_ds(ExplicitVRLittleEndian, 32, 48, 'MONOCHROME2', bits=16, stored=12)
ds.Modality = 'CT'
ds.ImageComments = '12 bits stored, rescale and a window; two window pairs'
px = np.clip(gradient(32, 48, 12, 700), 0, 4095)
px[8:24, 16:32] = 1064 + 200  # a bright block (+200 HU)
px[12:20, 20:28] = 1064 - 300
ds.PixelData = px.astype('<u2').tobytes()
ds.RescaleIntercept, ds.RescaleSlope = -1024, 1
ds.WindowCenter, ds.WindowWidth = [40, 300], [400, 1500]
ds.WindowCenterWidthExplanation = ['SOFT TISSUE', 'BONE']
ds.PixelSpacing = [0.5, 0.5]
ds.SliceThickness = 2.5
ds.BodyPartExamined = 'CHEST'
ds.StudyDescription = 'Fixture study'
write('ct-window.dcm', ds)

# MONOCHROME1 8-bit without a window: full range, inverted.
ds = base_ds(ExplicitVRLittleEndian, 20, 40, 'MONOCHROME1', bits=8)
ds.ImageComments = 'MONOCHROME1, 8 bits, no window (full range, inverted)'
px = np.clip(gradient(20, 40, 1, 40), 0, 200)
ds.PixelData = px.astype(np.uint8).tobytes()
write('mono1.dcm', ds)

# Signed 16-bit samples, implicit VR, no window; also as RLE.
ds = base_ds(ImplicitVRLittleEndian, 24, 36, 'MONOCHROME2', bits=16, signed=1)
ds.ImageComments = 'signed 16-bit samples, implicit VR, no window'
px = gradient(24, 36, 9, -600)
ds.PixelData = px.astype('<i2').tobytes()
write('signed16-implicit.dcm', ds)
ds2 = pydicom.dcmread(os.path.join(OUT, 'signed16-implicit.dcm'))
ds2.ImageComments = 'signed 16-bit samples, RLE lossless'
ds2.compress(RLELossless, encoding_plugin='pydicom')
write('signed16-rle.dcm', ds2)

# Four 8-bit frames with a window; also as RLE.
ds = base_ds(ExplicitVRLittleEndian, 16, 24, 'MONOCHROME2', bits=8, frames=4)
ds.ImageComments = 'four 8-bit frames with a window'
fr = [np.clip(gradient(16, 24, 2, 20 * f), 0, 255).astype(np.uint8) for f in range(4)]
for f in range(4):
    fr[f][2 + f * 3:6 + f * 3, 4:20] = 255
ds.PixelData = b''.join(a.tobytes() for a in fr)
ds.WindowCenter, ds.WindowWidth = 128, 200
write('frames.dcm', ds)
ds2 = pydicom.dcmread(os.path.join(OUT, 'frames.dcm'))
ds2.ImageComments = 'four 8-bit frames, RLE lossless'
ds2.compress(RLELossless, encoding_plugin='pydicom')
write('frames-rle.dcm', ds2)

# JPEG baseline: one grayscale frame; two YBR_FULL_422 color frames with an offset table.
ds = base_ds(JPEGBaseline8Bit, 40, 56, 'MONOCHROME2', bits=8)
ds.ImageComments = 'JPEG baseline, one grayscale frame'
g = np.clip(gradient(40, 56, 1, 30), 0, 255).astype(np.uint8)
b = io.BytesIO(); Image.fromarray(g, 'L').save(b, format='JPEG', quality=92)
ds.PixelData = encapsulate([b.getvalue()])
ds['PixelData'].VR = 'OB'
write('jpeg-gray.dcm', ds)

ds = base_ds(JPEGBaseline8Bit, 32, 48, 'YBR_FULL_422', samples=3, bits=8, frames=2)
ds.ImageComments = 'JPEG baseline, two color frames (YBR_FULL_422), with a basic offset table'
frames = []
for f in range(2):
    rgb = np.zeros((32, 48, 3), np.uint8)
    rgb[..., 0] = np.clip(gradient(32, 48, 1, 20 + 60 * f), 0, 255)
    rgb[..., 1] = 90 + 40 * f
    rgb[..., 2] = np.clip(255 - gradient(32, 48, 1, 0), 0, 255)
    b = io.BytesIO(); Image.fromarray(rgb, 'RGB').save(b, format='JPEG', quality=95, subsampling='4:2:2')
    frames.append(b.getvalue())
ds.PixelData = encapsulate(frames, has_bot=True)
ds['PixelData'].VR = 'OB'
write('jpeg-color-frames.dcm', ds)

# JPEG 2000 lossless, 16-bit allocated 12 stored, with a window: the decoder reduces the samples to 8 bits.
ds = base_ds(JPEG2000Lossless, 24, 32, 'MONOCHROME2', bits=16, stored=12)
ds.ImageComments = 'JPEG 2000 lossless, 12 bits stored, with a window'
px = np.clip(gradient(24, 32, 20, 100), 0, 4095).astype('<u2')
b = io.BytesIO(); Image.fromarray(px).save(b, format='JPEG2000', no_jp2=True, irreversible=False)
ds.PixelData = encapsulate([b.getvalue()])
ds['PixelData'].VR = 'OB'
ds.WindowCenter, ds.WindowWidth = 2000, 3000
write('j2k-12bit.dcm', ds)

# A palette: 8-bit indices, 16-bit lookup tables (the common layout), 64 entries starting at index 0.
ds = base_ds(ExplicitVRLittleEndian, 16, 64, 'PALETTE COLOR', bits=8)
ds.ImageComments = 'PALETTE COLOR, 8-bit indices, 16-bit lookup tables'
idx = np.tile(np.arange(64, dtype=np.uint8), (16, 1))
ds.PixelData = idx.tobytes()
n = 64
ds.RedPaletteColorLookupTableDescriptor = [n, 0, 16]
ds.GreenPaletteColorLookupTableDescriptor = [n, 0, 16]
ds.BluePaletteColorLookupTableDescriptor = [n, 0, 16]
ds.RedPaletteColorLookupTableData = np.array([i * 1040 for i in range(n)], '<u2').tobytes()
ds.GreenPaletteColorLookupTableData = np.array([65535 - i * 1040 for i in range(n)], '<u2').tobytes()
ds.BluePaletteColorLookupTableData = np.array([(i * 4111) % 65536 for i in range(n)], '<u2').tobytes()
write('palette8.dcm', ds)

# JPEG-LS written with CharLS (pyjpegls): 12-bit near-lossless with a window, and RGB in separate scans (planar).
ds = base_ds(JPEGLSNearLossless, 28, 36, 'MONOCHROME2', bits=16, stored=12)
ds.ImageComments = 'JPEG-LS near-lossless (error 2), 12 bits stored, with a window'
px = np.clip(gradient(28, 36, 20, 100), 0, 4095)
px[10:18, 12:24] = 3000
px[20:, :] += rng.integers(0, 300, size=(8, 36))
px = np.clip(px, 0, 4095).astype('<u2')
ds.PixelData = encapsulate([bytes(jpeg_ls.encode_array(px, lossy_error=2))])
ds['PixelData'].VR = 'OB'
ds.WindowCenter, ds.WindowWidth = 2000, 3000
write('jls-12bit-near.dcm', ds)

ds = base_ds(JPEGLSLossless, 20, 26, 'RGB', samples=3, bits=8)
ds.ImageComments = 'JPEG-LS lossless, RGB in separate scans (planar configuration 1)'
ds.PlanarConfiguration = 1
rgb = np.zeros((3, 20, 26), np.uint8)
rgb[0] = np.clip(gradient(20, 26, 1, 30), 0, 255); rgb[1] = 120; rgb[2] = np.clip(255 - gradient(20, 26, 2, 0), 0, 255)
rgb[:, 5:9, 4:20] = 250
rgb[1, 12:, :] = rng.integers(0, 256, size=(8, 26))
ds.PixelData = encapsulate([bytes(jpeg_ls.encode_array(rgb, lossy_error=0, interleave_mode=0))])
ds['PixelData'].VR = 'OB'
write('jls-rgb-planar.dcm', ds)

# Lookup tables: a modality LUT (a square-root curve) and a VOI LUT (an inverse-gamma curve) on 12-bit data; and a VOI LUT beside a window.
ds = base_ds(ExplicitVRLittleEndian, 24, 40, 'MONOCHROME2', bits=16, stored=12)
ds.ImageComments = 'a Modality LUT Sequence and a VOI LUT Sequence (the LUT is used, not the window)'
px = np.clip(gradient(24, 40, 14, 0), 0, 4095).astype('<u2')
ds.PixelData = px.tobytes()
item = Dataset(); item.LUTDescriptor = [4096, 0, 16]
item.LUTData = np.round(np.sqrt(np.arange(4096) / 4095) * 4095).astype('<u2').tobytes(); item.LUTExplanation = 'square root'
ds.ModalityLUTSequence = Sequence([item]); ds.ModalityLUTType = 'US'
item = Dataset(); item.LUTDescriptor = [2048, 1024, 16]
item.LUTData = np.round(((np.arange(2048) / 2047) ** 2.2) * 60000).astype('<u2').tobytes(); item.LUTExplanation = 'gamma 2.2'
ds.VOILUTSequence = Sequence([item])
ds.WindowCenter, ds.WindowWidth = 2000, 1000
write('luts.dcm', ds)

# An overlay plane in its own element (a frame around a block), and one embedded in the unused high bits of 12-in-16 pixel words.
ds = base_ds(ExplicitVRLittleEndian, 30, 44, 'MONOCHROME2', bits=8)
ds.ImageComments = 'an overlay plane (Overlay Data) with an origin inside the picture'
ds.PixelData = np.clip(gradient(30, 44, 1, 40), 0, 255).astype(np.uint8).tobytes()
ov = np.zeros((16, 20), np.uint8); ov[0, :] = 1; ov[-1, :] = 1; ov[:, 0] = 1; ov[:, -1] = 1; ov[8, 4:16] = 1
packed = np.packbits(ov.reshape(-1), bitorder='little')
ds.add_new((0x6000, 0x0010), 'US', 16); ds.add_new((0x6000, 0x0011), 'US', 20); ds.add_new((0x6000, 0x0040), 'CS', 'G')
ds.add_new((0x6000, 0x0050), 'SS', [6, 12]); ds.add_new((0x6000, 0x0100), 'US', 1); ds.add_new((0x6000, 0x0102), 'US', 0)
ds.add_new((0x6000, 0x3000), 'OW', packed.tobytes() + (b'\0' if len(packed) % 2 else b''))
write('overlay.dcm', ds)

ds = base_ds(ExplicitVRLittleEndian, 20, 24, 'MONOCHROME2', bits=16, stored=12)
ds.ImageComments = 'an overlay plane embedded in bit 15 of the pixel words (retired encoding)'
px = np.clip(gradient(20, 24, 12, 0), 0, 4095).astype(np.uint16)
ov = np.zeros((20, 24), np.uint16); ov[3:17, 3] = 1; ov[3, 3:21] = 1; ov[10, 3:21] = 1
ds.PixelData = (px | (ov << 15)).astype('<u2').tobytes()
ds.add_new((0x6000, 0x0010), 'US', 20); ds.add_new((0x6000, 0x0011), 'US', 24); ds.add_new((0x6000, 0x0040), 'CS', 'G')
ds.add_new((0x6000, 0x0050), 'SS', [1, 1]); ds.add_new((0x6000, 0x0100), 'US', 16); ds.add_new((0x6000, 0x0102), 'US', 15)
write('overlay-embedded.dcm', ds)

# Segmented palettes (PS3.3 C.7.9.2): the standard WINTER palette's segments (8-bit entries, from pydicom's copy of the
# standard's palettes), and an own 16-bit one with discrete, linear and indirect segments.
PAL = os.path.join(os.path.dirname(pydicom.__file__), 'data', 'palettes')
winter = pydicom.dcmread(os.path.join(PAL, 'winter.dcm'))
ds = base_ds(ExplicitVRLittleEndian, 8, 64, 'PALETTE COLOR', bits=8)
ds.ImageComments = 'PALETTE COLOR with the segmented WINTER palette (8-bit entries)'
ds.PixelData = np.tile(np.arange(0, 256, 4, dtype=np.uint8), (8, 1)).tobytes()
for tag in [(0x28, 0x1101), (0x28, 0x1102), (0x28, 0x1103), (0x28, 0x1221), (0x28, 0x1222), (0x28, 0x1223)]:
    ds.add(winter[tag])
write('palette-segmented-winter.dcm', ds)

ds = base_ds(ExplicitVRLittleEndian, 6, 128, 'PALETTE COLOR', bits=8)
ds.ImageComments = 'PALETTE COLOR with a 16-bit segmented palette: discrete, linear and indirect segments'
ds.PixelData = np.tile(np.arange(0, 256, 2, dtype=np.uint8), (6, 1)).tobytes()
def seg16(discrete, linear_pairs, indirect=None):
    words = []
    words += [0, len(discrete)] + list(discrete)                      # opcode 0: discrete values
    for n, y in linear_pairs:
        words += [1, n, y]                                             # opcode 1: n values climbing to y
    if indirect is not None:
        n, offset = indirect
        words += [2, n, offset & 0xFFFF, offset >> 16]                 # opcode 2: n segments repeated from word offset
    return np.array(words, '<u2').tobytes()
ds.RedPaletteColorLookupTableDescriptor = [256, 0, 16]
ds.GreenPaletteColorLookupTableDescriptor = [256, 0, 16]
ds.BluePaletteColorLookupTableDescriptor = [256, 0, 16]
# red: 16 discrete, then 112 linear to 65535, then 128 linear down to 0 → 256 entries
ds.add_new((0x28, 0x1221), 'OW', seg16([i * 1000 for i in range(16)], [(112, 65535), (128, 0)]))
# green: 8 discrete, 120 linear to 30000, then the same two segments again by an indirect reference (offset 0: the start), 
ds.add_new((0x28, 0x1222), 'OW', seg16([5000] * 8, [(120, 30000)], indirect=(2, 0)))
# blue: 256 linear to 65535 from an initial discrete 0
ds.add_new((0x28, 0x1223), 'OW', seg16([0], [(255, 65535)]))
write('palette-segmented16.dcm', ds)

# Grayscale softcopy presentation states referencing ct-window.dcm: one with a window, an inverse presentation LUT, a
# rectangular shutter, a displayed area and a spatial transformation (its expected picture computed here); one with
# graphic annotations and text (checked pixel by pixel in the tests); one referencing a missing image.
img = pydicom.dcmread(os.path.join(OUT, 'ct-window.dcm'))
def gsps(name, comment):
    ps = Dataset()
    ps.file_meta = FileMetaDataset()
    ps.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ps.file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.11.1'
    ps.file_meta.MediaStorageSOPInstanceUID = generate_uid(entropy_srcs=[name])
    ps.SOPClassUID = ps.file_meta.MediaStorageSOPClassUID
    ps.SOPInstanceUID = ps.file_meta.MediaStorageSOPInstanceUID
    ps.SpecificCharacterSet = 'ISO_IR 192'
    ps.PatientName = img.PatientName; ps.PatientID = img.PatientID; ps.StudyDate = img.StudyDate
    ps.Modality = 'PR'; ps.ContentLabel = 'FIXTURE'; ps.ContentDescription = comment; ps.PresentationCreationDate = '20240312'; ps.PresentationCreationTime = '101500'
    ps.ImageComments = comment
    ref = Dataset(); ref.ReferencedSOPClassUID = img.SOPClassUID; ref.ReferencedSOPInstanceUID = img.SOPInstanceUID
    series = Dataset(); series.SeriesInstanceUID = generate_uid(entropy_srcs=['series']); series.ReferencedImageSequence = Sequence([ref])
    ps.ReferencedSeriesSequence = Sequence([series])
    return ps, ref

ps, ref = gsps('gsps.dcm', 'window 100/600, inverse presentation LUT, rectangular shutter, displayed area, rotation 90 and horizontal flip')
voi = Dataset(); voi.WindowCenter = 100; voi.WindowWidth = 600; voi.ReferencedImageSequence = Sequence([ref])
ps.SoftcopyVOILUTSequence = Sequence([voi])
ps.PresentationLUTShape = 'INVERSE'
ps.ShutterShape = 'RECTANGULAR'; ps.ShutterLeftVerticalEdge = 5; ps.ShutterRightVerticalEdge = 44; ps.ShutterUpperHorizontalEdge = 3; ps.ShutterLowerHorizontalEdge = 29; ps.ShutterPresentationValue = 0x3000
area = Dataset(); area.DisplayedAreaTopLeftHandCorner = [3, 2]; area.DisplayedAreaBottomRightHandCorner = [46, 31]; area.PresentationSizeMode = 'SCALE TO FIT'; area.ReferencedImageSequence = Sequence([ref])
ps.DisplayedAreaSelectionSequence = Sequence([area])
ps.ImageHorizontalFlip = 'Y'; ps.ImageRotation = 90
ps.save_as(os.path.join(OUT, 'gsps.dcm'), enforce_file_format=True)
# the expected picture, by the rules the app applies: window → inverse → shutter → displayed area → flip, then rotation
raw = img.pixel_array.astype(np.float64) * float(img.RescaleSlope) + float(img.RescaleIntercept)
y = 255 - window(raw, 100, 600)
sh = np.full_like(y, (0x3000 >> 8))
sh[3 - 1:29, 5 - 1:44] = y[3 - 1:29, 5 - 1:44]           # edges are 1-based pixel columns/rows, inclusive
crop = sh[2 - 1:31, 3 - 1:46]                              # TLHC (col 3, row 2) to BRHC (col 46, row 31), 1-based inclusive
flipped = crop[:, ::-1]
rot = np.rot90(flipped, k=-1)                              # 90° clockwise
g = rot.astype(np.uint8)
Image.fromarray(np.stack([g, g, g], -1), 'RGB').save(os.path.join(OUT, 'gsps.png'), optimize=True)
manifest['gsps.dcm'] = {'what': 'presentation state: ' + ps.ContentDescription, 'frames': 1, 'width': int(g.shape[1]), 'height': int(g.shape[0]), 'pi': 'MONOCHROME2', 'ts': str(ps.file_meta.TransferSyntaxUID), 'comment': ps.ContentDescription, 'references': 'ct-window.dcm'}

ps, ref = gsps('gsps-annot.dcm', 'graphic annotations: a filled rectangle, a circle, an ellipse, a point, text with an anchor')
layer = Dataset(); layer.GraphicLayer = 'MARKS'; layer.GraphicLayerOrder = 1; layer.GraphicLayerRecommendedDisplayGrayscaleValue = 0xC000
ps.GraphicLayerSequence = Sequence([layer])
ann = Dataset(); ann.GraphicLayer = 'MARKS'; ann.ReferencedImageSequence = Sequence([ref])
def gobj(kind, pts, filled='N'):
    g = Dataset(); g.GraphicAnnotationUnits = 'PIXEL'; g.GraphicDimensions = 2; g.NumberOfGraphicPoints = len(pts) // 2; g.GraphicData = [float(v) for v in pts]; g.GraphicType = kind
    if kind in ('POLYLINE', 'CIRCLE', 'ELLIPSE'): g.GraphicFilled = filled
    return g
ann.GraphicObjectSequence = Sequence([
    gobj('POLYLINE', [4, 4, 14, 4, 14, 12, 4, 12, 4, 4], 'Y'),   # a filled rectangle, columns 4–14, rows 4–12
    gobj('CIRCLE', [30, 10, 36, 10]),                            # center (30, 10), radius 6
    gobj('ELLIPSE', [20, 26, 44, 26, 32, 22, 32, 30]),           # major axis 20..44 at row 26, minor 22..30
    gobj('POINT', [2, 30]),
    gobj('INTERPOLATED', [16, 18, 20, 14, 24, 18]),
])
t = Dataset(); t.BoundingBoxAnnotationUnits = 'PIXEL'; t.AnchorPointAnnotationUnits = 'PIXEL'; t.UnformattedTextValue = 'Lesion'; t.AnchorPoint = [30.0, 10.0]; t.AnchorPointVisibility = 'Y'
t.BoundingBoxTopLeftHandCorner = [18.0, 1.0]; t.BoundingBoxBottomRightHandCorner = [46.0, 7.0]; t.BoundingBoxTextHorizontalJustification = 'LEFT'
ann.TextObjectSequence = Sequence([t])
ps.GraphicAnnotationSequence = Sequence([ann])
ps.save_as(os.path.join(OUT, 'gsps-annot.dcm'), enforce_file_format=True)
manifest['gsps-annot.dcm'] = {'what': 'presentation state: ' + ps.ContentDescription, 'frames': 1, 'width': 48, 'height': 32, 'pi': 'MONOCHROME2', 'ts': str(ps.file_meta.TransferSyntaxUID), 'comment': ps.ContentDescription, 'references': 'ct-window.dcm', 'annotations': True}

# A pseudo-color softcopy presentation state (PS3.3 A.33.4): the WINTER palette applied to the windowed values.
ps, ref = gsps('pcsps.dcm', 'pseudo-color: window 100/600 through the segmented WINTER palette')
ps.file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.11.3'; ps.SOPClassUID = ps.file_meta.MediaStorageSOPClassUID
voi = Dataset(); voi.WindowCenter = 100; voi.WindowWidth = 600; voi.ReferencedImageSequence = Sequence([ref])
ps.SoftcopyVOILUTSequence = Sequence([voi])
ps.PresentationLUTShape = 'IDENTITY'
for tag in [(0x28, 0x1101), (0x28, 0x1102), (0x28, 0x1103), (0x28, 0x1221), (0x28, 0x1222), (0x28, 0x1223)]:
    ps.add(winter[tag])
ps.save_as(os.path.join(OUT, 'pcsps.dcm'), enforce_file_format=True)
raw = img.pixel_array.astype(np.float64) * float(img.RescaleSlope) + float(img.RescaleIntercept)
y = window(raw, 100, 600).astype(np.uint8)
rgb = apply_color_lut(y, winter)
rgb = (rgb if rgb.dtype == np.uint8 else np.round(rgb.astype(np.float64) * 255 / 65535)).astype(np.uint8)
Image.fromarray(rgb, 'RGB').save(os.path.join(OUT, 'pcsps.png'), optimize=True)
manifest['pcsps.dcm'] = {'what': 'presentation state: ' + ps.ContentDescription, 'frames': 1, 'width': int(rgb.shape[1]), 'height': int(rgb.shape[0]), 'pi': 'MONOCHROME2', 'ts': str(ps.file_meta.TransferSyntaxUID), 'comment': ps.ContentDescription, 'references': 'ct-window.dcm'}

# A blending softcopy presentation state (PS3.3 A.33.5, C.11.14): a second picture (a "PET" blob of the same size) windowed,
# through the WINTER palette, over the CT at opacity 0.6. Its expected picture is computed here.
pet = base_ds(ExplicitVRLittleEndian, 32, 48, 'MONOCHROME2', bits=16)
pet.Modality = 'PT'; pet.ImageComments = 'a blob for the blending presentation state'
yy, xx = np.mgrid[0:32, 0:48]
blob = np.round(3000 * np.exp(-(((xx - 30) ** 2) / 60 + ((yy - 14) ** 2) / 30))).astype(np.uint16)
pet.PixelData = blob.tobytes(); pet.WindowCenter, pet.WindowWidth = 1500, 3000
write('pet-blob.dcm', pet)
pet = pydicom.dcmread(os.path.join(OUT, 'pet-blob.dcm'))
ps, ref = gsps('bsps.dcm', 'blending: the PET blob through the WINTER palette at opacity 0.6 over the CT windowed 100/600')
ps.file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.11.4'; ps.SOPClassUID = ps.file_meta.MediaStorageSOPClassUID
del ps.ReferencedSeriesSequence
def layer(position, image, center, width):
    it = Dataset(); it.BlendingPosition = position
    r = Dataset(); r.ReferencedSOPClassUID = image.SOPClassUID; r.ReferencedSOPInstanceUID = image.SOPInstanceUID
    series = Dataset(); series.SeriesInstanceUID = generate_uid(entropy_srcs=['series ' + position]); series.ReferencedImageSequence = Sequence([r])
    it.ReferencedSeriesSequence = Sequence([series])
    voi = Dataset(); voi.WindowCenter = center; voi.WindowWidth = width; voi.ReferencedImageSequence = Sequence([r])
    it.SoftcopyVOILUTSequence = Sequence([voi])
    return it
under = layer('UNDERLYING', img, 100, 600)
over = layer('SUPERIMPOSED', pet, 1200, 2400); over.RelativeOpacity = 0.6
for tag in [(0x28, 0x1101), (0x28, 0x1102), (0x28, 0x1103), (0x28, 0x1221), (0x28, 0x1222), (0x28, 0x1223)]:
    over.add(winter[tag])
ps.BlendingSequence = Sequence([under, over])
ps.save_as(os.path.join(OUT, 'bsps.dcm'), enforce_file_format=True)
under_y = window(img.pixel_array.astype(np.float64) * float(img.RescaleSlope) + float(img.RescaleIntercept), 100, 600)
over_y = window(pet.pixel_array.astype(np.float64), 1200, 2400).astype(np.uint8)
over_rgb = apply_color_lut(over_y, winter)
over_rgb = (over_rgb if over_rgb.dtype == np.uint8 else np.round(over_rgb.astype(np.float64) * 255 / 65535)).astype(np.float64)
out = np.round(under_y[..., None] * 0.4 + over_rgb * 0.6).astype(np.uint8)
Image.fromarray(out, 'RGB').save(os.path.join(OUT, 'bsps.png'), optimize=True)
manifest['bsps.dcm'] = {'what': 'presentation state: ' + ps.ContentDescription, 'frames': 1, 'width': 48, 'height': 32, 'pi': 'MONOCHROME2', 'ts': str(ps.file_meta.TransferSyntaxUID), 'comment': ps.ContentDescription, 'references': 'ct-window.dcm', 'superimposed': 'pet-blob.dcm'}

ps, ref = gsps('gsps-missing.dcm', 'references an image that is not in the folder')
ref.ReferencedSOPInstanceUID = '1.2.826.0.1.3680043.8.498.99999999999999999999'
ps.save_as(os.path.join(OUT, 'gsps-missing.dcm'), enforce_file_format=True)
manifest['gsps-missing.dcm'] = {'what': 'presentation state referencing a missing image', 'unsupported': 'missing reference', 'comment': ps.ContentDescription}

# A raw dataset: implicit VR little endian, no preamble, no file meta (as some PACS exports and DICOMDIR-less dumps are).
ds = base_ds(ImplicitVRLittleEndian, 10, 12, 'MONOCHROME2', bits=8)
ds.ImageComments = 'raw dataset without the Part 10 header'
ds.PixelData = np.clip(gradient(10, 12, 3, 0), 0, 255).astype(np.uint8).tobytes()
raw = os.path.join(OUT, 'raw-noheader.dcm')
ds.file_meta = FileMetaDataset()
ds.preamble = None
pydicom.dcmwrite(raw, ds, implicit_vr=True, little_endian=True, enforce_file_format=False)
back = pydicom.dcmread(raw, force=True)
back.file_meta = FileMetaDataset()
back.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
manifest['raw-noheader.dcm'] = {'what': 'raw dataset without the Part 10 header', **save_expected('raw-noheader.dcm', back, back.pixel_array)}

with open(os.path.join(OUT, 'expected.json'), 'w') as f:
    json.dump(manifest, f, indent=1, sort_keys=True)
with open(os.path.join(OUT, 'LICENSE-pydicom'), 'w') as f:
    f.write("The files listed as pydicom's in expected.json (\"what\" entries) come from pydicom's test suite\n"
            "(https://github.com/pydicom/pydicom, pydicom/data/test_files), distributed under pydicom's MIT license:\n\n")
    lic = open(os.path.join(os.path.dirname(pydicom.__file__), '..', 'pydicom-3.0.2.dist-info', 'licenses', 'LICENSE')).read()
    f.write(lic.split('Portions of pydicom')[0])
    f.write("\nFrom the test files' README: \"images were often downsized ... In some cases, the original files have been binary edited\n"
            "to replace anything that looks like a real patient name. I believe there is no restriction on using any of these files\n"
            "in this manner.\" CT_small.dcm derives from NEMA's WG04 data set CT1_UNC.\n")
print(json.dumps({k: (v.get('frames'), v.get('width'), v.get('height'), v.get('pi')) for k, v in manifest.items()}, indent=0))
