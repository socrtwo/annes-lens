// @vitest-environment node
/**
 * The desktop app's file permissions (electron/main.cjs), exercised through its IPC handlers with Electron stubbed:
 * what the page may read by moving through folders, what it may write only with the user's say, and what it never
 * reaches (the app's own settings folder, hidden files and folders).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'qn-grants-'))), home = join(root, 'home'), appData = join(home, 'AppData'), userData = join(appData, 'QuillLens');
const uri = (...p: string[]) => pathToFileURL(join(home, ...p)).href;

/** An object that answers anything: any property, any call, `new`. Named members come from `own`. */
function anything(own: Record<string, unknown> = {}): any {
  const made = new Map<string, unknown>();
  return new Proxy(function () { /* callable */ }, {
    get(_t, k) { if (typeof k === 'symbol' || k === 'then') return undefined; if (k in own) return own[k]; if (!made.has(k)) made.set(k, anything()); return made.get(k); },
    set(_t, k, v) { own[k as string] = v; return true; },
    apply: () => anything(),
    construct: () => anything(),
  });
}

const handlers = new Map<string, (e: unknown, opts: unknown) => Promise<any>>();
const asked: string[] = []; let answer = 1; let picked = '';
let windowMade: any = null;
const paths = new Map<string, string>([['appData', appData]]);
const electron = {
  app: anything({ setPath: (k: string, v: string) => { paths.set(k, v); }, getPath: (k: string) => paths.get(k) || join(root, 'other', k), getVersion: () => '0.0.0-test', whenReady: () => Promise.resolve(), isReady: () => true, requestSingleInstanceLock: () => true, on: () => undefined, quit: () => undefined, exit: () => undefined }),
  BrowserWindow: new Proxy(function () { /* class */ }, { construct: () => (windowMade = anything({ isDestroyed: () => false, isMinimized: () => false })), get: (_t, k) => (k === 'getAllWindows' ? () => [windowMade] : undefined) }),
  ipcMain: { handle: (name: string, fn: (e: unknown, o: unknown) => Promise<any>) => { handlers.set(name, fn); }, on: () => undefined },
  dialog: { showMessageBox: async (_w: unknown, o: { message: string }) => { asked.push(o.message); return { response: answer }; }, showOpenDialog: async () => ({ canceled: !picked, filePaths: picked ? [picked] : [] }), showSaveDialog: async () => ({ canceled: true }), showMessageBoxSync: () => 1 },
  protocol: anything(), net: anything(), shell: anything(), clipboard: anything(), powerSaveBlocker: anything(), Menu: anything(), session: anything(), desktopCapturer: anything(), safeStorage: anything(), screen: anything(),
};
/** Calls an IPC handler the way the app's own page does. */
const call = (name: string, opts: Record<string, unknown> = {}) => handlers.get('ql:' + name)!({ sender: windowMade.webContents, senderFrame: { url: 'app://quilllens/index.html' } }, opts);
const fails = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => String(e?.message || e));

const keep = { argv: process.argv, home: process.env.HOME, profile: process.env.USERPROFILE, load: (Module as any)._load };
beforeAll(async () => {
  for (const d of ['Pictures/2020', 'Pictures/2021', '.ssh', 'AppData/QuillLens', 'Out']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, 'Pictures/2020/a.png'), 'A'); writeFileSync(join(home, 'Pictures/2020/b.png'), 'B'); writeFileSync(join(home, 'Pictures/2021/c.png'), 'C');
  writeFileSync(join(home, '.ssh/id_key'), 'secret'); writeFileSync(join(userData, 'programs.json'), '[]');
  process.argv = ['annes-lens']; process.env.HOME = home; process.env.USERPROFILE = home;
  (Module as any)._load = function (request: string, ...rest: unknown[]) { return request === 'electron' ? electron : keep.load.call(this, request, ...rest); };
  require('../../electron/main.cjs');
  await new Promise((r) => setTimeout(r, 20)); // whenReady: the handlers are registered and the window made
  // The user opens one picture through the dialog.
  picked = join(home, 'Pictures/2020/a.png'); await call('openDocument'); picked = '';
});
afterAll(() => { process.argv = keep.argv; process.env.HOME = keep.home; process.env.USERPROFILE = keep.profile; (Module as any)._load = keep.load; rmSync(root, { recursive: true, force: true }); });

describe('what the page reaches by moving through folders', () => {
  it('reads the pictures of the opened folder and its neighbors, and stops going up at the home folder', async () => {
    expect((await call('listFolder', { uri: uri('Pictures/2020') })).entries.map((e: { name: string }) => e.name)).toEqual(['a.png', 'b.png']);
    const up = await call('parentFolder', { uri: uri('Pictures/2020') }); expect(up.name).toBe('Pictures');
    expect((await call('listSubfolders', { uri: up.uri })).folders.map((f: { name: string }) => f.name)).toEqual(['2020', '2021']);
    expect((await call('listFolder', { uri: uri('Pictures/2021') })).entries).toHaveLength(1);
    const top = await call('parentFolder', { uri: up.uri }); expect(top.uri).toBe(uri());
    expect(await call('parentFolder', { uri: top.uri })).toBeNull();          // nothing above home
    expect(await fails(call('listFolder', { uri: pathToFileURL(root).href }))).toMatch(/no permission/);
  });
  it('is not led into hidden folders or the app\'s own settings folder', async () => {
    const names = (await call('listSubfolders', { uri: uri() })).folders.map((f: { name: string }) => f.name);
    expect(names).toEqual(['AppData', 'Out', 'Pictures']);                     // no .ssh
    expect(await fails(call('listFolder', { uri: uri('.ssh'), all: true }))).toMatch(/no permission/);
    expect(await fails(call('readUri', { uri: uri('.ssh/id_key') }))).toMatch(/no permission/);
    expect((await call('listSubfolders', { uri: uri('AppData') })).folders).toEqual([]);  // QuillLens is left out
    expect(await fails(call('listFolder', { uri: uri('AppData/QuillLens'), all: true }))).toMatch(/no permission/);
    expect(await fails(call('readUri', { uri: uri('AppData/QuillLens/programs.json') }))).toMatch(/no permission/);
    expect(await fails(call('rememberFolder', { uri: uri('AppData/QuillLens') }))).toMatch(/no permission/);
  });
});

describe('what the page writes only with the user\'s say', () => {
  const data = Buffer.from('written').toString('base64');
  it('asks before saving into a folder that was only read, and writes nothing when refused', async () => {
    answer = 1; asked.length = 0;
    expect(await fails(call('createInFolder', { dirUri: uri('Pictures/2021'), name: 'new.png', data }))).toMatch(/was not allowed/);
    expect(await fails(call('copyFile', { uri: uri('Pictures/2020/a.png'), dirUri: uri('Pictures/2021') }))).toMatch(/was not allowed/);
    expect(await fails(call('createSubfolder', { dirUri: uri('Pictures/2021'), name: 'sub' }))).toMatch(/was not allowed/);
    expect(asked).toEqual(Array(3).fill('Allow Anne\'s Lens to save files into “2021”?'));
    expect(existsSync(join(home, 'Pictures/2021/new.png'))).toBe(false); expect(existsSync(join(home, 'Pictures/2021/a.png'))).toBe(false); expect(existsSync(join(home, 'Pictures/2021/sub'))).toBe(false);
    answer = 0; asked.length = 0;
    expect((await call('createInFolder', { dirUri: uri('Pictures/2021'), name: 'new.png', data })).name).toBe('new.png');
    expect((await call('copyFile', { uri: uri('Pictures/2020/a.png'), dirUri: uri('Pictures/2021') })).name).toBe('a.png');
    expect(asked).toHaveLength(1);                                             // once per folder
    expect(readFileSync(join(home, 'Pictures/2021/new.png'), 'utf8')).toBe('written');
  });
  it('does not ask for a folder the user picked in the folder dialog, and remembers that it is writable', async () => {
    asked.length = 0; picked = join(home, 'Out'); const out = await call('pickFolder', { title: 'x' }); picked = '';
    expect((await call('createInFolder', { dirUri: out.uri, name: 'o.png', data })).name).toBe('o.png');
    const sub = await call('createSubfolder', { dirUri: out.uri, name: 'day 1' });
    expect((await call('createInFolder', { dirUri: sub.uri, name: 'p.png', data })).name).toBe('p.png');
    expect(asked).toHaveLength(0);
    await call('rememberFolder', { uri: out.uri }); await call('rememberFolder', { uri: uri('Pictures/2020') });
    expect(JSON.parse(readFileSync(join(userData, 'writable-folders.json'), 'utf8'))).toEqual([join(home, 'Out')]); // the folder that was only read is remembered, not made writable
    expect(JSON.parse(readFileSync(join(userData, 'remembered-folders.json'), 'utf8'))).toEqual([join(home, 'Out'), join(home, 'Pictures/2020')]);
  });
  it('makes no hidden files or folders, even where it may write', async () => {
    answer = 0;
    expect(await fails(call('createInFolder', { dirUri: uri('Out'), name: '.bashrc', data }))).toMatch(/cannot start with a dot/);
    expect(await fails(call('createSubfolder', { dirUri: uri('Out'), name: '.config' }))).toMatch(/cannot start with a dot/);
    expect(await fails(call('copyFile', { uri: uri('Pictures/2020/a.png'), dirUri: uri('Out'), name: '.profile' }))).toMatch(/cannot start with a dot/);
    // The home folder itself, allowed by the user: an existing hidden folder is still not entered by "making" it.
    expect(await fails(call('createSubfolder', { dirUri: uri(), name: '.ssh' }))).toMatch(/cannot start with a dot/);
    expect(await fails(call('listFolder', { uri: uri('.ssh'), all: true }))).toMatch(/no permission/);
    // Renaming an opened picture into a shell start-up file is refused; Batch Rename's own short-lived names pass.
    expect(await fails(call('renameDocument', { uri: uri('Pictures/2020/a.png'), name: '.bash_profile' }))).toMatch(/cannot start with a dot/);
    const tmp = await call('renameDocument', { uri: uri('Pictures/2020/a.png'), name: '.ql-batch-1700000000000-0.png' }); expect(tmp.name).toBe('.ql-batch-1700000000000-0.png');
    expect((await call('renameDocument', { uri: tmp.uri, name: 'a.png' })).name).toBe('a.png');
  });
  it('never writes into the app\'s own settings folder', async () => {
    answer = 0;
    expect(await fails(call('createInFolder', { dirUri: uri('AppData/QuillLens'), name: 'programs.json', data }))).toMatch(/no permission|settings folder/);
    expect(await fails(call('moveFile', { uri: uri('Pictures/2020/b.png'), dirUri: uri('AppData/QuillLens') }))).toMatch(/no permission|settings folder/);
    expect(readFileSync(join(userData, 'programs.json'), 'utf8')).toBe('[]');
    expect(existsSync(join(home, 'Pictures/2020/b.png'))).toBe(true);
  });
});

describe('scripts for PowerShell and AppleScript', () => {
  it('never carry a file name in their text: names go beside the script', () => {
    const osx = require('../../electron/osscripts.cjs');
    // U+2019 closes a PowerShell single-quoted string just as ' does; the double quote and backslash end an AppleScript one.
    const hostile = ['a\u2019);Start-Process calc;#.jpg', "b');Start-Process calc;#.jpg", 'c" & (do shell script "open -a Calculator") & ".jpg', 'd\\".jpg', '$(calc).jpg', '`calc`.jpg'];
    for (const name of hostile) {
      const dir = `C:\\Users\\me\\${name} folder`;
      for (const c of [osx.setWallpaperWin(`${dir}\\${name}`), osx.showPropertiesWin(dir, name), osx.scanWin(name, false, 300, `${dir}\\${name}`)]) {
        expect(c.cmd).toBe('powershell.exe');
        const script = c.args[c.args.indexOf('-Command') + 1];
        expect(Object.values(osx.SCRIPTS)).toContain(script);                 // one of the fixed texts, unchanged
        expect(c.args.join('\n')).not.toContain(name);
        expect(Object.values(c.env).some((v) => String(v).includes(name))).toBe(true); // the name travels in the environment
        for (const k of Object.keys(c.env)) expect(script).toContain(`$env:${k}`);
      }
      for (const c of [osx.setWallpaperMac(`/Users/me/${name}`), osx.showPropertiesMac(`/Users/me/${name}`)]) {
        expect(c.cmd).toBe('osascript'); expect(c.args[0]).toBe('-e');
        expect(c.args[1]).not.toContain(name); expect(c.args[1]).toMatch(/^on run argv\n[\s\S]*item 1 of argv[\s\S]*\nend run$/);
        expect(c.args[2]).toBe(`/Users/me/${name}`); expect(c.args).toHaveLength(3);
      }
    }
    // Numbers are numbers: a resolution that is not one falls back, and an empty device means the first scanner.
    expect(osx.scanWin('', true, 'x; calc', 'f.png').env).toEqual({ QN_DEVICE: '', QN_MODE: '2', QN_RES: '300', QN_FILE: 'f.png' });
  });
});
