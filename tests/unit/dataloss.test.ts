/**
 * The safeguards against losing pictures or edits: names that never replace a file, unsaved-changes tracking that
 * survives a long undo history, Before / After as a view only, saving only what round-trips, and stores that do not
 * mistake "could not be read" for "empty".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listing = vi.hoisted(() => ({ next: null as null | { uri: string; name: string; entries: { uri: string; name: string; size: number; mtime: number }[] } }));
vi.mock('../../src/platform/native', async (orig) => ({ ...(await orig<typeof import('../../src/platform/native')>()), listFolderFiles: async () => { if (!listing.next) throw new Error('not reachable'); return listing.next; }, listSubfolders: async () => [] }));

import { freeNameWith } from '../../src/platform/native';
import { writesBackWhole } from '../../src/commands/file';
import { PictureTab } from '../../src/app';
import { watchTick, saveWatches, listWatches, type Watch } from '../../src/picture/watch';
import { scanFolder, type CatFolder } from '../../src/picture/catalog';
import { kvGet, kvSet } from '../../src/util/store';
import { savePrefs, loadStoredPlaces, defaultPrefs, prefsHooks } from '../../src/prefs';

describe('names that never replace a file', () => {
  it('finds the first free "name (n).ext"', async () => {
    const taken = new Set(['a.jpg', 'a (2).jpg', 'notes']);
    const has = async (n: string) => taken.has(n);
    expect(await freeNameWith('b.jpg', has)).toBe('b.jpg');
    expect(await freeNameWith('a.jpg', has)).toBe('a (3).jpg');
    expect(await freeNameWith('notes', has)).toBe('notes (2)');
  });
});

describe('plain Save writes back only what the encoder keeps', () => {
  const pic = (id: string, name: string, pages: number, frames: number, extra: Record<string, unknown> = {}) => ({ format: { id }, name, pages: Array.from({ length: pages }, () => ({ frames: new Array(frames).fill(0), bitDepth: 24, hasAlpha: false, ...extra })) });
  it('one page and one frame, and for Netpbm an 8-bit color PPM', () => {
    expect(writesBackWhole(pic('jpeg', 'a.jpg', 1, 1), 'jpeg')).toBe(true);
    expect(writesBackWhole(pic('webp', 'anim.webp', 1, 12), 'webp')).toBe(false); // an animation would become one frame
    expect(writesBackWhole(pic('png', 'pages.png', 3, 1), 'png')).toBe(false);
    expect(writesBackWhole(pic('pnm', 'a.ppm', 1, 1), 'ppm')).toBe(true);
    expect(writesBackWhole(pic('pnm', 'a.pam', 1, 1, { hasAlpha: true, bitDepth: 32 }), 'ppm')).toBe(false); // transparency would be flattened
    expect(writesBackWhole(pic('pnm', 'a.pgm', 1, 1, { bitDepth: 16 }), 'ppm')).toBe(false);
    expect(writesBackWhole(pic('pnm', 'deep.ppm', 1, 1, { bitDepth: 48 }), 'ppm')).toBe(false);
    expect(writesBackWhole(pic('pnm', 'a.pfm', 1, 1, { bitDepth: 96 }), 'ppm')).toBe(false);
  });
});

describe('unsaved changes and the undo history', () => {
  const makeTab = () => {
    const app = { ui: { tabsChanged() { /* */ } }, refresh() { /* */ } } as any;
    const tab = new PictureTab(app);
    tab.ui = { pictureChanged() { /* */ }, draw() { /* */ } } as any;
    const page = (tag: string) => [{ frames: [{ width: 2, height: 2, tag }] }] as any;
    tab.picture = { pages: page('opened'), page: 0, frame: 0, version: 0, width: 2, height: 2, name: 'a.png' } as any;
    const edit = (tag: string) => tab.edit(tag, (p) => { p.pages = page(tag); });
    const shown = () => (tab.picture!.pages[0].frames[0] as any).tag as string;
    return { tab, edit, shown };
  };
  it('is dirty exactly when the picture differs from the saved one, however far undo goes', () => {
    const { tab, edit, shown } = makeTab();
    edit('one'); edit('two'); edit('three');
    expect(tab.dirty).toBe(true);
    tab.undo(); tab.undo(); tab.undo();
    expect([tab.dirty, shown()]).toEqual([false, 'opened']); // back at the opened picture: nothing to save
    tab.redo();
    expect([tab.dirty, shown()]).toEqual([true, 'one']);
    tab.clearHistory(); // what Save does
    expect(tab.dirty).toBe(false);
    edit('more'); tab.undo();
    expect([tab.dirty, shown()]).toEqual([false, 'one']);
  });
  it('stays dirty when the history has dropped its oldest steps (the first edit can no longer be undone)', () => {
    const { tab, edit, shown } = makeTab();
    for (let i = 1; i <= 35; i++) edit(`e${i}`);
    let undone = 0; while (tab.undo()) undone++;
    expect(undone).toBe(30);
    expect(shown()).toBe('e5'); // five edits are still in the picture
    expect(tab.dirty).toBe(true);
  });
  it('Before / After is a view: undo, redo and the saved state work on the edited picture', () => {
    const { tab, edit, shown } = makeTab();
    edit('one'); edit('two'); edit('three');
    expect(tab.showOriginal(true)).toBe(true);
    expect([shown(), tab.showingOriginal, tab.dirty]).toEqual(['opened', true, true]);
    tab.undo(); // leaves the "before" view first, then undoes the last edit
    expect([shown(), tab.showingOriginal]).toEqual(['two', false]);
    tab.showOriginal(true); tab.redo();
    expect([shown(), tab.showingOriginal]).toEqual(['three', false]);
    tab.undo(); tab.undo(); tab.undo();
    expect([shown(), tab.dirty]).toEqual(['opened', false]);
  });
});

describe('a folder that cannot be listed is not an empty folder', () => {
  beforeEach(() => { localStorage.clear(); });
  const entry = (name: string, size: number) => ({ uri: `file:///d/${name}`, name, size, mtime: 1 });
  it('Watch Folder keeps what it knew while the folder is away, and only truly new pictures count afterwards', async () => {
    const w: Watch = { id: 'w1', folder: { name: 'd', uri: 'file:///d' }, action: 'catalog', known: ['a.jpg|10', 'b.jpg|20'], created: 1 };
    await saveWatches([w]);
    const handled: string[][] = [];
    const act = async (_w: Watch, fresh: { name: string }[]) => { handled.push(fresh.map((e) => e.name)); };
    listing.next = null; // the drive is away
    expect(await watchTick({} as any, act)).toBe(0);
    expect((await listWatches())[0].known).toEqual(['a.jpg|10', 'b.jpg|20']);
    listing.next = { uri: 'file:///d', name: 'd', entries: [entry('a.jpg', 10), entry('b.jpg', 20), entry('c.jpg', 30)] }; // back, with one new picture
    expect(await watchTick({} as any, act)).toBe(1);
    expect(handled).toEqual([['c.jpg']]);
    expect((await listWatches())[0].known).toEqual(['a.jpg|10', 'b.jpg|20', 'c.jpg|30']);
  });
  it('a second pass does not start while one is still running', async () => {
    await saveWatches([{ id: 'w1', folder: { name: 'd', uri: 'file:///d' }, action: 'recipe', known: [], created: 1 }]);
    listing.next = { uri: 'file:///d', name: 'd', entries: [entry('a.jpg', 10)] };
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let runs = 0;
    const slow = watchTick({} as any, async () => { runs++; await gate; });
    await new Promise((r) => setTimeout(r, 20));
    expect(await watchTick({} as any, async () => { runs++; })).toBe(0); // skipped: the first is still at work
    release(); expect(await slow).toBe(1);
    expect(runs).toBe(1);
  });
  it('a catalog rescan of an unreachable folder fails and leaves the catalog as it was', async () => {
    const f = { id: 'f1', name: 'Photos', uri: 'file:///photos', subfolders: true, added: 1 } as unknown as CatFolder;
    const items = [{ key: 'f1/a.jpg', folderId: 'f1', path: [], name: 'a.jpg', uri: 'file:///photos/a.jpg', size: 1, mtime: 1, info: {} }];
    await kvSet('catalog.v1.items.f1', items);
    const before = JSON.stringify(await kvGet('catalog.v1.items.f1'));
    listing.next = null;
    await expect(scanFolder({} as any, f)).rejects.toThrow(/could not be listed/);
    expect(JSON.stringify(await kvGet('catalog.v1.items.f1'))).toBe(before);
  });
});

describe('settings storage', () => {
  beforeEach(() => { localStorage.clear(); });
  it('imported places stay out of the settings record and come back from the database', async () => {
    const p = defaultPrefs();
    p.importedPlaces = Array.from({ length: 5000 }, (_, i) => ({ city: `City ${i}`, country: 'X', countryCode: 'XX', lat: i / 100, lon: -i / 100 }));
    savePrefs(p);
    const record = localStorage.getItem('quilllens.prefs.v1')!;
    expect(record.length).toBeLessThan(60000); expect(JSON.parse(record).importedPlaces).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    const again = defaultPrefs();
    await loadStoredPlaces(again);
    expect(again.importedPlaces.length).toBe(5000); expect(again.importedPlaces[4999].city).toBe('City 4999');
  });
  it('a save that fails is reported once, not swallowed', () => {
    const told: string[] = []; prefsHooks.saveFailed = (why) => told.push(why);
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) { if (k === 'quilllens.prefs.v1') throw new Error('QuotaExceededError'); return real.call(this, k, v); };
    try { const p = defaultPrefs(); savePrefs(p); savePrefs(p); } finally { Storage.prototype.setItem = real; prefsHooks.saveFailed = null; }
    expect(told).toEqual(['QuotaExceededError']);
  });
});
