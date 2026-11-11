// PowerShell and AppleScript command lines for the main process. The text of every script is fixed: file names,
// device names and numbers travel beside the script (environment variables for PowerShell, arguments for AppleScript)
// and never inside it, so nothing in a name can end a string and start a command. (Escaping the quote characters
// was not enough: PowerShell also closes a single-quoted string at the typographic quotes U+2018 to U+201B, and
// AppleScript strings need their backslashes escaped too.)
'use strict';

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
/** A PowerShell call: `script` reads its values as $env:QN_<NAME>. Returns { cmd, args, env } (env: only the added variables). */
function powershell(script, vars = {}, extra = []) {
  const env = {};
  for (const [k, v] of Object.entries(vars)) env[`QN_${k.toUpperCase()}`] = String(v);
  return { cmd: 'powershell.exe', args: [...PS, ...extra, '-Command', script], env };
}
/** An AppleScript call: `lines` are the body of `on run argv`; the values are `item 1 of argv`, `item 2 of argv`, … */
function applescript(lines, argv = []) {
  return { cmd: 'osascript', args: ['-e', ['on run argv', ...lines, 'end run'].join('\n'), ...argv.map(String)], env: {} };
}

const SCRIPTS = {
  wallpaperWin: "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class W { [DllImport(\"user32.dll\", SetLastError = true)] public static extern bool SystemParametersInfo(int a, int b, string c, int d); }'; [W]::SystemParametersInfo(20, 0, $env:QN_FILE, 3)",
  propertiesWin: "$s = New-Object -ComObject Shell.Application; $f = $s.Namespace($env:QN_DIR).ParseName($env:QN_NAME); $f.InvokeVerb('Properties'); Start-Sleep -Seconds 900",
  scanWin: "$m = New-Object -ComObject WIA.DeviceManager; $info = $null; foreach ($d in $m.DeviceInfos) { if ($d.Type -eq 1 -and ([string]::IsNullOrEmpty($env:QN_DEVICE) -or ($d.DeviceID -eq $env:QN_DEVICE))) { $info = $d; break } }; if ($info -eq $null) { throw 'No scanner' }; $dev = $info.Connect(); $item = $dev.Items.Item(1); foreach ($p in $item.Properties) { if ($p.PropertyID -eq 6146) { $p.Value = [int]$env:QN_MODE }; if ($p.PropertyID -eq 6147 -or $p.PropertyID -eq 6148) { $p.Value = [int]$env:QN_RES } }; $img = $item.Transfer('{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'); $img.SaveFile($env:QN_FILE)",
  wallpaperMac: ['tell application "System Events" to set picture of every desktop to POSIX file (item 1 of argv)'],
  propertiesMac: ['tell application "Finder" to open information window of (POSIX file (item 1 of argv) as alias)', 'tell application "Finder" to activate'],
};

const setWallpaperWin = (file) => powershell(SCRIPTS.wallpaperWin, { file });
const showPropertiesWin = (dir, name) => powershell(SCRIPTS.propertiesWin, { dir, name }, ['-WindowStyle', 'Hidden']);
const scanWin = (device, gray, res, file) => powershell(SCRIPTS.scanWin, { device: device || '', mode: gray ? 2 : 1, res: Math.round(Number(res)) || 300, file });
const setWallpaperMac = (file) => applescript(SCRIPTS.wallpaperMac, [file]);
const showPropertiesMac = (file) => applescript(SCRIPTS.propertiesMac, [file]);

module.exports = { powershell, applescript, SCRIPTS, setWallpaperWin, showPropertiesWin, scanWin, setWallpaperMac, showPropertiesMac };
