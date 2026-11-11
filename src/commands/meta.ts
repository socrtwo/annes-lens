/**
 * Metadata tab: the EXIF viewer; editing title and caption, keywords, creator and copyright, IPTC,
 * raw XMP and the file comment; templates, copy from another file, compare; date shifting and
 * location; strip, privacy check, content credentials, checksums and fixity manifests; citation
 * fields for records; CSV export and import. Edits go into JPEG, PNG and WebP files in place and
 * into .xmp sidecars for the other formats (or always, per the Write Sidecar or Embed setting).
 * Ratings, color labels, favorites and pick/reject flags live here too (Browse tab).
 */
import { def } from './registry';
import type { App } from '../app';
import type { Entry } from '../picture/folder';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import type { Field } from '../ui/dialog';
import { h } from '../ui/dom';
import { readMeta, patchXmp, patchBytes, forTargets, metaTargets, bytesAndFormat, propsOf } from '../picture/metadata';
import { parseXmp, updateXmp, scrubXmp, type XmpProps, type Citation } from '../meta/xmp';
import { readIptc, writeIptc, type IptcFields } from '../meta/iptc';
import { getComment, setComment, stripMeta, replaceExif, removeGpsFromExif, hasGpsIfd, exifDates, mapExifDates, minimalExif, detectProvenance, sha, md5, parseExifDate, formatExifDate, canEmbed, decodeText, setXmp } from '../meta/metaEdit';
import { extractMeta } from '../meta/metaWrite';
import { readExif } from '../meta/exif';
import { openDocuments, openExternal, saveAs, writeClipboardText, readClipboardText } from '../platform/native';
import { fmtSize } from '../ui/shell';

const has = (app: App) => !!app.picture;
const canEdit = (app: App) => !!app.picture && !!app.picture.entry;
const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (key: string, label: string, value = '', half = false): Field => ({ key, label, type: 'text', value, half });
const area = (key: string, label: string, value = '', rows = 3): Field => ({ key, label, type: 'textarea', value, rows });
const scopeNote = (app: App) => { const n = metaTargets(app).length; return n > 1 ? `Applies to the ${n} marked pictures.` : ''; };
const list = (s: string) => s.split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);

async function currentProps(app: App): Promise<XmpProps> { return (await readMeta(app, app.picture!.entry))?.props || {}; }

def([
  {
    id: 'meta.exif', icon: 'photo_camera', popular: true, noRecord: true, isEnabled: has,
    tip: 'Camera, exposure, date and place, grouped and searchable; copy as text',
    run: async (app) => {
      const pic = app.picture!;
      const e = pic.exif;
      if (!e || !e.tags.length) { toast(`${pic.name} has no EXIF data.`); return; }
      const filter = h('input', { placeholder: 'Filter tags…', 'aria-label': 'Filter tags', style: 'width:100%' }) as HTMLInputElement;
      const table = h('table', { class: 'ql-stats qn-info' });
      const draw = () => {
        const q = filter.value.trim().toLowerCase();
        table.replaceChildren(...e.tags.filter((t) => !q || `${t.name} ${t.value}`.toLowerCase().includes(q)).map((t) => h('tr', null, h('td', null, t.name.replace(/([a-z])([A-Z])/g, '$1 $2')), h('td', null, t.value))));
      };
      filter.addEventListener('input', draw);
      draw();
      const summary = [e.make || e.model ? `${[e.make, e.model].filter(Boolean).join(' ')}` : '', e.exposure, e.dateTaken, e.gps ? `${e.gps.lat.toFixed(5)}, ${e.gps.lon.toFixed(5)}` : ''].filter(Boolean).join(' · ');
      await openDialog({ title: `EXIF — ${pic.name}`, wide: true, content: h('div', null, summary ? h('p', { class: 'ql-help' }, summary) : null, filter, h('div', { style: 'max-height:55vh;overflow:auto;margin-top:6px' }, table)), cancel: false, ok: 'Close', buttons: [
        { label: 'Copy', onClick: () => { navigator.clipboard?.writeText(e.tags.map((t) => `${t.name}\t${t.value}`).join('\n')); toast('Copied'); } },
        ...(e.gps ? [{ label: 'Map', onClick: () => { openExternal(`https://www.openstreetmap.org/?mlat=${e.gps!.lat}&mlon=${e.gps!.lon}#map=16/${e.gps!.lat}/${e.gps!.lon}`); } }] : []),
      ] });
    },
  },

  // View and edit ----------------------------------------------------------------------------------
  {
    id: 'meta.caption', icon: 'title', popular: true, noRecord: true, isEnabled: canEdit, tip: 'Title, caption and headline (XMP dc:title, dc:description, photoshop:Headline)',
    run: async (app) => {
      const v = await currentProps(app);
      const r = await openDialog({ title: 'Title and Caption', ok: 'Save', help: scopeNote(app) || undefined, fields: [text('title', 'Title', v.title || ''), area('description', 'Caption', v.description || '', 4), text('headline', 'Headline', v.headline || '')] });
      if (!r) return;
      await forTargets(app, 'Caption saved', (e) => patchXmp(app, e, { title: r.title.trim(), description: r.description.trim(), headline: r.headline.trim() }));
    },
  },
  {
    id: 'meta.keywords', icon: 'label', popular: true, noRecord: true, isEnabled: canEdit, tip: 'Keywords (XMP dc:subject); "Places|Somerset|Bath" for a hierarchy; autocomplete from earlier keywords',
    run: async (app) => {
      const v = await currentProps(app);
      const many = metaTargets(app).length > 1;
      const r = await openDialog({ title: 'Keywords', ok: 'Save', help: 'One keyword per line or separated by commas. ' + (scopeNote(app) || ''), fields: [
        area('keywords', 'Keywords', (v.keywords || []).join('\n'), 5),
        { key: 'add', label: 'Suggestions', type: 'combo', options: app.prefs.keywordHistory, placeholder: 'Type to search earlier keywords, then press Add', half: true },
        { key: 'addBtn', label: 'Add', type: 'button', half: true, onClick: (vals, ctl) => { const k = String(vals.add || '').trim(); if (!k) return; ctl.set('keywords', [...list(vals.keywords), k].join('\n')); ctl.set('add', ''); } },
        ...(many ? [{ key: 'mode', label: 'On the marked pictures', type: 'select', options: [{ value: 'replace', label: 'Replace their keywords' }, { value: 'add', label: 'Add to their keywords' }], value: 'add', half: true } as Field] : []),
      ] });
      if (!r) return;
      const kws = [...new Set(list(r.keywords))];
      app.prefs.keywordHistory = [...new Set([...kws, ...app.prefs.keywordHistory])].slice(0, 500); app.savePrefs();
      await forTargets(app, 'Keywords saved', async (e) => {
        if (many && r.mode === 'add') { const cur = (await readMeta(app, e))?.props.keywords || []; return patchXmp(app, e, { keywords: [...new Set([...cur, ...kws])] }); }
        return patchXmp(app, e, { keywords: kws });
      });
    },
  },
  {
    id: 'meta.copyright', icon: 'copyright', noRecord: true, isEnabled: canEdit, tip: 'Creator, copyright notice, usage terms, credit and source',
    run: async (app) => {
      const v = await currentProps(app);
      const r = await openDialog({ title: 'Creator and Copyright', ok: 'Save', help: scopeNote(app) || undefined, fields: [text('creator', 'Creator (separate several with ;)', (v.creator || []).join('; ')), text('jobTitle', 'Creator\'s job title', v.jobTitle || '', true), text('credit', 'Credit line', v.credit || '', true), text('rights', 'Copyright notice', v.rights || ''), area('usageTerms', 'Usage terms', v.usageTerms || '', 2), text('source', 'Source', v.source || '')] });
      if (!r) return;
      await forTargets(app, 'Copyright saved', (e) => patchXmp(app, e, { creator: list(r.creator), jobTitle: r.jobTitle.trim(), credit: r.credit.trim(), rights: r.rights.trim(), usageTerms: r.usageTerms.trim(), source: r.source.trim() }));
    },
  },
  {
    id: 'meta.comment', icon: 'comment', noRecord: true, isEnabled: (app) => !!app.picture && canEmbed(app.picture.format.id) && app.picture.format.id !== 'webp', tip: 'The JPEG comment (COM) or the PNG "Comment" text',
    run: async (app) => {
      const pic = app.picture!;
      const cur = getComment(pic.bytes, pic.format.id) || '';
      const r = await openDialog({ title: 'Comment', ok: 'Save', fields: [area('comment', 'Comment', cur, 5)] });
      if (!r) return;
      await forTargets(app, 'Comment saved', (e) => patchBytes(app, e, (b, f) => (f === 'webp' ? null : setComment(b, f, r.comment))));
    },
  },
  {
    id: 'meta.iptc', icon: 'badge', noRecord: true, isEnabled: canEdit, tip: 'IPTC-IIM fields in JPEG files (and their XMP equivalents in every format)',
    run: async (app) => {
      const pic = app.picture!;
      const ip = (pic.format.id === 'jpeg' ? readIptc(pic.bytes) : undefined) || {};
      const x = await currentProps(app);
      const f = (k: keyof IptcFields, xk?: keyof XmpProps) => (ip[k] as string | undefined) || (xk ? (x[xk] as string | undefined) : undefined) || '';
      const r = await openDialog({ title: 'IPTC Information', wide: true, ok: 'Save', help: (pic.format.id === 'jpeg' ? 'Written as IPTC-IIM (APP13) and as XMP.' : 'This format has no IPTC-IIM block; the fields are written as XMP.') + ' ' + scopeNote(app), fields: [
        text('title', 'Title (object name)', f('title', 'title'), true), text('headline', 'Headline', f('headline', 'headline'), true),
        area('caption', 'Caption (description)', f('caption', 'description'), 3), text('writer', 'Caption writer', f('writer', 'writer'), true), text('dateCreated', 'Date created (YYYYMMDD)', ip.dateCreated || (x.dateCreated || '').replace(/-/g, '').slice(0, 8), true),
        text('keywords', 'Keywords (;)', (ip.keywords || x.keywords || []).join('; ')),
        text('byline', 'By-line (creator)', ip.byline || (x.creator || [])[0] || '', true), text('bylineTitle', 'By-line title', f('bylineTitle', 'jobTitle'), true),
        text('credit', 'Credit', f('credit', 'credit'), true), text('source', 'Source', f('source', 'source'), true),
        text('copyright', 'Copyright notice', f('copyright', 'rights')),
        text('city', 'City', f('city', 'city'), true), text('state', 'Province or state', f('state', 'state'), true), text('country', 'Country', f('country', 'country'), true), text('category', 'Category', ip.category || '', true),
        area('instructions', 'Special instructions', f('instructions', 'instructions'), 2),
      ] });
      if (!r) return;
      const fields: IptcFields = { title: r.title.trim(), headline: r.headline.trim(), caption: r.caption.trim(), writer: r.writer.trim(), dateCreated: r.dateCreated.replace(/\D/g, '').slice(0, 8), keywords: list(r.keywords), byline: r.byline.trim(), bylineTitle: r.bylineTitle.trim(), credit: r.credit.trim(), source: r.source.trim(), copyright: r.copyright.trim(), city: r.city.trim(), state: r.state.trim(), country: r.country.trim(), category: r.category.trim(), instructions: r.instructions.trim() };
      const d = fields.dateCreated!;
      const xpatch: Partial<XmpProps> = { title: fields.title, headline: fields.headline, description: fields.caption, writer: fields.writer, keywords: fields.keywords, creator: fields.byline ? [fields.byline] : [], jobTitle: fields.bylineTitle, credit: fields.credit, source: fields.source, rights: fields.copyright, city: fields.city, state: fields.state, country: fields.country, instructions: fields.instructions, dateCreated: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '' };
      await forTargets(app, 'IPTC saved', async (e) => {
        const bf = await bytesAndFormat(app, e);
        if (bf?.format === 'jpeg') { const r1 = await patchBytes(app, e, (b) => writeIptc(b, fields)); if (r1 === 'failed' || r1 === 'canceled') return r1; }
        return patchXmp(app, e, xpatch);
      });
    },
  },
  {
    id: 'meta.xmp', icon: 'code', noRecord: true, isEnabled: canEdit, tip: 'The XMP packet as XML: view and edit',
    run: async (app) => {
      const e = app.picture!.entry;
      const view = await readMeta(app, e);
      if (!view) return;
      const src = view.sidecar ?? view.embedded ?? '';
      const r = await openDialog({ title: `XMP — ${e.name}`, wide: true, ok: 'Save', help: view.sidecar ? 'From the .xmp sidecar.' : view.embedded ? 'Embedded in the file.' : 'No packet yet; one is created when you save.', fields: [{ key: 'xml', label: 'Packet', type: 'textarea', rows: 18, value: src }], buttons: [{ label: 'Copy', onClick: (v) => { writeClipboardText(v.xml); toast('Copied'); } }] });
      if (!r) return;
      const xml = String(r.xml);
      if (xml.trim() && !/<rdf:Description/.test(xml)) { toast('The packet needs an rdf:Description element.'); return; }
      const res = await patchXmp(app, e, () => xml.trim());
      toast(res === 'written' ? 'XMP saved into the file' : res === 'sidecar' ? 'XMP saved to the sidecar' : res === 'savedAs' ? 'Saved' : res === 'canceled' ? 'Canceled' : 'The packet could not be written');
    },
  },
  {
    id: 'meta.template', icon: 'playlist_add_check', noRecord: true, isEnabled: canEdit, tip: 'Saved field sets applied to one or many pictures',
    run: async (app) => {
      const KEYS: [keyof XmpProps, string][] = [['title', 'Title'], ['description', 'Caption'], ['creator', 'Creator'], ['rights', 'Copyright'], ['usageTerms', 'Usage terms'], ['credit', 'Credit'], ['source', 'Source'], ['keywords', 'Keywords (;)'], ['city', 'City'], ['state', 'State'], ['country', 'Country']];
      const tpls = () => app.prefs.metaTemplates;
      const fields = (sel = ''): Field[] => {
        const t = tpls().find((x) => x.name === sel);
        return [
          { key: 'tpl', label: 'Template', type: 'select', options: [{ value: '', label: '(new)' }, ...tpls().map((x) => ({ value: x.name, label: x.name }))], value: sel, half: true },
          { key: 'name', label: 'Name', type: 'text', value: sel, half: true },
          ...KEYS.map(([k, label]) => text(k, label, t?.fields[k] || '', k !== 'description')),
          { key: 'onlyEmpty', label: 'Fill only empty fields (keep existing values)', type: 'checkbox', value: false },
          { key: 'save', label: 'Save template', type: 'button', half: true, onClick: (v, ctl) => { const name = String(v.name || '').trim(); if (!name) { toast('Give the template a name.'); return; } const f: Record<string, string> = {}; for (const [k] of KEYS) if (String(v[k] || '').trim()) f[k] = String(v[k]).trim(); app.prefs.metaTemplates = [...tpls().filter((x) => x.name !== name), { name, fields: f }]; app.savePrefs(); ctl.rebuild(fields(name)); toast(`Saved "${name}"`); } },
          { key: 'del', label: 'Delete template', type: 'button', half: true, onClick: (v, ctl) => { const name = String(v.tpl || ''); if (!name) return; app.prefs.metaTemplates = tpls().filter((x) => x.name !== name); app.savePrefs(); ctl.rebuild(fields('')); } },
        ];
      };
      const r = await openDialog({ title: 'Metadata Template', wide: true, ok: 'Apply', help: `Fields left empty are not changed. ${scopeNote(app)}`, fields: fields(), onChange: (v, ctl, key) => { if (key === 'tpl') ctl.rebuild(fields(String(v.tpl))); } });
      if (!r) return;
      const patch: Partial<XmpProps> = {};
      for (const [k] of KEYS) { const v = String(r[k] || '').trim(); if (!v) continue; (patch as any)[k] = k === 'creator' || k === 'keywords' ? list(v) : v; }
      if (!Object.keys(patch).length) { toast('Nothing to apply.'); return; }
      await forTargets(app, 'Template applied', async (e) => {
        if (!r.onlyEmpty) return patchXmp(app, e, patch);
        const cur = (await readMeta(app, e))?.props || {};
        const p: Partial<XmpProps> = {}; for (const [k, v] of Object.entries(patch)) { const c = (cur as any)[k]; if (c === undefined || c === '' || (Array.isArray(c) && !c.length)) (p as any)[k] = v; }
        return Object.keys(p).length ? patchXmp(app, e, p) : 'written';
      });
    },
  },
  {
    id: 'meta.copyFrom', icon: 'content_copy', noRecord: true, isEnabled: canEdit, tip: 'Copies EXIF, XMP and IPTC from another file into this one (or the marked pictures)',
    run: async (app) => {
      const files = await openDocuments('image/*', ['image/*'], false);
      if (!files.length) return;
      const src = new Uint8Array(files[0].data);
      const m = extractMeta(src), iptc = readIptc(src);
      if (!m.exif && !m.xmp && !iptc) { toast(`${files[0].name} carries no EXIF, XMP or IPTC.`); return; }
      if (!(await confirmDialog('Copy Metadata', `Replace the EXIF, XMP and IPTC of ${metaTargets(app).length > 1 ? `the ${metaTargets(app).length} marked pictures` : app.picture!.name} with those of ${files[0].name}?`, 'Copy'))) return;
      await forTargets(app, 'Metadata copied', async (e) => {
        const r = await patchBytes(app, e, (b, f) => { let out = stripMeta(b, f, { icc: true, comment: true, iptc: !iptc, exifReplacement: m.exif || null, xmpReplacement: m.xmp || null }); if (f === 'jpeg' && iptc) out = writeIptc(out, iptc); return out; });
        if (r === 'unsupported' && m.xmp) return patchXmp(app, e, () => decodeText(m.xmp!));
        return r;
      });
    },
  },
  {
    id: 'meta.diff', icon: 'difference', noRecord: true, isEnabled: has, tip: 'This picture and another file side by side, differences highlighted',
    run: async (app) => {
      const files = await openDocuments('image/*', ['image/*'], false);
      if (!files.length) return;
      const pic = app.picture!;
      const a = summarize(pic.bytes, pic.format.id, (await readMeta(app, pic.entry))?.props || {}), b = summarize(new Uint8Array(files[0].data), '', {});
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      const rows = keys.map((k) => { const same = (a[k] || '') === (b[k] || ''); return h('tr', { class: same ? '' : 'qn-diff' }, h('td', null, k), h('td', null, a[k] || '—'), h('td', null, b[k] || '—')); });
      await openDialog({ title: 'Compare Metadata', wide: true, cancel: false, ok: 'Close', content: h('div', { style: 'max-height:60vh;overflow:auto' }, h('table', { class: 'ql-stats qn-info' }, h('tr', null, h('th', null, 'Field'), h('th', null, pic.name), h('th', null, files[0].name)), ...rows)), help: `${rows.filter((r) => r.className).length} field${rows.filter((r) => r.className).length === 1 ? '' : 's'} differ.` });
    },
  },
  {
    id: 'meta.sidecarMode', icon: 'attach_file', kind: 'menu', noRecord: true,
    menu: (app) => [['embed', 'Embed in the file (JPEG, PNG, WebP); sidecar for other formats'], ['sidecar', 'Always write an .xmp sidecar'], ['both', 'Embed and write a sidecar']].map(([v, label]) => ({ id: 'meta.sidecarMode', arg: v, label, checked: app.prefs.sidecarMode === v })),
    run: (app, arg?: string) => { if (arg === 'embed' || arg === 'sidecar' || arg === 'both') { app.prefs.sidecarMode = arg; app.savePrefs(); toast(`Metadata: ${arg === 'embed' ? 'embedded when the format allows' : arg === 'sidecar' ? 'sidecar files' : 'embedded and sidecar'}`); } },
  },

  // Date and place ---------------------------------------------------------------------------------
  {
    id: 'meta.shiftDate', icon: 'schedule', noRecord: true, isEnabled: canEdit, tip: 'Shifts EXIF and XMP dates by an offset (a camera clock that was wrong) or sets a fixed date',
    run: async (app) => {
      const pic = app.picture!;
      const exif = extractMeta(pic.bytes).exif;
      const dates = exif ? exifDates(exif) : {};
      const cur = dates.original || dates.dateTime || '';
      const curDate = cur ? parseExifDate(cur) : null;
      const pad = (n: number) => String(n).padStart(2, '0');
      const r = await openDialog({ title: 'Change Date Taken', ok: 'Apply', preview: true, help: `${cur ? `Date taken now: ${cur}.` : 'No EXIF date in this picture.'} ${scopeNote(app)}`, fields: [
        { key: 'mode', label: 'Change', type: 'select', options: [{ value: 'shift', label: 'Shift by an offset' }, { value: 'set', label: 'Set a fixed date and time' }], value: 'shift', half: true },
        { key: 'days', label: 'Days', type: 'number', value: 0, half: true, visibleIf: (v) => v.mode === 'shift' }, { key: 'hours', label: 'Hours', type: 'number', value: 0, half: true, visibleIf: (v) => v.mode === 'shift' }, { key: 'minutes', label: 'Minutes', type: 'number', value: 0, half: true, visibleIf: (v) => v.mode === 'shift' },
        { key: 'date', label: 'Date', type: 'date', value: curDate ? `${curDate.getFullYear()}-${pad(curDate.getMonth() + 1)}-${pad(curDate.getDate())}` : '', half: true, visibleIf: (v) => v.mode === 'set' }, { key: 'time', label: 'Time', type: 'time', value: curDate ? `${pad(curDate.getHours())}:${pad(curDate.getMinutes())}` : '12:00', half: true, visibleIf: (v) => v.mode === 'set' },
      ], onChange: (v, ctl) => { const d = curDate ? mapDate(curDate, v) : null; ctl.setPreview(d ? `${cur} → <b>${formatExifDate(d)}</b>` : v.mode === 'set' && v.date ? `All dates become <b>${v.date} ${v.time || '00:00'}:00</b>` : 'Nothing to preview'); }, onOpen: (ctl) => ctl.setPreview(cur ? `${cur} → <b>${cur}</b>` : 'No EXIF date') });
      if (!r) return;
      const fn = (d: Date) => mapDate(d, r);
      await forTargets(app, 'Dates changed', async (e) => {
        const rb = await patchBytes(app, e, (b, f) => { const m = extractMeta(b); if (!m.exif) return b; const next = mapExifDates(m.exif, (old) => { const d = parseExifDate(old); const nd = d ? fn(d) : null; return nd ? formatExifDate(nd) : old; }); return replaceExif(b, f, next); });
        if (rb === 'failed' || rb === 'canceled') return rb;
        const cur2 = (await readMeta(app, e))?.props || {};
        const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const base = cur2.dateCreated || cur2.createDate;
        const from = base ? new Date(base) : r.mode === 'set' ? new Date() : null;
        if (!from || isNaN(from.getTime())) return rb;
        const nd = fn(from);
        return patchXmp(app, e, { dateCreated: nd ? iso(nd) : base, createDate: nd ? iso(nd) : cur2.createDate });
      });
    },
  },
  {
    id: 'meta.geotag', icon: 'location_on', noRecord: true, isEnabled: canEdit, tip: 'Latitude and longitude (paste "51.5, -0.12"); written as XMP exif:GPSLatitude/Longitude',
    run: async (app) => {
      const pic = app.picture!;
      const v = await currentProps(app);
      const lat = v.lat ?? pic.exif?.gps?.lat, lon = v.lon ?? pic.exif?.gps?.lon;
      const parse = (s: string) => { const m = s.match(/(-?\d+(?:\.\d+)?)\s*[°]?\s*([NS])?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*[°]?\s*([EW])?/i); if (!m) return null; let a = +m[1], b = +m[3]; if (m[2]?.toUpperCase() === 'S') a = -Math.abs(a); if (m[4]?.toUpperCase() === 'W') b = -Math.abs(b); return [a, b] as [number, number]; };
      const r = await openDialog({ title: 'Set Location', ok: 'Save', help: `Decimal degrees; south and west are negative. ${scopeNote(app)}`, fields: [
        { key: 'lat', label: 'Latitude', type: 'number', value: lat ?? '', step: 0.000001, min: -90, max: 90, half: true }, { key: 'lon', label: 'Longitude', type: 'number', value: lon ?? '', step: 0.000001, min: -180, max: 180, half: true },
        { key: 'paste', label: 'Paste coordinates from the clipboard', type: 'button', half: true, onClick: async (_v, ctl) => { const t = (await readClipboardText()) || ''; const p = parse(t); if (!p) { toast('No "latitude, longitude" pair on the clipboard.'); return; } ctl.set('lat', p[0]); ctl.set('lon', p[1]); } },
        { key: 'map', label: 'Pick on a map (opens OpenStreetMap; copy the coordinates back)', type: 'button', half: true, onClick: (vals) => openExternal(vals.lat !== '' ? `https://www.openstreetmap.org/?mlat=${vals.lat}&mlon=${vals.lon}#map=14/${vals.lat}/${vals.lon}` : 'https://www.openstreetmap.org/') },
        { key: 'clear', label: 'Remove the location instead', type: 'checkbox', value: false },
      ] });
      if (!r) return;
      if (r.clear) { await app.exec('meta.removeGps'); return; }
      const la = Number(r.lat), lo = Number(r.lon);
      if (r.lat === '' || r.lon === '' || !Number.isFinite(la) || !Number.isFinite(lo)) { toast('Enter both numbers.'); return; }
      await forTargets(app, 'Location saved', (e) => patchXmp(app, e, { lat: la, lon: lo }));
    },
  },
  {
    id: 'meta.removeGps', icon: 'location_off', noRecord: true, isEnabled: canEdit, tip: 'Removes GPS from EXIF and the location fields from XMP',
    run: async (app) => {
      await forTargets(app, 'Location removed', async (e) => {
        const rb = await patchBytes(app, e, (b, f) => { const m = extractMeta(b); let out = b; if (m.exif && hasGpsIfd(m.exif)) out = replaceExif(out, f, removeGpsFromExif(m.exif)); if (m.xmp) out = setXmp(out, f, utf8(scrubXmp(decodeText(m.xmp), { location: true }))); return out; });
        if (rb === 'failed' || rb === 'canceled') return rb;
        const view = await readMeta(app, e);
        if (view?.sidecar) return patchXmp(app, e, (xml) => scrubXmp(xml || '', { location: true }));
        return rb;
      });
    },
  },

  // Privacy and integrity ----------------------------------------------------------------------------
  {
    id: 'meta.strip', icon: 'cleaning_services', popular: true, noRecord: true, isEnabled: canEdit, tip: 'Removes metadata, keeping what you choose (orientation, color profile, copyright…)',
    run: async (app) => {
      const pic = app.picture!;
      const r = await openDialog({ title: 'Strip Metadata', ok: 'Strip', help: `JPEG, PNG and WebP files are rewritten without re-encoding. ${scopeNote(app)}`, fields: [
        { key: 'h', type: 'heading', label: 'Keep' },
        { key: 'orientation', label: 'Orientation (a minimal EXIF block)', type: 'checkbox', value: true, half: true }, { key: 'icc', label: 'Color profile', type: 'checkbox', value: true, half: true },
        { key: 'copyright', label: 'Creator and copyright', type: 'checkbox', value: true, half: true }, { key: 'comment', label: 'Comment', type: 'checkbox', value: false, half: true },
        { key: 'exif', label: 'All EXIF (camera, exposure, dates; GPS removed)', type: 'checkbox', value: false, half: true }, { key: 'xmp', label: 'All XMP (keywords, rating…)', type: 'checkbox', value: false, half: true }, { key: 'iptc', label: 'IPTC', type: 'checkbox', value: false, half: true },
      ] });
      if (!r) return;
      await forTargets(app, 'Stripped', (e) => patchBytes(app, e, (b, f) => stripFile(b, f, r)));
      if (app.picture === pic) toast(`${pic.name}: ${fmtSize(pic.bytes.length)}`, { ms: 2000 });
    },
  },
  {
    id: 'meta.privacyCheck', icon: 'privacy_tip', popular: true, noRecord: true, isEnabled: has, tip: 'What this picture would reveal if shared: location, names, serial numbers, edit history…',
    run: async (app) => {
      const pic = app.picture!;
      const view = await readMeta(app, pic.entry);
      const items = privacyItems(pic.bytes, pic.format.id, pic.exif, view?.props || {}, view?.embedded || view?.sidecar || '');
      const rows = items.map((i) => h('tr', { class: i.level === 'high' ? 'qn-priv-high' : i.level === 'medium' ? 'qn-priv-med' : '' }, h('td', null, i.level === 'high' ? '⚠' : i.level === 'medium' ? '•' : '·'), h('td', null, i.what), h('td', null, i.detail)));
      const found = items.filter((i) => i.level !== 'info');
      await openDialog({ title: `Privacy Check — ${pic.name}`, wide: true, cancel: false, ok: 'Close', help: found.length ? `${found.length} item${found.length === 1 ? '' : 's'} worth a look before sharing. Faces are not detected; look at the picture itself.` : 'Nothing identifying was found in the metadata. Faces, signs and documents in the picture itself are not checked.', content: h('div', { style: 'max-height:55vh;overflow:auto' }, h('table', { class: 'ql-stats qn-info' }, ...rows)), buttons: [
        { label: 'Strip Metadata…', onClick: (_v, ctl) => { ctl.close(); void app.exec('meta.strip'); } },
        ...(items.some((i) => i.key === 'gps') ? [{ label: 'Remove Location', onClick: (_v: any, ctl: any) => { ctl.close(); void app.exec('meta.removeGps'); } }] : []),
      ] });
    },
  },
  {
    id: 'meta.provenance', icon: 'verified_user', noRecord: true, isEnabled: has, tip: 'Content Credentials (C2PA) manifests and the IPTC digital source type: does the picture say it was made or edited with AI?',
    run: async (app) => {
      const pic = app.picture!;
      const p = detectProvenance(pic.bytes);
      const props = (await readMeta(app, pic.entry))?.props || {};
      const dst = props.digitalSourceType || '';
      const kind = dst.replace(/.*\//, '');
      const ai = /trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|algorithmicMedia/.test(kind);
      const rows: [string, string][] = [
        ['Content Credentials (C2PA)', p.c2pa ? `A manifest is embedded (${p.where.join(', ')}). The signature is not verified here; open the picture at contentcredentials.org/verify for the signed history.` : 'No C2PA manifest.'],
        ...(p.jumbfLabels.length ? [['Manifest labels', p.jumbfLabels.join(', ')] as [string, string]] : []),
        ['IPTC digital source type', dst ? `${kind}${ai ? ' — declares AI generation or AI compositing' : kind === 'digitalCapture' ? ' — a camera capture' : ''}` : 'Not declared.'],
        ['Software (EXIF)', pic.exif?.software || '—'],
        ['Creator', (props.creator || []).join('; ') || pic.exif?.artist || '—'],
        ['Credit', props.credit || '—'],
      ];
      const verdict = ai ? 'The picture declares itself as AI-generated or AI-composited.' : p.c2pa ? 'The picture carries signed content credentials; see the manifest for its history.' : dst ? 'The picture declares its source type; no AI generation is declared.' : 'The picture makes no statement about its origin. Absence of a declaration proves nothing either way.';
      await openDialog({ title: `Content Credentials — ${pic.name}`, wide: true, cancel: false, ok: 'Close', help: verdict, content: h('table', { class: 'ql-stats qn-info' }, ...rows.map(([a, b]) => h('tr', null, h('td', null, a), h('td', null, b)))), buttons: p.c2pa ? [{ label: 'Verify online', onClick: () => openExternal('https://contentcredentials.org/verify') }] : [] });
    },
  },
  {
    id: 'meta.checksum', icon: 'tag', noRecord: true, isEnabled: has, tip: 'SHA-256, SHA-1 and MD5 of the file; copy, or paste an expected value to verify',
    run: async (app) => {
      const pic = app.picture!;
      const sums = { 'SHA-256': await sha(pic.bytes, 'SHA-256'), 'SHA-1': await sha(pic.bytes, 'SHA-1'), MD5: md5(pic.bytes) };
      const status = (v: string) => { const x = v.trim().toLowerCase().replace(/[^0-9a-f]/g, ''); if (!x) return 'Paste an expected checksum to verify.'; const hit = Object.entries(sums).find(([, s]) => s === x); return hit ? `✓ Matches ${hit[0]}` : `✗ Does not match any of the three (${x.length} hex digits)`; };
      await openDialog({ title: `Checksum — ${pic.name}`, wide: true, cancel: false, ok: 'Close', preview: true, fields: [
        { key: 'sha256', label: 'SHA-256', type: 'text', value: sums['SHA-256'] }, { key: 'sha1', label: 'SHA-1', type: 'text', value: sums['SHA-1'] }, { key: 'md5', label: 'MD5', type: 'text', value: sums.MD5 },
        { key: 'expected', label: 'Expected (to verify)', type: 'text', value: '', placeholder: 'Paste a checksum' },
      ], onChange: (v, ctl, key) => { if (key === 'expected') ctl.setPreview(status(v.expected)); }, onOpen: (ctl) => ctl.setPreview(`${fmtSize(pic.bytes.length)}; ${status('')}`), buttons: [
        { label: 'Copy SHA-256', onClick: () => { writeClipboardText(`${sums['SHA-256']}  ${pic.name}`); toast('Copied'); } },
        { label: 'Copy all', onClick: () => { writeClipboardText(Object.entries(sums).map(([k, v]) => `${k}: ${v}`).join('\n')); toast('Copied'); } },
      ] });
    },
  },
  {
    id: 'meta.fixity', icon: 'fact_check', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'A SHA-256 manifest of the folder; verifying a manifest later reports changed, missing and new files',
    run: async (app) => {
      const entries = app.tab.folder.entries;
      const r = await openDialog({ title: 'Fixity Report', ok: 'Run', fields: [{ key: 'mode', label: 'Action', type: 'select', options: [{ value: 'create', label: `Create a manifest of the ${entries.length} pictures in this folder` }, { value: 'verify', label: 'Verify this folder against a manifest file…' }], value: 'create' }], help: 'The manifest is a plain sha256sum-style text file: one "checksum  name" line per file.' });
      if (!r) return;
      const digest = async (e: Entry) => { const bf = await bytesAndFormat(app, e); return bf ? sha(bf.bytes, 'SHA-256') : null; };
      if (r.mode === 'create') {
        const lines: string[] = []; let i = 0;
        for (const e of entries) { i++; if (i % 10 === 0) toast(`Hashing ${i} of ${entries.length}…`, { ms: 800 }); const d = await digest(e); if (d) lines.push(`${d}  ${e.name}`); }
        const name = `${(app.tab.folder.name || 'pictures').replace(/[\\/:*?"<>|]/g, '_')}.sha256`;
        const res = await saveAs(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }), name);
        if (res) toast(`Manifest with ${lines.length} entries saved as ${res.name}`);
        return;
      }
      const files = await openDocuments('.sha256,.md5,.sha1,.txt,text/plain', ['text/plain', 'application/octet-stream'], false);
      if (!files.length) return;
      const manifest = new Map<string, string>();
      for (const line of decodeText(new Uint8Array(files[0].data)).split(/\r?\n/)) { const m = line.match(/^([0-9a-fA-F]{32,128})\s+\*?(.+)$/); if (m) manifest.set(m[2].trim().replace(/^.*[\\/]/, ''), m[1].toLowerCase()); }
      if (!manifest.size) { toast('No checksum lines found in that file.'); return; }
      const algo = [...manifest.values()][0].length === 64 ? 'SHA-256' : [...manifest.values()][0].length === 40 ? 'SHA-1' : 'MD5';
      const changed: string[] = [], ok: string[] = [], missing: string[] = [], fresh: string[] = [];
      const byName = new Map(entries.map((e) => [e.name, e]));
      let i = 0;
      for (const [name, sum] of manifest) {
        i++; if (i % 10 === 0) toast(`Checking ${i} of ${manifest.size}…`, { ms: 800 });
        const e = byName.get(name); if (!e) { missing.push(name); continue; }
        const bf = await bytesAndFormat(app, e); if (!bf) { missing.push(name); continue; }
        const d = algo === 'MD5' ? md5(bf.bytes) : await sha(bf.bytes, algo);
        (d === sum ? ok : changed).push(name);
      }
      for (const e of entries) if (!manifest.has(e.name)) fresh.push(e.name);
      const sec = (title: string, names: string[]) => (names.length ? [h('h4', null, `${title} (${names.length})`), h('div', { class: 'ql-help', style: 'white-space:pre-wrap' }, names.join('\n'))] : []);
      await openDialog({ title: `Fixity — ${files[0].name} (${algo})`, wide: true, cancel: false, ok: 'Close', help: changed.length || missing.length ? `${changed.length} changed, ${missing.length} missing, ${ok.length} intact, ${fresh.length} new.` : `All ${ok.length} files intact; ${fresh.length} new file${fresh.length === 1 ? '' : 's'} not in the manifest.`, content: h('div', { style: 'max-height:55vh;overflow:auto' }, ...sec('Changed', changed), ...sec('Missing', missing), ...sec('New (not in the manifest)', fresh), ...sec('Intact', ok)), buttons: [{ label: 'Copy report', onClick: () => { writeClipboardText([`Fixity report for ${files[0].name}`, ...changed.map((n) => `CHANGED  ${n}`), ...missing.map((n) => `MISSING  ${n}`), ...fresh.map((n) => `NEW      ${n}`), ...ok.map((n) => `OK       ${n}`)].join('\n')); toast('Copied'); } }] });
    },
  },

  // Records and genealogy ----------------------------------------------------------------------------
  {
    id: 'meta.citation', icon: 'menu_book', noRecord: true, isEnabled: canEdit, tip: 'Repository, collection, call number, item, page, date accessed and the citation text, stored in XMP',
    run: async (app) => {
      const c = (await currentProps(app)).citation || {};
      const r = await openDialog({ title: 'Source Citation', wide: true, ok: 'Save', help: scopeNote(app) || undefined, fields: [text('repository', 'Repository', c.repository || '', true), text('collection', 'Collection', c.collection || '', true), text('callNumber', 'Call number', c.callNumber || '', true), text('item', 'Item', c.item || '', true), text('page', 'Page', c.page || '', true), { key: 'accessed', label: 'Date accessed', type: 'date', value: c.accessed || '', half: true }, area('text', 'Citation text', c.text || '', 3), { key: 'build', label: 'Compose the citation text from the fields above', type: 'button', onClick: (v, ctl) => ctl.set('text', [v.repository, v.collection, v.callNumber && `call no. ${v.callNumber}`, v.item, v.page && `p. ${v.page}`, v.accessed && `accessed ${v.accessed}`].filter(Boolean).join(', ')) }] });
      if (!r) return;
      const cit: Citation = {}; for (const k of ['repository', 'collection', 'callNumber', 'item', 'page', 'accessed', 'text'] as (keyof Citation)[]) if (String(r[k] || '').trim()) cit[k] = String(r[k]).trim();
      await forTargets(app, 'Citation saved', (e) => patchXmp(app, e, { citation: cit }));
    },
  },
  {
    id: 'meta.exportCsv', icon: 'table_view', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'One row per picture: file, size, camera, date, location, title, caption, keywords, rating…',
    run: async (app) => {
      const t = app.tab; const marked = t.folder.entries.filter((e) => t.marked.has(e)); const entries = marked.length ? marked : t.folder.entries;
      const rows: string[][] = [CSV_COLUMNS];
      let i = 0;
      for (const e of entries) { i++; if (i % 10 === 0) toast(`Reading ${i} of ${entries.length}…`, { ms: 800 }); const bf = await bytesAndFormat(app, e); if (!bf) continue; const props = (await readMeta(app, e))?.props || {}; rows.push(csvRow(e, bf.bytes, bf.format, props)); }
      const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      const res = await saveAs(new Blob(['﻿' + csv], { type: 'text/csv' }), `${(t.folder.name || 'pictures').replace(/[\\/:*?"<>|]/g, '_')}-metadata.csv`);
      if (res) toast(`${rows.length - 1} rows saved as ${res.name}`);
    },
  },
  {
    id: 'meta.importCsv', icon: 'upload_file', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'Matches rows to files by name and previews the changes before writing',
    run: async (app) => {
      const files = await openDocuments('.csv,text/csv', ['text/csv', 'text/plain'], false);
      if (!files.length) return;
      const table = parseCsv(decodeText(new Uint8Array(files[0].data)));
      if (table.length < 2) { toast('The CSV has no data rows.'); return; }
      const header = table[0].map((c) => c.trim().toLowerCase());
      const col = (names: string[]) => header.findIndex((hh) => names.includes(hh));
      const nameCol = col(['file', 'filename', 'file name', 'name']);
      if (nameCol < 0) { toast('The CSV needs a "File" column.'); return; }
      const MAP: [string[], keyof XmpProps, 'text' | 'list' | 'number'][] = [[['title'], 'title', 'text'], [['caption', 'description'], 'description', 'text'], [['headline'], 'headline', 'text'], [['keywords', 'subject', 'tags'], 'keywords', 'list'], [['creator', 'artist', 'byline', 'by-line'], 'creator', 'list'], [['copyright', 'rights'], 'rights', 'text'], [['credit'], 'credit', 'text'], [['source'], 'source', 'text'], [['rating'], 'rating', 'number'], [['label', 'color label'], 'label', 'text'], [['city'], 'city', 'text'], [['state', 'province'], 'state', 'text'], [['country'], 'country', 'text'], [['latitude', 'lat'], 'lat', 'number'], [['longitude', 'lon', 'lng'], 'lon', 'number'], [['date created', 'datecreated', 'date'], 'dateCreated', 'text']];
      const cols = MAP.map(([names, key, kind]) => ({ key, kind, i: col(names) })).filter((c) => c.i >= 0);
      if (!cols.length) { toast('No recognized metadata columns (Title, Caption, Keywords, Creator, Copyright, Rating, Label, City, Latitude…).'); return; }
      const byName = new Map(app.tab.folder.entries.map((e) => [e.name.toLowerCase(), e]));
      const plan: { e: Entry; patch: Partial<XmpProps> }[] = []; const unmatched: string[] = [];
      for (const row of table.slice(1)) {
        const name = (row[nameCol] || '').trim().replace(/^.*[\\/]/, ''); if (!name) continue;
        const e = byName.get(name.toLowerCase()); if (!e) { unmatched.push(name); continue; }
        const patch: Partial<XmpProps> = {};
        for (const c of cols) { const raw = (row[c.i] ?? '').trim(); if (c.kind === 'list') (patch as any)[c.key] = list(raw); else if (c.kind === 'number') { if (raw === '') (patch as any)[c.key] = undefined; else { const n = Number(raw); if (Number.isFinite(n)) (patch as any)[c.key] = n; } } else (patch as any)[c.key] = raw; }
        plan.push({ e, patch });
      }
      if (!plan.length) { toast(`No rows match the ${app.tab.folder.length} files in this folder.`); return; }
      const preview = h('table', { class: 'ql-stats qn-info', style: 'font-size:12px' }, h('tr', null, h('th', null, 'File'), ...cols.map((c) => h('th', null, c.key))), ...plan.slice(0, 200).map((p) => h('tr', null, h('td', null, p.e.name), ...cols.map((c) => h('td', null, String((p.patch as any)[c.key] ?? ''))))));
      const ok = await openDialog({ title: 'Import Metadata from CSV', wide: true, ok: `Write ${plan.length} file${plan.length === 1 ? '' : 's'}`, help: `${plan.length} matched${unmatched.length ? `, ${unmatched.length} rows name files not in this folder` : ''}. Columns: ${cols.map((c) => c.key).join(', ')}. Empty cells clear the field.`, content: h('div', { style: 'max-height:50vh;overflow:auto' }, preview) });
      if (!ok) return;
      let n = 0, failed = 0, i = 0;
      for (const p of plan) { i++; if (i % 5 === 0) toast(`Writing ${i} of ${plan.length}…`, { ms: 800 }); const r = await patchXmp(app, p.e, p.patch); if (r === 'canceled') break; if (r === 'written' || r === 'sidecar' || r === 'savedAs') n++; else failed++; }
      app.tab.thumbs.sync();
      toast(`${n} file${n === 1 ? '' : 's'} updated${failed ? `, ${failed} failed` : ''}`);
    },
  },

  // Rate and label (Browse tab) ---------------------------------------------------------------------
  {
    id: 'browse.rate', icon: 'star', kind: 'menu', popular: true, noRecord: true, isEnabled: canEdit, tip: 'Stars 0–5 (Ctrl+0…Ctrl+5), stored in XMP xmp:Rating',
    menu: (app) => { const cur = propsOf(app.picture?.entry)?.rating ?? 0; return [0, 1, 2, 3, 4, 5].map((n) => ({ id: 'browse.rate', arg: n, label: n ? `${'★'.repeat(n)}${'☆'.repeat(5 - n)}  ${n}` : 'No rating  0', checked: cur === n })); },
    run: (app, arg?: number) => { const n = Math.max(0, Math.min(5, Math.round(Number(arg ?? 0)))); return forTargets(app, n ? `Rated ${'★'.repeat(n)}` : 'Rating cleared', (e) => patchXmp(app, e, { rating: n || undefined })); },
  },
  {
    id: 'browse.colorLabel', icon: 'label_important', kind: 'menu', noRecord: true, isEnabled: canEdit, tip: 'Red, yellow, green, blue, purple or none (Ctrl+6…Ctrl+9), stored in XMP xmp:Label',
    menu: (app) => { const cur = (propsOf(app.picture?.entry)?.label || '').toLowerCase(); return [...LABELS, ''].map((l) => ({ id: 'browse.colorLabel', arg: l, label: l ? l[0].toUpperCase() + l.slice(1) : 'None', checked: cur === l })); },
    run: (app, arg?: string) => { const l = LABELS.includes(String(arg || '').toLowerCase()) ? String(arg).toLowerCase() : ''; return forTargets(app, l ? `Label: ${l}` : 'Label cleared', (e) => patchXmp(app, e, { label: l ? l[0].toUpperCase() + l.slice(1) : undefined })); },
  },
  {
    id: 'browse.favorite', icon: 'favorite', kind: 'toggle', popular: true, noRecord: true, isEnabled: canEdit, isActive: (app) => !!propsOf(app.picture?.entry)?.favorite, tip: 'Heart toggle, stored in XMP',
    run: async (app) => { const on = !propsOf(app.picture!.entry)?.favorite; await forTargets(app, on ? 'Favorite ♥' : 'Favorite removed', (e) => patchXmp(app, e, { favorite: on })); },
  },
  { id: 'browse.pick', icon: 'flag', noRecord: true, isEnabled: canEdit, isActive: (app) => propsOf(app.picture?.entry)?.flag === 'pick', tip: 'Flags the picture as a pick (keep)', run: (app) => forTargets(app, 'Picked', (e) => patchXmp(app, e, { flag: 'pick' })) },
  { id: 'browse.reject', icon: 'block', noRecord: true, isEnabled: canEdit, isActive: (app) => propsOf(app.picture?.entry)?.flag === 'reject', tip: 'Flags the picture as rejected; Select Rejected gathers them for deleting or moving', run: (app) => forTargets(app, 'Rejected', (e) => patchXmp(app, e, { flag: 'reject' })) },
  { id: 'browse.unflag', icon: 'outlined_flag', noRecord: true, isEnabled: canEdit, run: (app) => forTargets(app, 'Unflagged', (e) => patchXmp(app, e, { flag: '' })) },
  {
    id: 'browse.selectRejected', icon: 'rule', noRecord: true, isEnabled: (app) => app.folder.length > 0, tip: 'Marks every rejected picture in the folder (then Delete or Move)',
    run: async (app) => {
      const t = app.tab; const found: Entry[] = []; let i = 0;
      for (const e of t.folder.entries) { i++; if (i % 20 === 0) toast(`Checking ${i} of ${t.folder.length}…`, { ms: 600 }); const v = await readMeta(app, e); if (v?.props.flag === 'reject') found.push(e); }
      t.marked.clear(); for (const e of found) t.marked.add(e);
      if (found.length && !t.thumbs.open) t.thumbs.show('grid');
      t.thumbs.sync(); app.refresh();
      toast(found.length ? `${found.length} rejected picture${found.length === 1 ? '' : 's'} marked` : 'No rejected pictures in this folder.');
    },
  },
]);

const LABELS = ['red', 'yellow', 'green', 'blue', 'purple'];

function mapDate(d: Date, v: Record<string, any>): Date | null {
  if (v.mode === 'set') { if (!v.date) return null; const [y, m, dd] = String(v.date).split('-').map(Number); const [hh, mm] = String(v.time || '00:00').split(':').map(Number); return new Date(y, m - 1, dd, hh || 0, mm || 0, 0); }
  return new Date(d.getTime() + ((+v.days || 0) * 86400 + (+v.hours || 0) * 3600 + (+v.minutes || 0) * 60) * 1000);
}

/** Strip Metadata's keep options → the rewritten file. */
export function stripFile(b: Uint8Array, f: string, r: Record<string, any>): Uint8Array {
  const m = extractMeta(b);
  const exif = m.exif ? readExif(stripMeta(b, f, { exif: true })) : null;
  const props = m.xmp ? parseXmp(decodeText(m.xmp)) : {};
  let exifReplacement: Uint8Array | null = null, xmpReplacement: Uint8Array | null = null;
  if (r.exif && m.exif) exifReplacement = hasGpsIfd(m.exif) ? removeGpsFromExif(m.exif) : m.exif;
  else if (r.orientation || r.copyright) exifReplacement = minimalExif({ orientation: r.orientation ? exif?.orientation || 1 : 1, artist: r.copyright ? exif?.artist : undefined, copyright: r.copyright ? exif?.copyright : undefined });
  if (!r.xmp && r.copyright && (props.rights || props.creator?.length || props.usageTerms)) xmpReplacement = utf8(parseXmpPatchOnly({ rights: props.rights, creator: props.creator, usageTerms: props.usageTerms }));
  return stripMeta(b, f, { exif: false, exifReplacement, xmp: !!r.xmp, xmpReplacement, icc: !!r.icc, iptc: !!r.iptc, comment: !!r.comment });
}
function parseXmpPatchOnly(p: Partial<XmpProps>): string { return updateXmp(null, p); }

interface PrivacyItem { key: string; level: 'high' | 'medium' | 'info'; what: string; detail: string }
function privacyItems(bytes: Uint8Array, format: string, exif: import('../meta/exif').ExifData | null, props: XmpProps, xml: string): PrivacyItem[] {
  const out: PrivacyItem[] = [];
  const tag = (n: string) => exif?.tags.find((t) => t.name === n)?.value;
  if (exif?.gps || (props.lat !== undefined && props.lon !== undefined)) out.push({ key: 'gps', level: 'high', what: 'Location', detail: exif?.gps ? `GPS ${exif.gps.lat.toFixed(5)}, ${exif.gps.lon.toFixed(5)} in EXIF${props.lat !== undefined ? ' and XMP' : ''}` : `GPS ${props.lat!.toFixed(5)}, ${props.lon!.toFixed(5)} in XMP` });
  if (props.city || props.state || props.country || props.location) out.push({ key: 'place', level: 'medium', what: 'Place names', detail: [props.location, props.city, props.state, props.country].filter(Boolean).join(', ') });
  for (const n of ['BodySerialNumber', 'LensSerialNumber', 'ImageUniqueID']) { const v = tag(n); if (v) out.push({ key: n, level: 'medium', what: n.replace(/([a-z])([A-Z])/g, '$1 $2'), detail: v }); }
  const owner = tag('CameraOwnerName'); if (owner) out.push({ key: 'owner', level: 'high', what: 'Camera owner name', detail: owner });
  const names = [...(props.creator || []), exif?.artist, props.credit].filter(Boolean) as string[]; if (names.length) out.push({ key: 'creator', level: 'medium', what: 'Creator / credit', detail: [...new Set(names)].join('; ') });
  if (props.personInImage?.length) out.push({ key: 'people', level: 'high', what: 'People named in the picture', detail: props.personInImage.join('; ') });
  if (/<mwg-rs:Regions/.test(xml)) out.push({ key: 'regions', level: 'high', what: 'Face / region tags', detail: 'The XMP carries region tags (names attached to areas of the picture).' });
  const cap = [props.title, props.description, props.headline, exif?.description, exif?.userComment, getComment(bytes, format)].filter(Boolean) as string[]; if (cap.length) out.push({ key: 'captions', level: 'info', what: 'Captions and comments', detail: cap.map((c) => c.slice(0, 120)).join(' | ') });
  if (props.keywords?.length) out.push({ key: 'keywords', level: 'info', what: 'Keywords', detail: props.keywords.join(', ') });
  if (exif?.dateTaken) out.push({ key: 'date', level: 'info', what: 'Date taken', detail: exif.dateTaken });
  if (exif?.make || exif?.model) out.push({ key: 'camera', level: 'info', what: 'Camera', detail: [exif?.make, exif?.model, exif?.lens].filter(Boolean).join(' ') });
  if (exif?.software) out.push({ key: 'software', level: 'info', what: 'Software', detail: exif.software });
  if (/<xmpMM:History/.test(xml)) out.push({ key: 'history', level: 'medium', what: 'Edit history', detail: 'The XMP keeps an editing history (software, dates, source document ids).' });
  if (/<xmpMM:DerivedFrom|<xmpMM:DocumentID|<xmpMM:OriginalDocumentID/.test(xml)) out.push({ key: 'docid', level: 'info', what: 'Document identifiers', detail: 'Unique ids that link this file to other versions.' });
  if (exif?.tags.some((t) => t.name === 'MakerNote')) out.push({ key: 'makernote', level: 'info', what: 'Maker notes', detail: 'Undecoded camera data, which can include serial numbers and owner names.' });
  if (format === 'jpeg') { const thumb = exif?.tags.some((t) => t.name === 'Compression' || t.name === 'StripOffsets'); if (thumb) out.push({ key: 'thumb', level: 'medium', what: 'Embedded thumbnail', detail: 'EXIF carries a thumbnail; after cropping or redacting it may still show the original.' }); }
  if (!out.length) out.push({ key: 'none', level: 'info', what: 'Metadata', detail: 'No identifying metadata found.' });
  return out;
}

/** The fields shown by Compare Metadata and exported to CSV. */
function summarize(bytes: Uint8Array, format: string, props: XmpProps): Record<string, string> {
  const exif = readExif(bytes);
  const p = Object.keys(props).length ? props : (() => { const x = extractMeta(bytes).xmp; return x ? parseXmp(decodeText(x)) : {}; })();
  const ip = (bytes[0] === 0xff && bytes[1] === 0xd8) ? readIptc(bytes) : undefined;
  const o: Record<string, string> = { Size: fmtSize(bytes.length) };
  const put = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) o[k] = Array.isArray(v) ? v.join('; ') : String(v); };
  put('Camera', [exif?.make, exif?.model].filter(Boolean).join(' ')); put('Lens', exif?.lens); put('Exposure', exif?.exposure); put('Date taken', exif?.dateTaken); put('Orientation', exif?.orientation && exif.orientation !== 1 ? exif.orientation : undefined); put('Software', exif?.software);
  put('GPS', exif?.gps ? `${exif.gps.lat.toFixed(5)}, ${exif.gps.lon.toFixed(5)}` : p.lat !== undefined ? `${p.lat.toFixed(5)}, ${p.lon!.toFixed(5)}` : undefined);
  put('Title', p.title); put('Caption', p.description); put('Headline', p.headline); put('Keywords', p.keywords); put('Creator', p.creator || exif?.artist); put('Copyright', p.rights || exif?.copyright); put('Credit', p.credit); put('Source', p.source); put('Rating', p.rating); put('Label', p.label); put('Favorite', p.favorite ? 'yes' : undefined); put('Flag', p.flag); put('Date created', p.dateCreated); put('City', p.city); put('State', p.state); put('Country', p.country);
  put('IPTC title', ip?.title); put('IPTC caption', ip?.caption); put('IPTC keywords', ip?.keywords); put('IPTC by-line', ip?.byline); put('IPTC copyright', ip?.copyright);
  put('Comment', getComment(bytes, format || (bytes[0] === 0x89 ? 'png' : 'jpeg'))); put('Digital source type', p.digitalSourceType?.replace(/.*\//, ''));
  if (p.citation) for (const [k, v] of Object.entries(p.citation)) put(`Citation ${k}`, v);
  return o;
}

const CSV_COLUMNS = ['File', 'Size', 'Width', 'Height', 'Camera', 'Lens', 'Exposure', 'Date taken', 'Latitude', 'Longitude', 'Title', 'Caption', 'Headline', 'Keywords', 'Creator', 'Copyright', 'Credit', 'Source', 'Rating', 'Label', 'Favorite', 'Flag', 'Date created', 'City', 'State', 'Country', 'Citation'];
function csvRow(e: Entry, bytes: Uint8Array, format: string, p: XmpProps): string[] {
  const exif = readExif(bytes);
  const size = sizeOf(bytes, format);
  return [e.name, String(bytes.length), size ? String(size[0]) : '', size ? String(size[1]) : '', [exif?.make, exif?.model].filter(Boolean).join(' '), exif?.lens || '', exif?.exposure || '', exif?.dateTaken || '', exif?.gps ? String(exif.gps.lat) : p.lat !== undefined ? String(p.lat) : '', exif?.gps ? String(exif.gps.lon) : p.lon !== undefined ? String(p.lon) : '', p.title || '', p.description || '', p.headline || '', (p.keywords || []).join('; '), (p.creator || []).join('; ') || exif?.artist || '', p.rights || exif?.copyright || '', p.credit || '', p.source || '', p.rating !== undefined ? String(p.rating) : '', p.label || '', p.favorite ? 'yes' : '', p.flag || '', p.dateCreated || '', p.city || '', p.state || '', p.country || '', p.citation?.text || ''];
}
function sizeOf(u8: Uint8Array, format: string): [number, number] | null {
  try {
    if (format === 'jpeg') { let p = 2; while (p + 9 < u8.length && u8[p] === 0xff) { const m = u8[p + 1]; if (m === 0xff) { p++; continue; } if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; } if (m === 0xda || m === 0xd9) break; const len = (u8[p + 2] << 8) | u8[p + 3]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(u8[p + 7] << 8) | u8[p + 8], (u8[p + 5] << 8) | u8[p + 6]]; p += 2 + len; } }
    if (format === 'png') { const dv = new DataView(u8.buffer, u8.byteOffset); return [dv.getUint32(16), dv.getUint32(20)]; }
  } catch { /* ignore */ }
  return null;
}
export const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** RFC 4180 parsing with quoted fields and embedded newlines; the separator is , or ; or a tab (sniffed from the header). */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const first = t.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; } else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}
