#!/usr/bin/env python3
"""The openly licensed test corpus (tests/corpus, not committed): downloads camera RAW samples released under CC0 on
raw.pixls.us (the smallest file of each format the app knows, checked against the site's SHA-256), the FITS sample
files of NASA's FITS Support Office (public domain as US government works), and makes damaged copies of them for
the recovery engine (cut short, a zeroed block, flipped bytes). Writes tests/corpus/manifest.json with every file's
source, license, size and SHA-256; tests/unit/corpus.test.ts runs over the corpus when it is present.

  python3 scripts/fetch-corpus.py            # everything (about 250 MB)
  python3 scripts/fetch-corpus.py --max-mb 8 # only RAW samples up to 8 MB
  python3 scripts/fetch-corpus.py --only fits

The repository's own fixtures (tests/fixtures) are made by the scripts/gen-*-fixtures.py generators or come from
permissively licensed test suites with their LICENSE files beside them; docs/CORPUS.md lists them per format.
"""
import argparse, hashlib, html, json, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'tests', 'corpus')
UA = 'AnnesLensTests/1.0 (https://github.com/socrtwo/annes-lens; test corpus fetch)'
PIXLS_INDEX = 'https://raw.pixls.us/json/getrepository.php?set=all'
# The RAW families the app identifies (src/codecs/rawpreview.ts); .raw (Raspberry Pi, Panasonic) is ambiguous and left out.
RAW_FORMATS = ['DNG', 'NEF', 'NRW', 'CR2', 'CR3', 'CRW', 'ARW', 'SRF', 'SR2', 'RAF', 'ORF', 'RW2', 'RWL', 'PEF', 'SRW', 'MRW', 'ERF', 'KDC', 'DCR', 'MOS', 'IIQ', 'X3F', '3FR', 'FFF', 'MEF']
NASA = 'https://fits.gsfc.nasa.gov/samples/'
NASA_FILES = ['WFPC2u5780205r_c0fx.fits', 'WFPC2ASSNu5780205bx.fits', 'FOCx38i0101t_c0f.fits', 'FOSy19g0309t_c2f.fits', 'HRSz0yd020fm_c2f.fits', 'NICMOSn4hk12010_mos.fits', 'FGSf64y0106m_a1f.fits', 'UITfuv2582gc.fits', 'IUElwp25637mxlo.fits', 'EUVEngc4151imgx.fits', 'DDTSUVDATA.fits', 'testkeys.fits', 'testkeys2.fits']


def fetch(url, dest, expected_sha=None, retries=4):
    for attempt in range(retries):
        try:
            parts = urllib.parse.urlsplit(url)
            req = urllib.request.Request(urllib.parse.urlunsplit(parts._replace(path=urllib.parse.quote(parts.path))), headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r, open(dest + '.part', 'wb') as f:
                h = hashlib.sha256()
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk: break
                    f.write(chunk); h.update(chunk)
            sha = h.hexdigest()
            if expected_sha and sha != expected_sha:
                os.remove(dest + '.part'); raise ValueError(f'SHA-256 mismatch for {url}: {sha} != {expected_sha}')
            os.replace(dest + '.part', dest)
            return sha
        except (OSError, ValueError) as e:
            if attempt == retries - 1: raise
            print(f'  retry {attempt + 1}: {e}', file=sys.stderr); time.sleep(2 ** attempt)


def pixls_candidates(max_mb):
    req = urllib.request.Request(PIXLS_INDEX, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=120) as r: data = json.load(r)
    rows = data['data'] if isinstance(data, dict) else data
    best = {}
    for row in rows:
        make, model, mode, size, license_html, link_html = row[0], row[1], row[2], row[3], row[5], row[7]
        if re.sub('<[^>]+>', '', license_html).strip() != 'co': continue  # CC0 only: redistribution needs no attribution terms
        m = re.search(r"href='([^']+)'", link_html); sha = re.search(r"Checksum'>([0-9a-f]{64})", link_html)
        if not m or not sha: continue
        url = html.unescape(m.group(1)); ext = url.rsplit('.', 1)[-1].upper()
        try: size = float(size)
        except (TypeError, ValueError): continue
        if ext not in RAW_FORMATS or size > max_mb: continue
        if ext not in best or size < best[ext]['mb']:
            best[ext] = {'mb': size, 'make': make, 'model': model, 'mode': mode, 'url': url, 'sha256': sha.group(1), 'ext': ext}
    return [best[k] for k in RAW_FORMATS if k in best]


def damage(src, dest_dir, name):
    """Three damaged copies: cut at 60 %, a 4 KB block zeroed a third in, every 977th byte of the second half flipped."""
    b = bytearray(open(src, 'rb').read()); out = []
    base, ext = os.path.splitext(name)
    cut = b[: max(1024, len(b) * 3 // 5)]
    zero = bytearray(b); z = len(b) // 3; zero[z:z + 4096] = b'\0' * min(4096, len(b) - z)
    flip = bytearray(b)
    for i in range(len(b) // 2, len(b), 977): flip[i] ^= 0xff
    for suffix, data in (('cut', cut), ('zeroed', zero), ('flipped', flip)):
        p = os.path.join(dest_dir, f'{base}.{suffix}{ext}')
        open(p, 'wb').write(data); out.append({'name': os.path.relpath(p, OUT), 'from': name, 'damage': suffix, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--max-mb', type=float, default=45.0); ap.add_argument('--only', choices=['raw', 'fits']); a = ap.parse_args()
    os.makedirs(os.path.join(OUT, 'raw'), exist_ok=True); os.makedirs(os.path.join(OUT, 'fits'), exist_ok=True); os.makedirs(os.path.join(OUT, 'damaged'), exist_ok=True)
    mpath = os.path.join(OUT, 'manifest.json')
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {'files': [], 'damaged': []}
    have = {f['name']: f for f in manifest['files']}
    files = list(manifest['files'])
    if a.only != 'fits':
        for c in pixls_candidates(a.max_mb):
            name = f"raw/{c['ext'].lower()}-{re.sub(r'[^A-Za-z0-9]+', '-', c['make'] + '-' + c['model']).strip('-')}.{c['ext'].lower()}"
            dest = os.path.join(OUT, name)
            if name in have and os.path.exists(dest): print('have', name); continue
            print(f"raw.pixls.us {c['ext']} {c['mb']} MB: {c['make']} {c['model']} ({c['mode']})")
            sha = fetch(c['url'], dest, c['sha256'])
            files = [f for f in files if f['name'] != name] + [{'name': name, 'url': c['url'], 'sha256': sha, 'bytes': os.path.getsize(dest), 'license': 'CC0-1.0', 'licenseUrl': 'https://creativecommons.org/publicdomain/zero/1.0/', 'source': 'raw.pixls.us', 'format': 'raw', 'camera': f"{c['make']} {c['model']}", 'note': c['mode']}]
    if a.only != 'raw':
        for n in NASA_FILES:
            name = f'fits/{n}'; dest = os.path.join(OUT, name)
            if name in have and os.path.exists(dest): print('have', name); continue
            print('NASA FITS sample', n)
            sha = fetch(NASA + n, dest)
            files = [f for f in files if f['name'] != name] + [{'name': name, 'url': NASA + n, 'sha256': sha, 'bytes': os.path.getsize(dest), 'license': 'public domain (US government work)', 'licenseUrl': 'https://www.nasa.gov/nasa-brand-center/images-and-media/', 'source': 'fits.gsfc.nasa.gov', 'format': 'fits', 'note': 'FITS Support Office sample'}]
    damaged = []
    for f in files:
        src = os.path.join(OUT, f['name'])
        if os.path.exists(src) and os.path.getsize(src) <= 12 * 1024 * 1024: damaged += damage(src, os.path.join(OUT, 'damaged'), os.path.basename(f['name']))
    manifest = {'generated': time.strftime('%Y-%m-%d'), 'files': sorted(files, key=lambda f: f['name']), 'damaged': sorted(damaged, key=lambda f: f['name'])}
    json.dump(manifest, open(mpath, 'w'), indent=1)
    total = sum(f['bytes'] for f in manifest['files'])
    print(f"{len(manifest['files'])} files ({total / 1e6:.1f} MB), {len(manifest['damaged'])} damaged copies; manifest at {os.path.relpath(mpath, ROOT)}")


if __name__ == '__main__':
    main()
