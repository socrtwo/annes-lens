// Phone Remote for slideshows (desktop): a small HTTP server on the local network. The phone opens
// http://<this computer>:<port>/r/<token>/ (shown as a QR code) and gets a page with Previous,
// Play/Pause, Next, Start and Stop, the current picture and its caption. Only requests carrying the
// random token are answered; the server stops when the remote is turned off or the app quits.
'use strict';
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { urlOf, pushEvent, guarded, MAX_GUESTS } = require('./netshare.cjs');

const PAGE = (token) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anne's Lens remote</title><style>
body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#111;color:#eee;display:flex;flex-direction:column;min-height:100vh}
header{padding:10px 14px;font-size:14px;color:#aaa}main{flex:1;display:flex;flex-direction:column;align-items:center;gap:10px;padding:8px}
img{max-width:100%;max-height:45vh;border-radius:8px;background:#222}#cap{text-align:center;min-height:1.4em;color:#ccc;white-space:pre-line}
.row{display:flex;gap:10px;width:100%;max-width:520px}button{flex:1;font-size:22px;padding:18px 0;border:0;border-radius:12px;background:#2b5ea7;color:#fff}
button.alt{background:#333;font-size:16px;padding:12px 0}#st{font-size:13px;color:#888}</style></head><body>
<header>Anne's Lens · <span id="st">connecting…</span></header><main><img id="pic" alt=""><div id="name"></div><div id="cap"></div>
<div class="row"><button id="prev" aria-label="Previous">◀</button><button id="pause" aria-label="Play or pause">⏯</button><button id="next" aria-label="Next">▶</button></div>
<div class="row"><button class="alt" id="start">Start slideshow</button><button class="alt" id="stop">Stop</button></div></main>
<script src="/r/${token}/app.js"></script></body></html>`;
const SCRIPT = (token) => `'use strict';
const base = '/r/${token}/', $ = (id) => document.getElementById(id);
const send = (cmd) => fetch(base + 'cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) }).catch(() => {});
for (const c of ['prev', 'pause', 'next', 'start', 'stop']) $(c).onclick = () => send(c === 'prev' ? 'previous' : c);
const show = (s) => { $('st').textContent = s.running ? (s.paused ? 'paused' : 'playing') + ' · ' + s.index + ' / ' + s.total : 'not playing · ' + s.index + ' / ' + s.total; $('name').textContent = s.name || ''; $('cap').textContent = s.caption || ''; if (s.thumb) $('pic').src = s.thumb; };
const es = new EventSource(base + 'events'); es.onmessage = (e) => show(JSON.parse(e.data)); es.onerror = () => { $('st').textContent = 'reconnecting…'; };`;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out.length ? out : ['127.0.0.1'];
}

/** Starts the server; `onCommand` receives next / previous / pause / start / stop. */
function startRemote(onCommand, port = 0) {
  const token = crypto.randomBytes(16).toString('hex');
  let state = {};
  const clients = new Set();
  const server = http.createServer(guarded((req, res) => {
    const u = urlOf(req);
    if (!u) { res.writeHead(400).end(); return; }
    const prefix = `/r/${token}/`;
    if (!u.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const rest = u.pathname.slice(prefix.length);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (req.method === 'GET' && rest === '') { res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'" }); res.end(PAGE(token)); return; }
    if (req.method === 'GET' && rest === 'app.js') { res.writeHead(200, { ...headers, 'content-type': 'text/javascript' }); res.end(SCRIPT(token)); return; }
    if (req.method === 'GET' && rest === 'state') { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify(state)); return; }
    if (req.method === 'GET' && rest === 'events') {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      if (clients.size >= MAX_GUESTS) { res.writeHead(503, headers).end(); return; }
      pushEvent(res, `data: ${JSON.stringify(state)}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'POST' && rest === 'cmd') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
      req.on('end', () => { let cmd = ''; try { cmd = String(JSON.parse(body).cmd || ''); } catch { /* */ } if (['next', 'previous', 'pause', 'start', 'stop'].includes(cmd)) { onCommand(cmd); res.writeHead(204, headers).end(); } else res.writeHead(400, headers).end(); });
      return;
    }
    res.writeHead(404, headers).end();
  }));
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const p = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      resolve({
        token, port: p, urls: lanAddresses().map((ip) => `http://${ip}:${p}/r/${token}/`),
        setState(s) { state = s || {}; const line = `data: ${JSON.stringify(state)}\n\n`; for (const c of clients) pushEvent(c, line); },
        stop() { for (const c of clients) c.end(); clients.clear(); server.close(); },
      });
    });
  });
}
module.exports = { startRemote, lanAddresses };
