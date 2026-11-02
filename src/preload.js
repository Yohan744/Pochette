'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('pochette', {
  getSettings: () => call('settings:get'),
  setSettings: (patch) => call('settings:set', patch),
  openDialog: (mode) => call('dialog:open', mode),
  pickImage: () => call('dialog:image'),
  load: (paths) => call('files:load', paths),
  save: (items) => call('files:save', items),
  convert: (paths) => call('files:convert', paths),
  finderIcons: (paths) => call('files:finderIcons', paths),
  importCover: (source) => call('cover:import', source),
  keepCovers: (ids) => call('cover:keepOnly', ids),
  clipboardCover: () => call('cover:clipboard'),
  coverPreview: (q) => call('cover:preview', q),
  reveal: (p) => call('shell:reveal', p),
  openUrl: (url) => call('shell:open', url),
  audioUrl: (p) => `pochette://audio/?p=${encodeURIComponent(p)}`,
  pathForFile: (file) => webUtils.getPathForFile(file),
  confirm: (opts) => ipcRenderer.sendSync('confirm', opts),
  closeWindow: () => ipcRenderer.send('window:close'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onOpenPaths: (cb) => ipcRenderer.on('open-paths', (_e, p) => cb(p)),
});
