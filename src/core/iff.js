'use strict';

const { t } = require('../i18n');

/*
 * WAV (RIFF, little-endian) and AIFF (IFF, big-endian).
 *
 * WAV  : rekordbox ONLY reads the LIST/INFO block (title, artist, album, genre, year, comment)
 *        and ignores the "id3 " chunk — so no cover is possible in rekordbox for a WAV.
 *        Both are written, identical: INFO for rekordbox, "id3 " (ID3v2.3 + cover) for Serato,
 *        Traktor, Engine, Music…
 * AIFF : "ID3 " chunk (ID3v2.3) — read by rekordbox, cover included.
 */

const fs = require('fs');
const { FileSource, decodeLoose, encodeLoose } = require('./util');
const id3 = require('./id3');

const INFO_FIELDS = { INAM: 'title', IART: 'artist', IPRD: 'album', IGNR: 'genre', ICRD: 'year', ICMT: 'comment', IPRT: 'track', ITRK: 'track' };
const INFO_WRITE = [['INAM', 'title'], ['IART', 'artist'], ['IPRD', 'album'], ['IGNR', 'genre'], ['ICRD', 'year'], ['ICMT', 'comment'], ['IPRT', 'track'], ['ITRK', 'track']];

const isTagChunk = (c) => c.id === 'id3 ' || c.id === 'ID3 ' || (c.id === 'LIST' && c.listType === 'INFO');

function readU32(b, o, le) { return le ? b.readUInt32LE(o) : b.readUInt32BE(o); }

/** Walks the chunks without reading their data. */
function listChunks(src) {
  const head = src.read(0, 12);
  if (head.length < 12) throw new Error(t('err.short'));
  const magic = head.toString('latin1', 0, 4);
  const le = magic === 'RIFF';
  if (!le && magic !== 'FORM') throw new Error(t('err.notWavAiff'));
  if (magic === 'RIFF' && head.toString('latin1', 8, 12) !== 'WAVE') throw new Error(t('err.notWave'));
  const formType = head.toString('latin1', 8, 12);
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= src.size) {
    const h = src.read(pos, 8);
    const id = h.toString('latin1', 0, 4);
    if (!/^[\x20-\x7e]{4}$/.test(id)) break;
    let size = readU32(h, 4, le);
    const dataPos = pos + 8;
    const truncated = dataPos + size > src.size;
    if (truncated) size = src.size - dataPos;
    const c = { id, pos, dataPos, size, end: dataPos + size + (size & 1) };
    if (id === 'LIST' && size >= 4) c.listType = src.read(dataPos, 4).toString('latin1');
    chunks.push(c);
    if (truncated) { c.end = src.size; break; }
    pos = c.end;
  }
  return { le, formType, chunks };
}

function parseInfo(buf) {
  // buf = LIST data without the "INFO" type
  const tags = {};
  const extra = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const data = buf.subarray(p + 8, p + 8 + size);
    const field = INFO_FIELDS[id];
    if (field) {
      const v = decodeLoose(data);
      if (v && !tags[field]) tags[field] = v;
    } else extra.push({ id, data });
    p += 8 + size + (size & 1);
  }
  return { tags, extra };
}

function chunk(id, data, le) {
  const h = Buffer.alloc(8);
  h.write(id, 0, 4, 'latin1');
  if (le) h.writeUInt32LE(data.length, 4); else h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function buildInfo(tags, extra) {
  const parts = [Buffer.from('INFO', 'latin1')];
  for (const [id, field] of INFO_WRITE) {
    const v = (tags[field] ?? '').toString().trim();
    if (!v) continue;
    parts.push(chunk(id, Buffer.concat([encodeLoose(v), Buffer.from([0])]), true));
  }
  for (const e of extra) parts.push(chunk(e.id, e.data, true));
  return parts.length > 1 ? chunk('LIST', Buffer.concat(parts), true) : null;
}

function extendedToNumber(b) {
  const exp = ((b[0] & 0x7f) << 8) | b[1];
  const mant = b.readUInt32BE(2) * 2 ** 32 + b.readUInt32BE(6);
  if (!exp && !mant) return 0;
  return mant * 2 ** (exp - 16383 - 63) * (b[0] & 0x80 ? -1 : 1);
}

function audioInfo(src, layout) {
  const { le, chunks } = layout;
  const info = {};
  if (le) {
    const fmt = chunks.find((c) => c.id === 'fmt ');
    const data = chunks.find((c) => c.id === 'data');
    if (fmt) {
      const f = src.read(fmt.dataPos, Math.min(fmt.size, 40));
      let codec = f.readUInt16LE(0);
      info.channels = f.readUInt16LE(2);
      info.sampleRate = f.readUInt32LE(4);
      info.blockAlign = f.readUInt16LE(12);
      info.bits = f.readUInt16LE(14);
      if (codec === 0xfffe && f.length >= 26) codec = f.readUInt16LE(24);
      info.codec = codec === 1 ? 'PCM' : codec === 3 ? 'PCM float' : `codec ${codec}`;
      info.float = codec === 3;
      if (data && info.blockAlign && info.sampleRate) info.duration = data.size / info.blockAlign / info.sampleRate;
    }
  } else {
    const comm = chunks.find((c) => c.id === 'COMM');
    if (comm) {
      const f = src.read(comm.dataPos, Math.min(comm.size, 26));
      info.channels = f.readUInt16BE(0);
      const frames = f.readUInt32BE(2);
      info.bits = f.readUInt16BE(6);
      info.sampleRate = Math.round(extendedToNumber(f.subarray(8, 18)));
      info.codec = layout.formType === 'AIFC' && f.length >= 22 ? `AIFC ${f.toString('latin1', 18, 22)}` : 'PCM';
      if (info.sampleRate) info.duration = frames / info.sampleRate;
    }
  }
  return info;
}

/** Reads tags + cover from a WAV/AIFF. */
function read(path) {
  const src = new FileSource(path);
  try {
    const layout = listChunks(src);
    const format = layout.le ? 'wav' : 'aiff';
    let tags = {};
    let cover = null;
    let extra = [];
    let infoExtra = [];
    const tagChunk = layout.chunks.find((c) => c.id === 'id3 ' || c.id === 'ID3 ');
    if (tagChunk) {
      const t = id3.readTag(src.read(tagChunk.dataPos, tagChunk.size));
      if (t) ({ tags, cover, extra } = t);
    }
    if (layout.le) {
      const info = layout.chunks.find((c) => c.id === 'LIST' && c.listType === 'INFO');
      if (info) {
        const parsed = parseInfo(src.read(info.dataPos + 4, info.size - 4));
        // INFO = what rekordbox shows: it takes priority
        tags = { ...tags, ...parsed.tags };
        infoExtra = parsed.extra;
      }
    } else if (!tagChunk) {
      // AIFF without ID3: native text chunks
      for (const c of layout.chunks) {
        if (c.id === 'NAME' && !tags.title) tags.title = decodeLoose(src.read(c.dataPos, c.size));
        if (c.id === 'AUTH' && !tags.artist) tags.artist = decodeLoose(src.read(c.dataPos, c.size));
      }
    }
    return { format, tags, cover, extra, infoExtra, audio: audioInfo(src, layout) };
  } finally {
    src.close();
  }
}

/**
 * Rewrites the tag chunks.
 * Fast path (the most common): the tags are already at the end of the file → truncate and rewrite
 * only the end, without touching the megabytes of audio.
 * Otherwise: full rebuild, written into the same file (Finder metadata is preserved).
 */
function write(path, { tags, cover }) {
  const current = read(path);
  const src = new FileSource(path, 'r+');
  try {
    const layout = listChunks(src);
    const { le } = layout;
    const newChunks = [];
    if (le) {
      const info = buildInfo(tags, current.infoExtra);
      if (info) newChunks.push(info);
      newChunks.push(chunk('id3 ', id3.buildTag({ tags, cover, extra: current.extra }), true));
    } else {
      newChunks.push(chunk('ID3 ', id3.buildTag({ tags, cover, extra: current.extra }), false));
    }
    const tail = Buffer.concat(newChunks);

    const kept = layout.chunks.filter((c) => !isTagChunk(c));
    const lastKept = kept[kept.length - 1];
    const firstTag = layout.chunks.findIndex(isTagChunk);
    const lastKeptIdx = layout.chunks.lastIndexOf(lastKept);
    const tagsAtEnd = firstTag === -1 || firstTag > lastKeptIdx;

    if (tagsAtEnd && lastKept) {
      let cut = lastKept.dataPos + lastKept.size;
      const pad = lastKept.size & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
      const out = Buffer.concat([pad, tail]);
      fs.writeSync(src.fd, out, 0, out.length, cut);
      const total = cut + out.length;
      fs.ftruncateSync(src.fd, total);
      const sz = Buffer.alloc(4);
      if (le) sz.writeUInt32LE(total - 8); else sz.writeUInt32BE(total - 8);
      fs.writeSync(src.fd, sz, 0, 4, 4);
      return;
    }

    const parts = [src.read(0, 12)];
    for (const c of kept) {
      const data = src.read(c.dataPos, c.size);
      parts.push(chunk(c.id, data, le));
    }
    parts.push(tail);
    const out = Buffer.concat(parts);
    if (le) out.writeUInt32LE(out.length - 8, 4); else out.writeUInt32BE(out.length - 8, 4);
    fs.writeSync(src.fd, out, 0, out.length, 0);
    fs.ftruncateSync(src.fd, out.length);
  } finally {
    src.close();
  }
}

module.exports = { read, write, listChunks, chunk, audioInfo };
