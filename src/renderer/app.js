'use strict';

/* global hydrateIcons, icon, I18N */

const api = window.pochette;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = I18N.t; // translation (`t` often means a track in this file)
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const ROW = 34;
const FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'track', 'bpm', 'key', 'label', 'comment'];
const L = (k) => T(`col.${k}`); // label of a column / field
const SHORT = new Set(['key', 'track', 'albumArtist']); // short label in the header
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif|tiff?|bmp|avif)$/i;

const COLUMNS = [
  { key: 'cover', w: 46, fixed: true },
  { key: 'name', w: 270, edit: true },
  { key: 'title', w: 260, edit: true },
  { key: 'artist', w: 180, edit: true },
  { key: 'album', w: 170, edit: true },
  { key: 'albumArtist', w: 160, edit: true, hidden: true },
  { key: 'genre', w: 130, edit: true },
  { key: 'year', w: 64, edit: true, num: true },
  { key: 'label', w: 120, edit: true },
  { key: 'bpm', w: 60, edit: true, num: true },
  { key: 'key', w: 58, edit: true },
  { key: 'track', w: 50, edit: true, num: true, hidden: true },
  { key: 'comment', w: 220, edit: true, hidden: true },
  { key: 'format', w: 72 },
];
const COL = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
try {
  const saved = JSON.parse(localStorage.getItem('pochette.cols') || '{}');
  for (const [k, v] of Object.entries(saved)) if (COL[k]) Object.assign(COL[k], v);
} catch { /* unreadable column settings: use defaults */ }
const saveCols = () => {
  try { localStorage.setItem('pochette.cols', JSON.stringify(Object.fromEntries(COLUMNS.map((c) => [c.key, { w: c.w, hidden: !!c.hidden }])))); } catch { /* storage unavailable */ }
};
const visibleCols = () => COLUMNS.filter((c) => !c.hidden);

const S = {
  tracks: [],
  byId: new Map(),
  view: [],
  sel: new Set(),
  anchor: null,
  cursor: null,
  activeCol: 'title',
  sort: null,
  filter: { text: '', noCover: false, mismatch: false, dirty: false },
  undo: [],
  redo: [],
  settings: { lang: 'en', finderIcon: true, afterConvert: 'keep', coverSize: 1000 },
  previews: new Map(),
  progress: null,
};
let seq = 0;

// ================================================================== model

function makeTrack(d) {
  const t = { id: ++seq };
  return fillTrack(t, d);
}
function fillTrack(t, d) {
  Object.assign(t, d, { tags: { ...d.tags }, orig: { name: d.name, tags: { ...d.tags }, cover: d.cover }, coverAction: 'keep' });
  return t;
}
const get = (t, k) => (k === 'name' ? t.name : k === 'format' ? t.format : t.tags[k] ?? '');
const origGet = (t, k) => (k === 'name' ? t.orig.name : t.orig.tags[k] ?? '');
const isMod = (t, k) => (k === 'cover' ? t.coverAction !== 'keep' : get(t, k) !== origGet(t, k));
const isDirty = (t) => t.coverAction !== 'keep' || t.name !== t.orig.name || FIELDS.some((f) => (t.tags[f] ?? '') !== (t.orig.tags[f] ?? ''));
const mismatch = (t) => (t.tags.title || '').normalize('NFC').trim() !== t.name.normalize('NFC').trim();
const sanitizeName = (s) => s.replace(/[/:]/g, '-').replace(/^\.+/, '').trim();

function setVal(t, k, v) {
  if (k === 'name') {
    const n = sanitizeName(v);
    if (n) t.name = n;
  } else if (k !== 'format' && k !== 'cover') t.tags[k] = v;
}

/** Selected tracks, in display order. */
function targets() {
  const inView = S.view.filter((t) => S.sel.has(t.id));
  if (inView.length === S.sel.size) return inView;
  // selected tracks hidden by a filter (e.g. “Title ≠ name” right after ⌘T): keep them
  const shown = new Set(inView);
  return [...inView, ...S.tracks.filter((t) => S.sel.has(t.id) && !shown.has(t))];
}

// ================================================================== undo / redo

const snap = (t) => ({ name: t.name, tags: { ...t.tags }, cover: t.cover, coverAction: t.coverAction });
const sameSnap = (a, b) => a.name === b.name && a.coverAction === b.coverAction && a.cover === b.cover && FIELDS.every((f) => (a.tags[f] ?? '') === (b.tags[f] ?? ''));
function restore(t, s) { t.name = s.name; t.tags = { ...s.tags }; t.cover = s.cover; t.coverAction = s.coverAction; }

/**
 * Applies a change to several tracks, with undo.
 * `coalesce` merges continuous typing (in the inspector) into a single undo step.
 */
function mutate(label, tracks, fn, { coalesce = null, skipInspector = false } = {}) {
  const before = tracks.map((t) => [t, snap(t)]);
  tracks.forEach(fn);
  const changed = before.filter(([t, b]) => !sameSnap(snap(t), b));
  if (changed.length) {
    const top = S.undo[S.undo.length - 1];
    if (coalesce && top && top.coalesce === coalesce) {
      for (const [t, b] of changed) if (!top.items.some(([x]) => x === t)) top.items.push([t, b]);
    } else {
      S.undo.push({ label, coalesce, items: changed });
      if (S.undo.length > 200) S.undo.shift();
    }
    S.redo = [];
  }
  refresh({ skipInspector });
  return changed.length;
}

function undo() {
  const step = S.undo.pop();
  if (!step) return toast(T('undo.nothing'));
  const redoItems = step.items.map(([t]) => [t, snap(t)]);
  step.items.forEach(([t, b]) => restore(t, b));
  S.redo.push({ label: step.label, items: redoItems });
  refresh();
  toast(T('undo.done', step.label));
}
function redo() {
  const step = S.redo.pop();
  if (!step) return;
  const undoItems = step.items.map(([t]) => [t, snap(t)]);
  step.items.forEach(([t, b]) => restore(t, b));
  S.undo.push({ label: step.label, items: undoItems });
  refresh();
  toast(T('redo.done', step.label));
}

// ================================================================== view (filters + sort)

function computeView() {
  const { text, noCover, mismatch: mm, dirty } = S.filter;
  const q = fold(text.trim());
  let v = S.tracks.filter((t) => {
    if (noCover && t.cover) return false;
    if (mm && !mismatch(t)) return false;
    if (dirty && !isDirty(t)) return false;
    if (q) {
      const hay = fold([t.name, t.tags.title, t.tags.artist, t.tags.album, t.tags.genre, t.tags.label, t.tags.key, t.format].join(' '));
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  if (S.sort) {
    const { key, dir } = S.sort;
    const num = COL[key]?.num;
    const val = (t) => (key === 'cover' ? (t.cover ? 1 : 0) : get(t, key));
    v = v.slice().sort((a, b) => {
      const x = val(a); const y = val(b);
      let r;
      if (key === 'cover') r = x - y;
      else if (num) r = (parseFloat(x) || 0) - (parseFloat(y) || 0);
      else r = String(x).localeCompare(String(y), I18N.getLang(), { numeric: true, sensitivity: 'base' });
      return r * dir;
    });
  }
  S.view = v;
}

// ================================================================== render: table

const tbody = $('#tbody');
const tinner = $('#tbody-inner');
const thead = $('#thead');

function layoutVars() {
  const cols = visibleCols();
  const tpl = cols.map((c) => `${c.w}px`).join(' ') + ' minmax(0, 1fr)';
  const wrap = $('#table-wrap');
  wrap.style.setProperty('--tpl', tpl);
  tinner.style.minWidth = cols.reduce((n, c) => n + c.w, 0) + 'px';
  thead.style.minWidth = '100%';
}

function renderHeader() {
  layoutVars();
  thead.innerHTML = visibleCols().map((c) => {
    const active = c.key === S.activeCol;
    const sort = S.sort && S.sort.key === c.key ? `<span class="sort">${S.sort.dir > 0 ? '▲' : '▼'}</span>` : '';
    const label = c.key === 'cover' ? '' : (SHORT.has(c.key) ? T(`short.${c.key}`) : L(c.key));
    return `<div class="th ${c.num ? 'num' : ''} ${active ? 'active' : ''}" data-col="${c.key}" title="${c.key === 'cover' ? T('th.coverTip') : T('th.tip')}">${c.num ? sort : ''}<span>${esc(label)}</span>${c.num ? '' : sort}${c.fixed ? '' : `<span class="grip" data-grip="${c.key}"></span>`}</div>`;
  }).join('') + '<div class="th filler"></div>';
  thead.scrollLeft = tbody.scrollLeft;
}

function rowHtml(t, i) {
  const sel = S.sel.has(t.id);
  const cls = ['row', sel && 'sel', sel && S.cursor === t.id && 'cursor', t.error && 'err'].filter(Boolean).join(' ');
  let cells = '';
  for (const c of visibleCols()) {
    const k = c.key;
    const ac = k === S.activeCol ? ' active-col' : '';
    if (k === 'cover') {
      const img = t.cover && t.cover.thumb ? `<img class="thumb" src="${t.cover.thumb}" alt="">` : '<span class="thumb none"></span>';
      cells += `<div class="cell c-cover" data-col="cover"><span class="thumb-wrap ${t.coverAction !== 'keep' ? 'new' : ''}">${img}</span></div>`;
    } else if (k === 'format') {
      cells += `<div class="cell c-format${ac}" data-col="format"><span class="${esc(t.format)}">${esc((t.format || '').toUpperCase())}</span></div>`;
    } else {
      const v = get(t, k);
      const mod = isMod(t, k) ? ' mod' : '';
      const mm = k === 'title' && v && mismatch(t) ? ' mismatch' : '';
      const dot = k === 'name' && isDirty(t) ? '<i class="dirty-dot"></i>' : '';
      const title = k === 'title' && mm ? ` title="${esc(T('cell.mismatch'))}"` : t.error && k === 'name' ? ` title="${esc(t.error)}"` : '';
      cells += `<div class="cell c-${k}${c.num ? ' num' : ''}${mod}${mm}${ac}${v ? '' : ' empty-val'}" data-col="${k}"${title}>${dot}<span>${esc(v)}</span></div>`;
    }
  }
  return `<div class="${cls}" data-id="${t.id}" style="top:${i * ROW}px">${cells}<div class="cell"></div></div>`;
}

function renderRows() {
  tinner.style.height = S.view.length * ROW + 'px';
  const top = tbody.scrollTop;
  const h = tbody.clientHeight || 800;
  const start = Math.max(0, Math.floor(top / ROW) - 10);
  const end = Math.min(S.view.length, Math.ceil((top + h) / ROW) + 10);
  let html = '';
  for (let i = start; i < end; i++) html += rowHtml(S.view[i], i);
  tinner.innerHTML = html;
  $('#empty').classList.toggle('show', S.tracks.length === 0);
  $('#no-results').classList.toggle('show', S.tracks.length > 0 && S.view.length === 0);
}

function ensureVisible(idx) {
  const top = idx * ROW;
  if (top < tbody.scrollTop) tbody.scrollTop = top;
  else if (top + ROW > tbody.scrollTop + tbody.clientHeight) tbody.scrollTop = top + ROW - tbody.clientHeight;
}

tbody.addEventListener('scroll', () => {
  thead.scrollLeft = tbody.scrollLeft;
  requestAnimationFrame(renderRows);
});
window.addEventListener('resize', () => requestAnimationFrame(renderRows));

// ================================================================== render: status, counters

function renderStatus() {
  const dirty = S.tracks.filter(isDirty).length;
  const noCover = S.tracks.filter((t) => !t.cover).length;
  const mm = S.tracks.filter(mismatch).length;
  $('[data-count="noCover"]').textContent = S.tracks.length ? noCover : '';
  $('[data-count="mismatch"]').textContent = S.tracks.length ? mm : '';
  $('[data-count="dirty"]').textContent = dirty || '';
  $$('.chip').forEach((c) => c.classList.toggle('on', !!S.filter[c.dataset.filter]));
  $('#dirty-count').textContent = dirty || '';
  $('.save-btn').disabled = !dirty;
  $('[data-cmd="clearList"]').disabled = !S.tracks.length;

  const sel = S.sel.size;
  const parts = [`<b>${T('status.tracks', S.tracks.length)}</b>`];
  if (S.view.length !== S.tracks.length) parts.push(T('status.shown', S.view.length));
  if (sel) parts.push(T('status.selected', sel));
  if (dirty) parts.push(`<span class="mod">${T('status.dirty', dirty)}</span>`);
  $('#status').innerHTML = S.tracks.length ? parts.join(' · ') : T('status.none');
  $('#filter-hint').textContent = S.tracks.length ? T('hint.header') : '';
  const p = S.progress;
  $('#status-right').innerHTML = p ? `${esc(p.label)}${p.total ? ` · ${p.done}/${p.total}` : '…'}` : T('status.activeCol', esc(L(S.activeCol)));
  const bar = $('#progress');
  bar.classList.toggle('indeterminate', !!p && !p.total);
  bar.firstElementChild.style.width = p && p.total ? `${Math.round((p.done / p.total) * 100)}%` : '0';
  document.title = dirty ? T('title.modified') : 'Pochette';
}

function refresh({ skipInspector = false } = {}) {
  computeView();
  renderHeader();
  renderRows();
  if (!skipInspector) renderInspector();
  renderStatus();
}

// ================================================================== inspector

const fmtSize = (b) => T('size', b);
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '—');
function fmtAudio(a) {
  if (!a) return '—';
  const bits = [];
  if (a.sampleRate) bits.push(T('audio.khz', a.sampleRate));
  if (a.bits) bits.push(T('audio.bits', a.bits));
  if (a.channels) bits.push(a.channels === 1 ? T('audio.mono') : a.channels === 2 ? T('audio.stereo') : T('audio.channels', a.channels));
  return bits.join(' · ') || a.codec || '—';
}

function common(ts, k) {
  const first = get(ts[0], k);
  return ts.every((t) => get(t, k) === first) ? { mixed: false, value: first } : { mixed: true, value: '' };
}

function coverWell(ts) {
  const keys = new Map();
  for (const t of ts) {
    const k = t.cover ? t.cover.thumb : 'none';
    if (!keys.has(k)) keys.set(k, t);
  }
  const pending = ts.some((t) => t.coverAction !== 'keep');
  const badge = pending ? `<span class="cover-badge">${T('insp.unsaved')}</span>` : '';
  const placeholder = `<div class="cover-placeholder">${icon('image')}${T('insp.dropHere')}</div>`;
  if (keys.size === 1) {
    const [k, t] = [...keys][0];
    if (k === 'none') return { html: placeholder + badge, rep: null };
    const pv = previewFor(t);
    return { html: `<img class="big" id="cover-big" src="${pv || t.cover.thumb}" alt="">${badge}`, rep: pv ? null : t };
  }
  const imgs = [...keys.entries()].filter(([k]) => k !== 'none').slice(0, 3).map(([, t]) => `<img src="${t.cover.thumb}" alt="">`).join('');
  return { html: imgs ? `<div class="stack">${imgs}</div>${badge}` : placeholder + badge, rep: null, mixed: true };
}

function previewFor(t) {
  if (!t.cover) return null;
  if (t.coverAction !== 'keep') return S.previews.get(t.coverAction) || null;
  return S.previews.get('file:' + t.path) || null;
}

async function loadPreview(t) {
  const key = 'file:' + t.path;
  if (S.previews.has(key)) return;
  try {
    const url = await api.coverPreview({ path: t.path });
    S.previews.set(key, url);
    const img = $('#cover-big');
    const ts = targets();
    if (img && url && ts.length && ts.every((x) => x.cover && x.cover.thumb === t.cover.thumb)) img.src = url;
  } catch { /* preview unavailable: the thumbnail stays */ }
}

const FIELD_LAYOUT = [
  ['name', 'full'], ['title', 'full'], ['artist', 'full'], ['album', 'full'],
  ['albumArtist', ''], ['genre', ''], ['label', ''], ['year', ''], ['bpm', ''], ['key', ''], ['track', ''], ['comment', 'full'],
];

function renderInspector() {
  const el = $('#inspector');
  const ts = targets();
  if (!ts.length) {
    el.innerHTML = `<div class="insp-empty">${S.tracks.length ? T('insp.empty') : ''}</div>`;
    return;
  }
  const single = ts.length === 1 ? ts[0] : null;
  const well = coverWell(ts);
  const withCover = ts.filter((t) => t.cover).length;
  const wavs = ts.filter((t) => t.format === 'wav');
  const flacs = ts.filter((t) => t.format === 'flac');
  const meta = single && single.cover
    ? `<span>${single.cover.width ? `${single.cover.width} × ${single.cover.height}` : ''}</span><span>${(single.cover.mime || '').replace('image/', '').toUpperCase()} · ${fmtSize(single.cover.bytes || 0)}</span>`
    : single ? `<span>${T('insp.noCover')}</span>` : `<span>${T('insp.withCover', withCover, ts.length)}</span><span>${well.mixed ? T('insp.mixedCovers') : ''}</span>`;

  const fields = FIELD_LAYOUT.map(([k, cls]) => {
    if (k === 'name' && !single) {
      return `<div class="field full"><label>${L('name')}<button class="link" data-act="nameFromTitle" title="${esc(T('insp.fromTitle.tip'))}">${icon('arrowLeft')}${T('insp.fromTitle')}</button></label><input disabled placeholder="${esc(T('insp.nameMulti', ts.length))}"></div>`;
    }
    const { mixed, value } = common(ts, k);
    const mod = ts.some((t) => isMod(t, k)) ? ' mod' : '';
    const link = k === 'title' ? `<button class="link" data-act="titleFromName" title="${esc(T('insp.fromName.tip'))}">${icon('arrowLeft')}${T('insp.fromName')}</button>`
      : k === 'name' ? `<button class="link" data-act="nameFromTitle" title="${esc(T('insp.fromTitle.tip'))}">${icon('arrowLeft')}${T('insp.fromTitle')}</button>` : '';
    const ph = mixed ? esc(T('insp.mixed')) : '';
    const input = k === 'comment'
      ? `<textarea data-field="${k}" placeholder="${ph}" spellcheck="false">${esc(value)}</textarea>`
      : k === 'name'
        ? `<div class="suffix"><input data-field="name" value="${esc(value)}" spellcheck="false"><span>${esc(single.ext)}</span></div>`
        : `<input data-field="${k}" value="${esc(value)}" placeholder="${ph}" spellcheck="false" autocomplete="off">`;
    return `<div class="field ${cls}${mod}" data-wrap="${k}"><label>${L(k)}${link}</label>${input}</div>`;
  }).join('');

  let info;
  if (single) {
    info = `
      <div><dt>${T('meta.format')}</dt><dd>${esc(single.format.toUpperCase())} ${single.audio?.codec && single.audio.codec !== 'PCM' ? `· ${esc(single.audio.codec)}` : ''}</dd></div>
      <div><dt>${T('meta.audio')}</dt><dd>${fmtAudio(single.audio)}</dd></div>
      <div><dt>${T('meta.duration')}</dt><dd>${fmtDur(single.audio?.duration)}</dd></div>
      <div><dt>${T('meta.size')}</dt><dd>${fmtSize(single.size)}</dd></div>
      <div><dt>${T('meta.folder')}</dt><dd class="path" data-act="reveal" title="${esc(single.path)}">${esc(single.dir)}</dd></div>
      ${single.error ? `<div><dt>${T('meta.error')}</dt><dd style="color:var(--danger)">${esc(single.error)}</dd></div>` : ''}`;
  } else {
    const counts = {};
    ts.forEach((t) => { counts[t.format] = (counts[t.format] || 0) + 1; });
    info = `
      <div><dt>${T('meta.formats')}</dt><dd>${Object.entries(counts).map(([f, n]) => `${n} ${f.toUpperCase()}`).join(' · ')}</dd></div>
      <div><dt>${T('meta.totalSize')}</dt><dd>${fmtSize(ts.reduce((n, t) => n + t.size, 0))}</dd></div>`;
  }

  el.innerHTML = `
    <div class="insp-head"><h2>${single ? esc(single.name + single.ext) : T('insp.tracks', ts.length)}</h2><span>${single ? '' : T('insp.batch')}</span></div>
    <div class="cover-well" id="cover-well" data-drop-label="${esc(T('drop.apply'))}">${well.html}</div>
    <div class="cover-meta">${meta}</div>
    <div class="cover-actions">
      <button class="btn small" data-act="pickCover" title="${esc(T('insp.choose.tip'))}">${icon('image')}${T('insp.choose')}</button>
      <button class="btn small" data-act="pasteCover" title="${esc(T('insp.paste.tip'))}">${icon('clipboard')}${T('insp.paste')}</button>
      <button class="btn small" data-act="searchCover" title="${esc(T('insp.google.tip'))}">${icon('globe')}${T('insp.google')}</button>
      <button class="btn small danger" data-act="removeCover" ${withCover ? '' : 'disabled'} title="${esc(T('insp.remove.tip'))}">${icon('trash')}${T('insp.remove')}</button>
    </div>
    ${wavs.length ? `<div class="notice">${T('insp.wavNotice')}<br><button class="btn small" data-act="convert">${icon('disc')}${T('insp.convertN', wavs.length + flacs.length)}</button></div>`
      : flacs.length ? `<div class="notice">${T('insp.flacNotice')}<br><button class="btn small" data-act="convert">${icon('disc')}${T('insp.convertFlac', flacs.length)}</button></div>` : ''}
    <div class="fields">${fields}</div>
    <dl class="meta">${info}</dl>
    <div class="insp-footer">
      ${single ? `<button class="btn small" data-act="reveal">${icon('reveal')}${T('insp.reveal')}</button>` : ''}
      ${ts.some(isDirty) ? `<button class="btn small ghost" data-act="revert">${icon('x')}${T('insp.revert')}</button>` : ''}
    </div>`;
  hydrateIcons(el);
  if (well.rep) loadPreview(well.rep);
}

// typing in the inspector: applied live to the whole selection
let editSession = null;
$('#inspector').addEventListener('focusin', (e) => {
  const f = e.target.dataset?.field;
  if (f) editSession = `insp:${f}:${Date.now()}`;
});
$('#inspector').addEventListener('input', (e) => {
  const f = e.target.dataset?.field;
  if (!f) return;
  const ts = targets();
  const v = e.target.value;
  mutate(T('undo.edit', L(f)), ts, (t) => setVal(t, f, v), { coalesce: editSession, skipInspector: true });
  const wrap = e.target.closest('.field');
  wrap.classList.toggle('mod', ts.some((t) => isMod(t, f)));
  if (f !== 'comment') e.target.placeholder = '';
});
$('#inspector').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.blur(); tbody.focus({ preventScroll: true }); }
  if (e.key === 'Escape' && /INPUT|TEXTAREA/.test(e.target.tagName)) { e.target.blur(); tbody.focus({ preventScroll: true }); }
});
$('#inspector').addEventListener('focusout', (e) => {
  if (e.target.dataset?.field) { editSession = null; setTimeout(() => { if (!$('#inspector').contains(document.activeElement)) renderInspector(); }, 0); }
});
$('#inspector').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a) run(a.dataset.act, a);
  else if (e.target.closest('#cover-well')) run('pickCover');
});

// ================================================================== selection & mouse

function selectOnly(id) { S.sel = new Set([id]); S.anchor = id; S.cursor = id; }
function rangeTo(id) {
  const ids = S.view.map((t) => t.id);
  const a = ids.indexOf(S.anchor); const b = ids.indexOf(id);
  if (a < 0) return selectOnly(id);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  S.sel = new Set(ids.slice(lo, hi + 1));
  S.cursor = id;
}
function selChanged() {
  renderRows();
  renderInspector();
  renderStatus();
}

tinner.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.row');
  if (!row || e.button !== 0) return;
  e.preventDefault();
  commitEdit();
  const id = +row.dataset.id;
  const cell = e.target.closest('.cell');
  const col = cell?.dataset.col;
  const prevCol = S.activeCol;
  if (col && col !== 'cover') S.activeCol = col;
  if (e.shiftKey) rangeTo(id);
  else if (e.metaKey || e.ctrlKey) {
    if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
    S.anchor = id; S.cursor = id;
  } else if (S.sel.has(id) && S.sel.size > 1 && col !== prevCol && col !== 'cover') {
    S.cursor = id; // click in another column: keep the selection, just change the active column
  } else if (S.sel.has(id) && S.sel.size > 1) {
    S.cursor = id;
    // same column: single selection on mouseup (unless it's the start of a drag)
    const x0 = e.clientX; const y0 = e.clientY;
    window.addEventListener('mouseup', (u) => {
      if (Math.abs(u.clientX - x0) < 4 && Math.abs(u.clientY - y0) < 4) { selectOnly(id); selChanged(); }
    }, { once: true });
  } else selectOnly(id);
  tbody.focus({ preventScroll: true });
  if (prevCol !== S.activeCol) renderHeader();
  selChanged();
});
tinner.addEventListener('dblclick', (e) => {
  const cell = e.target.closest('.cell');
  const row = e.target.closest('.row');
  if (!row || !cell) return;
  const col = cell.dataset.col;
  if (col === 'cover') return run('pickCover');
  if (COL[col]?.edit) startEdit(+row.dataset.id, col);
});
tinner.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const id = +row.dataset.id;
  if (!S.sel.has(id)) { selectOnly(id); selChanged(); }
  const n = S.sel.size;
  const ts = targets();
  showMenu(e.clientX, e.clientY, [
    { label: T('ctx.titleFromName'), kbd: '⌘T', action: () => run('titleFromName') },
    { label: T('ctx.nameFromTitle'), kbd: '⇧⌘T', action: () => run('nameFromTitle') },
    { label: T('ctx.copyColumn'), action: () => run('copyColumn') },
    'sep',
    { label: T('ctx.pickCover'), kbd: '⌘I', action: () => run('pickCover') },
    { label: T('ctx.pasteCover'), kbd: '⇧⌘V', action: () => run('pasteCover') },
    { label: T('ctx.searchCover'), kbd: '⇧⌘F', action: () => run('searchCover') },
    { label: T('ctx.removeCover'), action: () => run('removeCover') },
    'sep',
    ...(ts.some((x) => x.format === 'wav' || x.format === 'flac') ? [{ label: T('ctx.convert'), action: () => run('convert') }] : []),
    { label: T('ctx.reveal'), action: () => run('reveal') },
    ...(ts.some(isDirty) ? [{ label: T('ctx.revert'), action: () => run('revert') }] : []),
    { label: T('ctx.removeN', n), kbd: '⌘⌫', action: () => run('removeFromList') },
  ]);
});

// headers: active column, sort, resize, visible columns
thead.addEventListener('mousedown', (e) => {
  const grip = e.target.closest('[data-grip]');
  if (grip) {
    e.preventDefault();
    const c = COL[grip.dataset.grip];
    const x0 = e.clientX; const w0 = c.w;
    const move = (ev) => { c.w = Math.max(40, Math.round(w0 + ev.clientX - x0)); layoutVars(); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); saveCols(); renderRows(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
});
thead.addEventListener('click', (e) => {
  if (e.target.closest('[data-grip]')) return;
  const th = e.target.closest('.th[data-col]');
  if (!th) return;
  const key = th.dataset.col;
  if (key === 'cover' || key === S.activeCol) {
    if (!S.sort || S.sort.key !== key) S.sort = { key, dir: 1 };
    else if (S.sort.dir === 1) S.sort.dir = -1;
    else S.sort = null;
  } else S.activeCol = key;
  refresh({ skipInspector: true });
});
thead.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, COLUMNS.filter((c) => !c.fixed).map((c) => ({
    label: L(c.key), check: !c.hidden,
    action: () => { c.hidden = !c.hidden; if (c.hidden && S.activeCol === c.key) S.activeCol = 'title'; saveCols(); refresh({ skipInspector: true }); },
  })));
});

// ================================================================== inline editing (spreadsheet-style)

let editor = null;

function colOffset(key) {
  let x = 0;
  for (const c of visibleCols()) { if (c.key === key) return x; x += c.w; }
  return x;
}
function nextCol(key, dir, editable = true) {
  const cols = visibleCols().filter((c) => c.key !== 'cover' && (!editable || c.edit));
  const i = cols.findIndex((c) => c.key === key);
  return cols[i + dir]?.key || null;
}

function startEdit(id, col, initial) {
  if (!COL[col]?.edit) return;
  commitEdit();
  const idx = S.view.findIndex((t) => t.id === id);
  if (idx < 0) return;
  if (!S.sel.has(id)) { selectOnly(id); selChanged(); }
  S.cursor = id;
  ensureVisible(idx);
  const t = S.byId.get(id);
  const x = colOffset(col);
  const input = document.createElement('input');
  input.className = 'cell-editor';
  input.spellcheck = false;
  input.value = initial ?? get(t, col);
  Object.assign(input.style, { left: `${x + 2}px`, top: `${idx * ROW + 2}px`, width: `${Math.max(COL[col].w - 4, col === 'name' || col === 'title' ? 260 : 140)}px` });
  tbody.appendChild(input);
  input.focus();
  if (initial == null) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
  editor = { id, col, input };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); moveCursor(e.shiftKey ? -1 : 1, false); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const next = nextCol(col, e.shiftKey ? -1 : 1);
      commitEdit();
      if (next) { S.activeCol = next; renderHeader(); startEdit(id, next); }
    }
  });
  input.addEventListener('blur', () => commitEdit());
}
function commitEdit() {
  if (!editor) return;
  const { id, col, input } = editor;
  editor = null;
  const v = input.value;
  input.remove();
  const tr = S.byId.get(id);
  if (tr && v !== get(tr, col)) mutate(T('undo.edit', L(col)), [tr], (x) => setVal(x, col, v));
  tbody.focus({ preventScroll: true });
}
function cancelEdit() {
  if (!editor) return;
  const { input } = editor;
  editor = null;
  input.remove();
  tbody.focus({ preventScroll: true });
}

function moveCursor(delta, extend) {
  if (!S.view.length) return;
  let idx = S.view.findIndex((t) => t.id === S.cursor);
  idx = idx < 0 ? 0 : Math.min(S.view.length - 1, Math.max(0, idx + delta));
  const id = S.view[idx].id;
  if (extend) rangeTo(id); else selectOnly(id);
  ensureVisible(idx);
  selChanged();
}

// ================================================================== keyboard

const isField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

document.addEventListener('keydown', (e) => {
  if ($('.modal-backdrop') || $('.popmenu')) {
    if (e.key === 'Escape') { closeModal(); closeMenu(); }
    return;
  }
  if (isField(document.activeElement)) return;
  const meta = e.metaKey || e.ctrlKey;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveCursor(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey); return; }
  if (meta && e.key === 'Backspace') { e.preventDefault(); run('removeFromList'); return; }
  if (meta) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const next = nextCol(S.activeCol, e.key === 'ArrowRight' ? 1 : -1, false);
    if (next) { S.activeCol = next; refresh({ skipInspector: true }); }
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    if (S.view.length) { const i = e.key === 'Home' ? 0 : S.view.length - 1; selectOnly(S.view[i].id); ensureVisible(i); selChanged(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (S.cursor && S.sel.has(S.cursor)) startEdit(S.cursor, S.activeCol);
  } else if (e.key === 'Escape') {
    if (S.sel.size > 1 && S.cursor) { selectOnly(S.cursor); selChanged(); } else if (S.filter.text) { $('#search').value = ''; S.filter.text = ''; refresh(); }
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    const ts = targets();
    if (ts.length && COL[S.activeCol]?.edit && S.activeCol !== 'name') {
      const n = mutate(T('undo.clear', L(S.activeCol)), ts, (x) => setVal(x, S.activeCol, ''));
      if (n) toast(T('toast.cleared', L(S.activeCol), n), { undo: true });
    }
  } else if (e.key.length === 1 && !e.altKey && S.cursor && S.sel.has(S.cursor) && COL[S.activeCol]?.edit) {
    e.preventDefault();
    startEdit(S.cursor, S.activeCol, e.key);
  }
});

// ================================================================== column copy / paste

document.addEventListener('copy', (e) => {
  if (isField(document.activeElement)) return;
  const ts = targets();
  if (!ts.length || S.activeCol === 'cover') return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', ts.map((x) => get(x, S.activeCol)).join('\n'));
  toast(T('toast.copied', ts.length, L(S.activeCol)));
});

document.addEventListener('paste', async (e) => {
  if (isField(document.activeElement)) return;
  e.preventDefault();
  const ts = targets();
  if (!ts.length) return toast(T('toast.pasteSelectFirst'));
  const files = [...(e.clipboardData?.files || [])];
  const imgFile = files.find((f) => f.type.startsWith('image/'));
  if (imgFile) {
    const p = api.pathForFile(imgFile);
    return importCover(p ? { path: p } : { bytes: new Uint8Array(await imgFile.arrayBuffer()) }, ts);
  }
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!text) return run('pasteCover');
  if (/^https?:\/\/\S+\.(jpe?g|png|webp)(\?\S*)?$/i.test(text.trim()) && (S.activeCol === 'cover' || !COL[S.activeCol]?.edit)) {
    return importCover({ url: text.trim() }, ts);
  }
  const col = S.activeCol;
  if (!COL[col]?.edit) return toast(T('toast.pickEditableCol'));
  const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n');
  let pairs;
  if (lines.length === 1) pairs = ts.map((x) => [x, lines[0]]);
  else if (ts.length === 1) {
    // a single row selected: paste downwards, like a spreadsheet
    const start = S.view.indexOf(ts[0]);
    pairs = lines.map((l, i) => [S.view[start + i], l]).filter(([x]) => x);
  } else {
    pairs = ts.slice(0, lines.length).map((x, i) => [x, lines[i]]);
    if (lines.length !== ts.length) toast(T('toast.pasteMismatch', lines.length, ts.length), { error: true });
  }
  const map = new Map(pairs);
  const n = mutate(T('undo.paste', L(col)), [...map.keys()], (x) => setVal(x, col, map.get(x)));
  toast(T('toast.pasted', n, L(col)), { undo: true });
});

// ================================================================== drag & drop

const overlay = $('#drop-overlay');
let dropRow = null;
let dragDepth = 0;

function dragKind(dt) {
  const items = [...(dt.items || [])];
  const files = items.filter((i) => i.kind === 'file');
  const imageOnly = files.length > 0 && files.every((i) => i.type.startsWith('image/'));
  const urlOnly = !files.length && (dt.types.includes('text/uri-list') || dt.types.includes('text/html'));
  return { image: imageOnly || urlOnly, files: files.length > 0 && !imageOnly };
}
function clearDrop() {
  overlay.classList.remove('show');
  $('#cover-well')?.classList.remove('drag');
  dropRow?.classList.remove('drop-target');
  dropRow = null;
}

document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; clearDrop(); } });
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  const k = dragKind(e.dataTransfer);
  const well = e.target.closest('#cover-well');
  const row = e.target.closest('.row');
  clearDrop();
  if (k.image && well) well.classList.add('drag');
  else if (k.image && row) { dropRow = row; row.classList.add('drop-target'); }
  else if (k.files || (k.image && !S.tracks.length)) overlay.classList.add('show');
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  const well = e.target.closest('#cover-well');
  const row = dropRow || e.target.closest('.row');
  clearDrop();
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  const images = paths.filter((p) => IMAGE_EXT.test(p));
  const others = paths.filter((p) => !IMAGE_EXT.test(p));
  if (others.length) await addPaths(others);

  let source = null;
  if (images.length) source = { path: images[0] };
  else if (!paths.length) {
    const html = e.dataTransfer.getData('text/html');
    const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
    const uri = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#'));
    const url = (m && m[1]) || uri;
    if (url && /^(https?:|data:image)/.test(url)) source = { url: url.replace(/&amp;/g, '&') };
  }
  if (!source) return;
  let ts;
  if (row) {
    const id = +row.dataset.id;
    ts = S.sel.has(id) ? targets() : [S.byId.get(id)];
  } else if (well || S.sel.size) ts = targets();
  if (!ts || !ts.length) return toast(T('toast.dropOnTrack'));
  importCover(source, ts);
});

// ================================================================== actions

async function addPaths(paths) {
  if (!paths.length) return;
  const known = new Set(S.tracks.map((t) => t.path));
  setProgress({ label: T('progress.reading') });
  try {
    const list = await api.load(paths);
    const fresh = list.filter((d) => !known.has(d.path)).map(makeTrack);
    fresh.forEach((x) => { S.tracks.push(x); S.byId.set(x.id, x); });
    if (fresh.length) {
      S.sel = new Set([fresh[0].id]);
      S.anchor = fresh[0].id;
      S.cursor = fresh[0].id;
    }
    refresh();
    const errs = fresh.filter((x) => x.error).length;
    if (!list.length) toast(T('toast.noAudio'), { error: true });
    else if (!fresh.length) toast(T('toast.already'));
    else toast(T('toast.added', fresh.length, errs), { error: !!errs });
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    setProgress(null);
  }
}

async function importCover(source, ts) {
  setProgress({ label: T('progress.cover') });
  try {
    const info = await api.importCover(source);
    applyCover(info, ts);
  } catch (err) {
    toast(T('toast.coverErr', err.message), { error: true });
  } finally {
    setProgress(null);
  }
}

function applyCover(info, ts) {
  S.previews.set(info.coverId, info.preview);
  const cover = { thumb: info.thumb, width: info.width, height: info.height, bytes: info.bytes, mime: info.mime };
  const n = mutate(T('undo.cover'), ts, (x) => { x.cover = cover; x.coverAction = info.coverId; });
  toast(T('toast.coverApplied', n, info.width, info.height), { undo: true, success: true });
}

async function saveAll() {
  commitEdit();
  const dirty = S.tracks.filter(isDirty);
  if (!dirty.length) return toast(T('toast.nothingToSave'));
  return saveTracks(dirty);
}

async function saveTracks(list) {
  setProgress({ label: T('progress.saving'), done: 0, total: list.length });
  try {
    const items = list.map((x) => ({ path: x.path, tags: x.tags, cover: x.coverAction, name: x.name !== x.orig.name ? x.name : null }));
    const res = await api.save(items);
    const errors = [];
    res.forEach((r, i) => {
      const tr = list[i];
      if (r.ok) {
        S.previews.delete('file:' + tr.path);
        S.previews.delete('file:' + r.track.path);
        fillTrack(tr, r.track);
      } else errors.push(`${tr.orig.name} : ${r.error}`);
    });
    refresh();
    const ok = res.filter((r) => r.ok).length;
    if (errors.length) toast(T('toast.saveErrors', ok, errors.length, errors[0]), { error: true });
    else toast(T('toast.saved', ok), { success: true });
    return !errors.length;
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  } finally {
    setProgress(null);
  }
}

function needSelection() {
  const ts = targets();
  if (!ts.length) toast(T('toast.needSel'));
  return ts;
}

const cleanTitle = (s) => (s || '').replace(/\s*[([](original|extended|radio|club|vocal|dub|instrumental)( mix| edit| version)?[)\]]/gi, '').trim();

/** Opens Google Images in the default browser with “artist title” of the first selected track. */
function searchCover() {
  const ts = needSelection();
  if (!ts.length) return;
  const tr = ts[0];
  const title = cleanTitle(tr.tags.title || tr.name);
  const artist = (tr.tags.artist || '').trim();
  // don't repeat the artist if the title already contains it (“Artist - Title”)
  const q = artist && !fold(title).includes(fold(artist)) ? `${artist} ${title}` : title;
  api.openUrl(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q + ' cover')}`);
  toast(T('toast.searchHint'));
}

function copyColumnModal() {
  const ts = targets();
  const scopeSel = ts.length;
  const opts = ['name', 'title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'label', 'bpm', 'key', 'track', 'comment'];
  const options = (sel) => opts.map((k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(L(k))}</option>`).join('');
  openModal(`
    <h3>${T('cc.title')}</h3>
    <p class="sub">${T('cc.sub')}</p>
    <div class="row2">
      <div><label class="lbl">${T('cc.from')}</label><select id="cc-from">${options('name')}</select></div>
      <div class="arrow">→</div>
      <div><label class="lbl">${T('cc.to')}</label><select id="cc-to">${options('title')}</select></div>
    </div>
    <div class="checks">
      <label><input type="radio" name="cc-scope" value="sel" ${scopeSel ? 'checked' : 'disabled'}> ${T('cc.scopeSel', scopeSel)}</label>
      <label><input type="radio" name="cc-scope" value="all" ${scopeSel ? '' : 'checked'}> ${T('cc.scopeAll', S.view.length)}</label>
      <label><input type="checkbox" id="cc-artist"> ${T('cc.stripArtist')}</label>
      <label><input type="checkbox" id="cc-num"> ${T('cc.stripNum')}</label>
    </div>
    <div class="preview-list" id="cc-preview"></div>
    <div class="modal-actions"><button class="btn" data-close>${T('btn.cancel')}</button><button class="btn primary" id="cc-go">${T('cc.go')}</button></div>`, (m) => {
    const read = () => ({
      from: $('#cc-from', m).value, to: $('#cc-to', m).value,
      list: $('input[name="cc-scope"]:checked', m).value === 'sel' ? targets() : S.view,
      artist: $('#cc-artist', m).checked, num: $('#cc-num', m).checked,
    });
    const transform = (tr, o) => {
      let v = get(tr, o.from);
      if (o.num) v = v.replace(/^\s*\d{1,3}\s*[-.)_]\s*/, '');
      if (o.artist) {
        const a = (tr.tags.artist || '').trim();
        if (a && v.toLowerCase().startsWith((a + ' - ').toLowerCase())) v = v.slice(a.length + 3);
        else if (!a) v = v.replace(/^[^-]+ - /, '');
      }
      return v.trim();
    };
    const preview = () => {
      const o = read();
      $('#cc-go', m).disabled = o.from === o.to || !o.list.length;
      $('#cc-preview', m).innerHTML = o.list.slice(0, 5).map((tr) => {
        const before = get(tr, o.to); const after = transform(tr, o);
        return `<div><span class="from">${esc(before) || '—'}</span><i>→</i><span class="${before === after ? 'same' : 'to'}">${esc(after) || '—'}</span></div>`;
      }).join('') + (o.list.length > 5 ? `<div><span class="from">${T('cc.more', o.list.length - 5)}</span></div>` : '');
    };
    m.addEventListener('change', preview);
    preview();
    $('#cc-go', m).addEventListener('click', () => {
      const o = read();
      const n = mutate(`${L(o.to)} ← ${L(o.from)}`, o.list, (tr) => setVal(tr, o.to, transform(tr, o)));
      closeModal();
      toast(T('cc.done', L(o.to), L(o.from), n), { undo: true });
    });
  });
}

async function convertSelection() {
  const wavs = targets().filter((x) => x.format === 'wav' || x.format === 'flac');
  if (!wavs.length) return toast(T('toast.noConvertible'));
  const kinds = [...new Set(wavs.map((x) => x.format.toUpperCase()))].join(' / ');
  const dirty = wavs.filter(isDirty);
  const trash = S.settings.afterConvert === 'trash';
  const choice = api.confirm({
    message: T('conv.message', wavs.length, kinds),
    detail: T('conv.detail', trash, dirty.length),
    buttons: [T('conv.btn'), T('btn.cancel')],
  });
  if (choice !== 0) return;
  if (dirty.length && !(await saveTracks(dirty))) return;
  setProgress({ label: T('progress.converting'), done: 0, total: wavs.length });
  try {
    const res = await api.convert(wavs.map((x) => x.path));
    const newSel = new Set();
    let ok = 0;
    const errors = [];
    for (const r of res) {
      const tr = S.tracks.find((x) => x.path === r.from);
      if (!r.ok) { errors.push(`${tr ? tr.name : r.from} : ${r.error}`); continue; }
      ok++;
      const nt = makeTrack(r.track);
      const i = S.tracks.indexOf(tr);
      S.byId.delete(tr.id);
      S.tracks.splice(i, 1, nt);
      S.byId.set(nt.id, nt);
      newSel.add(nt.id);
    }
    S.sel = newSel;
    S.cursor = [...newSel][0] ?? null;
    S.anchor = S.cursor;
    S.undo = S.undo.filter((s) => s.items.every(([x]) => S.byId.has(x.id)));
    refresh();
    if (errors.length) toast(T('toast.convErrors', ok, errors.length, errors[0]), { error: true });
    else toast(T('toast.converted', ok, trash), { success: true });
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    setProgress(null);
  }
}

function settingsModal() {
  const s = S.settings;
  const seg = (key, values) => `<div class="seg" data-key="${key}">${values.map(([v, l]) => `<button data-v="${v}" class="${String(s[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  openModal(`
    <h3>${T('set.title')}</h3>
    <div class="setting"><div><strong>${T('set.lang')}</strong><p>${T('set.langDesc')}</p></div>${seg('lang', [['en', 'English'], ['fr', 'Français']])}</div>
    <div class="setting"><div><strong>${T('set.finder')}</strong><p>${T('set.finderDesc')}</p></div>${seg('finderIcon', [[true, T('set.yes')], [false, T('set.no')]])}</div>
    <div class="setting"><div><strong>${T('set.after')}</strong><p>${T('set.afterDesc')}</p></div>${seg('afterConvert', [['keep', T('set.keep')], ['trash', T('set.trash')]])}</div>
    <div class="setting"><div><strong>${T('set.size')}</strong><p>${T('set.sizeDesc')}</p></div>${seg('coverSize', [[600, '600'], [1000, '1000'], [1400, '1400']])}</div>
    <div class="modal-actions"><button class="btn primary" data-close>${T('btn.ok')}</button></div>`, (m) => {
    m.addEventListener('click', async (e) => {
      const b = e.target.closest('.seg button');
      if (!b) return;
      const key = b.parentElement.dataset.key;
      let v = b.dataset.v;
      if (v === 'true' || v === 'false') v = v === 'true';
      else if (/^\d+$/.test(v)) v = +v;
      S.settings = await api.setSettings({ [key]: v });
      if (key === 'lang') { applyLang(v); settingsModal(); return; }
      $$('button', b.parentElement).forEach((x) => x.classList.toggle('on', x === b));
    });
  });
}

/** Switches the language of the whole interface (static texts + dynamic renders). */
function applyLang(lang) {
  I18N.setLang(lang);
  document.documentElement.lang = I18N.getLang();
  $$('[data-i18n]').forEach((el) => { el.textContent = T(el.dataset.i18n); });
  $$('[data-i18n-html]').forEach((el) => { el.innerHTML = T(el.dataset.i18nHtml); });
  $$('[data-i18n-tip]').forEach((el) => { el.title = T(el.dataset.i18nTip); });
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = T(el.dataset.i18nPh); });
  refresh();
}

/**
 * Clears Pochette's list without touching the files.
 * If changes are unsaved: save then clear, clear anyway, or cancel.
 */
async function clearList() {
  if (!S.tracks.length) return;
  commitEdit();
  const dirty = S.tracks.filter(isDirty);
  if (dirty.length) {
    const c = api.confirm({ message: T('clear.message', dirty.length), detail: T('clear.detail'), buttons: [T('clear.saveAndClear'), T('clear.discard'), T('btn.cancel')] });
    if (c !== 0 && c !== 1) return;
    if (c === 0 && !(await saveTracks(dirty))) { toast(T('clear.saveFailed'), { error: true }); return; }
  }
  const n = S.tracks.length;
  S.tracks = [];
  S.byId.clear();
  S.sel.clear();
  S.cursor = null;
  S.anchor = null;
  S.undo = [];
  S.redo = [];
  S.previews.clear();
  S.filter = { text: '', noCover: false, mismatch: false, dirty: false };
  $('#search').value = '';
  tbody.scrollTop = 0;
  refresh();
  toast(T('toast.listCleared', n), { success: true });
}

async function run(cmd, el) {
  const ts = () => needSelection();
  switch (cmd) {
    case 'openFiles': case 'openFolder': {
      const paths = await api.openDialog(cmd === 'openFolder' ? 'folder' : 'files');
      return addPaths(paths);
    }
    case 'save': return saveAll();
    case 'undo': if (isField(document.activeElement)) document.execCommand('undo'); else undo(); return;
    case 'redo': if (isField(document.activeElement)) document.execCommand('redo'); else redo(); return;
    case 'selectAll':
      if (isField(document.activeElement)) return document.activeElement.select();
      S.sel = new Set(S.view.map((t) => t.id));
      if (!S.cursor && S.view.length) S.cursor = S.view[0].id;
      S.anchor = S.view[0]?.id ?? null;
      return selChanged();
    case 'find': $('#search').focus(); $('#search').select(); return;
    case 'titleFromName': {
      let list = targets();
      if (!list.length) list = S.view;
      const n = mutate(T('undo.titleFromName'), list, (x) => { x.tags.title = x.name; });
      return toast(n ? T('toast.titleDone', n) : T('toast.titleSame'), { undo: !!n });
    }
    case 'nameFromTitle': {
      const list = ts();
      if (!list.length) return;
      const n = mutate(T('undo.nameFromTitle'), list, (x) => { if ((x.tags.title || '').trim()) setVal(x, 'name', x.tags.title); });
      return toast(n ? T('toast.nameDone', n) : T('toast.nameSame'), { undo: !!n });
    }
    case 'copyColumn': return copyColumnModal();
    case 'pickCover': {
      const list = ts();
      if (!list.length) return;
      const p = await api.pickImage();
      if (p) importCover({ path: p }, list);
      return;
    }
    case 'pasteCover': {
      const list = ts();
      if (!list.length) return;
      try { applyCover(await api.clipboardCover(), list); } catch (err) { toast(err.message, { error: true }); }
      return;
    }
    case 'searchCover': return searchCover();
    case 'removeCover': {
      const list = ts();
      if (!list.length) return;
      const n = mutate(T('undo.removeCover'), list, (x) => { x.cover = null; x.coverAction = x.orig.cover ? 'remove' : 'keep'; });
      return toast(T('toast.coverRemoved', n), { undo: true });
    }
    case 'revert': {
      const list = ts();
      mutate(T('undo.revert'), list, (x) => { x.name = x.orig.name; x.tags = { ...x.orig.tags }; x.cover = x.orig.cover; x.coverAction = 'keep'; });
      return;
    }
    case 'reveal': {
      const tr = S.byId.get(S.cursor) || targets()[0];
      if (tr) api.reveal(tr.path);
      return;
    }
    case 'removeFromList': {
      const list = targets();
      if (!list.length) return;
      if (list.some(isDirty) && api.confirm({ message: T('rm.message'), detail: T('rm.detail'), buttons: [T('rm.btn'), T('btn.cancel')] }) !== 0) return;
      const ids = new Set(list.map((x) => x.id));
      S.tracks = S.tracks.filter((x) => !ids.has(x.id));
      ids.forEach((id) => S.byId.delete(id));
      S.sel.clear(); S.cursor = null; S.anchor = null;
      S.undo = S.undo.filter((s) => s.items.every(([x]) => S.byId.has(x.id)));
      return refresh();
    }
    case 'clearList': return clearList();
    case 'convert': return convertSelection();
    case 'finderIcons': {
      const list = ts();
      if (!list.length) return;
      const n = await api.finderIcons(list.map((x) => x.path));
      return toast(T('toast.finderIcons', n), { success: true });
    }
    case 'settings': return settingsModal();
    case 'requestClose': {
      commitEdit();
      const dirty = S.tracks.filter(isDirty);
      if (!dirty.length) return api.closeWindow();
      const c = api.confirm({ message: T('close.message', dirty.length), detail: T('close.detail'), buttons: [T('close.save'), T('close.dont'), T('btn.cancel')] });
      if (c === 0) { if (await saveTracks(dirty)) api.closeWindow(); } else if (c === 1) api.closeWindow();
      return;
    }
    default:
  }
}

// ================================================================== UI: toasts, menus, modals, progress

function toast(msg, { error = false, success = false, undo: canUndo = false } = {}) {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${error ? 'error' : success ? 'success' : ''}`;
  el.innerHTML = `${error ? icon('alert') : success ? icon('check') : ''}<span>${esc(msg)}</span>${canUndo ? `<button>${esc(T('toast.undo'))}</button>` : ''}`;
  hydrateIcons(el);
  el.querySelector('button')?.addEventListener('click', () => { undo(); el.remove(); });
  root.appendChild(el);
  while (root.children.length > 2) root.firstElementChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, error ? 7000 : 3600);
}

function showMenu(x, y, items) {
  closeMenu();
  const root = $('#menu-root');
  const m = document.createElement('div');
  m.className = 'popmenu';
  m.innerHTML = items.map((it, i) => {
    if (it === 'sep') return '<hr>';
    if (it.header) return `<div style="padding:5px 9px 6px;font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px">${esc(it.header)}</div>`;
    const check = it.check !== undefined ? `<span class="check">${it.check ? icon('check') : ''}</span>` : '';
    return `<button data-i="${i}">${check}${esc(it.label)}${it.kbd ? `<small>${it.kbd}</small>` : ''}</button>`;
  }).join('');
  root.appendChild(m);
  hydrateIcons(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  m.addEventListener('mousedown', (e) => e.stopPropagation());
  m.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[+b.dataset.i].action();
  });
  setTimeout(() => document.addEventListener('mousedown', closeMenu, { once: true }), 0);
}
function closeMenu() { $('#menu-root').innerHTML = ''; }

function openModal(html, mount) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  const m = $('.modal', root);
  hydrateIcons(m);
  root.firstElementChild.addEventListener('mousedown', (e) => { if (e.target === root.firstElementChild) closeModal(); });
  m.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  mount?.(m);
  ($('select, input, .btn.primary', m))?.focus();
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function setProgress(p) {
  S.progress = p;
  renderStatus();
}

// ================================================================== wiring

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b) run(b.dataset.cmd, b);
  const chip = e.target.closest('.chip');
  if (chip) { const k = chip.dataset.filter; S.filter[k] = !S.filter[k]; refresh(); }
});
$('#search').addEventListener('input', (e) => { S.filter.text = e.target.value; refresh(); });
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); tbody.focus(); if (!S.sel.size && S.view.length) { selectOnly(S.view[0].id); selChanged(); } } });

api.onMenu((cmd) => run(cmd));
api.onOpenPaths((paths) => addPaths(paths));
api.onProgress((p) => {
  if (p) setProgress(p);
  else if (S.progress && S.progress.total) setProgress({ ...S.progress, done: S.progress.total });
});

hydrateIcons();
applyLang('en');
api.getSettings().then((s) => { S.settings = s; applyLang(s.lang || 'en'); }).catch(() => {});
