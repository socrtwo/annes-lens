// Exposes `window.quillDesktop`: the same interface as the Android QuillNative plugin
// (see src/platform/native.ts), plus folder listing, Show in Folder, Open With, window placement and
// portable mode. Runs sandboxed.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (opts) => ipcRenderer.invoke('ql:' + name, opts);
const methods = ['openDocument', 'openFolder', 'listFolder', 'saveAs', 'writeUri', 'readUri', 'print', 'share', 'getLaunchFile', 'keepAwake', 'readClipboard', 'writeClipboard', 'openExternal', 'revealInFolder', 'openWith', 'setAlwaysOnTop', 'minimize', 'fitWindow', 'getArgs', 'getPortableMode', 'setPortableMode', 'relaunch',
  'renameDocument', 'deleteDocument', 'pickFolder', 'moveFile', 'copyFile', 'createInFolder', 'setFileTime', 'fetchUrl', 'pickProgram', 'openWithProgram', 'request', 'cancelRequest',
  'setWallpaper', 'showProperties', 'copyFileToClipboard', 'setAssociations', 'listScanners', 'scan', 'createSubfolder',
  'listSubfolders', 'parentFolder', 'rememberFolder', 'secretInfo', 'secretGet', 'secretSet', 'secretDelete', 'remoteStart', 'remoteStop', 'remoteState', 'shareStart', 'shareState', 'shareAlbum', 'shareStop', 'listDisplays', 'moveToDisplay', 'setFrameless', 'windowControl', 'cliJob', 'cliWrite', 'cliDone'];

const api = { platform: process.platform };
for (const m of methods) api[m] = call(m);
api.addListener = (event, cb) => {
  if (event !== 'fileOpened' && event !== 'remoteCommand' && event !== 'shareAdded') return Promise.reject(new Error('Unknown event'));
  const listener = (_e, data) => cb(data);
  ipcRenderer.on('ql:' + event, listener);
  if (event === 'fileOpened') ipcRenderer.send('ql:fileListenerReady');
  return Promise.resolve({ remove: () => ipcRenderer.removeListener('ql:' + event, listener) });
};

contextBridge.exposeInMainWorld('quillDesktop', api);
