/**
 * Browse tab, organizing: Filter Bar (type, rating, label, keyword, text, dates, camera, location,
 * orientation, flag), Group By (date, camera, lens, rating, label, keyword, type, stack), Timeline
 * (year, month, day), Stack Bursts and Versions, Light Table (the marked pictures in a new window)
 * and Cull Mode (full screen, one key per decision, auto-advance).
 */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import { h } from '../ui/dom';
import { Folder } from '../picture/folder';
import type { Entry } from '../picture/folder';
import { collectInfo, infoOf, forgetInfo, makeFilter, groupLabel, stackIds, type GroupKey, type FilterSpec } from '../picture/folderInfo';
import { viewState } from '../ui/overlays';
import { fullScreen } from './view';

const hasFolder = (app: App) => app.folder.length > 0;
const state = { group: 'none' as GroupKey, spec: null as FilterSpec | null, stacks: null as Map<string, string> | null };

async function ensureInfo(app: App): Promise<void> {
  const t = app.tab; const missing = t.folder.entries.filter((e) => !infoOf(e));
  if (!missing.length) return;
  toast(`Reading ${missing.length} picture${missing.length === 1 ? '' : 's'}…`, { ms: 1500 });
  await collectInfo(app, missing, (i, n) => toast(`Reading ${i} of ${n}…`, { ms: 700 }));
}
function applyGroup(app: App, key: GroupKey): void {
  const t = app.tab; state.group = key;
  if (key === 'none') t.thumbs.groupBy = null;
  else t.thumbs.groupBy = (e: Entry) => { const i = infoOf(e); return i ? groupLabel(key, i, key === 'stack' ? (n) => state.stacks?.get(n) || 'Single pictures' : undefined) : 'Unread'; };
  if (!t.thumbs.open) t.thumbs.show('grid'); t.thumbs.refilter(); app.refresh();
}
function applyFilter(app: App, spec: FilterSpec | null, label = ''): void {
  const t = app.tab; state.spec = spec;
  t.thumbs.filter = spec ? ((e: Entry) => { const i = infoOf(e); return i ? makeFilter(spec)(i) : true; }) : null;
  t.thumbs.filterLabel = label;
  if (!t.thumbs.open) t.thumbs.show('grid'); t.thumbs.refilter(); app.refresh();
}

const cull = { running: false, app: null as App | null, decided: 0 };
const onCullKey = (e: KeyboardEvent) => {
  const app = cull.app; if (!app || !cull.running) return;
  const k = e.key.toLowerCase(); const stopIt = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  const decide = async (cmd: string, label: string) => { stopIt(); const entry = app.picture?.entry; await app.exec(cmd); if (entry) forgetInfo(entry); cull.decided++; app.viewer.flash(label); setTimeout(() => app.exec('view.next'), 150); };
  if (k === 'p') void decide('browse.pick', 'Pick ✓'); else if (k === 'x') void decide('browse.reject', 'Reject ✗'); else if (k === 'u') void decide('browse.unflag', 'Unflagged');
  else if (k >= '1' && k <= '5' && !e.ctrlKey && !e.metaKey) { stopIt(); void app.exec('browse.rate', +k); }
  else if (k === 'escape') { stopIt(); stopCull(app); }
};
function startCull(app: App): void {
  cull.running = true; cull.app = app; cull.decided = 0;
  window.addEventListener('keydown', onCullKey, true);
  (cull as any).savedOsd = viewState.osd;
  viewState.osd = true; viewState.osdTemplate = 'CULL  {n} / {total}  {name}\nP pick · X reject · U unflag · 1–5 stars · Esc leaves';
  fullScreen(app, true); app.viewer.draw(); app.refresh();
}
function stopCull(app: App): void {
  if (!cull.running) return; cull.running = false;
  window.removeEventListener('keydown', onCullKey, true);
  viewState.osd = (cull as any).savedOsd; viewState.osdTemplate = null;
  fullScreen(app, false); app.viewer.draw(); app.refresh();
  toast(`Cull mode ended: ${cull.decided} decision${cull.decided === 1 ? '' : 's'}. Select Rejected gathers the rejects.`, { ms: 4000 });
}
export const cullState = cull;

def([
  {
    id: 'browse.filter', icon: 'filter_alt', popular: true, kind: 'toggle', noRecord: true, isEnabled: hasFolder, isActive: (app) => !!app.tab.thumbs.filter, tip: 'Show only the thumbnails that match: type, rating, label, keyword, text, dates, camera, location, orientation, flag',
    run: async (app) => {
      await ensureInfo(app);
      const s = state.spec || {};
      const r = await openDialog({ title: 'Filter Bar', ok: 'Apply', wide: true, help: 'Leave a field empty to ignore it. The thumbnails show only the matches; navigation still covers the whole folder.', fields: [
        { key: 'types', label: 'Types (e.g. jpeg png; empty = all)', type: 'text', value: (s.types || []).join(' '), half: true }, { key: 'minRating', label: 'Rating at least', type: 'select', options: ['0', '1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v === '0' ? 'Any' : '★'.repeat(+v) })), value: String(s.minRating || 0), half: true },
        { key: 'label', label: 'Color label', type: 'select', options: ['', 'red', 'yellow', 'green', 'blue', 'purple'].map((v) => ({ value: v, label: v ? v[0].toUpperCase() + v.slice(1) : 'Any' })), value: s.label || '', half: true }, { key: 'flag', label: 'Flag', type: 'select', options: [{ value: '', label: 'Any' }, { value: 'pick', label: 'Picks' }, { value: 'reject', label: 'Rejects' }], value: s.flag || '', half: true },
        { key: 'keyword', label: 'Keyword contains', type: 'text', value: s.keyword || '', half: true }, { key: 'text', label: 'Name or text contains', type: 'text', value: s.text || '', half: true },
        { key: 'from', label: 'Taken from', type: 'date', value: s.from ? s.from.toISOString().slice(0, 10) : '', half: true }, { key: 'to', label: 'Taken to', type: 'date', value: s.to ? s.to.toISOString().slice(0, 10) : '', half: true },
        { key: 'camera', label: 'Camera contains', type: 'text', value: s.camera || '', half: true }, { key: 'orientation', label: 'Orientation', type: 'select', options: [{ value: '', label: 'Any' }, { value: 'landscape', label: 'Landscape' }, { value: 'portrait', label: 'Portrait' }, { value: 'square', label: 'Square' }], value: s.orientation || '', half: true },
        { key: 'hasGps', label: 'Location', type: 'select', options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Has a location' }, { value: 'no', label: 'No location' }], value: s.hasGps === true ? 'yes' : s.hasGps === false ? 'no' : '', half: true }, { key: 'favorite', label: 'Favorites only', type: 'checkbox', value: !!s.favorite, half: true },
      ], buttons: [{ label: 'Clear filter', onClick: (_v, ctl) => { ctl.close(null); applyFilter(app, null); } }, { label: 'Mark the matches', onClick: (v, ctl) => { ctl.close(v); setTimeout(() => { const t = app.tab; t.marked.clear(); for (const e of t.folder.entries) if (!t.thumbs.filter || t.thumbs.filter(e)) t.marked.add(e); t.thumbs.refilter(); app.refresh(); }, 50); } }] });
      if (!r) return;
      const spec: FilterSpec = { types: String(r.types || '').split(/[\s,;]+/).filter(Boolean), minRating: +r.minRating || 0, label: r.label, flag: r.flag, keyword: r.keyword, text: r.text, from: r.from ? new Date(r.from) : null, to: r.to ? new Date(new Date(r.to).getTime() + 86400e3 - 1) : null, camera: r.camera, orientation: r.orientation, hasGps: r.hasGps === 'yes' ? true : r.hasGps === 'no' ? false : null, favorite: r.favorite ? true : null };
      const parts = [spec.types!.length ? spec.types!.join('/') : '', spec.minRating ? `≥${'★'.repeat(spec.minRating)}` : '', spec.label, spec.flag, spec.keyword && `kw:${spec.keyword}`, spec.text && `"${spec.text}"`, r.from || r.to ? `${r.from || '…'}–${r.to || '…'}` : '', spec.camera, spec.orientation, spec.hasGps === true ? 'located' : spec.hasGps === false ? 'unlocated' : '', spec.favorite ? '♥' : ''].filter(Boolean);
      if (!parts.length) { applyFilter(app, null); return; }
      applyFilter(app, spec, parts.join(' · '));
      toast(`${app.tab.folder.entries.filter((e) => app.tab.thumbs.filter!(e)).length} of ${app.folder.length} match`);
    },
  },
  {
    id: 'browse.groupBy', icon: 'workspaces', kind: 'menu', noRecord: true, isEnabled: hasFolder, isActive: () => state.group !== 'none', tip: 'Thumbnails under headers by date, camera, lens, rating, label, keyword, type or stack',
    menu: () => ([['none', 'No grouping'], ['date', 'Date taken'], ['camera', 'Camera'], ['lens', 'Lens'], ['rating', 'Rating'], ['label', 'Color label'], ['keyword', 'First keyword'], ['type', 'File type'], ['stack', 'Stacks (bursts, RAW+JPEG pairs)']] as [GroupKey, string][]).map(([value, label]) => ({ id: 'browse.groupBy', arg: value, label, checked: state.group === value })),
    run: async (app, arg?: GroupKey) => { const key = arg || (state.group === 'none' ? 'date' : 'none'); if (key !== 'none') await ensureInfo(app); if (key === 'stack') { const infos = app.tab.folder.entries.map((e) => infoOf(e)!).filter(Boolean); state.stacks = stackIds(infos); } applyGroup(app, key); },
  },
  {
    id: 'browse.timeline', icon: 'calendar_month', noRecord: true, isEnabled: hasFolder, tip: 'Pictures by year, month and day (date taken); pick a period to show it',
    run: async (app) => {
      await ensureInfo(app);
      const f = app.tab.folder; const counts = new Map<string, number>(); let undated = 0;
      for (const e of f.entries) { const i = infoOf(e); if (!i?.date) { undated++; continue; } const d = i.date; const y = String(d.getFullYear()), m = `${y}-${String(d.getMonth() + 1).padStart(2, '0')}`, day = `${m}-${String(d.getDate()).padStart(2, '0')}`; for (const k of [y, m, day]) counts.set(k, (counts.get(k) || 0) + 1); }
      const keys = [...counts.keys()].sort();
      let chosen: string | null = null; const dialog = { close: null as null | (() => void) };
      const rows = keys.map((k) => h('button', { class: 'ql-btn qn-timeline-row', style: `margin-left:${(k.length - 4) * 6}px`, onclick: () => { chosen = k; dialog.close?.(); } }, k.length === 4 ? k : k.length === 7 ? new Date(k + '-01T12:00').toLocaleString(undefined, { month: 'long', year: 'numeric' }) : new Date(k + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), h('span', { class: 'ql-help' }, ` ${counts.get(k)}`)));
      await openDialog({ title: 'Timeline', ok: 'Close', cancel: false, help: `${f.length - undated} dated pictures${undated ? `, ${undated} without a date` : ''}. Click a period to show only those pictures, grouped by day.`, content: h('div', { style: 'max-height:60vh;overflow:auto;display:flex;flex-direction:column;gap:2px;align-items:flex-start' }, ...(rows.length ? rows : [h('p', { class: 'ql-help' }, 'No dated pictures in this folder.')])), onOpen: (ctl) => { dialog.close = () => ctl.close({}); } });
      if (!chosen) return;
      const k: string = chosen; const from = new Date(k.length === 4 ? `${k}-01-01T00:00` : k.length === 7 ? `${k}-01T00:00` : `${k}T00:00`); const to = new Date(from); if (k.length === 4) to.setFullYear(to.getFullYear() + 1); else if (k.length === 7) to.setMonth(to.getMonth() + 1); else to.setDate(to.getDate() + 1);
      applyFilter(app, { from, to: new Date(to.getTime() - 1) }, k); applyGroup(app, 'date');
    },
  },
  {
    id: 'browse.stacks', icon: 'layers', noRecord: true, isEnabled: hasFolder, tip: 'Groups bursts (taken within 3 seconds) and RAW+JPEG pairs under stack headers',
    run: async (app) => { await ensureInfo(app); const infos = app.tab.folder.entries.map((e) => infoOf(e)!).filter(Boolean); state.stacks = stackIds(infos); const n = new Set([...state.stacks.values()].filter((v) => v !== 'Single pictures')).size; applyGroup(app, 'stack'); toast(n ? `${n} stack${n === 1 ? '' : 's'} found` : 'No bursts or pairs found.'); },
  },
  {
    id: 'browse.lightTable', icon: 'table_restaurant', noRecord: true, isEnabled: (app) => app.tab.marked.size > 0, tip: 'The marked pictures in a new window, for side-by-side review (thumbnails open there)',
    run: async (app) => { const t = app.tab; const marked = t.folder.entries.filter((e) => t.marked.has(e)); if (!marked.length) { toast('Mark pictures first.'); return; } const tab = await app.openFolder(new Folder([...marked], `Light table (${marked.length})`), 0, { newWindow: true }); tab.thumbs.show('grid'); },
  },
  {
    id: 'browse.cull', icon: 'rule', kind: 'toggle', noRecord: true, isEnabled: hasFolder, isActive: () => cull.running, tip: 'Full-screen keep/reject: P pick, X reject, U unflag, 1–5 stars, auto-advance; Esc leaves',
    run: (app) => { if (cull.running) stopCull(app); else startCull(app); },
  },
]);

/** For smart albums: the filter in use, applying a saved one, and reading the folder's details first. */
export const currentFilter = (): FilterSpec | null => state.spec;
export { applyFilter, ensureInfo };
