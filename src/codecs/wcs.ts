/**
 * FITS World Coordinate System (Greisen & Calabretta 2002, Calabretta & Greisen 2002): the celestial position of a
 * pixel from the header's CTYPE/CRVAL/CRPIX/CDELT, PC or CD matrix (or the legacy CROTA2), LONPOLE/LATPOLE, and the
 * projection: TAN, SIN, ARC, STG, ZEA (zenithal), CAR, MER, CEA (cylindrical), AIT, SFL/GLS (pseudo-cylindrical),
 * with the SIP polynomial distortion (Shupe et al. 2005) when the header carries it. Linear axes without a projection
 * are read too (plain CDELT scaling). Only the primary coordinate description (no alternate letters), two axes.
 * Pixel coordinates here are the app's: x to the right and y down from the top-left corner of the displayed picture,
 * continuous (a pixel's center at +0.5), with the first stored row at the bottom as the FITS reader shows it.
 */
export interface Wcs {
  /** CTYPE of the two axes, and the projection code ('' for linear axes). */
  ctype: [string, string]; proj: string;
  /** The reference pixel (FITS 1-based), reference value and the linear matrix (CD, degrees per pixel). */
  crpix: [number, number]; crval: [number, number]; cd: [number, number, number, number];
  lonpole: number; latpole: number;
  /** Native longitude/latitude of the fiducial point for the projection. */
  phi0: number; theta0: number;
  /** PV2_n projection parameters (CEA's λ, SIN's ξ/η, AZP's μ/γ, ZPN's polynomial, the conics' θa/η…). */
  pv: number[];
  /** TPV distortion polynomials (PV1_i for ξ, PV2_i for η), when CTYPE says TPV. */
  tpv?: { x: number[]; y: number[] };
  /** SIP forward polynomials: [p, q, coefficient] triples for u (A) and v (B). */
  sipA?: [number, number, number][]; sipB?: [number, number, number][];
  /** Picture height, to turn y-down coordinates into FITS rows. */
  height: number;
  /** Coordinate frame for labels: 'equatorial' (RA/Dec), 'galactic', 'ecliptic', 'helioecliptic', 'supergalactic', 'other'. */
  frame: string; equinox?: string; radesys?: string;
  /** Axis units for linear axes (CUNIT). */
  cunit: [string, string];
}

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const ZENITHAL = new Set(['TAN', 'TPV', 'SIN', 'ARC', 'STG', 'ZEA', 'AZP', 'SZP', 'ZPN', 'AIR']), CYLINDRICAL = new Set(['CAR', 'MER', 'CEA', 'CYP']), PSEUDO = new Set(['AIT', 'SFL', 'GLS', 'PAR', 'MOL', 'BON', 'PCO']), CONIC = new Set(['COP', 'COE', 'COD', 'COO']), QUADCUBE = new Set(['TSC', 'QSC', 'CSC']), HEALPIX = new Set(['HPX', 'XPH']);
export const WCS_PROJECTIONS = [...ZENITHAL, ...CYLINDRICAL, ...PSEUDO, ...CONIC, ...QUADCUBE, ...HEALPIX];

/** Reads the WCS of a two-axis image from its header cards; null when there is none the reader understands. */
export function parseWcs(cards: Map<string, string>, width: number, height: number): Wcs | null {
  const num = (k: string, d: number): number => { const v = cards.get(k); const n = v === undefined ? NaN : +v; return Number.isFinite(n) ? n : d; };
  const has = (k: string) => cards.has(k) && Number.isFinite(+cards.get(k)!);
  const ctype1 = (cards.get('CTYPE1') || '').trim().toUpperCase(), ctype2 = (cards.get('CTYPE2') || '').trim().toUpperCase();
  if (!ctype1 && !ctype2 && !has('CRVAL1') && !has('CDELT1') && !has('CD1_1')) return null;
  if (num('WCSAXES', 2) < 2 && (ctype1 || ctype2) && !(ctype1 && ctype2)) return null;
  const parts1 = ctype1.split('-').filter(Boolean), parts2 = ctype2.split('-').filter(Boolean);
  let proj = '';
  const lonAxis = /^(RA|GLON|ELON|HLON|SLON|[A-Z]LON)$/.test(parts1[0] || '') && !/^(RA|GLON|ELON|HLON|SLON|[A-Z]LON)$/.test(parts2[0] || '') ? 0 : /^(RA|GLON|ELON|HLON|SLON|[A-Z]LON)$/.test(parts2[0] || '') ? 1 : -1;
  if (parts1.length >= 2 && parts2.length >= 2 && parts1[1] === parts2[1] && lonAxis >= 0) proj = parts1[1];
  const sip = /-SIP$/.test(ctype1) || parts1.includes('SIP');
  if (proj && !WCS_PROJECTIONS.includes(proj)) return null;
  // The linear part: CD, else PC × CDELT (with CROTA2 as a rotation of the PC matrix).
  const cdelt1 = num('CDELT1', 1), cdelt2 = num('CDELT2', 1);
  let cd: [number, number, number, number];
  if (has('CD1_1') || has('CD1_2') || has('CD2_1') || has('CD2_2')) cd = [num('CD1_1', 0), num('CD1_2', 0), num('CD2_1', 0), num('CD2_2', 0)];
  else {
    let pc: [number, number, number, number] = [num('PC1_1', 1), num('PC1_2', 0), num('PC2_1', 0), num('PC2_2', 1)];
    if (has('CROTA2') && !has('PC1_1') && !has('PC1_2') && !has('PC2_1') && !has('PC2_2')) {
      const rho = num('CROTA2', 0) * D2R, c = Math.cos(rho), s = Math.sin(rho);
      pc = [c, -s * (cdelt2 / cdelt1), s * (cdelt1 / cdelt2), c];
    }
    cd = [pc[0] * cdelt1, pc[1] * cdelt1, pc[2] * cdelt2, pc[3] * cdelt2];
  }
  if (!cd.some((v) => v !== 0)) return null;
  const crval: [number, number] = [num('CRVAL1', 0), num('CRVAL2', 0)], crpix: [number, number] = [num('CRPIX1', 0), num('CRPIX2', 0)];
  // Swapped axes (DEC first) are turned around so that axis 1 is the longitude.
  const w: Wcs = { ctype: [ctype1, ctype2], proj, crpix, crval, cd, lonpole: NaN, latpole: num('LATPOLE', 90), phi0: 0, theta0: 0, pv: [], height, frame: 'other', cunit: [(cards.get('CUNIT1') || '').trim(), (cards.get('CUNIT2') || '').trim()] };
  if (proj && lonAxis === 1) { w.ctype = [ctype2, ctype1]; w.crval = [crval[1], crval[0]]; w.cd = [cd[2], cd[3], cd[0], cd[1]]; w.pv = []; }
  if (proj) {
    const lonName = w.ctype[0].split('-')[0];
    w.frame = lonName === 'RA' ? 'equatorial' : lonName === 'GLON' ? 'galactic' : lonName === 'ELON' ? 'ecliptic' : lonName === 'HLON' ? 'helioecliptic' : lonName === 'SLON' ? 'supergalactic' : 'other';
    if (proj === 'TPV') { w.tpv = { x: [], y: [] }; for (let i = 0; i < 40; i++) { w.tpv.x[i] = num(`PV1_${i}`, i === 1 ? 1 : 0); w.tpv.y[i] = num(`PV2_${i}`, i === 1 ? 1 : 0); } }
    else for (let i = 0; i <= 20; i++) w.pv[i] = num(`PV2_${i}`, i === 1 && (proj === 'CEA' || proj === 'CYP') ? 1 : i === 2 && proj === 'CYP' ? 1 : i === 1 && proj === 'AIR' ? 90 : i === 3 && proj === 'SZP' ? 90 : 0);
    w.theta0 = ZENITHAL.has(proj) || proj === 'XPH' ? 90 : CONIC.has(proj) ? w.pv[1] : 0;
    if (proj === 'HPX') { if (!has('PV2_1')) w.pv[1] = 4; if (!has('PV2_2')) w.pv[2] = 3; }
    w.lonpole = has('LONPOLE') ? num('LONPOLE', 0) : w.crval[1] >= w.theta0 ? 0 : 180;
    if (cards.has('EQUINOX')) w.equinox = cards.get('EQUINOX')!.trim();
    if (cards.has('RADESYS')) w.radesys = cards.get('RADESYS')!.trim();
    if (sip) {
      const read = (p: string): [number, number, number][] => { const out: [number, number, number][] = [], order = num(`${p}_ORDER`, 0); for (let i = 0; i <= order; i++) for (let j = 0; j <= order - i; j++) { const k = `${p}_${i}_${j}`; if (has(k)) out.push([i, j, num(k, 0)]); } return out; };
      w.sipA = read('A'); w.sipB = read('B');
    }
  }
  if (!Number.isFinite(w.lonpole)) w.lonpole = 0;
  void width;
  return w;
}

/** The world coordinate of an app pixel position (x right, y down, continuous): degrees of longitude and latitude, or linear axis values. */
export function pixelToWorld(w: Wcs, x: number, y: number): [number, number] | null {
  let u = x + 0.5 - w.crpix[0], v = w.height - y + 0.5 - w.crpix[1]; // FITS pixel (x + 0.5, height − y + 0.5) relative to the reference pixel
  if (w.sipA || w.sipB) {
    const poly = (terms: [number, number, number][] | undefined) => { let s = 0; if (terms) for (const [p, q, c] of terms) s += c * u ** p * v ** q; return s; };
    const du = poly(w.sipA), dv = poly(w.sipB);
    u += du; v += dv;
  }
  let ix = w.cd[0] * u + w.cd[1] * v, iy = w.cd[2] * u + w.cd[3] * v; // intermediate world coordinates (degrees)
  if (!w.proj) return [w.crval[0] + ix, w.crval[1] + iy];
  if (w.tpv) { const [dx, dy] = tpvDistort(w.tpv, ix, iy); ix = dx; iy = dy; }
  const inv = inverseProjection(w, ix, iy);
  if (!inv) return null;
  const [phi, theta] = inv;
  if (!Number.isFinite(phi) || !Number.isFinite(theta)) return null;
  return nativeToCelestial(w, phi, theta);
}

/** The spherical rotation from native (φ, θ) to celestial (α, δ), eq. 2 of Calabretta & Greisen 2002. */
function nativeToCelestial(w: Wcs, phi: number, theta: number): [number, number] {
  const [ap, dp] = celestialPole(w), phip = w.lonpole;
  const st = Math.sin(theta * D2R), ct = Math.cos(theta * D2R), sdp = Math.sin(dp * D2R), cdp = Math.cos(dp * D2R);
  const dphi = (phi - phip) * D2R, cdphi = Math.cos(dphi), sdphi = Math.sin(dphi);
  const delta = Math.asin(Math.max(-1, Math.min(1, st * sdp + ct * cdp * cdphi))) * R2D;
  let alpha = ap + Math.atan2(-ct * sdphi, st * cdp - ct * sdp * cdphi) * R2D;
  alpha = ((alpha % 360) + 360) % 360;
  return [alpha, delta];
}

/** The celestial coordinates of the native pole (α_p, δ_p), eq. 8–9 of the paper, from the reference point. */
function celestialPole(w: Wcs): [number, number] {
  const [a0, d0] = w.crval, phip = w.lonpole, phi0 = w.phi0, theta0 = w.theta0;
  if (theta0 === 90) return [a0, d0]; // zenithal: the reference point is the native pole
  const st0 = Math.sin(theta0 * D2R), ct0 = Math.cos(theta0 * D2R), dphi = (phip - phi0) * D2R, cdphi = Math.cos(dphi), sdphi = Math.sin(dphi);
  const sd0 = Math.sin(d0 * D2R), A = st0, B = ct0 * cdphi, R = Math.hypot(A, B);
  let dp: number;
  if (R < 1e-12) dp = w.latpole;
  else {
    const g = Math.atan2(B, A), ratio = Math.max(-1, Math.min(1, sd0 / R)), s1 = Math.asin(ratio);
    const cands = [s1 - g, Math.PI - s1 - g].map((v) => { let d = v * R2D; while (d > 180) d -= 360; while (d < -180) d += 360; return d; }).filter((d) => d >= -90.000001 && d <= 90.000001);
    if (!cands.length) dp = w.latpole;
    else if (cands.length === 1) dp = cands[0];
    else dp = Math.abs(cands[0] - w.latpole) <= Math.abs(cands[1] - w.latpole) ? cands[0] : cands[1];
  }
  const sdp = Math.sin(dp * D2R), cdp = Math.cos(dp * D2R);
  let ap: number;
  if (Math.abs(d0) >= 90 - 1e-9) ap = a0; // the reference point at a celestial pole: the native pole's longitude is CRVAL1 (wcslib's celset; the formula below is 0/0 there)
  else ap = a0 - Math.atan2(ct0 * sdphi, st0 * cdp - ct0 * sdp * cdphi) * R2D;
  return [ap, dp];
}

/** Great-circle separation of two (lon, lat) positions in degrees. */
export function angularSeparation(a: [number, number], b: [number, number]): number {
  const [l1, b1] = [a[0] * D2R, a[1] * D2R], [l2, b2] = [b[0] * D2R, b[1] * D2R];
  const dl = l2 - l1, sb1 = Math.sin(b1), cb1 = Math.cos(b1), sb2 = Math.sin(b2), cb2 = Math.cos(b2);
  const num = Math.hypot(cb2 * Math.sin(dl), cb1 * sb2 - sb1 * cb2 * Math.cos(dl)), den = sb1 * sb2 + cb1 * cb2 * Math.cos(dl);
  return Math.atan2(num, den) * R2D;
}

/** An angle in degrees as °, ′ or ″ with sensible precision. */
export function formatAngle(deg: number): string {
  const a = Math.abs(deg);
  if (a >= 1) return `${trim(deg.toFixed(4))}°`;
  if (a >= 1 / 60) return `${trim((deg * 60).toFixed(3))}′`;
  return `${trim((deg * 3600).toFixed(2))}″`;
}
const trim = (s: string) => s.replace(/\.?0+$/, '');
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** Right ascension as hh:mm:ss.ss. */
export function formatRa(deg: number): string {
  let h = (((deg % 360) + 360) % 360) / 15;
  let hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
  ss = Math.round(ss * 100) / 100;
  if (ss >= 60) { ss -= 60; mm++; } if (mm >= 60) { mm -= 60; hh = (hh + 1) % 24; }
  return `${pad(hh)}:${pad(mm)}:${ss.toFixed(2).padStart(5, '0')}`;
}
/** Declination (or any latitude) as ±dd:mm:ss.s. */
export function formatDec(deg: number): string {
  const sign = deg < 0 ? '−' : '+', a = Math.abs(deg);
  let dd = Math.floor(a), mm = Math.floor((a - dd) * 60), ss = ((a - dd) * 60 - mm) * 60;
  ss = Math.round(ss * 10) / 10;
  if (ss >= 60) { ss -= 60; mm++; } if (mm >= 60) { mm -= 60; dd++; }
  return `${sign}${pad(dd)}:${pad(mm)}:${ss.toFixed(1).padStart(4, '0')}`;
}
/** The readout for a position: "RA 10:00:24.00 Dec −20:30:00.0 (J2000)", "l 123.4567° b +12.3456°", or linear axis values. */
export function formatWorld(w: Wcs, pos: [number, number], withFrame = true): string {
  if (!w.proj) return `${w.ctype[0] || 'axis 1'} ${trim(pos[0].toFixed(6))}${w.cunit[0] ? ' ' + w.cunit[0] : ''}, ${w.ctype[1] || 'axis 2'} ${trim(pos[1].toFixed(6))}${w.cunit[1] ? ' ' + w.cunit[1] : ''}`;
  if (w.frame === 'equatorial') return `RA ${formatRa(pos[0])} Dec ${formatDec(pos[1])}${withFrame && (w.radesys || w.equinox) ? ` (${w.radesys ? w.radesys : ''}${w.radesys && w.equinox ? ' ' : ''}${w.equinox ? (/^\d/.test(w.equinox) ? 'J' + trim((+w.equinox).toFixed(1)) : w.equinox) : ''})` : ''}`;
  const [ln, lt] = w.frame === 'galactic' ? ['l', 'b'] : w.frame === 'ecliptic' ? ['λ', 'β'] : w.frame === 'supergalactic' ? ['SGL', 'SGB'] : [w.ctype[0].split('-')[0], w.ctype[1].split('-')[0]];
  return `${ln} ${trim(pos[0].toFixed(5))}° ${lt} ${pos[1] >= 0 ? '+' : '−'}${trim(Math.abs(pos[1]).toFixed(5))}°`;
}
/** The sky scale at a pixel: degrees along a pixel's diagonal neighbour… no: the mean of the two axes' scales, in degrees per pixel. */
export function pixelScale(w: Wcs, x: number, y: number): number | null {
  const a = pixelToWorld(w, x, y), b = pixelToWorld(w, x + 1, y), c = pixelToWorld(w, x, y + 1);
  if (!a || !b || !c) return null;
  return (angularSeparation(a, b) + angularSeparation(a, c)) / 2;
}

/** The TPV polynomial distortion of the intermediate coordinates (the SCAMP/TPV convention, 40 terms each). */
function tpvDistort(t: { x: number[]; y: number[] }, x: number, y: number): [number, number] {
  const r = Math.hypot(x, y);
  const terms = (a: number, b: number): number[] => [1, a, b, r, a * a, a * b, b * b, a ** 3, a * a * b, a * b * b, b ** 3, r ** 3, a ** 4, a ** 3 * b, a * a * b * b, a * b ** 3, b ** 4, a ** 5, a ** 4 * b, a ** 3 * b * b, a * a * b ** 3, a * b ** 4, b ** 5, r ** 5, a ** 6, a ** 5 * b, a ** 4 * b * b, a ** 3 * b ** 3, a * a * b ** 4, a * b ** 5, b ** 6, a ** 7, a ** 6 * b, a ** 5 * b * b, a ** 4 * b ** 3, a ** 3 * b ** 4, a * a * b ** 5, a * b ** 6, b ** 7, r ** 7];
  const tx = terms(x, y), ty = terms(y, x);
  let ox = 0, oy = 0;
  for (let i = 0; i < 40; i++) { if (t.x[i]) ox += t.x[i] * tx[i]; if (t.y[i]) oy += t.y[i] * ty[i]; }
  return [ox, oy];
}
const argd = (a: number, b: number): number => Math.atan2(b, a) * R2D; // the papers' arg(a, b)
const clampAsin = (v: number): number => Math.asin(Math.max(-1, Math.min(1, v))) * R2D;

/** Intermediate (x, y) in degrees to native (φ, θ) for the projection, or null outside its domain. */
function inverseProjection(w: Wcs, ix: number, iy: number): [number, number] | null {
  const p = w.proj, r = Math.hypot(ix, iy), pv = w.pv;
  let phi = 0, theta = 0;
  if (ZENITHAL.has(p)) {
    phi = r === 0 ? 0 : argd(-iy, ix);
    switch (p) {
      case 'TAN': case 'TPV': theta = Math.atan2(R2D, r) * R2D; break;
      case 'SIN': {
        const xi = pv[1] || 0, eta = pv[2] || 0;
        if (xi === 0 && eta === 0) { const s = r * D2R; if (s > 1) return null; theta = Math.acos(s) * R2D; }
        else { // the slant orthographic
          const X = ix * D2R, Y = iy * D2R, a = xi * xi + eta * eta + 1, b = xi * (X - xi) + eta * (Y - eta), c = (X - xi) ** 2 + (Y - eta) ** 2 - 1;
          const disc = b * b - a * c; if (disc < 0) return null;
          const t = (-b + Math.sqrt(disc)) / a;
          theta = clampAsin(t);
          phi = Math.atan2(X - xi * (1 - Math.sin(theta * D2R)), -(Y - eta * (1 - Math.sin(theta * D2R)))) * R2D;
        }
        break;
      }
      case 'ARC': theta = 90 - r; break;
      case 'STG': theta = 90 - 2 * Math.atan((r * D2R) / 2) * R2D; break;
      case 'ZEA': { const s = (r * D2R) / 2; if (s > 1) return null; theta = 90 - 2 * Math.asin(s) * R2D; break; }
      case 'AZP': { // zenithal perspective from distance μ with the plane tilted by γ (Calabretta & Greisen 2002, §5.1.1)
        const mu = pv[1] || 0, gamma = (pv[2] || 0) * D2R, cg = Math.cos(gamma);
        const rr = Math.hypot(ix, iy * cg), den = R2D * (mu + 1) + iy * Math.sin(gamma);
        if (!den) return null;
        const rho = rr / den, s = (rho * mu) / Math.sqrt(rho * rho + 1);
        if (Math.abs(s) > 1 + 1e-13) return null;
        const psi = argd(rho, 1), om = clampAsin(s);
        phi = rr === 0 ? 0 : argd(-iy * cg, ix);
        let a = psi - om, b = psi + om + 180; // two solutions; the one nearer the pole (as wcslib chooses)
        if (a > 90) a -= 360; if (b > 90) b -= 360;
        theta = Math.max(a, b);
        break;
      }
      case 'SZP': { // slant zenithal perspective: the projection point at μ along (φc, θc)
        const mu = pv[1] || 0, phic = (pv[2] || 0) * D2R, thetac = (pv[3] ?? 90) * D2R;
        const xp = -mu * Math.cos(thetac) * Math.sin(phic), yp = mu * Math.cos(thetac) * Math.cos(phic), zp = mu * Math.sin(thetac) + 1;
        const X = ix * D2R, Y = iy * D2R, a1 = xp - X, b1 = yp - Y;
        const A = a1 * a1 + b1 * b1 + zp * zp, B = 2 * zp * (X * a1 + Y * b1 - zp), C = zp * zp * (X * X + Y * Y);
        const disc = B * B - 4 * A * C; if (disc < 0 || A === 0) return null;
        const roots = [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)].filter((sv) => sv >= 0 && sv <= 2);
        if (!roots.length) return null;
        const sv = roots[0]; // 1 − sin θ: the smaller is nearer the pole, the visible side
        theta = clampAsin(1 - sv);
        phi = Math.atan2(X * (zp - sv) + xp * sv, -(Y * (zp - sv) + yp * sv)) * R2D;
        break;
      }
      case 'ZPN': { // R = (180/π) Σ Pk ζ^k with ζ = 90° − θ in radians; solved for ζ by Newton's method
        const coef = pv.slice(0, 21), rr = r * D2R;
        const f = (z: number) => coef.reduce((acc, c, k) => acc + c * z ** k, 0) - rr, df = (z: number) => coef.reduce((acc, c, k) => acc + (k ? k * c * z ** (k - 1) : 0), 0);
        let z = coef[1] ? rr / coef[1] : rr, ok = false;
        for (let i = 0; i < 50; i++) { const d = df(z); if (!d) break; const nz = z - f(z) / d; if (Math.abs(nz - z) < 1e-13) { z = nz; ok = true; break; } z = nz; }
        if (!ok || !Number.isFinite(z) || z < 0 || z > Math.PI) return null;
        theta = 90 - z * R2D;
        break;
      }
      case 'AIR': { // Airy's minimum-error projection, inverted by bisection on ξ = (90° − θ)/2
        const thetab = pv[1] ?? 90, xib = ((90 - thetab) / 2) * D2R;
        const tb = Math.tan(xib), kb = Math.abs(xib) < 1e-9 ? -0.5 : Math.log(Math.cos(xib)) / (tb * tb);
        const fwd = (xi: number): number => (xi <= 0 ? 0 : -2 * R2D * (Math.log(Math.cos(xi)) / Math.tan(xi) + kb * Math.tan(xi)));
        let lo = 0, hi = Math.PI / 2 - 1e-6;
        if (r > fwd(hi)) return null;
        for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (fwd(mid) < r) lo = mid; else hi = mid; }
        theta = 90 - 2 * ((lo + hi) / 2) * R2D;
        break;
      }
    }
  } else if (CYLINDRICAL.has(p)) {
    phi = ix;
    if (p === 'CAR') theta = iy;
    else if (p === 'MER') theta = 2 * Math.atan(Math.exp(iy * D2R)) * R2D - 90;
    else if (p === 'CEA') { const lam = pv[1] || 1, s = lam * iy * D2R; if (Math.abs(s) > 1) return null; theta = Math.asin(s) * R2D; }
    else { // CYP: cylindrical perspective from μ, radius λ
      const mu = pv[1] ?? 1, lam = pv[2] ?? 1;
      if (!lam || mu + lam === 0) return null;
      phi = ix / lam;
      const eta = (iy * D2R) / (mu + lam);
      theta = argd(1, eta) + clampAsin((eta * mu) / Math.sqrt(eta * eta + 1));
    }
  } else if (PSEUDO.has(p)) {
    if (p === 'AIT') {
      const z2 = 1 - (ix * D2R / 4) ** 2 - (iy * D2R / 2) ** 2; if (z2 < 0.5) return null;
      const z = Math.sqrt(z2);
      phi = 2 * Math.atan2((z * ix * D2R) / 2, 2 * z2 - 1) * R2D;
      const s = iy * D2R * z; if (Math.abs(s) > 1) return null; theta = Math.asin(s) * R2D;
    } else if (p === 'PAR') {
      const s = iy / 180; if (Math.abs(s) > 1) return null;
      theta = 3 * Math.asin(s) * R2D; const d = 1 - 4 * s * s; if (!d) return null; phi = ix / d;
    } else if (p === 'MOL') {
      const sg = (iy * D2R) / Math.SQRT2; if (Math.abs(sg) > 1) return null;
      const g = Math.asin(sg), cg = Math.cos(g); if (!cg) return null;
      phi = (Math.PI * ix) / (2 * Math.SQRT2 * cg);
      theta = clampAsin((2 * g + Math.sin(2 * g)) / Math.PI);
    } else if (p === 'BON') {
      const t1 = pv[1] || 0;
      if (t1 === 0) { theta = iy; const c = Math.cos(theta * D2R); if (!c) return null; phi = ix / c; } // Sanson–Flamsteed
      else {
        const y0 = R2D / Math.tan(t1 * D2R) + t1, rt = Math.sign(t1) * Math.hypot(ix, y0 - iy);
        if (!rt) return null;
        const aphi = argd((y0 - iy) / rt, ix / rt);
        theta = y0 - rt; const c = Math.cos(theta * D2R); if (!c) return null;
        phi = (aphi * rt * D2R) / c;
      }
    } else if (p === 'PCO') { // polyconic: Newton's method on (φ, θ) with the forward projection
      const fwd = (f: number, t: number): [number, number] => { const st = Math.sin(t * D2R); if (Math.abs(st) < 1e-10) return [f, t]; const ct = Math.cos(t * D2R) / st; return [R2D * ct * Math.sin(f * D2R * st), R2D * ct * (1 - Math.cos(f * D2R * st)) + t]; };
      let f = ix, t = iy;
      for (let i = 0; i < 60; i++) {
        const [x0, y0] = fwd(f, t), ex = x0 - ix, ey = y0 - iy;
        if (Math.abs(ex) < 1e-11 && Math.abs(ey) < 1e-11) break;
        const h = 1e-5, [xa, ya] = fwd(f + h, t), [xb, yb] = fwd(f, t + h);
        const a = (xa - x0) / h, b = (xb - x0) / h, c = (ya - y0) / h, d = (yb - y0) / h, det = a * d - b * c;
        if (!det) return null;
        f -= (d * ex - b * ey) / det; t -= (-c * ex + a * ey) / det;
        if (!Number.isFinite(f) || !Number.isFinite(t)) return null;
      }
      phi = f; theta = t;
    } else { theta = iy; const c = Math.cos(theta * D2R); if (Math.abs(c) < 1e-12) return null; phi = ix / c; } // SFL / GLS
  } else if (CONIC.has(p)) {
    const ta = pv[1] || 0, eta = pv[2] || 0, t1 = ta - eta, t2 = ta + eta;
    const sa = Math.sin(ta * D2R), ca = Math.cos(ta * D2R);
    let C: number, y0: number, thetaOf: (rt: number) => number;
    if (p === 'COP') { C = sa; const ce = Math.cos(eta * D2R); y0 = (R2D * ce * ca) / sa; thetaOf = (rt) => ta + Math.atan(ca / sa - (rt * D2R) / ce) * R2D; }
    else if (p === 'COE') { const s1 = Math.sin(t1 * D2R), s2 = Math.sin(t2 * D2R), g = s1 + s2; C = g / 2; y0 = ((R2D * 2) / g) * Math.sqrt(Math.max(0, 1 + s1 * s2 - g * sa)); thetaOf = (rt) => clampAsin((1 + s1 * s2 - (rt * g * D2R / 2) ** 2) / g); }
    else if (p === 'COD') { const e = eta * D2R; C = e ? (sa * Math.sin(e)) / e : sa; y0 = (e ? (eta / Math.tan(e)) : R2D) * (ca / sa); thetaOf = (rt) => ta + y0 - rt; }
    else { // COO
      const c1 = Math.cos(t1 * D2R), c2 = Math.cos(t2 * D2R), tn1 = Math.tan(((90 - t1) / 2) * D2R), tn2 = Math.tan(((90 - t2) / 2) * D2R);
      C = t1 === t2 ? Math.sin(t1 * D2R) : Math.log(c2 / c1) / Math.log(tn2 / tn1);
      const psi = (R2D * c1) / (C * tn1 ** C);
      y0 = psi * Math.tan(((90 - ta) / 2) * D2R) ** C;
      thetaOf = (rt) => 90 - 2 * Math.atan((rt / psi) ** (1 / C)) * R2D;
    }
    if (!C) return null;
    const rt = Math.sign(ta || 1) * Math.hypot(ix, y0 - iy);
    if (!rt) return null;
    const aphi = argd((y0 - iy) / rt, ix / rt);
    phi = aphi / C; theta = thetaOf(rt);
  } else if (QUADCUBE.has(p)) {
    const d = cubeDirection(p, ix / 45, iy / 45); if (!d) return null;
    const [l, m, n] = d;
    phi = l === 0 && m === 0 ? 0 : argd(l, m); theta = clampAsin(n);
  } else if (p === 'HPX') { // HEALPix (Calabretta & Roukema 2007): H facets around, K rows; wcslib's inverse
    const H = pv[1] || 4, K = pv[2] || 3, mOdd = Math.round(H) % 2, nOdd = Math.round(K) % 2;
    if (H <= 0 || K <= 0) return null;
    const w3 = (90 * K) / H, w4 = (K + 1) / 2, w5 = (90 * (K - 1)) / H, w6 = 180 / H, w7 = H / 360;
    let tx = -180 + (2 * Math.floor((ix + 180) * w7) + 1) * w6; tx = ix - tx; // the offset within the facet
    const absy = Math.abs(iy);
    if (absy <= w5) { phi = ix; theta = clampAsin(iy / w3); }
    else if (absy <= w6 * w4) {
      const offset = nOdd || iy > 0 ? 0 : 1, sigma = w4 - absy / w6;
      let sl: number, t: number;
      if (sigma === 0) { sl = 1e9; t = 90; } else { t = 1 - (sigma * sigma) / K; if (t < -1) return null; sl = 1 / sigma; t = clampAsin(t); }
      if (iy < 0) t = -t;
      if (offset) { const hh = Math.floor(ix / w6) + mOdd; tx += hh % 2 ? -w6 : w6; }
      let r = sl * tx; if (Math.abs(r) >= w6 + 1e-12) return null; if (r !== 0) r -= tx;
      phi = ix + r; theta = t;
    } else return null;
  } else if (p === 'XPH') { // HEALPix polar, the "butterfly": wcslib's inverse
    const xr = ix / Math.SQRT2, yr = iy / Math.SQRT2;
    let xi1: number, eta1: number;
    if (xr <= 0 && yr > 0) { xi1 = -xr - yr; eta1 = xr - yr; phi = -180; }
    else if (xr < 0 && yr <= 0) { xi1 = xr - yr; eta1 = xr + yr; phi = -90; }
    else if (xr >= 0 && yr < 0) { xi1 = xr + yr; eta1 = -xr + yr; phi = 0; }
    else { xi1 = -xr + yr; eta1 = -xr - yr; phi = 90; }
    const xi = xi1 + 45, eta = eta1 + 90, abseta = Math.abs(eta);
    if (abseta > 90) return null;
    if (abseta <= 45) { phi += xi; theta = clampAsin(eta / 67.5); if (Math.abs(xi1) > 45 + 1e-12) return null; }
    else {
      const sigma = (90 - abseta) / 45;
      if (xr === 0) phi = yr <= 0 ? 0 : 180; else if (yr === 0) phi = xr < 0 ? -90 : 90; else phi += 45 + xi1 / sigma;
      theta = sigma < 1e-4 ? 90 - sigma * Math.sqrt(2 / 3) * R2D : clampAsin(1 - (sigma * sigma) / 3);
      if (eta < 0) theta = -theta;
      if (eta < -45 && eta + 90 + 1e-12 < Math.abs(xi1)) return null;
    }
  } else return null;
  if (!Number.isFinite(phi) || !Number.isFinite(theta) || Math.abs(phi) > 180 + 1e-11 || Math.abs(theta) > 90 + 1e-11) return null; // wcslib's native bounds check
  return [phi, theta];
}

/**
 * The direction cosines (l, m, n) for a point of the quad-cube layout in face units (45° each), following wcslib:
 * faces 1–4 around the equator at x = 0, 2, 4, 6 (negative x wraps), face 0 above face 1 and face 5 below it.
 * TSC is gnomonic on each face; QSC (O'Neill & Laubscher's quadrilateralized cube) is equal-area.
 */
function cubeDirection(p: string, xf0: number, yf0: number): [number, number, number] | null {
  // wcslib works CSC in single precision from the start (the position in face units is rounded before the face is taken
  // off), TSC and QSC in double; the same order here gives its positions to the last digit.
  const r = p === 'CSC' ? Math.fround : (v: number): number => v;
  let xf = r(xf0), yf = r(yf0);
  if (Math.abs(xf) <= 1) { if (Math.abs(yf) > 3) return null; } else if (Math.abs(xf) > 7 || Math.abs(yf) > 1) return null;
  if (xf < -1) xf = r(xf + 8);
  let face: number;
  if (xf > 5) { face = 4; xf = r(xf - 6); } else if (xf > 3) { face = 3; xf = r(xf - 4); } else if (xf > 1) { face = 2; xf = r(xf - 2); } else if (yf > 1) { face = 0; yf = r(yf - 2); } else if (yf < -1) { face = 5; yf = r(yf + 2); } else face = 1;
  if (p === 'TSC') {
    const q = 1 / Math.sqrt(1 + xf * xf + yf * yf);
    switch (face) {
      case 4: return [q * xf, -q, q * yf];
      case 3: return [-q, -q * xf, q * yf];
      case 2: return [-q * xf, q, q * yf];
      case 0: return [-q * yf, q * xf, q];
      case 5: return [q * yf, q * xf, -q];
      default: return [q, q * xf, q * yf];
    }
  }
  if (p === 'CSC') { // COBE's quadrilateralized spherical cube: the inverse polynomial fit (Chan & O'Neill), as wcslib evaluates it (single precision)
    const P = [-0.27292696, -0.07629969, -0.22797056, 0.54852384, -0.62930065, 0.25795794, 0.02584375, -0.02819452, -0.01471565, 0.48051509, -1.74114454, 1.71547508, -0.53022337, 0.27058160, -0.56800938, 0.30803317, 0.98938102, -0.83180469, -0.60441560, 1.50880086, -0.93678576, 0.08693841, 0.93412077, -1.41601920, 0.33887446, -0.63915306, 0.52032238, 0.14381585].map(Math.fround);
    const [p00, p10, p20, p30, p40, p50, p60, p01, p11, p21, p31, p41, p51, p02, p12, p22, p32, p42, p03, p13, p23, p33, p04, p14, p24, p05, p15, p06] = P;
    const f = Math.fround, xf32 = f(xf), yf32 = f(yf), xx = f(xf32 * xf32), yy = f(yf32 * yf32);
    const series = (a: number, b: number): number => { // the polynomial in a (the "own" square) with coefficients in b
      const z0 = f(p00 + f(a * f(p10 + f(a * f(p20 + f(a * f(p30 + f(a * f(p40 + f(a * f(p50 + f(a * p60)))))))))))), z1 = f(p01 + f(a * f(p11 + f(a * f(p21 + f(a * f(p31 + f(a * f(p41 + f(a * p51)))))))))), z2 = f(p02 + f(a * f(p12 + f(a * f(p22 + f(a * f(p32 + f(a * p42)))))))), z3 = f(p03 + f(a * f(p13 + f(a * f(p23 + f(a * p33)))))), z4 = f(p04 + f(a * f(p14 + f(a * p24)))), z5 = f(p05 + f(a * p15)), z6 = p06;
      return f(z0 + f(b * f(z1 + f(b * f(z2 + f(b * f(z3 + f(b * f(z4 + f(b * f(z5 + f(b * z6))))))))))));
    };
    const chi = f(xf32 + f(f(xf32 * f(1 - xx)) * series(xx, yy))), psi = f(yf32 + f(f(yf32 * f(1 - yy)) * series(yy, xx)));
    const t = 1 / Math.sqrt(f(f(chi * chi) + f(psi * psi)) + 1); // χ² + ψ² in single precision, the rest in double, as wcslib has it
    switch (face) {
      case 1: return [t, chi * t, psi * t];
      case 2: return [-chi * t, t, psi * t];
      case 3: return [-t, -chi * t, psi * t]; // n keeps the sign of ψ on every equatorial face (wcslib: n = -ψ·l with l = -t)
      case 4: return [chi * t, -t, psi * t];
      case 5: return [-psi * -t, -chi * -t, -t];
      default: return [-psi * t, chi * t, t];
    }
  }
  const direct = Math.abs(xf) > Math.abs(yf);
  let omega = 0, tau = 1, zeta = 1, zeco = 0;
  const major = direct ? xf : yf, minor = direct ? yf : xf;
  if (major !== 0) {
    const w = (15 * minor) / major;
    omega = Math.sin(w * D2R) / (Math.cos(w * D2R) - Math.SQRT1_2);
    tau = 1 + omega * omega;
    zeco = major * major * (1 - 1 / Math.sqrt(1 + tau));
    zeta = 1 - zeco;
  }
  let w: number;
  if (zeta < -1) { if (zeta < -1 - 1e-12) return null; zeta = -1; w = 0; } else w = Math.sqrt((zeco * (2 - zeco)) / tau);
  const sgn = (v: number, neg: boolean): number => (neg ? -v : v);
  let l: number, m: number, n: number;
  switch (face) {
    case 1: if (direct) { m = sgn(w, xf < 0); n = m * omega; } else { n = sgn(w, yf < 0); m = n * omega; } l = zeta; break;
    case 2: if (direct) { l = sgn(w, xf > 0); n = -l * omega; } else { n = sgn(w, yf < 0); l = -n * omega; } m = zeta; break;
    case 3: if (direct) { m = sgn(w, xf > 0); n = -m * omega; } else { n = sgn(w, yf < 0); m = -n * omega; } l = -zeta; break;
    case 4: if (direct) { l = sgn(w, xf < 0); n = l * omega; } else { n = sgn(w, yf < 0); l = n * omega; } m = -zeta; break;
    case 5: if (direct) { m = sgn(w, xf < 0); l = m * omega; } else { l = sgn(w, yf < 0); m = l * omega; } n = -zeta; break;
    default: if (direct) { m = sgn(w, xf < 0); l = -m * omega; } else { l = sgn(w, yf > 0); m = -l * omega; } n = zeta; break;
  }
  return [l, m, n];
}
