#!/usr/bin/env node
// The suite's relay: a small, self-hostable server that passes shared-view and shared-album state from a
// host to guests who cannot reach the host's computer directly (another network, a phone on mobile data).
//
//   node scripts/relay.mjs [port]            (default 8787; PORT in the environment works too)
//
// Protocol (docs/NETSHARE.md): a room is /s/<token>/ (view) or /a/<token>/ (album). The host creates it by
// PUTting its state with an `authorization: Bearer <key>` header; the first PUT claims the room for that
// key, later PUTs must carry the same key. Guests GET `state` (JSON) or `events` (server-sent events), and
// the room's page (the same pages the desktop app serves) for a plain browser. Album files are not relayed:
// the album state carries thumbnails (data URLs), and downloads need the host's own address. Rooms vanish
// after 15 minutes without a PUT. Everything is in memory; nothing is logged or stored.
//
// Limits (each from the environment, or the options of startRelay): RELAY_MAX_ROOMS (64) rooms at once,
// RELAY_ROOMS_PER_ADDRESS (8) rooms created from one address, RELAY_MAX_GUESTS (64) event streams per room. A
// room's state is at most 8 MB, so the defaults bound the relay's memory at about half a gigabyte.
import http from 'node:http';
import { createRequire } from 'node:module';

const MAX_STATE = 8 * 1024 * 1024, TTL = 15 * 60 * 1000;
const envInt = (name, fallback) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback; };
/** The request's address, or null when it does not parse (`GET //` and the like): answered 400, never an exception that ends the relay. */
const urlOf = (req) => { try { return new URL(req.url, 'http://x'); } catch { return null; } };
/** Writes an event to a guest's stream; a guest that is not reading gets the latest state when it catches up, not a queue of every state. */
function pushEvent(c, line) {
  if (c._qnBlocked) { c._qnNext = line; return; }
  if (!c.write(line)) { c._qnBlocked = true; c.once('drain', () => { c._qnBlocked = false; const n = c._qnNext; c._qnNext = null; if (n) pushEvent(c, n); }); }
}

/** Starts the relay on `port` (0 for any). Returns { port, rooms(), close() }. */
export function startRelay(port = 8787, opts = {}) {
  const rooms = new Map(); // token → { kind, key, state, clients, at, from }
  const maxRooms = opts.maxRooms || envInt('RELAY_MAX_ROOMS', 64), perAddress = opts.roomsPerAddress || envInt('RELAY_ROOMS_PER_ADDRESS', 8), maxGuests = opts.maxGuests || envInt('RELAY_MAX_GUESTS', 64);
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' };
  let pages = null;
  const loadPages = () => { if (!pages) { const req = createRequire(import.meta.url); pages = req('../electron/netshare.cjs'); } return pages; };
  const handle = (req, res) => {
    const u = urlOf(req);
    if (!u) { res.writeHead(400, headers); res.end(); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (u.pathname === '/') { res.writeHead(200, { ...headers, 'content-type': 'text/plain' }); res.end(`Anne's Lens relay: ${rooms.size} room(s)\n`); return; }
    const m = u.pathname.match(/^\/(s|a)\/([0-9a-f]{16,64})\/(.*)$/);
    if (!m) { res.writeHead(404, headers); res.end(); return; }
    const [, kind, token, rest] = m, base = `/${kind}/${token}/`;
    let room = rooms.get(token);
    if ((req.method === 'PUT' || req.method === 'POST') && rest === 'state') {
      const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!key) { res.writeHead(401, headers); res.end(); return; }
      if (room && room.key !== key) { res.writeHead(403, headers); res.end(); return; }
      const from = req.socket.remoteAddress || '';
      // A new room needs a free place: in the relay, and among the rooms made from this address.
      const full = () => rooms.size >= maxRooms || [...rooms.values()].filter((r) => r.from === from).length >= perAddress;
      if (!room && full()) { res.writeHead(429, { ...headers, 'retry-after': '60' }); res.end(); return; }
      if (Number(req.headers['content-length']) > MAX_STATE) { res.writeHead(413, { ...headers, connection: 'close' }); res.end(); return; }
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_STATE) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        let state; try { state = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400, headers); res.end(); return; }
        if (!state || typeof state !== 'object') { res.writeHead(400, headers); res.end(); return; }
        room = rooms.get(token); // another request may have made or claimed the room while this body arrived
        if (room && room.key !== key) { res.writeHead(403, headers); res.end(); return; }
        if (!room) { if (full()) { res.writeHead(429, { ...headers, 'retry-after': '60' }); res.end(); return; } room = { kind, key, state: {}, clients: new Set(), at: 0, from }; rooms.set(token, room); }
        room.state = state; room.at = Date.now();
        const line = `data: ${JSON.stringify(state)}\n\n`; for (const c of room.clients) pushEvent(c, line);
        // A host that says it has stopped frees the room a minute later (time for guests that poll to hear it), not after the full 15.
        if (state.ended === true) room.at = Date.now() - TTL + 60000;
        res.writeHead(204, headers); res.end();
      });
      return;
    }
    if (!room || room.kind !== kind) { res.writeHead(404, headers); res.end(); return; }
    if (req.method === 'GET' && rest === 'state') { const since = u.searchParams.get('since'); if (since && room.state.sig && since === room.state.sig) { res.writeHead(304, headers); res.end(); return; } res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify(room.state)); return; }
    if (req.method === 'GET' && rest === 'events') {
      if (room.clients.size >= maxGuests) { res.writeHead(503, headers); res.end(); return; }
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      pushEvent(res, `data: ${JSON.stringify(room.state)}\n\n`); room.clients.add(res); req.on('close', () => room.clients.delete(res)); return;
    }
    if (req.method === 'GET' && (rest === '' || rest === 'app.js')) {
      // The desktop app's guest pages, served here too so a plain browser can follow through the relay.
      let p; try { p = loadPages(); } catch { res.writeHead(404, headers); res.end(); return; }
      const page = kind === 's' ? (rest ? p.viewScript(base) : p.viewPage(base)) : (rest ? p.albumScript(base) : p.albumPage(base));
      res.writeHead(200, { ...headers, 'content-type': rest ? 'text/javascript' : 'text/html; charset=utf-8', ...(rest ? {} : { 'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'` }) });
      res.end(page); return;
    }
    res.writeHead(404, headers); res.end();
  };
  // No request may end the relay: whatever a handler throws is answered 400.
  const server = http.createServer((req, res) => { try { handle(req, res); } catch { try { if (!res.headersSent) res.writeHead(400, headers); res.end(); } catch { /* the socket is gone */ } } });
  const sweeper = setInterval(() => { const now = Date.now(); for (const [t, r] of rooms) if (now - r.at > TTL) { for (const c of r.clients) c.end(); rooms.delete(t); } }, 60000);
  sweeper.unref();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => resolve({ port: server.address().port, rooms: () => rooms.size, close() { clearInterval(sweeper); for (const r of rooms.values()) for (const c of r.clients) c.end(); rooms.clear(); server.close(); } }));
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.argv[2] || process.env.PORT || 8787);
  startRelay(port).then((r) => console.log(`Anne's Lens relay listening on port ${r.port}`), (e) => { console.error(e.message); process.exit(1); });
}
