/**
 * The shortcut handler sees every key first (capture phase), so it has to stand aside for the widget that owns a key:
 * a control reached with Tab, a list or the map, an open menu, a picture larger than the window. And Esc closes the app
 * only where that option is on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const on = vi.hoisted(() => ({ desktop: false }));
vi.mock('../../src/platform/native', async (orig) => ({ ...(await orig<typeof import('../../src/platform/native')>()), isDesktop: () => on.desktop }));

import { Shell } from '../../src/ui/shell';
import { showMenu, closeMenus, menuOpen } from '../../src/ui/dialog';
import { getCommand } from '../../src/commands/file';

const KEYS: Record<string, string> = { Space: 'view.next', Enter: 'view.fullScreen', ArrowRight: 'view.next', ArrowLeft: 'view.prev', Escape: 'file.exit', 'Alt-F4': 'file.exit', s: 'file.saveAs' };

function fakeShell(over: { pans?: boolean } = {}) {
  const exec = vi.fn();
  const viewerEl = document.createElement('div'); document.body.appendChild(viewerEl);
  const app: any = {
    exec, tabs: [{}], tab: { selection: null }, picture: {},
    viewer: { el: viewerEl, panKey: (e: KeyboardEvent) => !!over.pans && e.key.startsWith('Arrow') },
    commandForKey: (k: string) => KEYS[k] || null,
  };
  const shell: any = Object.create(Shell.prototype);
  shell.app = app; shell.root = document.createElement('div'); shell.keyNav = false; shell.hideBackstage = () => undefined;
  return { shell: shell as Shell, exec, viewerEl };
}
/** Sends a key to `target` and returns the event the handler saw. */
function press(shell: Shell, target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  let seen!: KeyboardEvent;
  const on = (e: Event) => { seen = e as KeyboardEvent; shell.globalKey(seen); };
  document.addEventListener('keydown', on, true);
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  document.removeEventListener('keydown', on, true);
  return seen;
}

beforeEach(() => { document.body.innerHTML = ''; (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }); });
afterEach(() => closeMenus());

describe('shortcuts stand aside for the widget that owns the key', () => {
  it('runs the command when nothing else wants the key', () => {
    const { shell, exec } = fakeShell();
    const e = press(shell, document.body, ' ');
    expect(exec).toHaveBeenCalledWith('view.next');
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves Enter and Space to a control reached with Tab, and takes them back after a click', () => {
    const { shell, exec } = fakeShell();
    const b = document.createElement('button'); document.body.appendChild(b);
    (shell as any).keyNav = true;
    for (const k of ['Enter', ' ']) { const e = press(shell, b, k); expect(e.defaultPrevented).toBe(false); }
    expect(exec).not.toHaveBeenCalled();
    // Other keys are still shortcuts there.
    press(shell, b, 's'); expect(exec).toHaveBeenLastCalledWith('file.saveAs');
    // After a mouse click on the button, Space is Next again (and the press is cancelled, so the button is not clicked again).
    (shell as any).keyNav = false; exec.mockClear();
    const e = press(shell, b, ' ');
    expect(exec).toHaveBeenCalledWith('view.next'); expect(e.defaultPrevented).toBe(true);
  });

  it('leaves a list its own keys and keeps the others', () => {
    const { shell, exec } = fakeShell();
    const list = document.createElement('div'); const item = document.createElement('div'); list.appendChild(item); document.body.appendChild(list);
    (list as any).__ownsKey = (e: KeyboardEvent) => e.key.startsWith('Arrow') || e.key === ' ';
    press(shell, item, 'ArrowRight'); press(shell, item, ' ');
    expect(exec).not.toHaveBeenCalled();
    press(shell, item, 'Enter');
    expect(exec).toHaveBeenCalledWith('view.fullScreen');
  });

  it('lets the arrows move a picture larger than the window, from the page or the viewer only', () => {
    const big = fakeShell({ pans: true });
    press(big.shell, document.body, 'ArrowRight'); press(big.shell, big.viewerEl, 'ArrowLeft');
    expect(big.exec).not.toHaveBeenCalled();
    press(big.shell, document.body, ' ');
    expect(big.exec).toHaveBeenCalledWith('view.next');
    const fits = fakeShell();
    press(fits.shell, document.body, 'ArrowRight');
    expect(fits.exec).toHaveBeenCalledWith('view.next');
  });

  it('gives an open menu the plain keys, and moves focus into it on an arrow', () => {
    const { shell, exec } = fakeShell();
    const picked: string[] = [];
    const menu = showMenu([{ label: 'One', id: 'one' }, { label: 'Two', id: 'two' }], { x: 0, y: 0, focus: false, onPick: (m) => { picked.push(m.id!); } });
    expect(menuOpen()).toBe(true);
    const items = [...menu.querySelectorAll('button')] as HTMLElement[];
    for (const it of items) Object.defineProperty(it, 'offsetParent', { get: () => document.body });   // jsdom has no layout
    const down = press(shell, document.body, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]); expect(down.defaultPrevented).toBe(true);
    for (const k of ['Enter', ' ', 's', 'ArrowRight']) { const e = press(shell, items[0], k); expect(e.defaultPrevented).toBe(false); }
    expect(exec).not.toHaveBeenCalled();
    // Modified keys are still shortcuts while a menu is open.
    press(shell, items[0], 'F4', { altKey: true });
    expect(exec).toHaveBeenCalledWith('file.exit');
    press(shell, items[0], 'Escape');
    expect(menuOpen()).toBe(false);
  });
});

describe('Esc and Exit', () => {
  it('tells the Exit command that Esc ran it', () => {
    const { shell, exec } = fakeShell();
    press(shell, document.body, 'Escape');
    expect(exec).toHaveBeenCalledWith('file.exit', 'esc');
  });

  it('closes the desktop app with Esc only when the option is on; Exit from a menu always does', async () => {
    const exit = getCommand('file.exit')!;
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    on.desktop = true;
    try {
      const app: any = { prefs: { escExits: false }, tabs: [], exec: vi.fn() };
      await exit.run(app, 'esc'); expect(close).not.toHaveBeenCalled();
      app.prefs.escExits = true;
      await exit.run(app, 'esc'); expect(close).toHaveBeenCalledTimes(1);
      app.prefs.escExits = false;
      await exit.run(app); expect(close).toHaveBeenCalledTimes(2);
      // In full screen, Esc (and Exit) leave full screen first, whatever the option says.
      document.body.classList.add('ql-fullscreen');
      await exit.run(app, 'esc'); expect(app.exec).toHaveBeenCalledWith('view.fullScreen'); expect(close).toHaveBeenCalledTimes(2);
    } finally { document.body.classList.remove('ql-fullscreen'); on.desktop = false; close.mockRestore(); }
  });
});

describe('what a script may run on its own', () => {
  it('asks before commands that reach beyond the open picture and folder, once per command and argument', async () => {
    const { ScriptHost, scriptNeedsConsent } = await import('../../src/dev/scriptHost');
    // Changing the picture and moving in the folder is what scripts are for; the rest asks.
    for (const id of ['image.rotateRight', 'adjust.autoLevels', 'view.next', 'file.save', 'meta.keywords', 'edit.undo']) expect(scriptNeedsConsent(id), id).toBe(false);
    for (const id of ['view.shareView', 'tools.plugins', 'tools.external', 'file.openWith', 'file.deletePermanent', 'ai.generate', 'batch.convert', 'dev.macros', 'plugin:abc', 'file.options', 'file.openUrl', 'file.exit']) expect(scriptNeedsConsent(id), id).toBe(true);
    const ran: [string, unknown][] = [], asked: [string, unknown][] = []; let answer = false;
    const app: any = { exec: (id: string, arg: unknown) => { ran.push([id, arg]); return true; }, picture: null };
    const host: any = new ScriptHost(app, () => undefined, async (_label, id, arg) => { asked.push([id, arg]); return answer; });
    const exec = (id: string, arg?: unknown) => host.call('exec', [id, arg]).then(() => 'ran', (e: Error) => e.message);
    expect(await exec('file.save')).toBe('ran'); expect(asked).toEqual([]);
    // Refused: nothing runs, and the script is told why.
    expect(await exec('file.options', { quiet: true, url: 'https://elsewhere.example' })).toMatch(/was not allowed/);
    expect(ran).toEqual([['file.save', undefined]]);
    // Allowed: runs, and the same call does not ask again; another argument does.
    answer = true;
    expect(await exec('file.options', { quiet: true, url: 'https://elsewhere.example' })).toBe('ran');
    expect(await exec('file.options', { quiet: true, url: 'https://elsewhere.example' })).toBe('ran');
    expect(await exec('file.options', { quiet: true, url: 'https://another.example' })).toBe('ran');
    expect(asked.map((a) => (a[1] as any).url)).toEqual(['https://elsewhere.example', 'https://elsewhere.example', 'https://another.example']);
    expect(ran).toHaveLength(4);
    expect(await exec('no.such.command')).toMatch(/Unknown command/);
    expect(await exec('dev.console')).toMatch(/cannot open itself/);
  });
});

describe('the plus and minus keys', () => {
  it('"+" zooms in however it is typed; Shift with the numpad\'s + is Double Size; minus keys keep their names', async () => {
    const { keyName, canonicalKey, prettyKey } = await import('../../src/util/keys');
    const { PLAN_COMMANDS } = await import('../../src/plan.generated');
    const owner = (k: string) => Object.entries(PLAN_COMMANDS).find(([, c]) => c.keys.map(canonicalKey).includes(canonicalKey(k)))?.[0];
    const ev = (key: string, code: string, shiftKey = false, ctrlKey = false) => new KeyboardEvent('keydown', { key, code, shiftKey, ctrlKey });
    const cases: [KeyboardEvent, string, string | undefined][] = [
      [ev('+', 'Equal', true), '+', 'view.zoomIn'],              // US: Shift with the = key
      [ev('+', 'NumpadAdd'), '+', 'view.zoomIn'],                // the numpad
      [ev('+', 'BracketRight'), '+', 'view.zoomIn'],             // German: its own + key
      [ev('=', 'Equal'), '=', 'view.zoomIn'],
      [ev('+', 'NumpadAdd', true), 'Shift-+', 'image.doubleSize'],
      [ev('-', 'Minus'), '-', 'view.zoomOut'], [ev('-', 'NumpadSubtract'), '-', 'view.zoomOut'], [ev('-', 'Slash'), '-', 'view.zoomOut'],
      [ev('_', 'Minus', true), 'Shift--', 'image.halfSize'],
    ];
    for (const [e, name, cmd] of cases) { expect(keyName(e), `${e.key} ${e.code}`).toBe(name); expect(owner(name), name).toBe(cmd); }
    expect([canonicalKey('-'), canonicalKey('Shift--'), canonicalKey('Ctrl-Shift--'), canonicalKey('Mod-=')]).toEqual(['-', 'Shift--', 'Mod-Shift--', 'Mod-=']);
    expect(prettyKey('Shift--')).toMatch(/^(Shift\+-|⇧-)$/);
  });
});

describe('wheel input', () => {
  it('a notch is one step; a trackpad swipe with its inertia is one step; a pinch zooms by its size', async () => {
    const { WheelStepper, wheelZoomFactor } = await import('../../src/ui/wheel');
    const s = new WheelStepper();
    // Mouse notches (Chrome sends 100 px, Firefox 3 lines): each is a step, however fast they come.
    expect([s.step(100, 0, 0), s.step(100, 0, 10), s.step(-3, 1, 20), s.step(3, 1, 25)]).toEqual([1, 1, -1, 1]);
    // A trackpad swipe: 60 events of a few pixels over a second, with no pause longer than 16 ms. One step.
    let steps = 0; for (let i = 0; i < 60; i++) steps += Math.abs(s.step(4 + (i % 3), 0, 1000 + i * 16));
    expect(steps).toBe(1);
    // The next swipe after a pause is another step; a small accidental touch is none.
    expect([s.step(30, 0, 2500), s.step(40, 0, 2510)]).toEqual([0, 1]);
    expect(s.step(5, 0, 4000)).toBe(0);
    // Turning round mid-swipe starts the count again.
    const t = new WheelStepper(); expect([t.step(50, 0, 0), t.step(-50, 0, 10), t.step(-20, 0, 20)]).toEqual([0, 0, -1]);
    // Zoom: a notch is about 16 %; a pinch's tiny deltas zoom by tiny amounts, not 10 % each.
    expect(wheelZoomFactor(-100, 0)).toBeCloseTo(1.16, 2); expect(wheelZoomFactor(100, 0)).toBeCloseTo(1 / 1.16, 2);
    expect(wheelZoomFactor(-2, 0)).toBeCloseTo(1.003, 3);
    let z = 1; for (let i = 0; i < 50; i++) z *= wheelZoomFactor(-2, 0); expect(z).toBeLessThan(1.2);
  });
});

describe('removing a key from one command', () => {
  it('leaves it to the other commands that share it, and Reset Command gives it back', async () => {
    const { keyCommands, removeKey, resetCommand } = await import('../../src/util/keymap');
    const map: Record<string, string> = {}, defaults = ['view.next', 'show.pause'];
    removeKey(map, 'Space', 'view.next', true);
    expect(keyCommands('Space', defaults, map)).toEqual(['show.pause']);          // Pause keeps Space
    removeKey(map, 'Space', 'show.pause', true);
    expect(keyCommands('Space', defaults, map)).toEqual([]);
    resetCommand(map, 'view.next', ['Space']);
    expect(keyCommands('Space', defaults, map)).toEqual(['view.next']);
    resetCommand(map, 'show.pause', ['Space']); expect(map).toEqual({});
    // A key added to a command, then removed, is simply gone; a key another command was given stays theirs.
    map['Mod-k'] = 'view.next'; removeKey(map, 'Mod-k', 'view.next', false); expect(map).toEqual({});
    map['Space'] = 'file.save'; removeKey(map, 'Space', 'view.next', true);
    expect(keyCommands('Space', defaults, map)).toEqual(['file.save', 'view.next', 'show.pause']);
    // The older form of removal still takes the key from every command.
    expect(keyCommands('Space', defaults, { Space: '' })).toEqual([]);
  });
});

describe('dialogs are modal', () => {
  it('keep Tab inside, make the page behind inert, and ignore an Enter that ends an IME composition', async () => {
    const { openDialog } = await import('../../src/ui/dialog');
    const page = document.createElement('div'); page.id = 'app'; page.appendChild(document.createElement('button')); document.body.appendChild(page);
    let result: unknown = 'pending';
    const p = openDialog({ title: 'T', fields: [{ key: 'a', label: 'A', type: 'text', value: '' }] }).then((r) => { result = r; });
    const box = document.querySelector('.ql-dialog') as HTMLElement;
    for (const el of box.querySelectorAll<HTMLElement>('button, input')) Object.defineProperty(el, 'offsetParent', { get: () => document.body });
    expect(page.hasAttribute('inert')).toBe(true);
    const ctrls = [...box.querySelectorAll<HTMLElement>('button, input')];
    const tab = (shift = false) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));
    ctrls[ctrls.length - 1].focus(); tab(); expect(document.activeElement).toBe(ctrls[0]);           // past the last: the first
    tab(true); expect(document.activeElement).toBe(ctrls[ctrls.length - 1]);                          // before the first: the last
    const input = box.querySelector('input')!; input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    await Promise.resolve(); expect(result).toBe('pending');                                          // the composition's Enter
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await p;
    expect(result).toEqual({ a: '' }); expect(page.hasAttribute('inert')).toBe(false);
    page.remove();
  });
});
