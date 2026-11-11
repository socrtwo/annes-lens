/**
 * Tools ▸ Back Up Library, Plug-ins and External Tools.
 */
import { def, addCommandSource, type Command } from './registry';
import type { App } from '../app';
import { openDialog, toast, promptDialog, confirmDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { isPictureName } from '../picture/folder';
import { pickFolder, createSubfolder, writeIntoFolder, listFolderFiles, listSubfolders, desktopBridge, isDesktop, openExternal, rememberFolder, writeClipboardText, type FolderEntry } from '../platform/native';
import { listCatFolders, catItems, folderUri } from '../picture/catalog';
import { listAlbums, listSmart } from '../picture/albums';
import { listFavorites } from '../picture/favorites';
import { listWatches } from '../picture/watch';
import { propsOf } from '../picture/metadata';
import { ScriptHost } from '../dev/scriptHost';
import { FORMATS } from '../codecs/registry';
import { ORT_VERSION, MODELS, downloadedModels } from '../ai/device';
import { TESSERACT_VERSION, OCR_LANGS } from '../picture/ocr';
import { installed as installedLanguages } from '../i18n/languages';

// External Tools ---------------------------------------------------------------------------------

/** Fills a web tool's address; null when the picture lacks something the address needs. Values are URL-encoded. */
export function expandToolUrl(template: string, vars: Record<string, string | number | undefined>): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_m, k) => { const v = vars[k]; if (v === undefined || v === '') { missing = true; return ''; } return encodeURIComponent(String(v)); });
  return missing || !/^https?:\/\//i.test(out) ? null : out;
}
/** Splits a command line into arguments ("quoted parts" stay together). */
export function splitArgs(s: string): string[] { return [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]); }

function pictureVars(app: App): Record<string, string | number | undefined> {
  const p = app.picture; if (!p) return {};
  const x = propsOf(p.entry), gps = p.exif?.gps;
  const date = p.exif?.dateTaken?.replace(/^(\d{4}):(\d{2}):(\d{2}).*/, '$1-$2-$3');
  return { name: p.name, base: p.name.replace(/\.[^.]+$/, ''), lat: x?.lat ?? gps?.lat, lon: x?.lon ?? gps?.lon, date, title: x?.title, keywords: x?.keywords?.join(' '), width: p.width, height: p.height };
}
async function runTool(app: App, t: App['prefs']['externalTools'][number]): Promise<void> {
  if (t.kind === 'web') {
    const url = expandToolUrl(t.url || '', pictureVars(app));
    if (!url) { toast(`${t.name} needs something this picture does not have (${(t.url || '').match(/\{(\w+)\}/g)?.join(' ') || 'an address'}).`, { ms: 4000 }); return; }
    await openExternal(url); return;
  }
  const d = desktopBridge(), uri = app.picture?.entry.uri;
  if (!d) { toast('Programs run from the desktop app; web tools work everywhere.'); return; }
  if (!uri || !uri.startsWith('file:')) { toast('Open a picture from a file first.'); return; }
  const r = await d.openWithProgram({ uri, program: t.program || '', args: t.args ? splitArgs(t.args) : undefined }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  toast(r.ok ? `Sent ${app.picture!.name} to ${t.name}.` : `${t.name} could not be started: ${r.error}`, { ms: r.ok ? 1500 : 5000 });
}

// Script plug-ins --------------------------------------------------------------------------------

/** Runs a plug-in's script in the worker; prints and the result come back as a message. Stops after a minute. */
export async function runPlugin(app: App, code: string, name: string): Promise<{ ok: boolean; output: string[] }> {
  const output: string[] = [];
  const host = new ScriptHost(app, (o) => { if (o.kind !== 'info') output.push((o.kind === 'error' ? '✖ ' : '') + o.text); });
  const timer = setTimeout(() => host.stop(), 60000);
  try { const ok = await host.run(code); if (output.length) toast(`${name}: ${output.slice(-3).join(' · ').slice(0, 300)}`, { ms: 4000 }); return { ok, output }; }
  finally { clearTimeout(timer); host.dispose(); }
}

addCommandSource((id) => {
  const app: App | undefined = (globalThis as any).qn;
  if (!app) return undefined;
  if (id.startsWith('tool:')) {
    const t = app.prefs.externalTools.find((x) => `tool:${x.id}` === id); if (!t) return undefined;
    return { id, label: t.name, icon: t.kind === 'web' ? 'travel_explore' : 'open_in_new', tab: 'Tools', group: 'External Tools', noRecord: true, isEnabled: (a) => !!a.picture, run: (a) => runTool(a, t) } as Command;
  }
  if (id.startsWith('plugin:')) {
    const p = app.prefs.scriptPlugins.find((x) => `plugin:${x.id}` === id && x.enabled); if (!p) return undefined;
    return { id, label: p.name, icon: p.icon || 'extension', tab: 'Tools', group: 'Plug-ins', run: async (a) => { await runPlugin(a, p.code, p.name); } } as Command;
  }
  return undefined;
});
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const addToQat = (app: App, id: string) => { if (!app.prefs.qat.includes(id)) { app.prefs.qat = [...app.prefs.qat, id]; app.savePrefs(); app.ui.renderQat(); } };

// Back Up Library --------------------------------------------------------------------------------

export interface BackupReport { folders: number; copied: number; skipped: number; failed: string[]; bytes: number; library: boolean }
const isKept = (name: string) => isPictureName(name) || /\.xmp$/i.test(name);

/** Copies one folder tree (pictures and sidecars) into `destUri`, skipping files already there at the same size. */
async function copyTree(srcUri: string, destUri: string, subfolders: boolean, rep: BackupReport, progress: (t: string) => void, depth = 0): Promise<void> {
  rep.folders++;
  const there = new Map<string, number | undefined>();
  const existing = await listFolderFiles(destUri, { all: true }).catch(() => null);
  for (const e of (existing?.entries || []) as FolderEntry[]) there.set(e.name, e.size);
  for (const x of existing?.handles || []) { let size: number | undefined; try { size = (await x.handle.getFile()).size; } catch { /* */ } there.set(x.name, size); }
  const src = await listFolderFiles(srcUri, { all: true }).catch(() => null);
  const files: { name: string; size?: number; read: () => Promise<ArrayBuffer> }[] = [];
  for (const e of (src?.entries || []) as FolderEntry[]) if (isKept(e.name)) { const { readUri } = await import('../platform/native'); files.push({ name: e.name, size: e.size, read: async () => { const f = await readUri(e.uri); if (!f) throw new Error('unreadable'); return f.data; } }); }
  for (const x of src?.handles || []) if (isKept(x.name)) { let size: number | undefined; try { size = (await x.handle.getFile()).size; } catch { /* */ } files.push({ name: x.name, size, read: async () => (await x.handle.getFile()).arrayBuffer() }); }
  for (const f of files) {
    if (there.has(f.name) && f.size !== undefined && there.get(f.name) === f.size) { rep.skipped++; continue; }
    try { const data = await f.read(); await writeIntoFolder(destUri, f.name, data); rep.copied++; rep.bytes += data.byteLength; if (rep.copied % 10 === 0) progress(`Backed up ${rep.copied} files…`); }
    catch (e: any) { rep.failed.push(`${f.name}: ${e?.message || e}`); }
  }
  if (!subfolders || depth >= 16) return;
  for (const s of (await listSubfolders(srcUri).catch(() => null)) || []) {
    const d = await createSubfolder(destUri, s.name);
    await copyTree(s.uri, d.uri, true, rep, progress, depth + 1);
  }
}
/** The library as JSON: settings, albums, smart albums, favorites, the catalog (without thumbnails) and watches; browser handles cannot be written and are left out. */
export async function libraryJson(app: App): Promise<string> {
  const noHandle = <T extends { handle?: unknown }>(x: T) => { const { handle, ...rest } = x; void handle; return rest; };
  const folders = await listCatFolders();
  const catalog = await Promise.all(folders.map(async (f) => ({ ...noHandle(f), items: (await catItems(f.id)).map((i) => ({ ...i })) })));
  const albums = (await listAlbums()).map((a) => ({ ...a, items: a.items.map(noHandle) }));
  const watches = (await listWatches()).map((w) => ({ ...w, folder: noHandle(w.folder), dest: w.dest ? noHandle(w.dest) : undefined }));
  return JSON.stringify({ app: 'Anne\'s Lens', kind: 'library-backup', version: 1, created: new Date().toISOString(), prefs: app.prefs, albums, smartAlbums: await listSmart(), favorites: (await listFavorites()).map(noHandle), catalog, watches }, null, 1);
}

def([
  {
    id: 'tools.external', icon: 'construction', noRecord: true, tip: 'Programs (desktop) and web addresses to send pictures to; each one becomes a command for the Quick Access Bar, menus and keys',
    run: async (app, arg?: string | { add: 'web'; name: string; url: string } | { add: 'program'; name: string; program: string; args?: string } | { remove: string }) => {
      const tools = app.prefs.externalTools;
      if (typeof arg === 'string') { const t = tools.find((x) => x.id === arg || x.name === arg); if (t) return runTool(app, t); toast(`No tool named ${arg}.`); return; }
      let v = arg;
      if (!v) {
        const r = await openDialog({ title: 'External Tools', ok: 'OK', help: 'Web addresses may use {name} {base} {lat} {lon} {date} {title} {keywords} {width} {height}. Program arguments may use {file} {folder} {name}. Each tool is a command: add it to the Quick Access Bar here, or place it with Customize Tabs, Menus or Keyboard.', fields: [
          ...(tools.length ? [{ key: 'which', label: 'Tools', type: 'list' as const, value: tools[0].id, options: tools.map((t) => ({ value: t.id, label: `${t.name} — ${t.kind === 'web' ? t.url : `${t.program} ${t.args || ''}`}` })) }] : []),
          { key: 'act', label: 'Action', type: 'radio', value: tools.length ? 'run' : 'addWeb', options: [...(tools.length ? [{ value: 'run', label: 'Run the chosen tool on this picture' }, { value: 'qat', label: 'Add the chosen tool to the Quick Access Bar' }, { value: 'remove', label: 'Remove the chosen tool' }] : []), { value: 'addWeb', label: 'Add a web tool (an address)…' }, ...(isDesktop() ? [{ value: 'addProgram', label: 'Add a program…' }] : [])] },
          { key: 'name', label: 'Name', type: 'text', value: 'Show on OpenStreetMap', visibleIf: (x) => x.act === 'addWeb' },
          { key: 'url', label: 'Address', type: 'text', value: 'https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=16/{lat}/{lon}', visibleIf: (x) => x.act === 'addWeb' },
          { key: 'args', label: 'Arguments (empty: the file)', type: 'text', value: '', placeholder: '--open {file}', visibleIf: (x) => x.act === 'addProgram' },
        ] });
        if (!r) return;
        if (r.act === 'run') return app.exec('tools.external', String(r.which));
        if (r.act === 'qat') { addToQat(app, `tool:${r.which}`); toast('Added to the Quick Access Bar.'); return; }
        if (r.act === 'remove') v = { remove: String(r.which) };
        else if (r.act === 'addWeb') v = { add: 'web', name: String(r.name).trim(), url: String(r.url).trim() };
        else { const d = desktopBridge()!; const p = await d.pickProgram(); if (p.canceled || !p.path) return; const n = await promptDialog('Add a Program', 'Name', p.name || p.path); if (n === null) return; v = { add: 'program', name: n.trim() || p.path, program: p.path, args: String(r.args || '').trim() }; }
      }
      if ('remove' in v) { app.prefs.externalTools = tools.filter((t) => t.id !== v!.remove); app.prefs.qat = app.prefs.qat.filter((q) => q !== `tool:${v!.remove}`); app.savePrefs(); app.ui.renderQat(); toast('Tool removed.'); return; }
      if (v.add === 'web' && !/^https?:\/\//i.test(v.url)) { toast('A web tool\'s address starts with https:// (or http://).'); return; }
      const t = v.add === 'web' ? { id: newId(), name: v.name || 'Web tool', kind: 'web' as const, url: v.url } : { id: newId(), name: v.name, kind: 'program' as const, program: v.program, args: v.args };
      app.prefs.externalTools = [...tools, t]; app.savePrefs();
      toast(`${t.name} added; run it from Tools ▸ External Tools or put it on the Quick Access Bar.`, { action: 'Add to QAT', onAction: () => addToQat(app, `tool:${t.id}`) });
      return t;
    },
  },
  {
    id: 'tools.plugins', icon: 'extension', noRecord: true, tip: 'The installed components and their versions (formats, runtimes, models, languages) and your script plug-ins: add, enable or disable, remove',
    run: async (app, arg?: { add: { name: string; code: string } } | { toggle: string } | { remove: string } | 'list') => {
      const plugins = app.prefs.scriptPlugins;
      if (arg && typeof arg === 'object') {
        if ('add' in arg) { const p = { id: newId(), name: arg.add.name, code: arg.add.code, enabled: true, added: Date.now() }; app.prefs.scriptPlugins = [...plugins, p]; app.savePrefs(); toast(`Plug-in "${p.name}" added: it is the command plugin:${p.id}.`); return p; }
        if ('toggle' in arg) { const p = plugins.find((x) => x.id === arg.toggle); if (p) { p.enabled = !p.enabled; app.savePrefs(); app.ui.renderQat(); toast(`${p.name} ${p.enabled ? 'enabled' : 'disabled'}.`); } return p; }
        if ('remove' in arg) { app.prefs.scriptPlugins = plugins.filter((x) => x.id !== arg.remove); app.prefs.qat = app.prefs.qat.filter((q) => q !== `plugin:${arg.remove}`); app.savePrefs(); app.ui.renderQat(); return; }
      }
      const models = await downloadedModels().catch(() => []);
      const own = FORMATS.filter((f) => f.decoder !== 'platform');
      const comps = [
        `ONNX Runtime Web ${ORT_VERSION} (on-device AI) · models downloaded: ${models.length ? models.map((m) => `${m.spec.title} ${(m.bytes / 1048576).toFixed(0)} MB`).join(', ') : 'none'} of ${MODELS.length}`,
        `Tesseract ${TESSERACT_VERSION} (OCR) · ${OCR_LANGS.length} languages available`,
        `Format readers of the app's own: ${own.length} (${own.map((f) => f.label).join(', ')}); the platform reads ${FORMATS.length - own.length} more`,
        `Interface languages: ${installedLanguages().map((l) => l.name).join(', ')}`,
      ];
      if (arg === 'list') return { comps, plugins };
      const r = await openDialog({ title: 'Plug-ins', ok: 'OK', wide: true, help: 'Script plug-ins are JavaScript run like the Script Console (app, picture, folder calls) in an isolated worker; each enabled one is a command for the Quick Access Bar, menus and keys.', fields: [
        { key: 'c', type: 'info', label: 'Components' }, { key: 'list', type: 'info', html: `<ul class="qn-plugin-list">${comps.map((c) => `<li>${c.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</li>`).join('')}</ul>` },
        ...(plugins.length ? [{ key: 'which', label: 'Script plug-ins', type: 'list' as const, value: plugins[0].id, options: plugins.map((p) => ({ value: p.id, label: `${p.enabled ? '✓' : '○'} ${p.name} (plugin:${p.id})` })) }] : []),
        { key: 'act', label: 'Action', type: 'radio', value: 'none', options: [{ value: 'none', label: 'Nothing (close)' }, { value: 'file', label: 'Add a plug-in from a .js file…' }, ...(plugins.length ? [{ value: 'run', label: 'Run the chosen plug-in' }, { value: 'toggle', label: 'Enable or disable the chosen plug-in' }, { value: 'qat', label: 'Add the chosen plug-in to the Quick Access Bar' }, { value: 'remove', label: 'Remove the chosen plug-in' }] : [])] },
      ] });
      if (!r || r.act === 'none') return;
      const p = plugins.find((x) => x.id === r.which);
      if (r.act === 'file') {
        const { pickFile } = await import('../ui/dom'); const [f] = await pickFile('.js,text/javascript'); if (!f) return;
        const code = await f.text(); if (code.length > 200000) { toast('That script is larger than 200 KB.'); return; }
        const name = (code.match(/^\s*\/\/\s*@name\s+(.+)$/m)?.[1] || f.name.replace(/\.js$/i, '')).trim();
        if (!(await confirmDialog('Add Plug-in', `Add "${name}"? It runs in the Script Console's isolated worker and can change the open picture and move through the open folder with the app's commands. Commands that go further (other programs, the network, AI services, other files, batch jobs, settings, other plug-ins) ask you each time it runs.`, 'Add'))) return;
        return app.exec('tools.plugins', { add: { name, code } });
      }
      if (!p) return;
      if (r.act === 'run') { await runPlugin(app, p.code, p.name); return; }
      if (r.act === 'toggle') return app.exec('tools.plugins', { toggle: p.id });
      if (r.act === 'qat') { if (!p.enabled) { toast('Enable the plug-in first.'); return; } addToQat(app, `plugin:${p.id}`); toast('Added to the Quick Access Bar.'); return; }
      if (r.act === 'remove' && (await confirmDialog('Remove Plug-in', `Remove "${p.name}"?`, 'Remove'))) return app.exec('tools.plugins', { remove: p.id });
    },
  },
  {
    id: 'tools.backup', icon: 'backup', noRecord: true, tip: 'Copies the catalog\'s folders (or the open folder) with their sidecars, and the library (settings, albums, catalog, favorites, watches), to a folder or drive; later runs copy only what changed',
    run: async (app, arg?: { dest: { uri: string; name: string }; library?: boolean }) => {
      const cat = await listCatFolders(), cur = app.folder;
      const sources: { name: string; uri: string; subfolders: boolean }[] = [];
      for (const f of cat) { const u = await folderUri(f); if (u) sources.push({ name: f.name, uri: u, subfolders: f.subfolders }); }
      if (!sources.length && cur.uri) sources.push({ name: cur.name.replace(/ \(with subfolders\)$/, ''), uri: cur.uri, subfolders: app.prefs.includeSubfolders });
      if (!sources.length) { toast('Nothing to back up: add folders to the catalog (Browse ▸ Folder Manager) or open a folder.'); return; }
      let v = arg;
      if (!v) {
        const r = await openDialog({ title: 'Back Up Library', ok: 'Choose Where…', fields: [{ key: 'i', type: 'info', label: `${sources.length === 1 ? sources[0].name : `${sources.length} folders`} ${cat.length ? '(the catalog)' : '(the open folder)'}: pictures and .xmp sidecars, into "Anne's Lens backup" in the folder you choose. Files already there at the same size are skipped.` }, { key: 'library', label: 'Also the library: settings, albums, smart albums, favorites, catalog, watches (annes-lens-library.json)', type: 'checkbox', value: true }] });
        if (!r) return;
        const d = await pickFolder('Back up to'); if (!d) return;
        v = { dest: d, library: !!r.library };
      }
      await rememberFolder(v.dest.uri);
      const root = await createSubfolder(v.dest.uri, 'Anne\'s Lens backup');
      const rep: BackupReport = { folders: 0, copied: 0, skipped: 0, failed: [], bytes: 0, library: false };
      for (const s of sources) { const d = await createSubfolder(root.uri, s.name); await copyTree(s.uri, d.uri, s.subfolders, rep, (t) => toast(t, { ms: 800 })); }
      if (v.library !== false) { const json = new TextEncoder().encode(await libraryJson(app)); await writeIntoFolder(root.uri, 'annes-lens-library.json', json.buffer as ArrayBuffer); rep.library = true; }
      const text = `${rep.copied} file${rep.copied === 1 ? '' : 's'} copied (${(rep.bytes / 1048576).toFixed(1)} MB), ${rep.skipped} already there, from ${rep.folders} folder${rep.folders === 1 ? '' : 's'}${rep.library ? '; library saved' : ''}${rep.failed.length ? `; ${rep.failed.length} failed` : ''}.`;
      if (arg) toast(text, { ms: 5000 });
      else await openDialog({ title: 'Back Up Library', ok: 'Close', cancel: false, content: h('div', null, h('p', null, `Into ${v.dest.name} ▸ Anne's Lens backup: ${text}`), ...(rep.failed.length ? [h('pre', { class: 'qn-console-out' }, rep.failed.join('\n'))] : [])), buttons: [{ label: 'Copy', onClick: () => void writeClipboardText(text) }] });
      return rep;
    },
  },
]);
