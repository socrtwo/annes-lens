// Print lifetime test: on a phone browser print() returns at once and the print UI keeps laying the
// live page out for its preview, so the print page must stay until the user is back in the app.
// Usage: npm run build && npm run e2e:print   (set QN_URL to test an already-running server instead)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4185;
let server = null;
let url = process.env.QN_URL;
if (!url) {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
  url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const browser = await chromium.launch(exe);
const failures = [];
const check = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

try {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => failures.push('pageerror: ' + e.message));
  await p.addInitScript(() => {
    localStorage.setItem('quilllens.prefs.v1', JSON.stringify({ firstRun: false }));
    window.print = () => { window.__printed = (window.__printed || 0) + 1; setTimeout(() => window.dispatchEvent(new Event('afterprint')), 50); };
  });
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.qn);
  await p.waitForTimeout(500);
  // Open a generated PNG through the drop command.
  await p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 64, 48);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await qn.exec('file.openDropped', [new File([blob], 'red.png', { type: 'image/png' })]);
  });
  await p.waitForFunction(() => !!qn.picture, null, { timeout: 10000 });
  const state = () => p.evaluate(() => ({ page: !!document.querySelector('#ql-print-root .ql-print-page img'), printing: document.body.classList.contains('ql-printing') }));

  await p.evaluate(() => { Promise.resolve(qn.exec('file.quickPrint')).catch((e) => { window.__printErr = String(e); }); });
  await p.waitForFunction(() => window.__printed === 1, null, { timeout: 10000 });
  await p.waitForTimeout(3000);
  check('print page kept while the print UI is open', await state(), { page: true, printing: true });
  await p.touchscreen.tap(200, 880);
  await p.waitForTimeout(1600);
  check('print page removed afterwards', await state(), { page: false, printing: false });
  check('print error', await p.evaluate(() => window.__printErr || null), null);
} finally {
  await browser.close();
  if (server) { try { process.kill(-server.pid); } catch { /* */ } }
}
if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exit(1); }
console.log('print e2e: ok');
