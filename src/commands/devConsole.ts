/** Developer ▸ Script Console (JavaScript in a worker, src/dev/scriptHost.ts) and Command-Line Help. */
import { def } from './registry';
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import { h } from '../ui/dom';
import { isDesktop, writeClipboardText } from '../platform/native';
import { ScriptHost, type ScriptOutput } from '../dev/scriptHost';
import CLI_OPTIONS from '../../electron/cli-options.json';

const STORE = 'quilllens.console.v1';
const EXAMPLE = `// The current picture, inverted as one Undo step:
const p = await picture.pixels();
for (let i = 0; i < p.data.length; i += 4) { p.data[i] = 255 - p.data[i]; p.data[i + 1] = 255 - p.data[i + 1]; p.data[i + 2] = 255 - p.data[i + 2]; }
await picture.setPixels(p, 'Invert (script)');
return picture.info();`;
const HELP = 'Ctrl+Enter runs. app.exec(id, arg), app.commands(filter), app.toast(text); picture.info(), picture.pixels(), picture.setPixels({ width, height, data }, label); folder.list(), folder.current(), folder.go(index or name); print(…), sleep(ms). Every call returns a promise (use await); return shows a value; globalThis keeps values between runs. Scripts run in a worker, apart from the page: they reach the app and your files only through these calls. A command that goes beyond the open picture and folder (other programs, the network, AI services, other files, batch jobs, settings, plug-ins) asks you first.';

let session: { host: ScriptHost; log: HTMLElement } | null = null;

async function openConsole(app: App, code?: string): Promise<void> {
  const log = h('pre', { class: 'qn-console-out', 'aria-live': 'polite' });
  const add = (o: ScriptOutput) => { log.append(h('div', { class: `qn-console-${o.kind}` }, (o.kind === 'result' ? '← ' : o.kind === 'error' ? '✖ ' : '') + o.text)); log.scrollTop = log.scrollHeight; };
  const host = new ScriptHost(app, add);
  let saved = ''; try { saved = localStorage.getItem(STORE) || ''; } catch { /* storage off */ }
  const input = h('textarea', { class: 'qn-console-in', rows: '9', spellcheck: 'false', 'aria-label': 'Script' }) as HTMLTextAreaElement;
  input.value = code ?? (saved || EXAMPLE);
  const run = async () => {
    const src = input.value; if (!src.trim()) return;
    try { localStorage.setItem(STORE, src); } catch { /* */ }
    add({ kind: 'info', text: `› ${src.split('\n')[0].slice(0, 80)}${src.includes('\n') ? ' …' : ''}` });
    await host.run(src);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(); } e.stopPropagation(); });
  session = { host, log };
  await openDialog({
    title: 'Script Console', wide: true, ok: false, cancel: 'Close', help: HELP,
    content: h('div', { class: 'qn-console' }, log, input),
    buttons: [
      { label: 'Run', primary: true, onClick: () => void run() },
      { label: 'Stop', onClick: () => host.stop() },
      { label: 'Clear', onClick: () => log.replaceChildren() },
      { label: 'Example', onClick: () => { input.value = EXAMPLE; input.focus(); } },
    ],
    onOpen: () => setTimeout(() => input.focus(), 50),
  });
  host.dispose(); session = null;
}

/** The command-line options as text (the same list `annes-lens --help` prints). */
export function cliHelpText(): string {
  const opts = CLI_OPTIONS as { name: string; short?: string; value?: string; group: string; text: string }[];
  const lines = ['Usage: annes-lens [options] [pictures or folders]', ''];
  for (const g of ['View', 'Convert', 'Other']) {
    lines.push(`${g}:`);
    for (const x of opts.filter((y) => y.group === g)) lines.push(`  ${x.short ? `-${x.short}, ` : ''}--${x.name}${x.value ? `=${x.value}` : ''}`, `      ${x.text}`);
    lines.push('');
  }
  lines.push('Examples:', '  annes-lens --slideshow ~/Pictures/Trip', '  annes-lens --convert="web/*.jpg" --long=1600 --quality=85 --strip ~/Pictures/Trip', '  annes-lens --convert="*.png" --rotate=exif scan1.tif scan2.tif', '', 'Exit status: 0 when every picture was written, 1 when some failed, 2 for a usage error.');
  return lines.join('\n');
}

def([
  { id: 'dev.console', icon: 'terminal', noRecord: true, tip: 'Run JavaScript against the picture and folder (in an isolated worker)', run: (app, code?: string) => (session ? undefined : openConsole(app, typeof code === 'string' ? code : undefined)) },
  {
    id: 'dev.cliHelp', icon: 'data_object', noRecord: true, tip: 'The desktop app\'s command-line options: open full screen or as a slideshow, or convert, resize and rotate without a window',
    run: async () => {
      const text = cliHelpText();
      await openDialog({ title: 'Command-Line Help', wide: true, ok: false, cancel: 'Close', help: isDesktop() ? 'Run these from a terminal with the program\'s path (on Windows, Anne\'s Lens.exe; on macOS, the binary inside the .app).' : 'These options are for the desktop app (Windows, macOS, Linux); the browser and the phone apps have no command line.', content: h('pre', { class: 'qn-console-out qn-cli-help' }, text), buttons: [{ label: 'Copy', onClick: () => void writeClipboardText(text).then(() => toast('Copied the options.')) }] });
    },
  },
]);
