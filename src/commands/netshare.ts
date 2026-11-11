/**
 * View ▸ Share View on the Network and Follow a Shared View; Browse ▸ Share Album and Open Shared Album.
 *
 * Sharing runs on the desktop app's local-network server (electron/netshare.cjs) behind a random token,
 * and, when a relay address is set (Options), through the suite's relay (scripts/relay.mjs) for guests
 * who cannot reach this computer; the web app shares through the relay alone. Guests can be a plain
 * browser (the server's own pages) or another Anne's Lens (these commands). Protocol: docs/NETSHARE.md.
 */
import { def } from './registry';
import type { App, PictureTab } from '../app';
import { openDialog, toast } from '../ui/dialog';
import { h } from '../ui/dom';
import { desktopBridge, writeClipboardText, pickFolder, nativeRequest, bufferFromB64, b64FromBuffer } from '../platform/native';
import { Folder, entryFromBytes, entryFromUri, isPictureName, type Entry } from '../picture/folder';
import { listAlbums, saveAlbums, entriesOf, addRefs, refOf, type Album } from '../picture/albums';
import { propsOf } from '../picture/metadata';
import { decodePicture } from '../codecs/registry';
import { encodeQr, qrSvg } from '../codecs/qr';

// Protocol helpers (pure; tested) ----------------------------------------------------------------------
export interface ShareAddress { base: string; kind: 's' | 'a'; token: string }
/** A shared view or album address as typed or scanned: the room's base URL with a trailing slash. */
export function parseShareAddress(text: string): ShareAddress | null {
  const m = String(text || '').trim().match(/^(https?:\/\/[^/\s]+(?:\/[^\s]*?)?\/(s|a)\/([0-9a-f]{16,64}))\/?(?:state|events|app\.js)?\/?$/i);
  return m ? { base: `${m[1]}/`, kind: m[2].toLowerCase() as 's' | 'a', token: m[3].toLowerCase() } : null;
}
export const randomToken = (bytes = 16): string => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
/** The relay base for a room: `<relay>/<kind>/<token>/`. */
export const relayRoom = (relay: string, kind: 's' | 'a', token: string): string => `${relay.replace(/\/+$/, '')}/${kind}/${token}/`;
export interface ViewState { kind: 'view'; name: string; index: number; total: number; caption: string; rel: number; nx: number; ny: number; key: string; picture: string; sig: string; size?: number }
export const viewSignature = (s: { key: string; rel: number; nx: number; ny: number }): string => `${s.key}|${s.rel.toFixed(4)}|${s.nx.toFixed(4)}|${s.ny.toFixed(4)}`;
/**
 * Runs `apply` on the states handed to it one at a time; a state that arrives while one is being applied waits, and
 * only the newest of those waiting is applied. Nothing is dropped for good: the last state handed in is always applied
 * (a follower that skipped it would stay on the picture before it, since the host does not send it again).
 */
export function latestOnly<T>(apply: (s: T) => Promise<void>, alive: () => boolean = () => true): (s: T) => void {
  let next: { s: T } | null = null, busy = false;
  return (s) => {
    next = { s }; if (busy) return; busy = true;
    void (async () => { try { while (next && alive()) { const n = next; next = null; try { await apply(n.s); } catch { /* the next state may work */ } } } finally { busy = false; next = null; } })();
  };
}
/** How long to wait before asking the host again after `failures` requests in a row failed: 0.4 s, then doubling to 5 s. */
export const retryDelay = (failures: number): number => Math.min(5000, 400 * 2 ** Math.max(0, Math.min(failures, 5)));

/** The bytes of a data URL. */
export function dataUrlBytes(url: string): ArrayBuffer | null { const i = url.indexOf(','); return url.startsWith('data:') && i > 0 ? bufferFromB64(url.slice(i + 1)) : null; }

// HTTP through the native layer where there is one (no mixed-content or cross-origin limits there), else fetch.
async function request(url: string, method: 'GET' | 'POST', headers: Record<string, string> = {}, body?: string | Uint8Array): Promise<{ status: number; bytes: Uint8Array }> {
  const n = await nativeRequest({ url, method, headers, body, timeoutMs: 20000 });
  if (n) return { status: n.status, bytes: n.bytes };
  const res = await fetch(url, { method, headers, body: body as BodyInit | undefined, mode: 'cors' });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}
const hasNative = () => !!desktopBridge() || !!(window as any).Capacitor?.isNativePlatform?.();
const relayOf = (app: App): string => String(app.prefs.netRelay || '').trim().replace(/\/+$/, '');
const relayPut = (room: string, key: string, state: unknown) => request(`${room}state`, 'POST', { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, JSON.stringify(state)).catch(() => ({ status: 0, bytes: new Uint8Array() }));

// Shared view: host -------------------------------------------------------------------------------------
const host = { on: false, token: '', key: '', urls: [] as string[], relay: '', timer: 0 as any, sig: '', picKey: '', picture: '', picSize: 0, relayAt: 0, relayPending: null as null | ReturnType<typeof setTimeout> };
/** A JPEG of the current frame (long side ≤ 1600 px), cached by picture and version. */
function rendition(app: App): { key: string; picture: string; size: number } {
  const p = app.picture; if (!p) return { key: '', picture: '', size: 0 };
  const key = `${p.name}|${p.version}|${app.folder.index}`; if (key === host.picKey) return { key, picture: host.picture, size: host.picSize };
  const src = p.frameCanvas(), k = Math.min(1, 1600 / Math.max(src.width, src.height)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k)); c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  host.picKey = key; host.picture = c.toDataURL('image/jpeg', 0.85); host.picSize = p.entry.size || 0;
  return { key, picture: host.picture, size: host.picSize };
}
export function viewState(app: App): ViewState {
  const p = app.picture, v = app.viewer.viewRel() || { rel: 1, nx: 0.5, ny: 0.5 }, r = rendition(app), x = p ? propsOf(p.entry) : undefined;
  const s: ViewState = { kind: 'view', name: p?.name || '', index: app.folder.index + 1, total: app.folder.length, caption: x?.description || x?.title || '', rel: v.rel, nx: v.nx, ny: v.ny, key: r.key, picture: r.picture, size: r.size, sig: '' };
  s.sig = viewSignature(s); return s;
}
function pushView(app: App): void {
  if (!host.on) return;
  const s = viewState(app); if (s.sig === host.sig) return; host.sig = s.sig;
  const d = desktopBridge(); if (d && host.urls.length) void d.shareState({ token: host.token, state: s as unknown as Record<string, unknown> }).catch(() => undefined);
  if (host.relay) { // at most four relay updates a second; the last one always goes out
    const send = () => { host.relayAt = Date.now(); host.relayPending = null; void relayPut(relayRoom(host.relay, 's', host.token), host.key, viewState(app)); };
    const wait = 250 - (Date.now() - host.relayAt);
    if (wait <= 0) send(); else if (!host.relayPending) host.relayPending = setTimeout(send, wait);
  }
}
async function stopHost(app: App): Promise<void> {
  host.on = false; clearInterval(host.timer); if (host.relayPending) { clearTimeout(host.relayPending); host.relayPending = null; }
  const d = desktopBridge(); if (d && host.urls.length) await d.shareStop({ token: host.token }).catch(() => undefined);
  if (host.relay) await relayPut(relayRoom(host.relay, 's', host.token), host.key, { kind: 'view', ended: true, sig: 'ended' });
  host.urls = []; host.relay = ''; host.sig = ''; host.picKey = ''; app.refresh();
}

// Shared view: guest -------------------------------------------------------------------------------------
const follow = { on: false, base: '', tab: null as PictureTab | null, folder: null as Folder | null, es: null as EventSource | null, timer: 0 as any, sig: '', key: '', session: 0, failures: 0, keys: new Map<string, Entry>() };
/** The same picture in another open window (full quality), by name and size. */
function localTwin(app: App, name: string, size?: number): Entry | null {
  for (const t of app.tabs) { if (t === follow.tab) continue; for (const e of t.folder.entries) if (e.name === name && (!size || !e.size || e.size === size)) return e; }
  return null;
}
async function applyShared(app: App, s: Partial<ViewState> & { ended?: boolean }): Promise<void> {
  if (!follow.on || !follow.tab || !follow.folder) return;
  if (!app.tabs.includes(follow.tab)) { await stopFollow(app); return; }
  if (s.ended) { toast('The host stopped sharing.'); await stopFollow(app); return; }
  if (!s.key) return;
  if (s.key !== follow.key) {
    let e = follow.keys.get(s.key) || null;
    if (!e) {
      e = localTwin(app, s.name || '', s.size);
      if (!e) { const bytes = s.picture ? dataUrlBytes(s.picture) : null; if (!bytes) return; e = entryFromBytes(s.name || 'shared picture.jpg', bytes); }
      follow.keys.set(s.key, e); if (follow.keys.size > 60) follow.keys.delete(follow.keys.keys().next().value!);
    }
    follow.key = s.key;
    const f = follow.folder; if (!f.entries.includes(e)) { f.entries.push(e); f.entries = f.entries.slice(-60); }
    f.select(f.entries.indexOf(e)); await follow.tab.show();
  }
  if (typeof s.rel === 'number' && typeof s.nx === 'number' && typeof s.ny === 'number') follow.tab.ui.applyRel({ rel: s.rel, nx: s.nx, ny: s.ny });
}
async function startFollow(app: App, base: string): Promise<void> {
  const id = ++follow.session;
  follow.on = true; follow.base = base; follow.sig = ''; follow.key = ''; follow.failures = 0; follow.keys.clear();
  follow.folder = new Folder([], 'Shared view'); const tab = follow.tab = await app.openFolder(follow.folder, 0, { newWindow: true });
  const mine = () => follow.on && follow.session === id;
  const onState = latestOnly<any>((s) => applyShared(app, s || {}), mine);
  // The window being closed ends the following, whether or not the host sends anything.
  const closed = () => { if (mine() && !app.tabs.includes(tab)) { void stopFollow(app); return true; } return false; };
  if (hasNative()) {
    // One request at a time, the next one after this one has answered; slower while the host cannot be reached.
    const poll = async (): Promise<void> => {
      if (!mine() || closed()) return;
      try {
        const r = await request(`${base}state${follow.sig ? `?since=${encodeURIComponent(follow.sig)}` : ''}`, 'GET');
        if (!mine()) return;
        if (r.status === 200) { const s = JSON.parse(new TextDecoder().decode(r.bytes)); follow.sig = s.sig || ''; follow.failures = 0; onState(s); }
        else if (r.status === 304) follow.failures = 0;
        else if (r.status === 404) { toast('The shared view is gone.'); await stopFollow(app); return; }
        else throw new Error(`status ${r.status}`);
      } catch { if (!mine()) return; if (++follow.failures === 5) toast('The shared view cannot be reached; still trying.'); }
      follow.timer = setTimeout(() => void poll(), retryDelay(follow.failures));
    };
    void poll();
  } else {
    const es = new EventSource(`${base}events`); follow.es = es;
    es.onmessage = (ev) => { try { onState(JSON.parse(ev.data)); } catch { /* ignore */ } };
    es.onerror = () => { /* EventSource reconnects on its own */ };
    follow.timer = setInterval(closed, 1000);
  }
  app.refresh();
}
async function stopFollow(app: App): Promise<void> {
  follow.on = false; follow.session++; clearInterval(follow.timer); clearTimeout(follow.timer); follow.es?.close(); follow.es = null; follow.tab = null; follow.folder = null; app.refresh();
}

// Shared album: host -------------------------------------------------------------------------------------
interface AlbumItem { id: string; name: string; size?: number; mtime?: number; uri: string | null; thumb: string | null; entry: Entry }
const albumHost = { on: false, token: '', key: '', urls: [] as string[], relay: '', album: null as Album | null, items: [] as AlbumItem[], contribute: false, contribDir: '', listening: false, servable: 0 };
/** A small JPEG of an entry (long side `size` px), or null when it cannot be decoded. */
export async function thumbOf(e: Entry, size = 160): Promise<string | null> {
  try {
    if (!isPictureName(e.name)) return null;
    const pic = await decodePicture(new Uint8Array(await e.read()), e);
    const src = pic.frameCanvas(), k = Math.min(1, size / Math.max(src.width, src.height)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k)); c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
    pic.release(); return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}
const albumState = (withThumbs: boolean) => ({ kind: 'album', name: albumHost.album?.name || '', contribute: albumHost.contribute, files: false, items: albumHost.items.map((it) => ({ id: it.id, name: it.name, size: it.size, mtime: it.mtime, ...(withThumbs ? { thumb: it.thumb } : {}) })), sig: `${albumHost.items.length}|${albumHost.items.filter((i) => i.thumb).length}` });
async function publishAlbum(): Promise<void> {
  if (!albumHost.on) return;
  const d = desktopBridge();
  if (d && albumHost.urls.length) { const r = await d.shareAlbum({ token: albumHost.token, name: albumHost.album?.name || '', items: albumHost.items.map((it) => ({ id: it.id, name: it.name, size: it.size, mtime: it.mtime, uri: it.uri, thumb: it.thumb })), contribute: albumHost.contribute, contribDir: albumHost.contribDir }).catch(() => null); if (r) { albumHost.servable = r.servable; if (albumHost.contribute && !r.contribute) albumHost.contribute = false; } } // the desktop refuses a folder it may not write to
  if (albumHost.relay) await relayPut(relayRoom(albumHost.relay, 'a', albumHost.token), albumHost.key, albumState(true));
}
async function addContribution(app: App, f: { uri: string; name: string; size: number }): Promise<void> {
  const a = albumHost.album; if (!a) return;
  const e = entryFromUri({ uri: f.uri, name: f.name, size: f.size, mtime: Date.now() }), ref = refOf(e); if (!ref) return;
  const albums = await listAlbums(), stored = albums.find((x) => x.id === a.id); if (stored && (await addRefs(stored, [ref]))) { await saveAlbums(albums); albumHost.album = stored; }
  const item: AlbumItem = { id: randomToken(6), name: f.name, size: f.size, mtime: Date.now(), uri: f.uri, thumb: null, entry: e };
  albumHost.items.push(item); await publishAlbum(); toast(`${f.name} was added to "${a.name}".`); app.refresh();
  item.thumb = await thumbOf(e); await publishAlbum();
}
async function stopAlbumHost(app: App): Promise<void> {
  albumHost.on = false;
  const d = desktopBridge(); if (d && albumHost.urls.length) await d.shareStop({ token: albumHost.token }).catch(() => undefined);
  if (albumHost.relay) await relayPut(relayRoom(albumHost.relay, 'a', albumHost.token), albumHost.key, { kind: 'album', ended: true, sig: 'ended' });
  albumHost.urls = []; albumHost.relay = ''; albumHost.items = []; albumHost.album = null; app.refresh();
}

// Dialog pieces ------------------------------------------------------------------------------------------
function addressBox(urls: string[], relayUrl: string): HTMLElement {
  const main = urls[0] || relayUrl, qr = main ? qrSvg(encodeQr(main, 'M')) : '';
  return h('div', { class: 'qn-remote-box' }, ...(qr ? [h('div', { class: 'qn-remote-qr', html: qr } as any)] : []), h('p', null, urls.length ? 'On this network, open:' : 'Open:'), ...urls.map((u) => h('code', null, u)), ...(relayUrl ? [h('p', null, 'From elsewhere, through the relay:'), h('code', null, relayUrl)] : []));
}
const copyButton = (text: string) => ({ label: 'Copy Address', onClick: () => void writeClipboardText(text).then(() => toast('Copied.')) });

def([
  {
    id: 'view.shareView', icon: 'cast', kind: 'toggle', noRecord: true, isActive: () => host.on, isEnabled: (app) => host.on || !!app.picture,
    tip: 'Shares what this window shows with other devices: they follow the picture, zoom and pan live, in a browser or in Anne\'s Lens (Follow a Shared View). On this network from the desktop app; from anywhere through a relay (Options ▸ Relay)',
    run: async (app, arg?: { quiet?: boolean; relay?: string }) => {
      if (host.on && !arg) { await stopHost(app); toast('View sharing off.'); return; }
      if (host.on) await stopHost(app);
      const d = desktopBridge(), relay = arg?.relay !== undefined ? String(arg.relay).replace(/\/+$/, '') : relayOf(app);
      if (!d && !relay) { toast('Sharing a view needs the desktop app (its network server) or a relay address: Options ▸ Network Relay.', { ms: 6000 }); return; }
      host.token = randomToken(); host.key = randomToken(); host.urls = []; host.relay = relay; host.sig = ''; host.picKey = '';
      if (d) { const r = await d.shareStart({ kind: 'view' }); host.token = r.token; host.urls = r.urls; }
      host.on = true;
      clearInterval(host.timer); host.timer = setInterval(() => pushView(app), 250); pushView(app);
      app.refresh();
      const relayUrl = relay ? relayRoom(relay, 's', host.token) : '';
      const out = { token: host.token, urls: host.urls, relayUrl };
      if (arg?.quiet) return out;
      await openDialog({ title: 'Share View on the Network', ok: 'Close', cancel: false, help: 'Anyone with the address sees the picture you show, at your zoom and pan, until you turn sharing off (this command again). Pictures travel as JPEG renditions of what is on screen (long side 1600 px). In Anne\'s Lens, View ▸ Follow a Shared View takes the address; a plain browser shows a page.',
        content: addressBox(host.urls, relayUrl), buttons: [copyButton(host.urls[0] || relayUrl)] });
      return out;
    },
  },
  {
    id: 'view.followView', icon: 'connected_tv', kind: 'toggle', noRecord: true, isActive: () => follow.on,
    tip: 'Follows a view shared from another Anne\'s Lens: its picture, zoom and pan in a window here (the same file in another open window is shown in full quality instead of the rendition)',
    run: async (app, arg?: string | { url?: string; quiet?: boolean }) => {
      if (follow.on && !arg) { await stopFollow(app); toast('No longer following.'); return; }
      if (follow.on) await stopFollow(app);
      let url = typeof arg === 'string' ? arg : arg?.url || '';
      if (!url) {
        const r = await openDialog({ title: 'Follow a Shared View', ok: 'Follow', help: 'Paste the address from the host\'s Share View dialog (or scan its QR code with a phone and open the link in Anne\'s Lens).', fields: [{ key: 'url', label: 'Address', type: 'text', placeholder: 'http://192.168.1.20:5123/s/…/', autofocus: true }] });
        if (!r) return; url = String(r.url || '');
      }
      const a = parseShareAddress(url);
      if (!a || a.kind !== 's') { toast('That is not a shared-view address (it ends in /s/<token>/).'); return; }
      try { const r = await request(`${a.base}state`, 'GET'); if (r.status === 404) { toast('No shared view at that address (sharing may have stopped).'); return; } if (r.status !== 200 && r.status !== 304) { toast(`The host answered ${r.status}.`); return; } } catch (e: any) { toast(`Could not reach the host: ${e?.message || e}`); return; }
      await startFollow(app, a.base);
      if (!(typeof arg === 'object' && arg?.quiet)) toast('Following the shared view; run the command again to stop.');
      return { base: a.base };
    },
  },
  {
    id: 'browse.shareAlbum', icon: 'share', kind: 'toggle', noRecord: true, isActive: () => albumHost.on,
    tip: 'Shares an album with other devices: a page with its pictures to look at and download, and a box to add pictures when you allow it. On this network from the desktop app; through a relay from anywhere (thumbnails only there)',
    run: async (app, arg?: { album?: string; contribute?: boolean; contribDir?: string; quiet?: boolean; relay?: string }) => {
      if (albumHost.on && !arg) { await stopAlbumHost(app); toast('Album sharing off.'); return; }
      if (albumHost.on) await stopAlbumHost(app);
      const d = desktopBridge(), relay = arg?.relay !== undefined ? String(arg.relay).replace(/\/+$/, '') : relayOf(app);
      if (!d && !relay) { toast('Sharing an album needs the desktop app (its network server) or a relay address: Options ▸ Network Relay.', { ms: 6000 }); return; }
      const albums = await listAlbums(); if (!albums.length) { toast('No albums yet: Browse ▸ Add to Album first.'); return; }
      let album: Album | undefined, contribute = false, contribDir = '';
      if (arg) { album = albums.find((x) => x.id === arg.album || x.name === arg.album) || albums[0]; contribute = !!arg.contribute; contribDir = arg.contribDir || ''; }
      else {
        const r = await openDialog({ title: 'Share Album', ok: 'Share', help: d ? 'Guests on this network see the album\'s pictures and can download them. When you allow additions, pictures they send are saved into the folder you choose and added to the album.' : 'Through the relay, guests see the album\'s thumbnails; downloads and additions need the desktop app on this network.',
          fields: [{ key: 'album', label: 'Album', type: 'select', options: albums.map((a) => ({ value: a.id, label: `${a.name} (${a.items.length})` })), value: albums[albums.length - 1].id }, ...(d ? [{ key: 'contribute', label: 'Let guests add pictures (into a folder you choose next)', type: 'checkbox' as const, value: false }] : [])] });
        if (!r) return; album = albums.find((x) => x.id === r.album); contribute = !!r.contribute;
        if (contribute) { const dir = await pickFolder('Folder for pictures guests add'); if (!dir) { contribute = false; } else contribDir = dir.uri; }
      }
      if (!album) return;
      const { entries, unavailable } = await entriesOf(album);
      albumHost.album = album; albumHost.contribute = contribute && !!contribDir; albumHost.contribDir = contribDir; albumHost.relay = relay; albumHost.key = randomToken(); albumHost.token = randomToken(); albumHost.urls = []; albumHost.servable = 0;
      albumHost.items = entries.map((e) => ({ id: randomToken(6), name: e.name, size: e.size, mtime: e.mtime, uri: e.uri && e.uri.startsWith('file:') ? e.uri : null, thumb: null, entry: e }));
      if (d) {
        const r = await d.shareStart({ kind: 'album' }); albumHost.token = r.token; albumHost.urls = r.urls;
        if (!albumHost.listening) { albumHost.listening = true; await (d as unknown as { addListener: (e: string, cb: (x: { token: string; uri: string; name: string; size: number }) => void) => Promise<unknown> }).addListener('shareAdded', (x) => { if (albumHost.on && x.token === albumHost.token) void addContribution(app, x); }); }
      }
      albumHost.on = true; app.refresh();
      await publishAlbum();
      // Thumbnails arrive as they are made (a few at a time), the listing first.
      void (async () => { let n = 0; for (const it of albumHost.items) { if (!albumHost.on) return; it.thumb = await thumbOf(it.entry); if (++n % 4 === 0) await publishAlbum(); } await publishAlbum(); })();
      const relayUrl = relay ? relayRoom(relay, 'a', albumHost.token) : '';
      const out = { token: albumHost.token, urls: albumHost.urls, relayUrl, pictures: albumHost.items.length, unavailable, contribute: albumHost.contribute };
      if (arg?.quiet) return out;
      await openDialog({ title: `Share Album: ${album.name}`, ok: 'Close', cancel: false, help: `${albumHost.items.length} picture${albumHost.items.length === 1 ? '' : 's'}${unavailable ? ` (${unavailable} unavailable)` : ''}${albumHost.contribute ? '; guests may add pictures' : ''}. Sharing stays on until you run this command again. In Anne's Lens, Browse ▸ Open Shared Album takes the address.`,
        content: addressBox(albumHost.urls, relayUrl), buttons: [copyButton(albumHost.urls[0] || relayUrl)] });
      return out;
    },
  },
  {
    id: 'browse.openSharedAlbum', icon: 'cloud_download', noRecord: true,
    tip: 'Opens an album another Anne\'s Lens shares, as a folder here: its pictures download from the host as you look at them (thumbnails only through a relay)',
    run: async (app, arg?: string | { url?: string; quiet?: boolean }) => {
      let url = typeof arg === 'string' ? arg : arg?.url || '';
      if (!url) { const r = await openDialog({ title: 'Open Shared Album', ok: 'Open', fields: [{ key: 'url', label: 'Address', type: 'text', placeholder: 'http://192.168.1.20:5123/a/…/', autofocus: true }] }); if (!r) return; url = String(r.url || ''); }
      const a = parseShareAddress(url);
      if (!a || a.kind !== 'a') { toast('That is not a shared-album address (it ends in /a/<token>/).'); return; }
      let s: any;
      try { const r = await request(`${a.base}state`, 'GET'); if (r.status !== 200) { toast(r.status === 404 ? 'No shared album at that address (sharing may have stopped).' : `The host answered ${r.status}.`); return; } s = JSON.parse(new TextDecoder().decode(r.bytes)); } catch (e: any) { toast(`Could not reach the host: ${e?.message || e}`); return; }
      if (s.ended) { toast('The host stopped sharing this album.'); return; }
      const items: { id: string; name: string; size?: number; mtime?: number; thumb?: string }[] = Array.isArray(s.items) ? s.items : [];
      if (!items.length) { toast(`"${s.name || 'The album'}" has no pictures yet.`); return; }
      const entries: Entry[] = items.map((it) => {
        let cached: ArrayBuffer | null = null;
        return { name: String(it.name || 'picture'), uri: null, size: it.size, mtime: it.mtime, read: async () => {
          if (cached) return cached;
          const r = await request(`${a.base}file/${encodeURIComponent(it.id)}`, 'GET').catch(() => ({ status: 0, bytes: new Uint8Array() }));
          if (r.status === 200) { cached = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) as ArrayBuffer; return cached; }
          const t = it.thumb ? dataUrlBytes(it.thumb) : null; if (t) { cached = t; return t; }
          throw new Error(r.status === 404 ? 'This picture is not downloadable from here (thumbnails only through a relay).' : `The host answered ${r.status}.`);
        } } as Entry;
      });
      await app.openFolder(new Folder(entries, `Shared album: ${s.name || 'album'}`), 0, { newWindow: true });
      if (!(typeof arg === 'object' && arg?.quiet)) toast(`${items.length} picture${items.length === 1 ? '' : 's'} from "${s.name || 'the shared album'}"${s.contribute ? '; the host accepts additions through the browser page' : ''}.`);
      return { name: s.name, pictures: items.length, contribute: !!s.contribute };
    },
  },
  {
    id: 'view.netRelay', icon: 'hub', noRecord: true,
    tip: 'The relay address for sharing beyond this network (a self-hosted scripts/relay.mjs); empty means local network only',
    run: async (app, arg?: string) => {
      if (arg !== undefined) { app.prefs.netRelay = String(arg || '').trim(); app.savePrefs(); return app.prefs.netRelay; }
      const r = await openDialog({ title: 'Network Relay', ok: 'Save', help: 'Shared views and albums go through this server for guests who cannot reach this computer directly. Run your own with `node scripts/relay.mjs` (docs/NETSHARE.md); leave it empty to share on the local network only (desktop app).', fields: [{ key: 'url', label: 'Relay address', type: 'text', value: app.prefs.netRelay || '', placeholder: 'https://relay.example.org' }] });
      if (!r) return;
      const url = String(r.url || '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\//i.test(url)) { toast('Enter an http(s) address.'); return; }
      app.prefs.netRelay = url; app.savePrefs(); toast(url ? `Relay: ${url}` : 'No relay: local network only.');
      return url;
    },
  },
]);
void b64FromBuffer;
