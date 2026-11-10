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
