/**
 * XMP packets: reading the properties Anne's Lens edits (title, caption, creator, copyright, keywords,
 * rating, color label, favorite and pick/reject flags, date created, location, IPTC Core fields, the
 * digital source type, citation fields) and writing them back into an existing packet while leaving
 * everything else in it untouched. Text manipulation, not a full RDF parser: the properties are
 * replaced in the first rdf:Description and unknown content is kept verbatim.
 */

export const NS: Record<string, string> = {
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  exif: 'http://ns.adobe.com/exif/1.0/',
  Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/',
  Iptc4xmpExt: 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/',
  lens: 'https://socrtwo.github.io/annes-lens/ns/1.0/',
  'mwg-rs': 'http://www.metadataworkinggroup.com/schemas/regions/',
  stArea: 'http://ns.adobe.com/xmp/sType/Area#',
  stDim: 'http://ns.adobe.com/xap/1.0/sType/Dimensions#',
};

export interface Citation { repository?: string; collection?: string; callNumber?: string; item?: string; page?: string; accessed?: string; text?: string }
export interface XmpProps {
  title?: string; description?: string; creator?: string[]; rights?: string; keywords?: string[];
  rating?: number; label?: string; favorite?: boolean; flag?: 'pick' | 'reject' | '';
  dateCreated?: string; createDate?: string; modifyDate?: string;
  city?: string; state?: string; country?: string; location?: string; headline?: string; credit?: string; source?: string; instructions?: string; writer?: string; jobTitle?: string;
  lat?: number; lon?: number;
  digitalSourceType?: string; personInImage?: string[]; usageTerms?: string;
  /** Accessibility (IPTC 2021): alt text and extended description. */
  altText?: string; extDescription?: string;
  /** AI provenance written by the AI tab (Anne's Lens namespace). */
  aiCommand?: string; aiProvider?: string; aiModel?: string; aiPrompt?: string; aiDate?: string;
  citation?: Citation;
}

const PROP: Record<string, { ns: string; name: string; kind: 'text' | 'alt' | 'bag' | 'seq' | 'number' | 'bool' }> = {
  title: { ns: 'dc', name: 'title', kind: 'alt' }, description: { ns: 'dc', name: 'description', kind: 'alt' }, creator: { ns: 'dc', name: 'creator', kind: 'seq' }, rights: { ns: 'dc', name: 'rights', kind: 'alt' }, keywords: { ns: 'dc', name: 'subject', kind: 'bag' },
  rating: { ns: 'xmp', name: 'Rating', kind: 'number' }, label: { ns: 'xmp', name: 'Label', kind: 'text' }, createDate: { ns: 'xmp', name: 'CreateDate', kind: 'text' }, modifyDate: { ns: 'xmp', name: 'ModifyDate', kind: 'text' },
  favorite: { ns: 'lens', name: 'Favorite', kind: 'bool' }, flag: { ns: 'lens', name: 'Flag', kind: 'text' },
  dateCreated: { ns: 'photoshop', name: 'DateCreated', kind: 'text' }, city: { ns: 'photoshop', name: 'City', kind: 'text' }, state: { ns: 'photoshop', name: 'State', kind: 'text' }, country: { ns: 'photoshop', name: 'Country', kind: 'text' }, headline: { ns: 'photoshop', name: 'Headline', kind: 'text' }, credit: { ns: 'photoshop', name: 'Credit', kind: 'text' }, source: { ns: 'photoshop', name: 'Source', kind: 'text' }, instructions: { ns: 'photoshop', name: 'Instructions', kind: 'text' }, writer: { ns: 'photoshop', name: 'CaptionWriter', kind: 'text' }, jobTitle: { ns: 'photoshop', name: 'AuthorsPosition', kind: 'text' },
  location: { ns: 'Iptc4xmpCore', name: 'Location', kind: 'text' }, digitalSourceType: { ns: 'Iptc4xmpExt', name: 'DigitalSourceType', kind: 'text' }, personInImage: { ns: 'Iptc4xmpExt', name: 'PersonInImage', kind: 'bag' }, usageTerms: { ns: 'xmpRights', name: 'UsageTerms', kind: 'alt' },
  altText: { ns: 'Iptc4xmpCore', name: 'AltTextAccessibility', kind: 'alt' }, extDescription: { ns: 'Iptc4xmpCore', name: 'ExtDescrAccessibility', kind: 'alt' },
  aiCommand: { ns: 'lens', name: 'AiCommand', kind: 'text' }, aiProvider: { ns: 'lens', name: 'AiProvider', kind: 'text' }, aiModel: { ns: 'lens', name: 'AiModel', kind: 'text' }, aiPrompt: { ns: 'lens', name: 'AiPrompt', kind: 'text' }, aiDate: { ns: 'lens', name: 'AiDate', kind: 'text' },
};
const CITATION: (keyof Citation)[] = ['repository', 'collection', 'callNumber', 'item', 'page', 'accessed', 'text'];
const citName = (k: string) => 'Citation' + k[0].toUpperCase() + k.slice(1);

export const unescapeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
export const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The prefix a packet uses for a namespace URI (its declared one, else our default). */
function prefixFor(xml: string, ns: string): string {
  const m = xml.match(new RegExp(`xmlns:([A-Za-z0-9_.-]+)=["']${esc(NS[ns])}["']`));
  return m ? m[1] : ns;
}

function readText(xml: string, p: string, name: string): string | undefined {
  const el = xml.match(new RegExp(`<${esc(p)}:${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(p)}:${name}>`));
  if (el) { const inner = el[1]; const li = inner.match(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/); return unescapeXml((li ? li[1] : inner).trim()); }
  // An attribute's value ends at the quote it began with: "Coeur d'Alene" holds an apostrophe.
  const at = xml.match(new RegExp(`\\s${esc(p)}:${name}=(?:"([^"]*)"|'([^']*)')`));
  return at ? unescapeXml(at[1] ?? at[2]) : undefined;
}
function readList(xml: string, p: string, name: string): string[] | undefined {
  const el = xml.match(new RegExp(`<${esc(p)}:${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(p)}:${name}>`));
  if (!el) { const at = readText(xml, p, name); return at === undefined ? undefined : at.split(/\s*[;,]\s*/).filter(Boolean); }
  return [...el[1].matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((m) => unescapeXml(m[1].trim())).filter(Boolean);
}

/** GPS coordinate in XMP form ("51,30.5N" or "51,30,30N") → decimal degrees. */
export function parseXmpGps(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:,(\d+(?:\.\d+)?))?\s*([NSEW])?$/i);
  if (!m) { const n = Number(s); return Number.isFinite(n) ? n : undefined; }
  let v = +m[1] + (m[2] ? +m[2] / 60 : 0) + (m[3] ? +m[3] / 3600 : 0);
  if (m[4] && /[SW]/i.test(m[4])) v = -v;
  return v;
}
export function formatXmpGps(v: number, lat: boolean): string {
  const a = Math.abs(v), d = Math.floor(a), m = ((a - d) * 60).toFixed(6).replace(/\.?0+$/, '');
  return `${d},${m}${lat ? (v < 0 ? 'S' : 'N') : v < 0 ? 'W' : 'E'}`;
}

/** Reads the known properties from a packet. */
export function parseXmp(xml: string): XmpProps {
  const out: XmpProps = {};
  for (const [key, p] of Object.entries(PROP)) {
    const pre = prefixFor(xml, p.ns);
    if (p.kind === 'bag' || p.kind === 'seq') { const v = readList(xml, pre, p.name); if (v) (out as any)[key] = v; }
    else { const v = readText(xml, pre, p.name); if (v === undefined) continue; if (p.kind === 'number') { const n = Number(v); if (Number.isFinite(n)) (out as any)[key] = n; } else if (p.kind === 'bool') (out as any)[key] = /^(true|1|yes)$/i.test(v); else (out as any)[key] = v; }
  }
  const ex = prefixFor(xml, 'exif');
  const lat = parseXmpGps(readText(xml, ex, 'GPSLatitude')), lon = parseXmpGps(readText(xml, ex, 'GPSLongitude'));
  if (lat !== undefined && lon !== undefined) { out.lat = lat; out.lon = lon; }
  const lp = prefixFor(xml, 'lens'); const cit: Citation = {}; let any = false;
  for (const k of CITATION) { const v = readText(xml, lp, citName(k)); if (v !== undefined) { cit[k] = v; any = true; } }
  if (any) out.citation = cit;
  if (out.flag && out.flag !== 'pick' && out.flag !== 'reject') out.flag = '';
  return out;
}

/** An empty packet. */
export function emptyXmp(): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Anne's Lens">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n  <rdf:Description rdf:about="">\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`;
}

function removeProp(xml: string, p: string, name: string): string {
  return xml.replace(new RegExp(`\\s*<${esc(p)}:${name}(?:\\s[^>]*)?>[\\s\\S]*?</${esc(p)}:${name}>`, 'g'), '').replace(new RegExp(`\\s*<${esc(p)}:${name}(?:\\s[^>]*)?/>`, 'g'), '').replace(new RegExp(`\\s${esc(p)}:${name}=(?:"[^"]*"|'[^']*')`, 'g'), '');
}
function ensureNs(xml: string, p: string, uri: string): string {
  if (new RegExp(`xmlns:${esc(p)}=`).test(xml)) return xml;
  return xml.replace(/<rdf:Description\b/, `<rdf:Description xmlns:${p}="${uri}"`);
}
function insert(xml: string, element: string): string {
  const i = xml.search(/<\/rdf:Description>/);
  if (i < 0) return xml;
  return xml.slice(0, i) + element + '\n  ' + xml.slice(i);
}
const altEl = (p: string, name: string, v: string) => `<${p}:${name}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(v)}</rdf:li></rdf:Alt></${p}:${name}>`;
const listEl = (p: string, name: string, kind: 'bag' | 'seq', v: string[]) => `<${p}:${name}><rdf:${kind === 'bag' ? 'Bag' : 'Seq'}>${v.map((x) => `<rdf:li>${escapeXml(x)}</rdf:li>`).join('')}</rdf:${kind === 'bag' ? 'Bag' : 'Seq'}></${p}:${name}>`;
const textEl = (p: string, name: string, v: string) => `<${p}:${name}>${escapeXml(v)}</${p}:${name}>`;

/**
 * Writes the properties in `patch` into the packet (created when `xml` is empty). A property set to
 * undefined, an empty string or an empty array is removed. Returns the packet text.
 */
export function updateXmp(xml: string | null | undefined, patch: Partial<XmpProps>): string {
  let out = xml && /<rdf:Description/.test(xml) ? xml : emptyXmp();
  if (!/<\/rdf:Description>/.test(out)) out = out.replace(/<rdf:Description\b([^>]*)\/>/, '<rdf:Description$1>\n  </rdf:Description>');
  const set = (ns: string, name: string, el: ((p: string) => string) | null) => {
    const p = prefixFor(out, ns);
    out = removeProp(out, p, name);
    if (el) { out = ensureNs(out, p, NS[ns]); out = insert(out, el(p)); }
  };
  for (const [key, val] of Object.entries(patch)) {
    if (key === 'lat' || key === 'lon' || key === 'citation') continue;
    const p = PROP[key]; if (!p) continue;
    const empty = val === undefined || val === null || val === '' || (Array.isArray(val) && !val.length) || (p.kind === 'bool' && val === false);
    if (empty) { set(p.ns, p.name, null); continue; }
    if (p.kind === 'alt') set(p.ns, p.name, (pre) => altEl(pre, p.name, String(val)));
    else if (p.kind === 'bag' || p.kind === 'seq') set(p.ns, p.name, (pre) => listEl(pre, p.name, p.kind as 'bag' | 'seq', val as string[]));
    else if (p.kind === 'bool') set(p.ns, p.name, (pre) => textEl(pre, p.name, 'True'));
    else set(p.ns, p.name, (pre) => textEl(pre, p.name, String(val)));
  }
  if ('lat' in patch || 'lon' in patch) {
    const has = typeof patch.lat === 'number' && typeof patch.lon === 'number';
    set('exif', 'GPSLatitude', has ? (pre) => textEl(pre, 'GPSLatitude', formatXmpGps(patch.lat!, true)) : null);
    set('exif', 'GPSLongitude', has ? (pre) => textEl(pre, 'GPSLongitude', formatXmpGps(patch.lon!, false)) : null);
  }
  if ('citation' in patch) {
    const c = patch.citation || {};
    for (const k of CITATION) set('lens', citName(k), c[k] ? (pre) => textEl(pre, citName(k), c[k]!) : null);
  }
  return out;
}

/** Removes location, people and the editing history from a packet (for Privacy and Remove Location). */
export function scrubXmp(xml: string, what: { location?: boolean; people?: boolean; history?: boolean }): string {
  let out = xml;
  if (what.location) {
    const ex = prefixFor(out, 'exif');
    for (const n of ['GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'GPSAltitudeRef', 'GPSTimeStamp', 'GPSDateStamp', 'GPSMapDatum', 'GPSVersionID']) out = removeProp(out, ex, n);
    for (const k of ['city', 'state', 'country', 'location'] as const) out = removeProp(out, prefixFor(out, PROP[k].ns), PROP[k].name);
    out = out.replace(/\s*<Iptc4xmpExt:Location(Created|Shown)>[\s\S]*?<\/Iptc4xmpExt:Location\1>/g, '');
  }
  if (what.people) { out = removeProp(out, prefixFor(out, 'Iptc4xmpExt'), 'PersonInImage'); out = out.replace(/\s*<mwg-rs:Regions>[\s\S]*?<\/mwg-rs:Regions>/g, ''); }
  if (what.history) { out = out.replace(/\s*<xmpMM:History>[\s\S]*?<\/xmpMM:History>/g, '').replace(/\s*<xmpMM:DerivedFrom(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/xmpMM:DerivedFrom>)/g, ''); }
  return out;
}

/** True when a packet carries anything beyond an empty description. */
export const xmpIsEmpty = (xml: string): boolean => /<rdf:Description[^>]*>\s*<\/rdf:Description>/.test(xml) && !/<rdf:Description[^>]*\s[A-Za-z0-9]+:[A-Za-z]+=/.test(xml);


// Region tags (MWG regions: named faces, pets and objects) and the person links on them --------

export interface Region {
  name: string;
  /** Face | Pet | Focus | BarCode | Object (free text allowed). */
  type: string;
  /** Normalized center and size, 0..1 of the picture. */
  area: { x: number; y: number; w: number; h: number };
  /** Person link (Anne's Lens): a person record's details copied onto the region. */
  personId?: string;
  born?: string;
  died?: string;
}
export interface RegionDoc { dims: { w: number; h: number } | null; regions: Region[] }

const numAttr = (s: string, name: string): number | undefined => { const m = s.match(new RegExp(`${esc(name)}=["']\\s*([-\\d.]+)`)); return m ? +m[1] : undefined; };
const strAttr = (s: string, name: string): string | undefined => { const m = s.match(new RegExp(`${esc(name)}=(?:"([^"]*)"|'([^']*)')`)); return m ? unescapeXml(m[1] ?? m[2]) : undefined; };

/** Reads the MWG region list (named areas) and the Anne's Lens person links on them. */
export function readRegions(xml: string | null | undefined): RegionDoc {
  const out: RegionDoc = { dims: null, regions: [] };
  if (!xml) return out;
  const block = xml.match(/<mwg-rs:Regions[\s\S]*?<\/mwg-rs:Regions>|<mwg-rs:Regions[^>]*rdf:parseType=["']Resource["'][\s\S]*?<\/mwg-rs:Regions>/);
  const scope = block ? block[0] : (/<mwg-rs:Regions\b/.test(xml) ? xml : '');
  if (!scope) return out;
  const dim = scope.match(/<mwg-rs:AppliedToDimensions\b([^>]*)\/?>/);
  if (dim) { const w = numAttr(dim[1], 'stDim:w') ?? numAttr(dim[1], 'w'); const h = numAttr(dim[1], 'stDim:h') ?? numAttr(dim[1], 'h'); if (w && h) out.dims = { w, h }; }
  for (const li of scope.matchAll(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/g)) {
    const body = li[1];
    const name = readText(body, prefixFor(xml, 'mwg-rs') || 'mwg-rs', 'Name') || body.match(/<mwg-rs:Name>([^<]*)</)?.[1];
    const type = body.match(/<mwg-rs:Type>([^<]*)</)?.[1] || 'Face';
    const areaTag = body.match(/<mwg-rs:Area\b([^>]*)\/?>/);
    if (!areaTag) continue;
    const a = areaTag[1];
    const x = numAttr(a, 'stArea:x') ?? numAttr(a, 'x'), y = numAttr(a, 'stArea:y') ?? numAttr(a, 'y'), w = numAttr(a, 'stArea:w') ?? numAttr(a, 'w') ?? numAttr(a, 'stArea:d'), h = numAttr(a, 'stArea:h') ?? numAttr(a, 'h') ?? numAttr(a, 'stArea:d');
    if (x === undefined || y === undefined) continue;
    out.regions.push({ name: name ? unescapeXml(name) : '', type: unescapeXml(type), area: { x, y, w: w ?? 0, h: h ?? 0 }, personId: strAttr(a, 'lens:PersonId'), born: strAttr(a, 'lens:PersonBorn'), died: strAttr(a, 'lens:PersonDied') });
  }
  return out;
}

/** Replaces the MWG region list with `regions` (removes it when empty); keeps the rest of the packet. */
export function writeRegions(xml: string | null | undefined, regions: Region[], dims: { w: number; h: number } | null): string {
  let out = xml && /<rdf:Description/.test(xml) ? xml : emptyXmp();
  if (!/<\/rdf:Description>/.test(out)) out = out.replace(/<rdf:Description\b([^>]*)\/>/, '<rdf:Description$1>\n  </rdf:Description>');
  // PersonInImage lists everyone in the picture, named areas or not: the names that did not come from the old regions
  // stay, and the new regions' names join them.
  const was = new Set(readRegions(out).regions.map((r) => r.name).filter(Boolean));
  out = out.replace(/\s*<mwg-rs:Regions[\s\S]*?<\/mwg-rs:Regions>/g, '');
  const ext = prefixFor(out, 'Iptc4xmpExt');
  const others = (ext ? readList(out, ext, 'PersonInImage') || [] : []).filter((n) => !was.has(n));
  out = removeProp(out, ext, 'PersonInImage');
  if (!regions.length) { if (others.length) { out = ensureNs(out, 'Iptc4xmpExt', NS.Iptc4xmpExt); out = insert(out, listEl(prefixFor(out, 'Iptc4xmpExt'), 'PersonInImage', 'bag', others)); } return out; }
  for (const ns of ['mwg-rs', 'stArea', 'stDim', 'Iptc4xmpExt']) out = ensureNs(out, ns, NS[ns]);
  const li = regions.map((r) => {
    const link = (r.personId ? ` lens:PersonId="${escapeXml(r.personId)}"` : '') + (r.born ? ` lens:PersonBorn="${escapeXml(r.born)}"` : '') + (r.died ? ` lens:PersonDied="${escapeXml(r.died)}"` : '');
    if (link) out = ensureNs(out, 'lens', NS.lens);
    return `    <rdf:li rdf:parseType="Resource">\n     <mwg-rs:Name>${escapeXml(r.name)}</mwg-rs:Name>\n     <mwg-rs:Type>${escapeXml(r.type || 'Face')}</mwg-rs:Type>\n     <mwg-rs:Area stArea:x="${+r.area.x.toFixed(6)}" stArea:y="${+r.area.y.toFixed(6)}" stArea:w="${+r.area.w.toFixed(6)}" stArea:h="${+r.area.h.toFixed(6)}" stArea:unit="normalized"${link}/>\n    </rdf:li>`;
  }).join('\n');
  const dimEl = dims ? `\n   <mwg-rs:AppliedToDimensions stDim:w="${dims.w}" stDim:h="${dims.h}" stDim:unit="pixel"/>` : '';
  const block = `<mwg-rs:Regions rdf:parseType="Resource">${dimEl}\n   <mwg-rs:RegionList>\n    <rdf:Bag>\n${li}\n    </rdf:Bag>\n   </mwg-rs:RegionList>\n  </mwg-rs:Regions>`;
  out = insert(out, block);
  const people = [...new Set([...others, ...regions.map((r) => r.name).filter(Boolean)])];
  if (people.length) out = insert(out, listEl(prefixFor(out, 'Iptc4xmpExt'), 'PersonInImage', 'bag', people));
  return out;
}
