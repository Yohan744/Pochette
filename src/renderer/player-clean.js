'use strict';

/*
 * Preview player and one-click cleanup. Loaded just before app.js (they share their globals):
 *  - preview player (Space), streamed by the main process through pochette://audio
 *  - one-click cleanup (website ads, double spaces)
 */

/* global api, S, T, L, $, $$, esc, icon, hydrateIcons, toast, mutate, targets, setVal, openModal, closeModal,
   fmtDur, Clean, renderRows */

// ================================================================== preview player

const player = { audio: new Audio(), path: null, seekFrac: null };
player.audio.preload = 'metadata';

/** Starts (or resumes) the preview of a track; a new track starts at 30 % to skip the DJ intro. */
function playTrack(t, frac = null) {
  if (!t) return;
  const a = player.audio;
  if (player.path !== t.path) {
    player.path = t.path;
    player.seekFrac = frac ?? 0.3;
    a.src = api.audioUrl(t.path);
  } else if (frac != null) {
    if (a.duration) a.currentTime = a.duration * frac; else player.seekFrac = frac;
  }
  a.play().catch(() => {});
}
function togglePlay(t) {
  if (!t) return;
  if (player.path === t.path && !player.audio.paused) player.audio.pause();
  else playTrack(t);
}
function stopPlayer() {
  const a = player.audio;
  a.pause();
  a.removeAttribute('src');
  a.load();
  player.path = null;
  updatePlayers();
}
const isPlaying = (p) => player.path === p && !player.audio.paused;

player.audio.addEventListener('loadedmetadata', () => {
  const a = player.audio;
  if (player.seekFrac != null && a.duration > 30) a.currentTime = a.duration * player.seekFrac;
  player.seekFrac = null;
});
for (const ev of ['play', 'pause', 'ended', 'emptied']) player.audio.addEventListener(ev, () => { updatePlayers(); renderRows(); });
player.audio.addEventListener('timeupdate', updatePlayers);
player.audio.addEventListener('error', () => {
  if (!player.path) return;
  const name = player.path.split('/').pop();
  player.path = null;
  updatePlayers();
  toast(T('toast.previewErr', name), { error: true });
});

/** Mini player markup for a track (inspector). */
function playerHtml(t) {
  return `<div class="player" data-player-path="${esc(t.path)}">
    <button class="play-btn" data-play title="${esc(T('player.tip'))}">${icon('play')}</button>
    <div class="pbar" data-seek><div class="pfill"></div></div>
    <span class="ptime">${fmtDur(t.audio?.duration)}</span>
  </div>`;
}

function updatePlayers() {
  const a = player.audio;
  for (const el of $$('.player')) {
    const active = el.dataset.playerPath === player.path;
    const playing = active && !a.paused;
    el.classList.toggle('active', active);
    const btn = $('.play-btn', el);
    const want = playing ? 'pause' : 'play';
    if (btn.dataset.state !== want) { btn.dataset.state = want; btn.innerHTML = icon(want); hydrateIcons(btn); }
    const d = active && a.duration ? a.duration : 0;
    $('.pfill', el).style.width = d ? `${(a.currentTime / d) * 100}%` : '0';
    const total = $('.ptime', el);
    if (active && d) total.textContent = `${fmtDur(a.currentTime) === '—' ? '0:00' : fmtDur(a.currentTime)} / ${fmtDur(d)}`;
  }
}

// clicks on any mini player (event delegation: players are re-rendered often)
document.addEventListener('click', (e) => {
  const el = e.target.closest('.player');
  if (!el) return;
  const t = S.tracks.find((x) => x.path === el.dataset.playerPath);
  if (!t) return;
  if (e.target.closest('[data-play]')) togglePlay(t);
  else if (e.target.closest('[data-seek]')) {
    const r = $('.pbar', el).getBoundingClientRect();
    playTrack(t, Math.min(0.99, Math.max(0, (e.clientX - r.left) / r.width)));
  }
});

// ================================================================== cleanup

function cleanModal() {
  // several tracks selected → those; otherwise every displayed track (the preview shows each change first)
  const list = S.sel.size > 1 ? targets() : S.view;
  const items = list.map((t) => ({ t, changes: Clean.cleanTrack(t) })).filter((x) => x.changes.length);
  if (!items.length) return toast(T('cl.none'));
  const rows = items.flatMap(({ t, changes }) => changes.map((c) => ({ t, ...c })));
  openModal(`
    <h3>${T('cl.title')}</h3>
    <p class="sub">${T('cl.sub', items.length)}</p>
    <div class="preview-list clean-list">${rows.slice(0, 40).map((r) => `
      <div><span class="from" title="${esc(r.before)}"><em>${esc(L(r.field))}</em> ${esc(r.before)}</span><i>→</i><span class="to" title="${esc(r.after)}">${esc(r.after) || '—'}</span></div>`).join('')}
      ${rows.length > 40 ? `<div><span class="from">${T('cc.more', rows.length - 40)}</span></div>` : ''}
    </div>
    <div class="modal-actions"><button class="btn" data-close>${T('btn.cancel')}</button><button class="btn primary" id="cl-go">${icon('broom')}${T('cl.go')}</button></div>`, (m) => {
    $('#cl-go', m).addEventListener('click', () => {
      const map = new Map(items.map((x) => [x.t, x.changes]));
      const n = mutate(T('undo.clean'), [...map.keys()], (t) => { for (const c of map.get(t)) setVal(t, c.field, c.after); });
      closeModal();
      toast(T('cl.done', n), { undo: true, success: true });
    });
  });
}
