'use strict';

const fs = require('fs');
const { FileSource } = require('./util');
const id3 = require('./id3');

function readV1(src) {
  if (src.size < 128) return null;
  const b = src.read(src.size - 128, 128);
  if (b.toString('latin1', 0, 3) !== 'TAG') return null;
  const s = (a, z) => b.toString('latin1', a, z).replace(/\0.*$/s, '').trim();
  const tags = { title: s(3, 33), artist: s(33, 63), album: s(63, 93), year: s(93, 97) };
  if (b[125] === 0 && b[126]) tags.track = String(b[126]);
  if (b[127] < id3.GENRES.length) tags.genre = id3.GENRES[b[127]];
  for (const k of Object.keys(tags)) if (!tags[k]) delete tags[k];
  return tags;
}

function buildV1(tags, old) {
  const b = Buffer.from(old);
  const put = (v, a, len) => {
    const s = Buffer.alloc(len);
    Buffer.from((v || '').normalize('NFD').replace(/[^\x00-\xff]/g, ''), 'latin1').copy(s, 0, 0, len);
    s.copy(b, a);
  };
  put(tags.title, 3, 30);
  put(tags.artist, 33, 30);
  put(tags.album, 63, 30);
  put(tags.year, 93, 4);
  return b;
}

function read(path) {
  const src = new FileSource(path);
  try {
    const size = id3.tagSizeFromHeader(src.read(0, 10));
    let res = { tags: {}, cover: null, extra: [] };
    if (size) res = id3.readTag(src.read(0, size)) || res;
    const v1 = readV1(src);
    if (v1) for (const [k, v] of Object.entries(v1)) if (!res.tags[k]) res.tags[k] = v;
    return { format: 'mp3', ...res, audio: { codec: 'MP3' } };
  } finally {
    src.close();
  }
}

function write(path, { tags, cover }) {
  const current = read(path);
  const src = new FileSource(path, 'r+');
  try {
    const oldSize = id3.tagSizeFromHeader(src.read(0, 10));
    const bare = id3.buildTag({ tags, cover, extra: current.extra }, 0);
    if (oldSize && bare.length <= oldSize) {
      // the new tag fits in the old one: rewrite in place, the audio doesn't move
      const tag = id3.buildTag({ tags, cover, extra: current.extra }, oldSize - bare.length);
      fs.writeSync(src.fd, tag, 0, tag.length, 0);
    } else {
      const audio = src.read(oldSize, src.size - oldSize);
      const out = Buffer.concat([id3.buildTag({ tags, cover, extra: current.extra }, 2048), audio]);
      fs.writeSync(src.fd, out, 0, out.length, 0);
      fs.ftruncateSync(src.fd, out.length);
    }
    const st = fs.fstatSync(src.fd);
    if (st.size >= 128) {
      const last = src.read(st.size - 128, 128);
      if (last.toString('latin1', 0, 3) === 'TAG') {
        const v1 = buildV1(tags, last);
        fs.writeSync(src.fd, v1, 0, 128, st.size - 128);
      }
    }
  } finally {
    src.close();
  }
}

module.exports = { read, write };
