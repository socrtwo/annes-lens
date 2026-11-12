// Network sharing for the desktop app: one small HTTP server on the local network that serves
//   /s/<token>/   a shared view: the host's current picture, zoom and pan, as a page guests follow
//                 (any browser) or as a state stream another Anne's Lens follows (Follow a Shared View),
//   /a/<token>/   a shared album: its pictures listed with thumbnails, each downloadable, with an
//                 upload box when the host allows contributions.
// Only requests carrying the random token are answered; the token changes every time sharing starts;
// the server stops when sharing is turned off or the app quits. The same protocol is spoken by the
// self-hostable relay (scripts/relay.mjs) for guests outside the local network; see docs/NETSHARE.md.
'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_UPLOAD = 64 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 3;   // per room, at once (each streams to disk)
const MAX_ROOM_UPLOADS = 500;   // per room, for as long as it is shared
const MAX_GUESTS = 64;          // event streams per room
/** What a guest may add to an album: pictures by name (the page offers image/* only). Programs, scripts, SVG and HTML are refused. */
const UPLOAD_NAME = /\.(jpe?g|jpe|png|gif|webp|avif|heic|heif|tiff?|bmp|jxl|dng|cr2|cr3|nef|arw|orf|rw2|raf|pef|srw)$/i;
/** The request's address, or null when it does not parse (`GET //` and the like): answered 400, never an exception in the server. */
const urlOf = (req) => { try { return new URL(req.url, 'http://x'); } catch { return null; } };
/** decodeURIComponent that returns null for a malformed escape. */
const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
/**
 * Writes an event to a guest's stream. A guest that is not reading (a stalled phone, a suspended tab) gets the latest
 * state when it catches up; states are not queued for it without limit.
 */
function pushEvent(c, line) {
  if (c._qnBlocked) { c._qnNext = line; return; }
  if (!c.write(line)) { c._qnBlocked = true; c.once('drain', () => { c._qnBlocked = false; const n = c._qnNext; c._qnNext = null; if (n) pushEvent(c, n); }); }
}
/** A request handler that answers 400 when the handler throws, so that no request can end the process. */
const guarded = (fn) => (req, res) => { try { fn(req, res); } catch { try { if (!res.headersSent) res.writeHead(400); res.end(); } catch { /* the socket is gone */ } } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The guest page of a shared view: the picture fills the window at the host's relative zoom and center. */
const VIEW_PAGE = (base) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anne's Lens shared view</title><style>
html,body{margin:0;height:100%;background:#111;color:#eee;font:14px/1.4 system-ui,sans-serif;overflow:hidden}
#stage{position:absolute;inset:0 0 2.2em 0;overflow:hidden}#pic{position:absolute;left:0;top:0;transform-origin:0 0;image-rendering:auto;user-select:none}
footer{position:absolute;left:0;right:0;bottom:0;height:2.2em;display:flex;align-items:center;gap:1em;padding:0 .8em;background:#000a;color:#bbb;white-space:nowrap;overflow:hidden}
#st{margin-left:auto;color:#888}</style></head><body><div id="stage"><img id="pic" alt=""></div>
<footer><span id="name"></span><span id="idx"></span><span id="cap"></span><span id="st">connecting…</span></footer>
<script src="${base}app.js"></script></body></html>`;
const VIEW_SCRIPT = (base) => `'use strict';
const $ = (id) => document.getElementById(id); let state = null, natural = [0, 0];
function place() {
  const img = $('pic'), s = state; if (!s || !natural[0]) return;
  const vw = innerWidth, vh = innerHeight - $('pic').parentElement.getBoundingClientRect().top - 2.2 * 14;
  const fit = Math.min(vw / natural[0], vh / natural[1]), z = fit * (s.rel || 1);
  const cx = (s.nx == null ? 0.5 : s.nx) * natural[0], cy = (s.ny == null ? 0.5 : s.ny) * natural[1];
  img.style.transform = 'translate(' + (vw / 2 - cx * z) + 'px,' + (vh / 2 - cy * z) + 'px) scale(' + z + ')';
}
function show(s) {
  if (s.ended) { $('st').textContent = 'The host stopped sharing.'; es.close(); return; }
  state = s; const img = $('pic');
  if (s.picture && img.dataset.key !== s.key) { img.dataset.key = s.key; img.onload = () => { natural = [img.naturalWidth, img.naturalHeight]; place(); }; img.src = s.picture; }
  $('name').textContent = s.name || ''; $('idx').textContent = s.total ? s.index + ' / ' + s.total : ''; $('cap').textContent = s.caption || '';
  $('st').textContent = s.name ? Math.round((s.rel || 1) * 100) + '% of fit' : 'waiting for the host…'; place();
}
addEventListener('resize', place);
const es = new EventSource('${base}events'); es.onmessage = (e) => show(JSON.parse(e.data)); es.onerror = () => { $('st').textContent = 'reconnecting…'; };`;

/** The guest page of a shared album: thumbnails, downloads, and an upload box when contributions are allowed. */
const ALBUM_PAGE = (base) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anne's Lens shared album</title><style>
body{margin:0;font:15px/1.4 system-ui,sans-serif;background:#141414;color:#eee}header{padding:12px 16px;display:flex;gap:1em;align-items:baseline;flex-wrap:wrap}
h1{font-size:20px;margin:0}#count{color:#999}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;padding:0 16px 16px}
figure{margin:0;background:#222;border-radius:8px;overflow:hidden}figure img{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#333}
figcaption{padding:6px 8px;font-size:13px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}figcaption a{color:#9cf;text-decoration:none}
#up{padding:0 16px 16px}#up input{display:none}#up label{display:inline-block;padding:10px 16px;background:#2b5ea7;border-radius:10px;cursor:pointer}#msg{margin-left:1em;color:#aaa}
#st{margin-left:auto;color:#777;font-size:13px}</style></head><body>
<header><h1 id="title">Shared album</h1><span id="count"></span><span id="st">connecting…</span></header>
<div id="up" hidden><label>Add pictures… <input id="file" type="file" accept="image/*" multiple></label><span id="msg"></span></div><main id="grid"></main>
<script src="${base}app.js"></script></body></html>`;
const ALBUM_SCRIPT = (base) => `'use strict';
const $ = (id) => document.getElementById(id);
function show(s) {
  $('title').textContent = s.name || 'Shared album'; $('count').textContent = s.items ? s.items.length + ' picture' + (s.items.length === 1 ? '' : 's') : '';
  // Through a relay (files: false) the state carries the thumbnails; downloads and additions need the host's own address.
  const relayed = s.files === false;
  if (s.ended) es.close();
  $('st').textContent = s.ended ? 'The host stopped sharing this album.' : s.name ? (relayed ? 'thumbnails only through the relay' : '') : 'waiting for the host…'; $('up').hidden = !s.contribute || relayed;
  const grid = $('grid'); grid.replaceChildren();
  for (const it of s.items || []) {
    const f = document.createElement('figure'), img = document.createElement('img'), c = document.createElement('figcaption'), a = document.createElement('a');
    img.alt = it.name; img.loading = 'lazy';
    if (relayed) { if (typeof it.thumb === 'string' && it.thumb.indexOf('data:image/') === 0) img.src = it.thumb; c.textContent = it.name; }
    else {
      img.src = '${base}thumb/' + encodeURIComponent(it.id);
      a.href = '${base}file/' + encodeURIComponent(it.id); a.download = it.name; a.textContent = it.name; a.title = it.name + (it.size ? ' · ' + (it.size / 1048576).toFixed(1) + ' MB' : '');
      c.append(a);
    }
    f.append(img, c); grid.append(f);
  }
}
$('file').onchange = async () => {
  const files = [...$('file').files]; let n = 0;
  for (const f of files) {
    $('msg').textContent = 'Sending ' + f.name + '…';
    const r = await fetch('${base}add?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f }).catch(() => ({ status: 0 }));
    if (r.status === 200) n++; else { $('msg').textContent = 'Could not add ' + f.name + ' (' + r.status + ').'; return; }
  }
  $('msg').textContent = n ? n + ' added.' : ''; $('file').value = '';
};
const es = new EventSource('${base}events'); es.onmessage = (e) => show(JSON.parse(e.data)); es.onerror = () => { $('st').textContent = 'reconnecting…'; };`;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out.length ? out : ['127.0.0.1'];
}

/**
 * Starts the sharing server. Returns { port, urls(kind, token), view(), album(opts), stop() }.
 * view(): { token, urls, setState(s), stop() } — s is what the host publishes (name, index, total, caption, rel, nx, ny, key, picture as a data URL).
 * album({ name, items: [{ id, name, size, mtime, path, thumb }], contribute, contribDir, onAdded(file) }): { token, urls, update(opts), stop() }.
 */
function startShare(port = 0) {
  const rooms = new Map(); // token → { kind, state, clients, ...album fields }
  const server = http.createServer(guarded((req, res) => {
    const u = urlOf(req);
    if (!u) { res.writeHead(400); res.end(); return; }
    const m = u.pathname.match(/^\/(s|a)\/([0-9a-f]{32})\/(.*)$/);
    const room = m && rooms.get(m[2]);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (!room || room.kind !== m[1]) { res.writeHead(404, headers); res.end(); return; }
    const base = `/${m[1]}/${m[2]}/`, rest = m[3];
    const json = (code, body) => { res.writeHead(code, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && rest === '') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'` });
      res.end(room.kind === 's' ? VIEW_PAGE(base) : ALBUM_PAGE(base)); return;
    }
    if (req.method === 'GET' && rest === 'app.js') { res.writeHead(200, { ...headers, 'content-type': 'text/javascript' }); res.end(room.kind === 's' ? VIEW_SCRIPT(base) : ALBUM_SCRIPT(base)); return; }
    if (req.method === 'GET' && rest === 'state') { const since = u.searchParams.get('since'); if (since && room.state.sig && since === room.state.sig) { res.writeHead(304, headers); res.end(); return; } return json(200, room.state); }
    if (req.method === 'GET' && rest === 'events') {
      if (room.clients.size >= MAX_GUESTS) { res.writeHead(503, headers); res.end(); return; }
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      pushEvent(res, `data: ${JSON.stringify(room.state)}\n\n`); room.clients.add(res); req.on('close', () => room.clients.delete(res)); return;
    }
    if (room.kind === 'a') {
      const item = (id) => (room.items || []).find((it) => it.id === id);
      let mm = rest.match(/^thumb\/(.+)$/);
      if (req.method === 'GET' && mm) { const it = item(decode(mm[1])); if (!it || !it.thumb) { res.writeHead(404, headers); res.end(); return; } const b = Buffer.from(it.thumb.replace(/^data:[^,]*,/, ''), 'base64'); res.writeHead(200, { ...headers, 'content-type': 'image/jpeg', 'content-length': b.length }); res.end(b); return; }
      mm = rest.match(/^file\/(.+)$/);
      if (req.method === 'GET' && mm) {
        const it = item(decode(mm[1])); if (!it || !it.path) { res.writeHead(404, headers); res.end(); return; }
        let st; try { st = fs.statSync(it.path); } catch { res.writeHead(404, headers); res.end(); return; }
        res.writeHead(200, { ...headers, 'content-type': it.mime || 'application/octet-stream', 'content-length': st.size, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(it.name)}` });
        fs.createReadStream(it.path).on('error', () => res.destroy()).pipe(res); return;
      }
      if (req.method === 'POST' && rest === 'add') {
        if (!room.contribute || !room.contribDir) { res.writeHead(403, headers); res.end(); return; }
        const name = path.basename(String(u.searchParams.get('name') || 'picture')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || 'picture';
        // Pictures only, a few at a time, and no more than the room's allowance.
        if (!UPLOAD_NAME.test(name)) { res.writeHead(415, headers); res.end(); return; }
        if (room.uploads.size >= MAX_ACTIVE_UPLOADS || room.added + room.uploads.size >= MAX_ROOM_UPLOADS) { res.writeHead(429, headers); res.end(); return; }
        if (Number(req.headers['content-length']) > MAX_UPLOAD) { res.writeHead(413, { ...headers, connection: 'close' }); res.end(); return; }
        // The upload streams into a hidden part file in the folder (not into memory) and gets its name only when it is
        // complete and the album is still shared; a room closed meanwhile discards it.
        const dir = room.contribDir, tmp = path.join(dir, `.upload-${crypto.randomBytes(6).toString('hex')}.part`);
        const out = fs.createWriteStream(tmp, { flags: 'wx' });
        let size = 0, settled = false;
        const up = { cancel: () => fail(410) };
        const drop = () => fs.rm(tmp, { force: true }, () => undefined);
        const reply = (code, body) => {
          if (res.headersSent || res.destroyed) return;
          if (code === 200) { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
          else { res.writeHead(code, { ...headers, connection: 'close' }); res.end(() => req.destroy()); }
        };
        // A failed upload stops writing; its part file is removed when the stream has closed (below).
        const fail = (code) => { if (settled) return; settled = true; room.uploads.delete(up); req.unpipe(out); out.destroy(); reply(code); };
        room.uploads.add(up);
        req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) fail(413); });
        req.on('close', () => { if (!req.complete) fail(400); });
        out.on('error', () => fail(500));
        out.on('close', () => {
          if (settled || !out.writableFinished) { fail(500); drop(); return; }
          settled = true; room.uploads.delete(up);
          if (!size) { drop(); return reply(413); }
          if (rooms.get(room.token) !== room || !room.contribute || room.contribDir !== dir) { drop(); return reply(410); }
          const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
          let target = '';
          for (let k = 1; ; k++) {
            target = path.join(dir, k === 1 ? name : `${stem} (${k})${ext}`);
            try { fs.copyFileSync(tmp, target, fs.constants.COPYFILE_EXCL); break; } // never replaces a file that is there
            catch (e) { if (e && e.code === 'EEXIST' && k < 10000) continue; drop(); return reply(500); }
          }
          drop(); room.added++;
          reply(200, { ok: true, name: path.basename(target) });
          if (room.onAdded) room.onAdded({ path: target, name: path.basename(target), size });
        });
        req.pipe(out);
        return;
      }
    }
    res.writeHead(404, headers); res.end();
  }));
  const broadcast = (room) => { const line = `data: ${JSON.stringify(room.state)}\n\n`; for (const c of room.clients) pushEvent(c, line); };
  const open = (kind) => { const token = crypto.randomBytes(16).toString('hex'); const room = { kind, token, state: {}, clients: new Set(), uploads: new Set(), added: 0 }; rooms.set(token, room); return room; };
  // Closing a room ends its guests' streams and discards uploads still on their way.
  const close = (room) => { rooms.delete(room.token); for (const c of room.clients) c.end(); room.clients.clear(); for (const up of [...room.uploads]) up.cancel(); };
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const p = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      const urls = (kind, token) => lanAddresses().map((ip) => `http://${ip}:${p}/${kind}/${token}/`);
      resolve({
        port: p,
        view() { const room = open('s'); return { token: room.token, urls: urls('s', room.token), setState(s) { room.state = s || {}; broadcast(room); }, stop() { close(room); } }; },
        album(opts) {
          const room = open('a');
          const update = (o) => { Object.assign(room, { items: o.items || room.items || [], contribute: !!o.contribute, contribDir: o.contribDir || room.contribDir, onAdded: o.onAdded || room.onAdded }); room.state = { name: o.name ?? room.state.name, contribute: !!room.contribute, items: (room.items || []).map((it) => ({ id: it.id, name: it.name, size: it.size, mtime: it.mtime })) }; broadcast(room); };
          update(opts || {});
          return { token: room.token, urls: urls('a', room.token), update, stop() { close(room); } };
        },
        rooms: () => rooms.size,
        stop() { for (const r of [...rooms.values()]) close(r); server.close(); },
      });
    });
  });
}
module.exports = { startShare, lanAddresses, MAX_UPLOAD, MAX_ACTIVE_UPLOADS, MAX_ROOM_UPLOADS, MAX_GUESTS, UPLOAD_NAME, urlOf, pushEvent, guarded, esc, viewPage: VIEW_PAGE, viewScript: VIEW_SCRIPT, albumPage: ALBUM_PAGE, albumScript: ALBUM_SCRIPT };
