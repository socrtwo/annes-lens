/**
 * Script Console engine: JavaScript runs in a dedicated Worker (no access to the page, the settings
 * or the network beyond what a worker has), loaded from a blob: URL so the app's Content Security
 * Policy can keep eval off. The worker reaches the app only through the calls below.
 *
 * In scripts: `app.exec(id, arg)`, `app.commands(filter)`, `app.toast(text)`;
 * `picture.info()`, `picture.pixels()`, `picture.setPixels({ width, height, data }, label)`;
 * `folder.list()`, `folder.current()`, `folder.go(indexOrName)`; `print(...)`, `sleep(ms)`.
 * Every call returns a promise. A snippet runs as the body of an async function: `return` shows a
 * value, and `globalThis.x = …` keeps something for the next run.
 *
 * What a script may do on its own is what the interface says: change the open picture and move through the open
 * folder. `app.exec` reaches every command, and some of those go further: they start other programs, use the network,
 * send pictures to services, touch other files, or change the app (its settings, its plug-ins, its own scripts).
 * Those ask the user first, in a dialog of the page that the worker cannot answer, naming the command and its
 * argument; the answer holds for that command and argument until the console is closed or the plug-in's run ends.
 */
import type { App } from '../app';
import { allCommands } from '../commands/registry';
import { frameRaster, editRaster } from '../picture/edit';
import { profileName } from '../color/embedded';

const WORKER = `'use strict';
const pending = new Map(); let seq = 0;
const call = (method, ...args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); postMessage({ type: 'call', id, method, args }); });
const show = (v) => { if (typeof v === 'string') return v; if (v === undefined) return 'undefined'; if (v instanceof Uint8ClampedArray || v instanceof Uint8Array) return v.constructor.name + '(' + v.length + ')'; try { return JSON.stringify(v, (k, x) => (x instanceof Uint8ClampedArray ? 'Uint8ClampedArray(' + x.length + ')' : x), 2); } catch (e) { return String(v); } };
self.app = { exec: (id, arg) => call('exec', id, arg), commands: (filter) => call('commands', filter), toast: (text) => call('toast', String(text)) };
self.picture = { info: () => call('picture.info'), pixels: () => call('picture.pixels'), setPixels: (r, label) => call('picture.setPixels', r, label) };
self.folder = { list: () => call('folder.list'), current: () => call('folder.current'), go: (to) => call('folder.go', to) };
self.print = (...a) => postMessage({ type: 'print', text: a.map(show).join(' ') });
self.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'reply') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.value); return; }
  if (m.type !== 'run') return;
  let url;
  try {
    url = URL.createObjectURL(new Blob(['self.__snippet = async function () {\\n' + m.code + '\\n};'], { type: 'text/javascript' }));
    self.__snippet = null;
    importScripts(url);
    if (typeof self.__snippet !== 'function') throw new SyntaxError('The script could not be read (check for a syntax error)');
    const v = await self.__snippet();
    postMessage({ type: 'done', id: m.id, value: v === undefined ? null : show(v) });
  } catch (err) { postMessage({ type: 'error', id: m.id, text: (err && err.name ? err.name + ': ' : '') + (err && err.message || String(err)) }); }
  finally { if (url) URL.revokeObjectURL(url); }
};
self.onerror = (msg) => { postMessage({ type: 'error', id: 0, text: String(msg) }); return true; };
`;

export interface ScriptOutput { kind: 'print' | 'result' | 'error' | 'info'; text: string }

const ASK_GROUPS = ['ai.', 'dev.', 'batch.', 'plugin:'];
const ASK_IDS = new Set([
  // other programs and the system
  'file.openExternal', 'file.openWith', 'tools.external', 'file.print', 'file.quickPrint', 'file.copyShop', 'file.wallpaper', 'file.lockScreen', 'file.contactPhoto', 'file.associations', 'file.sysProperties',
  'file.scan', 'file.batchScan', 'file.capture', 'file.captureCamera',
  // the network
  'file.openUrl', 'file.share', 'file.email', 'file.cast', 'view.shareView', 'view.followView', 'view.netRelay', 'browse.shareAlbum', 'browse.openSharedAlbum', 'show.remote',
  'help.sendSample', 'help.reportIssue', 'help.checkUpdates', 'meta.reverseGeocode',
  // files other than the open picture
  'file.delete', 'file.deletePermanent', 'file.moveTo', 'file.copyTo', 'file.quickMove', 'file.quickCopy', 'file.rename', 'file.importCamera', 'file.importRules', 'file.encrypt', 'file.saveAll',
  'tools.backup', 'browse.watchFolder', 'browse.maintenance', 'browse.folderManager',
  // the app itself
  'tools.plugins', 'file.options', 'file.exportSettings', 'file.portableMode', 'file.resetCustomizations', 'file.customizeQat', 'file.customizeRibbon', 'file.customizeMenus', 'file.customizeKeyboard', 'file.exit',
]);
/** Whether a script running this command needs the user's yes first: the command reaches beyond the open picture and folder. */
export const scriptNeedsConsent = (id: string): boolean => ASK_GROUPS.some((g) => id.startsWith(g)) || ASK_IDS.has(id);
/** Asks the user whether a script may run a command; the default is a dialog of the page. */
export type ScriptAsk = (label: string, id: string, arg: unknown) => Promise<boolean>;
const askInDialog: ScriptAsk = async (label, id, arg) => {
  const { confirmDialog } = await import('../ui/dialog');
  let shown = ''; try { shown = arg === undefined ? '' : JSON.stringify(arg); } catch { shown = String(arg); }
  return confirmDialog('A script wants to run a command', `“${label}” (${id})${shown ? `\nwith: ${shown.length > 400 ? shown.slice(0, 400) + '…' : shown}` : ''}\nThis command reaches beyond the open picture and folder (other programs, the network, services, other files or the app's own settings). Allow it only if you expect this script to do that.`, 'Allow', 'Don\'t Allow');
};

export class ScriptHost {
  private worker: Worker | null = null;
  private url: string | null = null;
  private runs = new Map<number, (ok: boolean) => void>();
  private seq = 0;
  running = 0;
  /** Commands (with their arguments) the user allowed this host's scripts to run. */
  private allowed = new Set<string>();
  constructor(private app: App, private out: (o: ScriptOutput) => void, private ask: ScriptAsk = askInDialog) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    this.url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
    const w = new Worker(this.url);
    w.onmessage = (e) => void this.message(e.data);
    w.onerror = (e) => { e.preventDefault(); this.out({ kind: 'error', text: e.message || 'Script error' }); };
    this.worker = w;
    return w;
  }
  /** Runs a snippet; resolves true when it finished without an error. */
  run(code: string): Promise<boolean> {
    const id = ++this.seq, w = this.start();
    this.running++;
    return new Promise((resolve) => { this.runs.set(id, (ok) => { this.running--; resolve(ok); }); w.postMessage({ type: 'run', id, code }); });
  }
  /** Stops a runaway script (the worker and anything kept in globalThis are discarded). */
  stop(): void {
    this.worker?.terminate(); this.worker = null;
    if (this.url) URL.revokeObjectURL(this.url); this.url = null;
    for (const done of this.runs.values()) done(false);
    this.runs.clear();
    this.out({ kind: 'info', text: 'Stopped; the console starts fresh.' });
  }
  dispose(): void { this.worker?.terminate(); this.worker = null; if (this.url) URL.revokeObjectURL(this.url); this.url = null; }

  private async message(m: any): Promise<void> {
    if (m.type === 'print') this.out({ kind: 'print', text: m.text });
    else if (m.type === 'done' || m.type === 'error') {
      if (m.type === 'done' && m.value !== null) this.out({ kind: 'result', text: m.value });
      if (m.type === 'error') this.out({ kind: 'error', text: m.text });
      const done = this.runs.get(m.id); if (done) { this.runs.delete(m.id); done(m.type === 'done'); }
    } else if (m.type === 'call') {
      try {
        const { value, transfer } = await this.call(m.method, m.args || []);
        this.worker?.postMessage({ type: 'reply', id: m.id, value }, transfer || []);
      } catch (e: any) { this.worker?.postMessage({ type: 'reply', id: m.id, error: e?.message || String(e) }); }
    }
  }

  private async call(method: string, args: any[]): Promise<{ value: any; transfer?: Transferable[] }> {
    const app = this.app, pic = app.picture;
    const need = () => { if (!pic) throw new Error('No picture is open'); return pic; };
    switch (method) {
      case 'exec': {
        const [id, arg] = args;
        if (id === 'dev.console') throw new Error('The console cannot open itself');
        const cmd = allCommands().find((c) => c.id === id) || (typeof id === 'string' && id.startsWith('plugin:') ? (await import('../commands/registry')).getCommand(id) : undefined);
        if (!cmd) throw new Error(`Unknown command: ${id}`);
        if (scriptNeedsConsent(id)) {
          let key = id; try { key = `${id}\n${JSON.stringify(arg)}`; } catch { /* asked every time */ }
          if (!this.allowed.has(key)) {
            if (!(await this.ask(cmd.label || id, id, arg))) throw new Error(`${id} was not allowed (it reaches beyond the open picture and folder, so it asks first)`);
            this.allowed.add(key);
          }
        }
        const r = app.exec(id, arg);
        if (r instanceof Promise) await r;
        return { value: true };
      }
      case 'commands': { const q = String(args[0] || '').toLowerCase(); return { value: allCommands().filter((c) => !q || c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q)).map((c) => ({ id: c.id, label: c.label, tab: c.tab })) }; }
      case 'toast': { const { toast } = await import('../ui/dialog'); toast(String(args[0]).slice(0, 300)); return { value: true }; }
      case 'picture.info': { const p = need(); return { value: { name: p.name, width: p.width, height: p.height, format: p.format.label, page: p.page, pages: p.pages.length, frames: p.current.frames.length, hasAlpha: p.current.hasAlpha, profile: profileName(p.current.icc), dirty: app.tab.dirty } }; }
      case 'picture.pixels': { const r = frameRaster(need().currentFrame); const data = new Uint8ClampedArray(r.data); return { value: { width: r.width, height: r.height, data }, transfer: [data.buffer] }; }
      case 'picture.setPixels': {
        need();
        const [r, label] = args;
        const w = r?.width | 0, hgt = r?.height | 0;
        if (!(w > 0 && hgt > 0) || !r.data || r.data.length !== w * hgt * 4) throw new Error('setPixels wants { width, height, data } with width × height × 4 values (RGBA)');
        const data = new Uint8ClampedArray(r.data);
        editRaster(app, String(label || 'Script'), () => ({ width: w, height: hgt, data: data as Uint8ClampedArray<ArrayBuffer> }));
        return { value: true };
      }
      case 'folder.list': return { value: app.folder.entries.map((e) => e.name) };
      case 'folder.current': return { value: { index: app.folder.index, name: app.folder.current?.name ?? null, count: app.folder.length } };
      case 'folder.go': {
        const to = args[0], f = app.folder;
        const i = typeof to === 'number' ? to : f.entries.findIndex((e) => e.name === to);
        if (i < 0 || i >= f.length) throw new Error(`No picture ${JSON.stringify(to)} in this folder`);
        f.select(i); await app.tab.show();
        return { value: f.current?.name };
      }
    }
    throw new Error(`Unknown call ${method}`);
  }
}
