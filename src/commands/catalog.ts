/**
 * Browse ▸ Use Catalog, Folder Manager, Catalog Maintenance and Watch Folder.
 */
import { def } from './registry';
import type { App } from '../app';
import type { Entry } from '../picture/folder';
import { Folder } from '../picture/folder';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { listCatFolders, saveCatFolders, catFolderFor, scanFolder, removeCatFolder, catalogEntries, catalogStats, catItems, folderUri, type ScanReport } from '../picture/catalog';
import { listWatches, saveWatches, dirRefFor, dirUri, primeWatch, watchTick, runWatches, copyInto, type Watch, type WatchAction } from '../picture/watch';
import { pickFolder, writeIntoFolder, writeClipboardText, rememberFolder } from '../platform/native';
import { runBatch, type BatchJob } from './batch';
import { showFolder } from './file';
import { kvKeys, kvDel } from '../util/store';
import type { EncodeFormat } from '../codecs/registry';

const baseName = (n: string) => n.replace(/ \(with subfolders\)$/, '');
const progress = (t: string) => toast(t, { ms: 900 });

/** Shows every cataloged picture as one folder (facts and thumbnails from the catalog). */
export async function openCatalogView(app: App, quiet = false): Promise<boolean> {
  const { entries, unreachable } = await catalogEntries();
  if (!entries.length) { if (!quiet || !unreachable.length) toast(unreachable.length ? `The catalog's folders cannot be reached now: ${unreachable.join(', ')}.` : 'The catalog is empty: add folders with Browse ▸ Folder Manager.', { ms: 4000 }); return false; }
  const f = new Folder(entries, `Catalog (${entries.length} pictures)`);
  f.sort(app.prefs.sort, app.prefs.sortDescending);
  await app.openFolder(f, 0);
  if (!app.tab.thumbs.open) app.tab.thumbs.show('grid');
  if (unreachable.length) toast(`Not reachable now: ${unreachable.join(', ')}.`, { ms: 3000 });
  return true;
}
const scanText = (name: string, r: ScanReport) => `${name}: ${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.unchanged} unchanged${r.failed ? `, ${r.failed} unreadable` : ''}${r.unlisted ? `, ${r.unlisted} kept from subfolders that could not be listed` : ''}`;

/** What a watch does with the pictures that appeared. */
async function act(app: App, w: Watch, fresh: Entry[], uri: string): Promise<void> {
  const names = fresh.map((e) => e.name).join(', ');
  if (w.action === 'catalog') {
    const all = await listCatFolders();
    let f = all.find((x) => (x.uri && x.uri === w.folder.uri) || (!!x.handle && !!w.folder.handle && x.name === w.folder.name));
    if (!f) { f = catFolderFor(uri, w.folder.name, false)!; all.push(f); await saveCatFolders(all); }
    const r = await scanFolder(app, f);
    toast(`Watch: ${fresh.length} new in ${w.folder.name} (${names}); catalog ${scanText(f.name, r)}.`, { ms: 4000 });
  } else if (w.action === 'open') {
    await showFolder(app, w.folder.name, uri, (await import('./file')).listingEntries((await (await import('../platform/native')).listFolderFiles(uri))!), null);
    const i = app.folder.entries.findIndex((e) => e.name === fresh[fresh.length - 1].name); if (i >= 0 && app.folder.select(i)) await app.tab.show();
    toast(`Watch: ${fresh.length} new in ${w.folder.name}: ${names}`, { ms: 4000 });
  } else if (w.dest) {
    const dest = await dirUri(w.dest, 'readwrite');
    if (!dest) throw new Error(`${w.dest.name} cannot be written to now`);
    if (w.action === 'copy') { for (const e of fresh) await copyInto(dest, e); toast(`Watch: copied ${fresh.length} new picture${fresh.length === 1 ? '' : 's'} from ${w.folder.name} to ${w.dest.name}.`, { ms: 4000 }); }
    else {
      const rec = app.prefs.batchRecipes.find((r) => r.name === w.recipe); if (!rec) throw new Error(`The recipe "${w.recipe}" no longer exists`);
      const job: BatchJob = { inputs: fresh, format: rec.format as EncodeFormat | 'keep', quality: rec.quality, keepMeta: rec.keepMeta, steps: { actions: rec.actions }, names: { pattern: rec.pattern } };
      const r = await runBatch(app, job, async (res) => writeIntoFolder(dest, res.name, res.data.buffer.slice(res.data.byteOffset, res.data.byteOffset + res.data.byteLength) as ArrayBuffer, 'rename'), { silent: true });
      toast(`Watch: "${rec.name}" made ${r.done.length} file${r.done.length === 1 ? '' : 's'} in ${w.dest.name} from the new pictures in ${w.folder.name}${r.failed.length ? `; ${r.failed.length} failed` : ''}.`, { ms: 5000 });
    }
  }
}
/** Starts the watch timer (called at start-up and whenever the watches change). */
export const startWatching = (app: App, everyMs?: number) => runWatches(app, (w, fresh, uri) => act(app, w, fresh, uri), everyMs);

def([
  {
    id: 'browse.catalog', icon: 'inventory_2', kind: 'toggle', noRecord: true, isActive: (app) => app.prefs.useCatalog, tip: 'A local database of the folders you add: every picture at once, instant filters and smart albums over all of them; plain folders still work without it',
    run: async (app, arg?: 'open') => {
      if (arg === 'open') { await openCatalogView(app); return; }
      app.prefs.useCatalog = !app.prefs.useCatalog; app.savePrefs();
      if (!app.prefs.useCatalog) { toast('Catalog off: folders open as usual; the catalog is kept for next time.'); app.refresh(); return; }
      const st = await catalogStats();
      if (!st.folders) { toast('Catalog on. Add folders to it with Browse ▸ Folder Manager.', { ms: 3500 }); app.refresh(); return app.exec('browse.folderManager'); }
      await openCatalogView(app); app.refresh();
    },
  },
  {
    id: 'browse.folderManager', icon: 'folder_managed', noRecord: true, tip: 'Which folders the catalog holds: add the open folder, scan again, open, remove',
    run: async (app, arg?: { add?: boolean; subfolders?: boolean; rescan?: string | 'all'; remove?: string }) => {
      let v = arg;
      const folders = await listCatFolders();
      if (!v) {
        const st = await catalogStats(), cur = app.folder;
        const r = await openDialog({ title: 'Folder Manager', ok: 'Go', help: `The catalog holds ${st.pictures} picture${st.pictures === 1 ? '' : 's'} in ${st.folders} folder${st.folders === 1 ? '' : 's'}. Removing a folder only forgets it; no file is touched.`, fields: [
          ...(folders.length ? [{ key: 'which', label: 'Catalog folders', type: 'list' as const, value: folders[0].id, options: folders.map((f) => ({ value: f.id, label: `${f.name}${f.subfolders ? ' (with subfolders)' : ''} — ${f.count ?? 0} pictures${f.lastScan ? `, scanned ${new Date(f.lastScan).toLocaleString()}` : ''}` })) }] : []),
          { key: 'act', label: 'Action', type: 'radio', value: cur.uri ? 'add' : folders.length ? 'open' : 'add', options: [
            { value: 'add', label: cur.uri ? `Add the open folder (${baseName(cur.name)})` : 'Add the open folder (open one with File ▸ Open Folder first)' },
            ...(folders.length ? [{ value: 'open', label: 'Open the chosen folder' }, { value: 'rescan', label: 'Scan the chosen folder again' }, { value: 'rescanAll', label: 'Scan every folder again' }, { value: 'remove', label: 'Remove the chosen folder from the catalog' }, { value: 'view', label: 'Show the whole catalog' }] : []),
          ] },
          { key: 'sub', label: 'With its subfolders', type: 'checkbox', value: true, visibleIf: (x) => x.act === 'add' },
        ] });
        if (!r) return;
        if (r.act === 'add') v = { add: true, subfolders: !!r.sub };
        else if (r.act === 'rescan') v = { rescan: String(r.which) }; else if (r.act === 'rescanAll') v = { rescan: 'all' };
        else if (r.act === 'remove') v = { remove: String(r.which) };
        else if (r.act === 'view') { await openCatalogView(app); return; }
        else if (r.act === 'open') { const f = folders.find((x) => x.id === r.which); const u = f && (await folderUri(f)); if (!f || !u) { toast('That folder cannot be reached now.'); return; } const { openFolderRef } = await import('./viewWindow'); await openFolderRef(app, { uri: u, name: f.name }, null); return; }
      }
      if (!v) return;
      if (v.add) {
        const cur = app.folder, f = catFolderFor(cur.uri, baseName(cur.name), v.subfolders !== false);
        if (!f) { toast('This folder has no address the catalog can keep (dropped files): open it with File ▸ Open Folder.'); return; }
        if (folders.some((x) => (x.uri && x.uri === f.uri) || (x.handle && f.handle && x.name === f.name))) { toast(`${f.name} is already in the catalog; scan it again from the Folder Manager.`); return; }
        folders.push(f); await saveCatFolders(folders); await rememberFolder(f.uri);
        const rep = await scanFolder(app, f, { progress });
        toast(`Cataloged ${scanText(f.name, rep)}.`, { ms: 4000 });
        if (app.prefs.useCatalog) await openCatalogView(app, true);
        return rep;
      }
      if (v.rescan) {
        const list = v.rescan === 'all' ? folders : folders.filter((f) => f.id === v!.rescan); const out: string[] = [];
        for (const f of list) { try { out.push(scanText(f.name, await scanFolder(app, f, { progress }))); } catch (e: any) { out.push(`${f.name}: ${e?.message || e}`); } }
        toast(out.join(' · '), { ms: 5000 }); return out;
      }
      if (v.remove) { const f = folders.find((x) => x.id === v!.remove); if (f && (await confirmDialog('Remove from Catalog', `Forget ${f.name} in the catalog? The pictures are not touched.`, 'Remove'))) { await removeCatFolder(f.id); toast(`${f.name} removed from the catalog.`); } }
    },
  },
  {
    id: 'browse.maintenance', icon: 'build', noRecord: true, tip: 'Scan every catalog folder: re-read the facts, drop pictures that are gone, rebuild thumbnails, list orphaned .xmp sidecars',
    run: async (app, arg?: { reread?: boolean; thumbs?: boolean }) => {
      const folders = await listCatFolders();
      if (!folders.length) { toast('The catalog is empty: add folders with Browse ▸ Folder Manager.'); return; }
      let v = arg;
      if (!v) { const r = await openDialog({ title: 'Catalog Maintenance', ok: 'Run', fields: [{ key: 'i', type: 'info', label: 'Every catalog folder is scanned: pictures that are gone are dropped and new ones added; orphaned .xmp sidecars (no picture beside them) are listed.' }, { key: 'reread', label: 'Re-read every picture\'s facts (dates, ratings, keywords…)', type: 'checkbox', value: false }, { key: 'thumbs', label: 'Rebuild the thumbnails', type: 'checkbox', value: false }] }); if (!r) return; v = { reread: !!r.reread, thumbs: !!r.thumbs }; }
      if (v.thumbs) for (const k of await kvKeys('catalog.v1.thumb.')) await kvDel(k);
      const lines: string[] = [], orphans: string[] = [];
      for (const f of folders) { try { const r = await scanFolder(app, f, { reread: v.reread, thumbs: true, progress }); lines.push(`${scanText(f.name, r)}, ${r.thumbs} thumbnail${r.thumbs === 1 ? '' : 's'} made`); orphans.push(...r.orphans.map((o) => `${f.name}/${o}`)); } catch (e: any) { lines.push(`${f.name}: ${e?.message || e}`); } }
      const report = [...lines, '', orphans.length ? `Orphaned sidecars (${orphans.length}):` : 'No orphaned sidecars.', ...orphans].join('\n');
      await openDialog({ title: 'Catalog Maintenance', ok: 'Close', cancel: false, wide: true, content: h('pre', { class: 'qn-console-out qn-maint' }, report), buttons: [{ label: 'Copy', onClick: () => void writeClipboardText(report).then(() => toast('Report copied.')) }] }).catch(() => undefined);
      return { lines, orphans };
    },
  },
  {
    id: 'browse.watchFolder', icon: 'notifications_active', noRecord: true, tip: 'New pictures in a folder are added to the catalog, shown, copied into a folder or run through a batch recipe, while Anne\'s Lens is open',
    run: async (app, arg?: 'tick' | { add: WatchAction; dest?: { uri: string; name: string }; recipe?: string } | { remove: string }) => {
      if (arg === 'tick') return watchTick(app, (w, fresh, uri) => act(app, w, fresh, uri));
      const watches = await listWatches();
      let v = arg;
      if (!v) {
        const cur = app.folder, recipes = app.prefs.batchRecipes;
        const r = await openDialog({ title: 'Watch Folder', ok: 'OK', help: 'Folders are checked every 15 seconds while Anne\'s Lens is open; pictures that arrived while it was closed count as new the next time.', fields: [
          ...(watches.length ? [{ key: 'which', label: 'Watched folders', type: 'list' as const, value: watches[0].id, options: watches.map((w) => ({ value: w.id, label: `${w.folder.name} → ${w.action === 'catalog' ? 'catalog' : w.action === 'open' ? 'show' : w.action === 'copy' ? `copy to ${w.dest?.name}` : `"${w.recipe}" into ${w.dest?.name}`}${w.total ? ` (${w.total} so far)` : ''}` })) }] : []),
          { key: 'act', label: 'Action', type: 'radio', value: cur.uri ? 'add' : 'remove', options: [{ value: 'add', label: cur.uri ? `Watch the open folder (${baseName(cur.name)})` : 'Watch the open folder (open one first)' }, ...(watches.length ? [{ value: 'remove', label: 'Stop watching the chosen folder' }] : [])] },
          { key: 'what', label: 'New pictures are', type: 'select', value: 'catalog', visibleIf: (x) => x.act === 'add', options: [{ value: 'catalog', label: 'Added to the catalog' }, { value: 'open', label: 'Shown' }, { value: 'copy', label: 'Copied into a folder' }, ...(recipes.length ? [{ value: 'recipe', label: 'Run through a batch recipe into a folder' }] : [])] },
          { key: 'recipe', label: 'Recipe', type: 'select', value: recipes[0]?.name || '', options: recipes.map((x) => ({ value: x.name, label: x.name })), visibleIf: (x) => x.act === 'add' && x.what === 'recipe' },
        ] });
        if (!r) return;
        if (r.act === 'remove') v = { remove: String(r.which) };
        else {
          let dest: { uri: string; name: string } | undefined;
          if (r.what === 'copy' || r.what === 'recipe') { const d = await pickFolder('Where should the new pictures go?'); if (!d) return; dest = d; }
          v = { add: r.what as WatchAction, dest, recipe: r.recipe };
        }
      }
      if ('remove' in v) { await saveWatches(watches.filter((w) => w.id !== v!.remove || false)); startWatching(app); toast('Stopped watching.'); return; }
      const cur = app.folder, folder = cur.uri ? dirRefFor(cur.uri, baseName(cur.name)) : null;
      if (!folder) { toast('Open a folder (File ▸ Open Folder) to watch it.'); return; }
      const dest = v.dest ? dirRefFor(v.dest.uri, v.dest.name) : undefined;
      if ((v.add === 'copy' || v.add === 'recipe') && !dest) { toast('Choose where the new pictures go.'); return; }
      const w: Watch = { id: `${Date.now().toString(36)}`, folder, action: v.add, dest: dest || undefined, recipe: v.recipe, known: [], created: Date.now() };
      await primeWatch(w); await rememberFolder(folder.uri); await rememberFolder(dest?.uri);
      watches.push(w); await saveWatches(watches); startWatching(app);
      toast(`Watching ${folder.name}: ${w.known.length} picture${w.known.length === 1 ? '' : 's'} there now; new ones will be ${v.add === 'catalog' ? 'added to the catalog' : v.add === 'open' ? 'shown' : v.add === 'copy' ? `copied to ${dest!.name}` : `run through "${v.recipe}" into ${dest!.name}`}.`, { ms: 4500 });
      return w;
    },
  },
]);
export { catItems };
