#!/usr/bin/env python3
"""Fixtures for workstation and home-computer picture formats, with expected pictures from other readers.

Writes to tests/fixtures/historic/ (expected pictures are <name>.png next to each file):
  Sun raster    sun8.ras sun24.ras sun32.ras (ImageMagick)             expected: ImageMagick's decoding
                sun1.ras, sun8-rle.ras sun1-rle.ras (netpbm pnmtorast)  expected: netpbm rasttopnm
  SGI           sgi-rle.sgi sgi-verbatim.sgi gray.sgi (netpbm pnmtosgi), sgi16.sgi (16-bit, pnmtosgi),
                rgba.sgi (Pillow)                                    expected: ImageMagick's decoding
  Utah RLE      urt.rle urt-gray.rle (netpbm pnmtorle)               expected: netpbm rletopnm
  MS Paint      msp1.msp (Pillow), msp2.msp (written here, version 2 RLE)    expected: Pillow's decoding
  GEM IMG       gem1.img (netpbm pbmtogem)                           expected: netpbm gemtopnm
                ximg4.img (written here: 4 planes with an XIMG palette, every compression opcode)
                                                                     expected: decoded here
  Atari ST      low.pi1 (Degas, written here)                        expected: netpbm pi1toppm
                low.pc1 (Degas Elite PackBits, same picture)         expected: low.png
                mono.pi3 (written here)                              expected: netpbm pi3topbm
                med.pi2 (written here)                               expected: decoded here
                neo.neo (NEOchrome)                                  expected: netpbm neotoppm
                spectrum.spu (Spectrum 512, a palette per line)      expected: netpbm sputoppm
  Commodore 64  koala.koa (multicolor), hires.art (Art Studio), doodle.dd   expected: decoded here (Pepto palette)
  PICT          pict8.pct pict32.pct (ImageMagick), ppm.pct (netpbm ppmtopict)   expected: ImageMagick's decoding
                jpeg.pct (QuickTime JPEG, quality 95; ImageMagick)  expected: close to jpeg-source.png
                shapes.pct (written here: QuickDraw rectangles, ovals, a polygon, lines, a PackBitsRect and text)
                                                                     expected: shapes.png, drawn here
                v1.pct (version 1: old colors, a pattern-filled oval, a region, a 1-bit BitsRect in srcOr, a line)
                                                                     expected: v1.png, drawn here
Needs numpy, Pillow, ImageMagick (convert) and netpbm.
"""
import os, struct, subprocess, tempfile
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures', 'historic')
TMP = tempfile.mkdtemp()


def out(n):
    return os.path.join(OUT, n)


def tmp(n):
    return os.path.join(TMP, n)


def sh(cmd, stdout=None):
    with open(stdout, 'wb') if stdout else open(os.devnull, 'wb') as f:
        subprocess.run(cmd, check=True, stdout=f if stdout else None, stderr=subprocess.DEVNULL)


def png(a, name):
    Image.fromarray(np.ascontiguousarray(a)).save(out(name))


def ref_magick(src, name):
    sh(['convert', src, '-strip', 'PNG24:' + out(name)] if not name.startswith('rgba') else ['convert', src, '-strip', 'PNG32:' + out(name)])


def ref_netpbm(tool, src, name):
    sh([tool, src], tmp('ref.pnm'))
    Image.open(tmp('ref.pnm')).convert('RGB').save(out(name))


def photo(w, h):
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    r = 128 + 100 * np.sin(x / 7.0) * np.cos(y / 9.0)
    return np.clip(np.stack([r, 255 * x / w, 255 * (1 - y / h)], -1), 0, 255).astype(np.uint8)


def packbits(b):
    """PackBits: runs of 3 or more as repeats, the rest as literals."""
    o, i, n = bytearray(), 0, len(b)
    while i < n:
        j = i
        while j < n and j - i < 128 and b[j] == b[i]:
            j += 1
        if j - i >= 3:
            o += bytes([(257 - (j - i)) & 255, b[i]])
            i = j
            continue
        j = i
        while j < n and j - i < 128 and not (j + 2 < n and b[j] == b[j + 1] == b[j + 2]):
            j += 1
        o += bytes([j - i - 1]) + bytes(b[i:j])
        i = j
    return bytes(o)


# Sun, SGI, Utah RLE ----------------------------------------------------------------------------------
def workstation():
    a = photo(61, 37)  # odd width: row padding
    Image.fromarray(a).save(tmp('p.ppm'))
    rgba = np.concatenate([a, np.tile(np.linspace(0, 255, 61).astype(np.uint8), (37, 1))[..., None]], -1)
    Image.fromarray(rgba, 'RGBA').save(tmp('p.png'))
    sh(['convert', tmp('p.ppm'), '-dither', 'None', '-colors', '60', tmp('q.ppm')])
    sh(['convert', tmp('p.ppm'), '-monochrome', tmp('m.pbm')])
    sh(['pnmtorast', '-standard', tmp('m.pbm')], out('sun1.ras'))
    sh(['convert', tmp('q.ppm'), '-type', 'Palette', out('sun8.ras')])
    sh(['convert', tmp('p.ppm'), out('sun24.ras')])
    sh(['convert', tmp('p.png'), out('sun32.ras')])
    sh(['pnmtorast', '-rle', tmp('q.ppm')], out('sun8-rle.ras'))
    sh(['pnmtorast', '-rle', tmp('m.pbm')], out('sun1-rle.ras'))
    for n in ('sun8', 'sun24'):
        ref_magick(out(n + '.ras'), n + '.png')
    for n in ('sun1', 'sun8-rle', 'sun1-rle'):
        ref_netpbm('rasttopnm', out(n + '.ras'), n + '.png')
    sh(['convert', out('sun32.ras'), '-strip', 'PNG32:' + out('sun32.png')])
    sh(['pnmtosgi', '-rle', tmp('p.ppm')], out('sgi-rle.sgi'))
    sh(['pnmtosgi', '-verbatim', tmp('p.ppm')], out('sgi-verbatim.sgi'))
    Image.fromarray(a).convert('L').save(tmp('g.pgm'))
    sh(['pnmtosgi', '-rle', tmp('g.pgm')], out('gray.sgi'))
    sh(['pnmdepth', '65535', tmp('p.ppm')], tmp('p16.ppm'))
    sh(['pnmtosgi', '-rle', tmp('p16.ppm')], out('sgi16.sgi'))
    Image.fromarray(rgba, 'RGBA').save(out('rgba.sgi'))
    for n in ('sgi-rle', 'sgi-verbatim', 'gray', 'sgi16'):
        ref_magick(out(n + '.sgi'), n + '.png')
    sh(['convert', out('rgba.sgi'), '-strip', 'PNG32:' + out('rgba.png')])
    sh(['pnmtorle', tmp('p.ppm')], out('urt.rle'))
    sh(['pnmtorle', tmp('g.pgm')], out('urt-gray.rle'))
    ref_netpbm('rletopnm', out('urt.rle'), 'urt.png')
    ref_netpbm('rletopnm', out('urt-gray.rle'), 'urt-gray.png')


# MS Paint --------------------------------------------------------------------------------------------
def msp():
    bits = (photo(75, 30)[..., 0] > 128)
    Image.fromarray(bits).convert('1').save(out('msp1.msp'))
    Image.open(out('msp1.msp')).convert('RGB').save(out('msp1.png'))
    # Version 2: a row-length table, then each row as runs (0, count, value) and literals (count, bytes).
    w, h = 75, 30
    rows = np.packbits(bits, axis=1)  # 1 = white in MSP
    data, lens = b'', []
    for r in rows:
        b, enc, i = bytes(r), bytearray(), 0
        while i < len(b):
            j = i
            while j < len(b) and j - i < 255 and b[j] == b[i]:
                j += 1
            if j - i >= 3:
                enc += bytes([0, j - i, b[i]])
                i = j
            else:
                k = i
                while k < len(b) and k - i < 255 and not (k + 2 < len(b) and b[k] == b[k + 1] == b[k + 2]):
                    k += 1
                enc += bytes([k - i]) + b[i:k]
                i = k
        lens.append(len(enc))
        data += bytes(enc)
    hdr = struct.pack('<4s14H', b'LinS', w, h, 1, 1, 1, 1, w, h, 0, 0, 0, 0, 0, 0)  # 16 words; word 12 is the checksum
    hdr = bytearray(hdr)
    ck = 0
    for i in range(0, 24, 2):
        ck ^= struct.unpack('<H', hdr[i:i + 2])[0]
    hdr[24:26] = struct.pack('<H', ck)
    open(out('msp2.msp'), 'wb').write(bytes(hdr) + struct.pack('<%dH' % h, *lens) + data)
    Image.open(out('msp2.msp')).convert('RGB').save(out('msp2.png'))


# GEM IMG ---------------------------------------------------------------------------------------------
def gem():
    sh(['convert', tmp('p.ppm'), '-monochrome', tmp('g1.pbm')])
    sh(['pbmtogem', tmp('g1.pbm')], out('gem1.img'))
    ref_netpbm('gemtopnm', out('gem1.img'), 'gem1.png')
    # Four planes with an XIMG palette (RGB in 0…1000); lines repeat, pattern runs, solid runs, bit strings.
    w, h = 48, 20
    idx = np.zeros((h, w), np.uint8)
    for y in range(h):
        for x in range(w):
            idx[y, x] = (x // 3 + (y // 4) * 3) % 16 if y < 16 else (5 if x < 24 else 10)
    idx[0:2] = idx[0]  # first two lines identical (vertical replication)
    pal = [(int(i * 1000 / 15), int((15 - i) * 1000 / 15), (i * 333) % 1001) for i in range(16)]
    bpl = (w + 7) // 8
    body, y = bytearray(), 0
    while y < h:
        rep = 1
        while y + rep < h and (idx[y + rep] == idx[y]).all():
            rep += 1
        if rep > 1:
            body += bytes([0, 0, 0xFF, rep])
        for p in range(4):
            line = np.packbits(((idx[y] >> p) & 1).astype(np.uint8)).tobytes()[:bpl]
            i = 0
            while i < bpl:
                if line[i] in (0, 0xFF):
                    j = i
                    while j < bpl and line[j] == line[i] and j - i < 127:
                        j += 1
                    body += bytes([(0x80 if line[i] == 0xFF else 0) | (j - i)])
                    i = j
                elif i + 3 < bpl and line[i:i + 1] * 2 == line[i:i + 2] and line[i + 2] == line[i]:
                    j = i
                    while j < bpl and line[j] == line[i] and j - i < 255:
                        j += 1
                    body += bytes([0, j - i, line[i]])  # pattern run, pattern length 1
                    i = j
                else:
                    j = i
                    while j < bpl and line[j] not in (0, 0xFF) and j - i < 255 and not (j + 2 < bpl and line[j] == line[j + 1] == line[j + 2]):
                        j += 1
                    body += bytes([0x80, j - i]) + line[i:j]
                    i = j
        y += rep
    head = struct.pack('>8H', 1, 8 + 3 + 48, 4, 1, 85, 85, w, h) + b'XIMG' + struct.pack('>H', 0) + b''.join(struct.pack('>3H', *c) for c in pal)
    open(out('ximg4.img'), 'wb').write(head + bytes(body))
    rgb = np.array([[round(c * 255 / 1000) for c in p] for p in pal], np.uint8)
    png(rgb[idx], 'ximg4.png')


# Atari ST --------------------------------------------------------------------------------------------
def st_planar(idx, planes):
    h, w = idx.shape
    o = bytearray()
    for y in range(h):
        for g in range(w // 16):
            for p in range(planes):
                bits = (idx[y, g * 16:(g + 1) * 16] >> p) & 1
                o += np.packbits(bits.astype(np.uint8)).tobytes()
    return bytes(o)


def st_pal(cols):
    return b''.join(struct.pack('>H', (r << 8) | (g << 4) | b) for r, g, b in cols)


ST_PAL = [(i % 8, (i * 3) % 8, 7 - i % 8) for i in range(16)]


def st_rgb(cols):
    return np.array([[round(v * 255 / 7) for v in c] for c in cols], np.uint8)


def atari():
    idx = np.zeros((200, 320), np.uint8)
    y, x = np.mgrid[0:200, 0:320]
    idx[:] = ((x // 20) + (y // 25) * 2) % 16
    idx[60:140, 100:220] = ((x[60:140, 100:220] - 100) ** 2 + (y[60:140, 100:220] - 100) ** 2 < 1600) * 15
    bm = st_planar(idx, 4)
    open(out('low.pi1'), 'wb').write(struct.pack('>H', 0) + st_pal(ST_PAL) + bm)
    ref_netpbm('pi1toppm', out('low.pi1'), 'low.png')
    # Degas Elite: each line's four planes PackBits-compressed in turn, then the color-cycling words.
    comp = bytearray()
    for row in range(200):
        line = bm[row * 160:(row + 1) * 160]
        for p in range(4):
            plane = b''.join(line[g * 8 + p * 2:g * 8 + p * 2 + 2] for g in range(20))
            comp += packbits(plane)
    open(out('low.pc1'), 'wb').write(struct.pack('>H', 0x8000) + st_pal(ST_PAL) + bytes(comp) + bytes(32))
    # Color cycling: Degas Elite's footer channel 0 turns colors 1–7 to the right every 8 VBLs (delay 120); NEOchrome's
    # animation words turn the same colors to the left every 4 VBLs. Expected: the second frame (one step) of each.
    footer = struct.pack('>4H4H4H4H', 1, 0, 0, 0, 7, 0, 0, 0, 2, 1, 1, 1, 120, 0, 0, 0)
    open(out('low-cycle.pc1'), 'wb').write(struct.pack('>H', 0x8000) + st_pal(ST_PAL) + bytes(comp) + footer)
    def turned(pal, lo, hi, right, steps):
        pal = [tuple(c) for c in pal]
        for _ in range(steps):
            seg = pal[lo:hi + 1]
            seg = [seg[-1]] + seg[:-1] if right else seg[1:] + [seg[0]]
            pal = pal[:lo] + seg + pal[hi + 1:]
        return pal
    png(st_rgb(turned(ST_PAL, 1, 7, True, 1))[idx], 'low-cycle-f1.png')
    neo_c = bytearray(128); neo_c[2:4] = struct.pack('>H', 0); neo_c[4:36] = st_pal(ST_PAL); neo_c[36:48] = b'CYCLE   .NEO'
    neo_c[48:50] = struct.pack('>H', 0x8000 | (7 << 4) | 1); neo_c[50:52] = struct.pack('>H', 0x8000 | (0xfc))  # on; speed −4: left, 4 VBLs
    neo_c[58:62] = struct.pack('>HH', 320, 200)
    open(out('neo-cycle.neo'), 'wb').write(bytes(neo_c) + bm)
    png(st_rgb(turned(ST_PAL, 1, 7, False, 1))[idx], 'neo-cycle-f1.png')
    # High (640 × 400, one plane; palette word 0 bit 0 = 0 means white paper).
    mono = ((x.repeat(2, 1)[:, :640] if False else None))
    yy, xx = np.mgrid[0:400, 0:640]
    m = (((xx // 8) ^ (yy // 8)) & 1).astype(np.uint8)
    m[100:300, 200:440] = ((xx[100:300, 200:440] - 320) ** 2 + (yy[100:300, 200:440] - 200) ** 2 < 90 ** 2)
    open(out('mono.pi3'), 'wb').write(struct.pack('>H', 2) + st_pal([(7, 7, 7)] + [(0, 0, 0)] * 15) + st_planar(m, 1))
    ref_netpbm('pi3topbm', out('mono.pi3'), 'mono.png')
    # Medium (640 × 200, two planes, four colors).
    my, mx = np.mgrid[0:200, 0:640]
    med = ((mx // 40 + my // 50) % 4).astype(np.uint8)
    medpal = [(7, 7, 7), (7, 0, 0), (0, 5, 0), (0, 0, 3)] + [(0, 0, 0)] * 12
    open(out('med.pi2'), 'wb').write(struct.pack('>H', 1) + st_pal(medpal) + st_planar(med, 2))
    png(st_rgb(medpal)[med], 'med.png')
    # NEOchrome.
    neo = bytearray(128)
    neo[2:4] = struct.pack('>H', 0)
    neo[4:36] = st_pal(ST_PAL)
    neo[36:48] = b'PICTURE .NEO'
    neo[58:62] = struct.pack('>HH', 320, 200)
    open(out('neo.neo'), 'wb').write(bytes(neo) + bm)
    ref_netpbm('neotoppm', out('neo.neo'), 'neo.png')
    # Spectrum 512: 199 lines × 48 colors; the color for x and index c is picked from three palettes along the line.
    pals = bytearray()
    for line in range(199):
        for k in range(48):
            r, g, b = (line + k) % 8, (k * 5 + line // 3) % 8, (k // 3) % 8
            pals += struct.pack('>H', (r << 8) | (g << 4) | b)
    sidx = (((x // 4) + y) % 16).astype(np.uint8)
    sbm = bytearray(st_planar(sidx, 4))
    sbm[0:160] = bytes(160)  # line 0 is not shown
    open(out('spectrum.spu'), 'wb').write(bytes(sbm) + bytes(pals))
    ref_netpbm('sputoppm', out('spectrum.spu'), 'spectrum.png')


# Commodore 64 ----------------------------------------------------------------------------------------
PEPTO = ['000000', 'FFFFFF', '68372B', '70A4B2', '6F3D86', '588D43', '352879', 'B8C76F',
         '6F4F25', '433900', '9A6759', '444444', '6C6C6C', '9AD284', '6C5EB5', '959595']
C64 = np.array([[int(c[i:i + 2], 16) for i in (0, 2, 4)] for c in PEPTO], np.uint8)


def c64():
    rng = np.random.default_rng(64)
    bitmap = rng.integers(0, 256, 8000, dtype=np.uint8)
    screen = rng.integers(0, 256, 1000, dtype=np.uint8)
    color = rng.integers(0, 16, 1000, dtype=np.uint8)
    bg = 6
    open(out('koala.koa'), 'wb').write(b'\x00\x60' + bitmap.tobytes() + screen.tobytes() + color.tobytes() + bytes([bg]))
    img = np.zeros((200, 320, 3), np.uint8)
    for cy in range(25):
        for cx in range(40):
            cell = cy * 40 + cx
            for r in range(8):
                byte = bitmap[cell * 8 + r]
                for px in range(4):
                    v = (byte >> (6 - 2 * px)) & 3
                    c = [bg, screen[cell] >> 4, screen[cell] & 15, color[cell]][v]
                    img[cy * 8 + r, cx * 8 + px * 2:cx * 8 + px * 2 + 2] = C64[c]
    png(img, 'koala.png')

    def hires(scr, bm):
        im = np.zeros((200, 320, 3), np.uint8)
        for cy in range(25):
            for cx in range(40):
                cell = cy * 40 + cx
                for r in range(8):
                    byte = bm[cell * 8 + r]
                    for px in range(8):
                        im[cy * 8 + r, cx * 8 + px] = C64[(scr[cell] >> 4) if (byte >> (7 - px)) & 1 else (scr[cell] & 15)]
        return im
    open(out('hires.art'), 'wb').write(b'\x00\x20' + bitmap.tobytes() + screen.tobytes() + bytes([3]) + bytes(6))
    png(hires(screen, bitmap), 'hires.png')
    open(out('doodle.dd'), 'wb').write(b'\x00\x5c' + screen[::-1].tobytes() + bytes(24) + bitmap[::-1].tobytes() + bytes(192))
    png(hires(screen[::-1], bitmap[::-1]), 'doodle.png')


# PICT ------------------------------------------------------------------------------------------------
def pict():
    a = photo(61, 37)
    Image.fromarray(a).save(tmp('p.ppm'))
    sh(['convert', tmp('p.ppm'), '-dither', 'None', '-colors', '60', '-type', 'Palette', out('pict8.pct')])
    sh(['convert', tmp('p.ppm'), out('pict32.pct')])
    sh(['pnmquant', '200', tmp('p.ppm')], tmp('q.ppm'))
    sh(['ppmtopict', tmp('q.ppm')], out('ppm.pct'))
    sh(['convert', tmp('p.ppm'), '-compress', 'JPEG', '-quality', '95', out('jpeg.pct')])
    for n in ('pict8', 'pict32', 'ppm'):
        ref_magick(out(n + '.pct'), n + '.png')
    Image.fromarray(a).save(out('jpeg-source.png'))  # ImageMagick does not read its QuickTime PICTs back
    # Shapes: a version 2 picture drawn here opcode by opcode, and the same drawing in numpy.
    w, h = 120, 80
    ops = bytearray()
    op = lambda code, data=b'': ops.extend(struct.pack('>H', code) + data)
    rect = lambda t, l, b, r: struct.pack('>4h', t, l, b, r)
    rgb = lambda r, g, b: struct.pack('>3H', r * 257, g * 257, b * 257)
    op(0x0011, b'\x02\xff')                         # version 2
    op(0x0C00, struct.pack('>hhIIIIhhI', -2, 0, 72 << 16, 72 << 16, 0, 0, h, w, 0))  # header (extended)
    op(0x001E)                                       # default highlight
    op(0x0001, struct.pack('>H', 10) + rect(0, 0, h, w))  # clip
    op(0x001A, rgb(255, 255, 255)); op(0x0031, rect(0, 0, h, w))           # white background (paintRect)
    op(0x001A, rgb(200, 30, 30)); op(0x0031, rect(10, 10, 40, 50))         # red rectangle
    op(0x001A, rgb(30, 30, 200)); op(0x0051, rect(10, 60, 40, 110))        # blue oval
    op(0x001A, rgb(0, 0, 0)); op(0x0007, struct.pack('>hh', 2, 2))         # pen 2 × 2
    op(0x0030, rect(50, 10, 70, 50))                                      # frameRect
    op(0x0020, struct.pack('>4h', 75, 5, 75, 115))                        # line
    poly = struct.pack('>H', 10 + 4 * 4) + rect(45, 60, 75, 110) + struct.pack('>8h', 45, 85, 75, 110, 75, 60, 45, 85)
    op(0x001A, rgb(30, 160, 30)); op(0x0071, poly)                         # green triangle (paintPoly)
    # A 1-bit PackBitsRect (rowBytes < 8: rows stored plain) with a 2-color palette.
    bm = np.zeros((8, 16), np.uint8); bm[::2, ::2] = 1; bm[1::2, 1::2] = 1
    rows = np.packbits(bm, axis=1).tobytes()
    pm = struct.pack('>H', 0x8000 | 2) + rect(0, 0, 8, 16) + struct.pack('>hhIIIhhhhIII', 0, 0, 0, 72 << 16, 72 << 16, 0, 1, 1, 1, 0, 0, 0)
    ctab = struct.pack('>IhH', 0, 0, 1) + struct.pack('>H', 0) + rgb(255, 255, 0) + struct.pack('>H', 1) + rgb(128, 0, 128)
    op(0x0098, pm + ctab + rect(0, 0, 8, 16) + rect(2, 100, 10, 116) + struct.pack('>h', 0) + rows)
    op(0x0028, struct.pack('>hh', 70, 60) + bytes([5]) + b'Annes')  # text (not drawn by the expected picture)
    op(0x00FF)
    body = struct.pack('>H', 0) + rect(0, 0, h, w) + bytes(ops)
    body = struct.pack('>H', len(body) & 0xFFFF) + body[2:]
    open(out('shapes.pct'), 'wb').write(bytes(512) + body)
    img = np.full((h, w, 3), 255, np.uint8)
    img[10:40, 10:50] = (200, 30, 30)
    yy, xx = np.mgrid[0:h, 0:w]
    cy, cx, ry, rx = 25, 85, 15, 25
    img[(((xx + 0.5 - cx) / rx) ** 2 + ((yy + 0.5 - cy) / ry) ** 2) <= 1] = (30, 30, 200)
    fr = np.zeros((h, w), bool); fr[50:70, 10:50] = True; fr[52:68, 12:48] = False
    img[fr] = 0
    img[75:77, 5:117] = 0  # the line with a 2 × 2 pen covers x 5…116, y 75…76
    # The triangle: centers of pixels inside (85,45)-(110,75)-(60,75).
    def inside(px, py):
        def s(ax, ay, bx, by):
            return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
        d1, d2, d3 = s(85, 45, 110, 75), s(110, 75, 60, 75), s(60, 75, 85, 45)
        return ((d1 >= 0) & (d2 >= 0) & (d3 >= 0)) | ((d1 <= 0) & (d2 <= 0) & (d3 <= 0))
    tri = inside(xx + 0.5, yy + 0.5)
    img[tri] = (30, 160, 30)
    img[2:10, 100:116] = np.where(bm[..., None] == 1, np.array([128, 0, 128], np.uint8), np.array([255, 255, 0], np.uint8))
    png(img, 'shapes.png')


def pict_v1():
    """A version 1 picture: byte opcodes, old-style colors, a pattern fill, a region and a 1-bit BitsRect in srcOr."""
    w, h = 100, 60
    rect = lambda t, l, b, r: struct.pack('>4h', t, l, b, r)
    ops = bytearray(b'\x11\x01')
    ops += b'\x01' + struct.pack('>H', 10) + rect(0, 0, h, w)                       # clip
    ops += b'\x0e' + struct.pack('>I', 205) + b'\x31' + rect(5, 5, 25, 45)          # red paintRect
    ops += b'\x0e' + struct.pack('>I', 33) + b'\x0a' + bytes([0xAA, 0x55] * 4)      # black; 50% gray fill pattern
    ops += b'\x54' + rect(5, 50, 35, 90)                                             # fillOval
    rgn = [30, 5, 25, 0x7FFF, 40, 25, 45, 0x7FFF, 50, 5, 45, 0x7FFF, 0x7FFF]
    ops += b'\x81' + struct.pack('>H', 10 + 2 * len(rgn)) + rect(30, 5, 50, 45) + struct.pack('>%dH' % len(rgn), *rgn)  # paintRgn (an L)
    bits = np.zeros((4, 16), np.uint8); bits[:, ::3] = 1
    ops += b'\x90' + struct.pack('>H', 2) + rect(0, 0, 4, 16) + rect(0, 0, 4, 16) + rect(40, 60, 44, 76) + struct.pack('>H', 1) + np.packbits(bits, axis=1).tobytes()
    ops += b'\x0e' + struct.pack('>I', 409) + b'\x20' + struct.pack('>4h', 55, 2, 55, 95)   # blue line
    ops += b'\xff'
    body = struct.pack('>H', 10 + len(ops)) + rect(0, 0, h, w) + bytes(ops)
    open(out('v1.pct'), 'wb').write(bytes(512) + body)
    img = np.full((h, w, 3), 255, np.uint8)
    img[5:25, 5:45] = (221, 8, 6)
    yy, xx = np.mgrid[0:h, 0:w]
    oval = ((xx + 0.5 - 70) / 20) ** 2 + ((yy + 0.5 - 20) / 15) ** 2 <= 1
    on = ((np.where(yy % 2 == 0, 0xAA, 0x55) >> (7 - (xx % 8))) & 1) == 1
    img[oval & on] = 0
    img[oval & ~on] = 255
    img[30:40, 5:25] = 0
    img[40:50, 5:45] = 0
    sub = img[40:44, 60:76]
    sub[bits == 1] = 0
    img[55, 2:96] = (0, 0, 212)
    png(img, 'v1.png')


def main():
    os.makedirs(OUT, exist_ok=True)
    workstation()
    msp()
    gem()
    atari()
    c64()
    pict()
    pict_v1()


if __name__ == '__main__':
    main()
