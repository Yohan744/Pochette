'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, shell, clipboard, net, protocol } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const core = require('./core');
const i18n = require('./i18n');

const { t } = i18n;
const { toAiff } = require('./convert');
const { previewSource } = require('./core/preview');
const { composeIcon, SIZE: ICON_SIZE, BOX: ICON_BOX } = require('./core/icon');

const isMac = process.platform === 'darwin';
let win;

// pochette://audio/?p=<path> streams a track to the preview player (must be declared before app is ready)
protocol.registerSchemesAsPrivileged([{ scheme: 'pochette', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

// ------------------------------------------------------------------ settings

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = { lang: 'en', finderIcon: true, afterConvert: 'keep', coverSize: 1000 };
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { ...DEFAULT_SETTINGS }; }
}
let settings;

// ------------------------------------------------------------------ covers

/** Covers waiting to be saved (normalized to JPEG), keyed by id. */
const coverStore = new Map();
let coverSeq = 0;

function thumbOf(buf, size = 72) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const r = width >= height ? { height: size } : { width: size };
  return 'data:image/jpeg;base64,' + img.resize({ ...r, quality: 'good' }).toJPEG(78).toString('base64');
}

function previewOf(buf, size = 640) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  const { width } = img.getSize();
  const out = width > size ? img.resize({ width: size, quality: 'best' }) : img;
  return 'data:image/jpeg;base64,' + out.toJPEG(88).toString('base64');
}

/**
 * Normalizes an image for maximum compatibility (CDJs, rekordbox, Serato…):
 * baseline JPEG, RGB, configurable max side (1000 px by default), a few hundred KB.
 */
function normalizeCover(img) {
  if (!img || img.isEmpty()) throw new Error(t('err.badImage'));
  const max = settings.coverSize || 1000;
  const { width, height } = img.getSize();
  let out = img;
  if (Math.max(width, height) > max) {
    out = width >= height ? img.resize({ width: max, quality: 'best' }) : img.resize({ height: max, quality: 'best' });
  }
  const data = out.toJPEG(90);
  const size = out.getSize();
  const id = `c${++coverSeq}`;
  coverStore.set(id, data);
  return { coverId: id, thumb: thumbOf(data), preview: previewOf(data), width: size.width, height: size.height, bytes: data.length, mime: 'image/jpeg' };
}

async function imageFromSource({ path: p, url, bytes }) {
  if (bytes) return nativeImage.createFromBuffer(Buffer.from(bytes));
  if (p) return nativeImage.createFromPath(p);
  if (url) {
    if (url.startsWith('data:')) return nativeImage.createFromDataURL(url);
    const res = await net.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Pochette' } });
    if (!res.ok) throw new Error(t('err.download', res.status));
    return nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
  }
  throw new Error(t('err.noImage'));
}

// ------------------------------------------------------------------ files

function scan(paths) {
  const out = [];
  const seen = new Set();
  const walk = (p, depth) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth > 8) return;
      let entries = [];
      try { entries = fs.readdirSync(p); } catch { return; }
      entries.sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
      for (const e of entries) if (!e.startsWith('.')) walk(path.join(p, e), depth + 1);
    } else if (core.EXTENSIONS.has(path.extname(p).toLowerCase()) && !path.basename(p).startsWith('._')) {
      if (!seen.has(p)) { seen.add(p); out.push(p); }
    }
  };
  for (const p of paths) walk(p, 0);
  return out;
}

function describe(p) {
  const ext = path.extname(p);
  const st = fs.statSync(p);
  const base = { path: p, dir: path.dirname(p), name: path.basename(p, ext), ext, size: st.size };
  try {
    const r = core.read(p);
    let cover = null;
    if (r.cover) {
      const dims = require('./core/util').imageSize(r.cover.data) || {};
      cover = { thumb: thumbOf(r.cover.data), width: dims.width || 0, height: dims.height || 0, bytes: r.cover.data.length, mime: r.cover.mime };
    }
    return { ...base, format: r.format, tags: r.tags, cover, audio: r.audio };
  } catch (e) {
    return { ...base, format: ext.slice(1).toLowerCase(), error: e.message, tags: Object.fromEntries(core.FIELDS.map((f) => [f, ''])), cover: null, audio: {} };
  }
}

function safeName(s) {
  return s.replace(/[/:]/g, '-').replace(/^\.+/, '').replace(/\s+$/g, '').slice(0, 240);
}

// ------------------------------------------------------------------ Finder icons (macOS)

/**
 * Turns a cover into a macOS-style icon (margin, rounded corners, shadow).
 * Set raw, a square image fills the whole icon frame and looks bigger than other icons.
 */
function iconPng(cover) {
  let img = nativeImage.createFromBuffer(cover);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  if (width !== height) img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  img = img.resize({ width: ICON_BOX, height: ICON_BOX, quality: 'best' });
  const bmp = img.toBitmap({ scaleFactor: 1 });
  if (bmp.length !== ICON_BOX * ICON_BOX * 4) return cover;
  return nativeImage.createFromBitmap(composeIcon(bmp), { width: ICON_SIZE, height: ICON_SIZE, scaleFactor: 1 }).toPNG();
}

/**
 * Finder never shows a WAV's embedded cover, so the cover is set as the file's custom icon
 * (like pasting an image in “Get Info”).
 */
function setFinderIcons(jobs) {
  if (!isMac || !jobs.length) return Promise.resolve();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pochette-'));
  const list = jobs.map((j, i) => {
    if (!j.image) return { file: j.file, image: null };
    let data;
    try { data = iconPng(j.image); } catch { data = j.image; }
    if (!data) return { file: j.file, image: null };
    const img = path.join(tmp, `${i}.png`);
    fs.writeFileSync(img, data);
    return { file: j.file, image: img };
  });
  const jobFile = path.join(tmp, 'jobs.json');
  fs.writeFileSync(jobFile, JSON.stringify(list));
  const script = `
    ObjC.import('AppKit');
    function run(argv) {
      const raw = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js;
      const jobs = JSON.parse(raw);
      const ws = $.NSWorkspace.sharedWorkspace;
      jobs.forEach(j => {
        const img = j.image ? $.NSImage.alloc.initWithContentsOfFile(j.image) : null;
        ws.setIconForFileOptions(img, j.file, 0);
      });
    }`;
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, jobFile], () => {
      fs.rm(tmp, { recursive: true, force: true }, () => {});
      resolve();
    });
  });
}

// ------------------------------------------------------------------ IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}

handle('settings:get', () => settings);
handle('settings:set', (patch) => {
  settings = { ...settings, ...patch };
  if (patch.lang) { i18n.setLang(settings.lang); buildMenu(); }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  return settings;
});

handle('dialog:open', async (mode) => {
  const r = await dialog.showOpenDialog(win, {
    properties: mode === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    filters: mode === 'folder' ? [] : [{ name: t('dialog.audio'), extensions: ['wav', 'wave', 'aif', 'aiff', 'aifc', 'mp3', 'flac'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

handle('dialog:image', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: t('dialog.images'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'tif', 'tiff', 'gif', 'bmp'] }] });
  return r.canceled ? null : r.filePaths[0];
});

handle('files:load', async (paths) => {
  const files = scan(paths);
  const tracks = [];
  for (let i = 0; i < files.length; i++) {
    tracks.push(describe(files[i]));
    if (i % 20 === 0) win?.webContents.send('progress', { label: t('progress.reading'), done: i, total: files.length });
    if (i % 50 === 0) await new Promise((r) => setImmediate(r));
  }
  win?.webContents.send('progress', null);
  return tracks;
});

handle('cover:import', async (source) => normalizeCover(await imageFromSource(source)));

/** Frees the covers nothing refers to any more (not on a track, not in the undo history). */
handle('cover:keepOnly', (ids) => {
  const keep = new Set(ids);
  for (const id of [...coverStore.keys()]) if (!keep.has(id)) coverStore.delete(id);
  return coverStore.size;
});

handle('cover:clipboard', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) throw new Error(t('err.clipboard'));
  return normalizeCover(img);
});

handle('cover:preview', ({ path: p, coverId }) => {
  if (coverId) return previewOf(coverStore.get(coverId));
  const r = core.read(p);
  return r.cover ? previewOf(r.cover.data) : null;
});

/**
 * items : [{ path, tags, cover: 'keep' | 'remove' | coverId, name }]
 * → [{ ok, track | error }]
 */
handle('files:save', async (items) => {
  const results = [];
  const icons = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    win?.webContents.send('progress', { label: t('progress.saving'), done: i, total: items.length });
    await new Promise((r) => setImmediate(r));
    try {
      let cover;
      if (it.cover === 'remove') cover = null;
      else if (it.cover && it.cover !== 'keep') {
        const data = coverStore.get(it.cover);
        if (!data) throw new Error(t('err.coverExpired'));
        cover = { data, mime: 'image/jpeg' };
      }
      core.write(it.path, { tags: it.tags, cover });

      let finalPath = it.path;
      const ext = path.extname(it.path);
      if (it.name != null && safeName(it.name) && safeName(it.name) !== path.basename(it.path, ext)) {
        const target = path.join(path.dirname(it.path), safeName(it.name) + ext);
        if (target.toLowerCase() !== it.path.toLowerCase() && fs.existsSync(target)) throw new Error(t('err.exists', `“${path.basename(target)}”`));
        fs.renameSync(it.path, target);
        finalPath = target;
      }
      if (settings.finderIcon && cover !== undefined) icons.push({ file: finalPath, image: cover ? cover.data : null });
      results.push({ ok: true, track: describe(finalPath) });
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
  }
  win?.webContents.send('progress', null);
  await setFinderIcons(icons);
  return results;
});

handle('files:finderIcons', async (paths) => {
  const jobs = paths.map((p) => {
    try { const r = core.read(p); return { file: p, image: r.cover ? r.cover.data : null }; } catch { return null; }
  }).filter(Boolean);
  await setFinderIcons(jobs);
  return jobs.filter((j) => j.image).length;
});

handle('files:convert', async (paths) => {
  const results = [];
  const icons = [];
  for (let i = 0; i < paths.length; i++) {
    win?.webContents.send('progress', { label: t('progress.converting'), done: i, total: paths.length });
    await new Promise((r) => setImmediate(r));
    try {
      const r = core.read(paths[i]);
      const out = await toAiff(paths[i]);
      const st = fs.statSync(paths[i]);
      fs.utimesSync(out, st.atime, st.mtime);
      if (settings.finderIcon && r.cover) icons.push({ file: out, image: r.cover.data });
      if (settings.afterConvert === 'trash') await shell.trashItem(paths[i]);
      results.push({ ok: true, from: paths[i], track: describe(out), trashed: settings.afterConvert === 'trash' });
    } catch (e) {
      results.push({ ok: false, from: paths[i], error: e.message });
    }
  }
  win?.webContents.send('progress', null);
  await setFinderIcons(icons);
  return results;
});

handle('shell:reveal', (p) => shell.showItemInFolder(p));
handle('shell:open', (url) => {
  if (!/^https:\/\//.test(url)) throw new Error(t('err.url'));
  return shell.openExternal(url);
});

// ------------------------------------------------------------------ menu

function send(cmd) { win?.webContents.send('menu', cmd); }

function buildMenu() {
  const item = (key, cmd, accelerator, extra = {}) => ({ label: t(key), accelerator, click: () => send(cmd), ...extra });
  const role = (r, key) => ({ role: r, label: t(key) });
  const sep = { type: 'separator' };
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [role('about', 'menu.about'), sep, item('menu.settings', 'settings', 'CmdOrCtrl+,'), sep, role('hide', 'menu.hide'), role('hideOthers', 'menu.hideOthers'), sep, role('quit', 'menu.quit')] }] : []),
    { label: t('menu.file'), submenu: [item('menu.openFiles', 'openFiles', 'CmdOrCtrl+O'), item('menu.openFolder', 'openFolder', 'CmdOrCtrl+Shift+O'), sep, item('menu.save', 'save', 'CmdOrCtrl+S'), item('menu.revert', 'revert'), sep, item('menu.clearList', 'clearList', 'CmdOrCtrl+Shift+K'), item('menu.reveal', 'reveal', 'CmdOrCtrl+Shift+R'), item('menu.removeFromList', 'removeFromList', 'CmdOrCtrl+Backspace', { registerAccelerator: false }), sep, role('close', 'menu.close')] },
    { label: t('menu.edit'), submenu: [item('menu.undo', 'undo', 'CmdOrCtrl+Z'), item('menu.redo', 'redo', 'CmdOrCtrl+Shift+Z'), sep, role('cut', 'menu.cut'), role('copy', 'menu.copy'), role('paste', 'menu.paste'), item('menu.selectAll', 'selectAll', 'CmdOrCtrl+A'), sep, item('menu.find', 'find', 'CmdOrCtrl+F')] },
    { label: t('menu.tags'), submenu: [item('menu.titleFromName', 'titleFromName', 'CmdOrCtrl+T'), item('menu.clean', 'clean', 'CmdOrCtrl+Shift+L'), item('menu.nameFromTitle', 'nameFromTitle', 'CmdOrCtrl+Shift+T'), item('menu.copyColumn', 'copyColumn', 'CmdOrCtrl+Shift+C'), sep, item('menu.pickCover', 'pickCover', 'CmdOrCtrl+I'), item('menu.pasteCover', 'pasteCover', 'CmdOrCtrl+Shift+V'), item('menu.searchCover', 'searchCover', 'CmdOrCtrl+Shift+F'), item('menu.removeCover', 'removeCover'), sep, item('menu.convert', 'convert', 'CmdOrCtrl+Shift+A'), item('menu.finderIcons', 'finderIcons')] },
    // Reload / DevTools only while developing: a reload would silently drop unsaved edits
    { label: t('menu.view'), submenu: [...(app.isPackaged ? [] : [role('reload', 'menu.reload'), role('toggleDevTools', 'menu.devtools'), sep]), role('togglefullscreen', 'menu.fullscreen')] },
    { role: 'windowMenu', label: t('menu.window') },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ window

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 980,
    minHeight: 560,
    title: 'Pochette',
    backgroundColor: '#141416',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // prevent navigation when a file is dropped outside the drop zones
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    if (win.__forceClose) return;
    e.preventDefault();
    win.webContents.send('menu', 'requestClose');
  });
  win.on('closed', () => { win = null; });
}

ipcMain.on('window:close', () => { if (win) { win.__forceClose = true; win.close(); } });
ipcMain.on('confirm', (e, { message, detail, buttons }) => {
  e.returnValue = dialog.showMessageBoxSync(win, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
});

const pendingOpen = [];
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win) win.webContents.send('open-paths', [p]); else pendingOpen.push(p);
});

// ------------------------------------------------------------------ preview player stream (byte ranges, so seeking works)

const AUDIO_EXT = new Set(['.wav', '.wave', '.aif', '.aiff', '.aifc', '.mp3', '.flac']);
const CHUNK = 256 * 1024;

function handleAudio(request) {
  const url = new URL(request.url);
  const p = url.searchParams.get('p');
  if (url.host !== 'audio' || !p || !AUDIO_EXT.has(path.extname(p).toLowerCase()) || !fs.existsSync(p)) return new Response('Not found', { status: 404 });
  let src;
  try { src = previewSource(p); } catch (e) { return new Response(e.message, { status: 415 }); }
  let start = 0;
  let end = src.size - 1;
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('Range') || '');
  if (m) {
    if (m[1]) start = +m[1];
    if (m[2]) end = Math.min(+m[2], end);
    if (!m[1] && m[2]) { start = Math.max(0, src.size - +m[2]); end = src.size - 1; }
    if (start > end || start >= src.size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${src.size}` } });
  }
  let pos = start;
  const body = new ReadableStream({
    pull(ctrl) {
      if (pos > end) { ctrl.close(); return; }
      const to = Math.min(end, pos + CHUNK - 1);
      try { ctrl.enqueue(new Uint8Array(src.read(pos, to))); } catch (e) { ctrl.error(e); return; }
      pos = to + 1;
    },
  });
  const headers = { 'Content-Type': src.mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (m) headers['Content-Range'] = `bytes ${start}-${end}/${src.size}`;
  return new Response(body, { status: m ? 206 : 200, headers });
}

app.whenReady().then(() => {
  protocol.handle('pochette', handleAudio);
  settings = loadSettings();
  i18n.setLang(settings.lang);
  buildMenu();
  createWindow();
  if (pendingOpen.length) win.webContents.once('did-finish-load', () => win.webContents.send('open-paths', pendingOpen.splice(0)));
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
