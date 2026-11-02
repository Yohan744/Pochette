'use strict';

const { t } = require('../i18n');

const fs = require('fs');
const { FileSource, imageSize } = require('./util');
const id3 = require('./id3');

const KEYS = {
  title: ['TITLE'],
  artist: ['ARTIST'],
  album: ['ALBUM'],
  albumArtist: ['ALBUMARTIST', 'ALBUM ARTIST'],
  genre: ['GENRE'],
  year: ['DATE', 'YEAR'],
  track: ['TRACKNUMBER'],
  bpm: ['BPM'],
  key: ['INITIALKEY', 'KEY'],
  label: ['LABEL', 'ORGANIZATION', 'PUBLISHER'],
  comment: ['COMMENT', 'DESCRIPTION'],
};
const ALL_KEYS = new Set(Object.values(KEYS).flat());

function layout(src) {
  let start = id3.tagSizeFromHeader(src.read(0, 10));
  if (src.read(start, 4).toString('latin1') !== 'fLaC') throw new Error(t('err.notFlac'));
  const blocks = [];
  let pos = start + 4;
  for (;;) {
    const h = src.read(pos, 4);
    if (h.length < 4) throw new Error(t('err.flacTruncated'));
    const last = !!(h[0] & 0x80);
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    blocks.push({ type, pos, len, data: src.read(pos + 4, len) });
    pos += 4 + len;
    if (last) break;
  }
  return { start, blocks, audioPos: pos };
}

function parseVorbis(d) {
  let p = 0;
  const vlen = d.readUInt32LE(p); p += 4;
  const vendor = d.toString('utf8', p, p + vlen); p += vlen;
  const n = d.readUInt32LE(p); p += 4;
  const comments = [];
  for (let i = 0; i < n && p + 4 <= d.length; i++) {
    const l = d.readUInt32LE(p); p += 4;
    const s = d.toString('utf8', p, p + l); p += l;
    const eq = s.indexOf('=');
    if (eq > 0) comments.push([s.slice(0, eq), s.slice(eq + 1)]);
  }
  return { vendor, comments };
}

function parsePicture(d) {
  let p = 0;
  const type = d.readUInt32BE(p); p += 4;
  const ml = d.readUInt32BE(p); p += 4;
  const mime = d.toString('latin1', p, p + ml); p += ml;
  const dl = d.readUInt32BE(p); p += 4 + dl;
  p += 16;
  const len = d.readUInt32BE(p); p += 4;
  return { type, mime, data: d.subarray(p, p + len) };
}

function read(path) {
  const src = new FileSource(path);
  try {
    const { blocks } = layout(src);
    const tags = {};
    let cover = null;
    const audio = { codec: 'FLAC' };
    for (const b of blocks) {
      if (b.type === 0 && b.data.length >= 18) {
        const d = b.data;
        audio.sampleRate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
        audio.channels = ((d[12] >> 1) & 7) + 1;
        audio.bits = (((d[12] & 1) << 4) | (d[13] >> 4)) + 1;
        const total = (d[13] & 0x0f) * 2 ** 32 + d.readUInt32BE(14);
        if (audio.sampleRate) audio.duration = total / audio.sampleRate;
      }
      if (b.type === 4) {
        const { comments } = parseVorbis(b.data);
        for (const [k, v] of comments) {
          const K = k.toUpperCase();
          for (const [field, keys] of Object.entries(KEYS)) {
            if (keys.includes(K) && !tags[field]) tags[field] = field === 'year' ? v.slice(0, 4) : v;
          }
        }
      }
      if (b.type === 6) {
        const pic = parsePicture(b.data);
        if (!cover || pic.type === 3) cover = pic;
      }
    }
    return { format: 'flac', tags, cover, extra: [], audio };
  } finally {
    src.close();
  }
}

function block(type, data, last) {
  const h = Buffer.from([(last ? 0x80 : 0) | type, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff]);
  return Buffer.concat([h, data]);
}

function buildVorbis(old, tags) {
  const vendor = old ? old.vendor : 'Pochette';
  const comments = (old ? old.comments : []).filter(([k]) => !ALL_KEYS.has(k.toUpperCase()));
  for (const [field, keys] of Object.entries(KEYS)) {
    const v = (tags[field] ?? '').toString().trim();
    if (v) comments.push([keys[0], v]);
  }
  const parts = [];
  const vb = Buffer.from(vendor, 'utf8');
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  parts.push(u32(vb.length), vb, u32(comments.length));
  for (const [k, v] of comments) {
    const s = Buffer.from(`${k}=${v}`, 'utf8');
    parts.push(u32(s.length), s);
  }
  return Buffer.concat(parts);
}

function buildPicture(cover) {
  const size = imageSize(cover.data) || { width: 0, height: 0 };
  const mime = Buffer.from(cover.mime || 'image/jpeg', 'latin1');
  const h = Buffer.alloc(4 + 4);
  h.writeUInt32BE(3, 0);
  h.writeUInt32BE(mime.length, 4);
  const mid = Buffer.alloc(4 + 16 + 4);
  mid.writeUInt32BE(0, 0); // empty description
  mid.writeUInt32BE(size.width, 4);
  mid.writeUInt32BE(size.height, 8);
  mid.writeUInt32BE(24, 12);
  mid.writeUInt32BE(0, 16);
  mid.writeUInt32BE(cover.data.length, 20);
  return Buffer.concat([h, mime, mid, cover.data]);
}

function write(path, { tags, cover, coverChanged }) {
  const src = new FileSource(path, 'r+');
  try {
    const { start, blocks, audioPos } = layout(src);
    const vcBlock = blocks.find((b) => b.type === 4);
    const old = vcBlock ? parseVorbis(vcBlock.data) : null;
    const body = [];
    body.push([0, blocks.find((b) => b.type === 0).data]);
    for (const b of blocks) if (![0, 1, 4, 6].includes(b.type)) body.push([b.type, b.data]);
    body.push([4, buildVorbis(old, tags)]);
    if (coverChanged) {
      if (cover) body.push([6, buildPicture(cover)]);
    } else {
      for (const b of blocks) if (b.type === 6) body.push([6, b.data]);
    }
    const metaLen = body.reduce((n, [, d]) => n + 4 + d.length, 0);
    const available = audioPos - start - 4;
    const remaining = available - metaLen;

    if (remaining === 0 || remaining >= 4) {
      if (remaining >= 4) body.push([1, Buffer.alloc(remaining - 4)]);
      const out = Buffer.concat(body.map(([t, d], i) => block(t, d, i === body.length - 1)));
      fs.writeSync(src.fd, out, 0, out.length, start + 4);
      return;
    }
    body.push([1, Buffer.alloc(4096)]);
    const audio = src.read(audioPos, src.size - audioPos);
    const out = Buffer.concat([Buffer.from('fLaC', 'latin1'), ...body.map(([t, d], i) => block(t, d, i === body.length - 1)), audio]);
    fs.writeSync(src.fd, out, 0, out.length, 0);
    fs.ftruncateSync(src.fd, out.length);
  } finally {
    src.close();
  }
}

module.exports = { read, write };
