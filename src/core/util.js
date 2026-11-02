'use strict';

const fs = require('fs');

/** Small positional reader over a file descriptor: a whole WAV is never loaded just to read its tags. */
class FileSource {
  constructor(path, flags = 'r') {
    this.path = path;
    this.fd = fs.openSync(path, flags);
    this.size = fs.fstatSync(this.fd).size;
  }
  read(pos, len) {
    if (pos >= this.size || len <= 0) return Buffer.alloc(0);
    len = Math.min(len, this.size - pos);
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(this.fd, buf, off, len - off, pos + off);
      if (n === 0) break;
      off += n;
    }
    return off === len ? buf : buf.subarray(0, off);
  }
  close() {
    if (this.fd != null) fs.closeSync(this.fd);
    this.fd = null;
  }
}

const isLatin1 = (s) => /^[\x00-\xff]*$/.test(s);

/** Decodes a “free text” string from an old format (INFO, NAME…): UTF-8 if valid, otherwise Latin-1. */
function decodeLoose(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  buf = buf.subarray(0, end);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8.trim();
  return buf.toString('latin1').trim();
}

/** Encodes for a “free text” format: Latin-1 when possible (what TagLib/rekordbox reads by default). */
function encodeLoose(s) {
  return isLatin1(s) ? Buffer.from(s, 'latin1') : Buffer.from(s, 'utf8');
}

/** Dimensions of a JPEG/PNG image without decoding it. */
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), mime: 'image/jpeg', progressive: marker === 0xc2 };
      }
      i += 2 + len;
    }
    return { width: 0, height: 0, mime: 'image/jpeg' };
  }
  return null;
}

function sniffMime(buf) {
  const s = imageSize(buf);
  return s ? s.mime : 'image/jpeg';
}

module.exports = { FileSource, isLatin1, decodeLoose, encodeLoose, imageSize, sniffMime };
