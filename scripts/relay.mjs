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
import http from 'node:http';
import { createRequire } from 'node:module';

const MAX_STATE = 8 * 1024 * 1024, TTL = 15 * 60 * 1000;

/** Starts the relay on `port` (0 for any). Returns { port, rooms(), close() }. */
export function startRelay(port = 8787) {
  const rooms = new Map(); // token → { kind, key, state, clients, at }
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' };
  let pages = null;
  const loadPages = () => { if (!pages) { const req = createRequire(import.meta.url); pages = req('../electron/netshare.cjs'); } return pages; };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
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
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_STATE) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        let state; try { state = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400, headers); res.end(); return; }
        if (!state || typeof state !== 'object') { res.writeHead(400, headers); res.end(); return; }
        if (!room) { room = { kind, key, state: {}, clients: new Set(), at: 0 }; rooms.set(token, room); }
        room.state = state; room.at = Date.now();
        const line = `data: ${JSON.stringify(state)}\n\n`; for (const c of room.clients) c.write(line);
        res.writeHead(204, headers); res.end();
      });
      return;
    }
    if (!room || room.kind !== kind) { res.writeHead(404, headers); res.end(); return; }
    if (req.method === 'GET' && rest === 'state') { const since = u.searchParams.get('since'); if (since && room.state.sig && since === room.state.sig) { res.writeHead(304, headers); res.end(); return; } res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify(room.state)); return; }
    if (req.method === 'GET' && rest === 'events') {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(room.state)}\n\n`); room.clients.add(res); req.on('close', () => room.clients.delete(res)); return;
    }
    if (req.method === 'GET' && (rest === '' || rest === 'app.js')) {
      // The desktop app's guest pages, served here too so a plain browser can follow through the relay.
      let p; try { p = loadPages(); } catch { res.writeHead(404, headers); res.end(); return; }
      const page = kind === 's' ? (rest ? p.viewScript(base) : p.viewPage(base)) : (rest ? p.albumScript(base) : p.albumPage(base));
      res.writeHead(200, { ...headers, 'content-type': rest ? 'text/javascript' : 'text/html; charset=utf-8', ...(rest ? {} : { 'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'` }) });
      res.end(page); return;
    }
    res.writeHead(404, headers); res.end();
  });
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
