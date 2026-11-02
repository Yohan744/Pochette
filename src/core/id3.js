'use strict';

/*
 * ID3v2: reads versions 2.2 / 2.3 / 2.4, writes 2.3 only
 * (the best-supported version in rekordbox, Serato, Traktor, CDJs…).
 * Frames the app doesn't edit (Serato cues, GEOB, PRIV, POPM…) are preserved.
 */

const { isLatin1, sniffMime } = require('./util');

const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebob', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A capella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore', 'Terror', 'Indie', 'BritPop', 'Negerpunk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover', 'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'JPop', 'Synthpop'];

/** Editable fields ↔ ID3v2.3 frames */
const TEXT_FRAMES = {
  title: 'TIT2',
  artist: 'TPE1',
  album: 'TALB',
  albumArtist: 'TPE2',
  genre: 'TCON',
  year: 'TYER',
  track: 'TRCK',
  bpm: 'TBPM',
  key: 'TKEY',
  label: 'TPUB',
};
const FIELD_BY_FRAME = Object.fromEntries(Object.entries(TEXT_FRAMES).map(([k, v]) => [v, k]));

const V22_MAP = {
  TT1: 'TIT1', TT2: 'TIT2', TT3: 'TIT3', TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TP4: 'TPE4', TAL: 'TALB',
  TCO: 'TCON', TYE: 'TYER', TRK: 'TRCK', TBP: 'TBPM', TKE: 'TKEY', TPB: 'TPUB', TCM: 'TCOM', TPA: 'TPOS',
  TXX: 'TXXX', COM: 'COMM', PIC: 'APIC', ULT: 'USLT', UFI: 'UFID', POP: 'POPM', GEO: 'GEOB',
};
/** 2.4 frames with no 2.3 equivalent: dropped on rewrite (TDRC is converted to TYER). */
const V24_ONLY = new Set(['TDRC', 'TDRL', 'TDOR', 'TDEN', 'TDTG', 'TIPL', 'TMCL', 'TMOO', 'TPRO', 'TSST', 'SEIK', 'ASPI', 'EQU2', 'RVA2']);

// ---------------------------------------------------------------- low level

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function toSyncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function deunsync(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    out[j++] = buf[i];
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function utf16beToLe(buf) {
  const b = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
  b.swap16();
  return b;
}

function decodeText(buf, enc) {
  let s;
  switch (enc) {
    case 0: s = buf.toString('latin1'); break;
    case 1: {
      if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) s = utf16beToLe(buf.subarray(2)).toString('utf16le');
      else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) s = buf.subarray(2, buf.length - (buf.length % 2)).toString('utf16le');
      else s = buf.subarray(0, buf.length - (buf.length % 2)).toString('utf16le');
      break;
    }
    case 2: s = utf16beToLe(buf).toString('utf16le'); break;
    default: s = buf.toString('utf8');
  }
  // multiple values (2.4) separated by \0; BOM repeated on each value
  return s.replace(/﻿/g, '').replace(/\u0000+$/g, '').split('\u0000').map((v) => v.trim()).filter(Boolean).join(' / ');
}

/** Reads a \0-terminated string (1 byte in Latin-1/UTF-8, 2 aligned bytes in UTF-16). */
function readTerminated(buf, offset, enc) {
  const wide = enc === 1 || enc === 2;
  let i = offset;
  if (wide) {
    while (i + 1 < buf.length && !(buf[i] === 0 && buf[i + 1] === 0)) i += 2;
    return { value: decodeText(buf.subarray(offset, i), enc), next: Math.min(i + 2, buf.length) };
  }
  while (i < buf.length && buf[i] !== 0) i++;
  return { value: decodeText(buf.subarray(offset, i), enc), next: Math.min(i + 1, buf.length) };
}

/** ID3v2.3 encoding: Latin-1 if possible, otherwise UTF-16 with BOM (UTF-8 doesn't exist in 2.3). */
function encodeText(str) {
  if (isLatin1(str)) return { enc: 0, bytes: Buffer.from(str, 'latin1'), term: Buffer.from([0]) };
  return { enc: 1, bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(str, 'utf16le')]), term: Buffer.from([0, 0]) };
}

function textFrameData(str) {
  const { enc, bytes } = encodeText(str);
  return Buffer.concat([Buffer.from([enc]), bytes]);
}

function frame23(id, data) {
  const h = Buffer.alloc(10);
  h.write(id, 0, 4, 'latin1');
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
}

// ---------------------------------------------------------------- reading

/** Total size (header + body + optional footer) of a tag starting with `head` (first 10 bytes). */
function tagSizeFromHeader(head) {
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return 0;
  const footer = head[3] === 4 && (head[5] & 0x10) ? 10 : 0;
  return 10 + syncsafe(head, 6) + footer;
}

/** Parses a full ID3v2 tag → raw frames (ids normalized to 4 characters). */
function parseFrames(buf) {
  if (!buf || buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const major = buf[3];
  const flags = buf[5];
  const size = syncsafe(buf, 6);
  let body = buf.subarray(10, 10 + size);
  if (major < 2 || major > 4) return null;
  if (major < 4 && (flags & 0x80)) body = deunsync(body);

  let pos = 0;
  if (flags & 0x40) {
    // extended header
    if (major === 3) pos = 4 + body.readUInt32BE(0);
    else if (major === 4) pos = syncsafe(body, 0);
  }

  const frames = [];
  const hlen = major === 2 ? 6 : 10;
  while (pos + hlen <= body.length) {
    if (body[pos] === 0) break; // padding
    let id; let fsize; let fflags = 0;
    if (major === 2) {
      id = body.toString('latin1', pos, pos + 3);
      fsize = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
    } else {
      id = body.toString('latin1', pos, pos + 4);
      fsize = major === 4 ? syncsafe(body, pos + 4) : body.readUInt32BE(pos + 4);
      fflags = body.readUInt16BE(pos + 8);
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    if (major === 4 && pos + hlen + fsize > body.length) {
      // some software writes non-“syncsafe” 2.4 sizes
      const alt = body.readUInt32BE(pos + 4);
      if (pos + hlen + alt <= body.length) fsize = alt;
    }
    let data = body.subarray(pos + hlen, pos + hlen + fsize);
    pos += hlen + fsize;

    if (major === 2) {
      const mapped = V22_MAP[id];
      if (!mapped) continue;
      if (id === 'PIC' && data.length > 5) {
        // PIC: 3-character image format instead of a MIME type
        const fmt = data.toString('latin1', 1, 4).toUpperCase();
        const mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
        data = Buffer.concat([data.subarray(0, 1), Buffer.from(mime + '\0', 'latin1'), data.subarray(4)]);
      }
      frames.push({ id: mapped, data, major: 3 });
      continue;
    }
    if (major === 3) {
      if (fflags & 0x00c0) continue; // compressed / encrypted: unsupported, dropped
      if (fflags & 0x0020) data = data.subarray(1); // grouping
    } else {
      if (fflags & 0x000c) continue; // compressed / encrypted
      if (fflags & 0x0040) data = data.subarray(1); // grouping
      if (fflags & 0x0002 || (flags & 0x80)) data = deunsync(data);
      if (fflags & 0x0001) data = data.subarray(4); // data length indicator
    }
    frames.push({ id, data, major });
  }
  return { major, frames };
}

function parseGenre(s) {
  // “(21)”, “(21)Ska”, “21”
  const m = s.match(/^\((\d+)\)(.*)$/);
  if (m) return m[2].trim() || GENRES[+m[1]] || s;
  if (/^\d+$/.test(s) && GENRES[+s]) return GENRES[+s];
  return s;
}

function parseApic(data) {
  if (data.length < 4) return null;
  const enc = data[0];
  let i = 1;
  while (i < data.length && data[i] !== 0) i++;
  let mime = data.toString('latin1', 1, i).toLowerCase();
  const type = data[i + 1];
  const desc = readTerminated(data, i + 2, enc);
  const img = data.subarray(desc.next);
  if (!img.length) return null;
  if (!mime || !mime.includes('/')) mime = sniffMime(img);
  if (mime === 'image/jpg') mime = 'image/jpeg';
  return { mime, type, description: desc.value, data: img };
}

function parseComm(data) {
  if (data.length < 5) return null;
  const enc = data[0];
  const lang = data.toString('latin1', 1, 4);
  const d = readTerminated(data, 4, enc);
  return { lang, description: d.value, text: decodeText(data.subarray(d.next), enc) };
}

/** Frames → editable fields + cover + frames to keep as is. */
function framesToTags(parsed) {
  const tags = {};
  const pictures = [];
  const extra = [];
  let commentTaken = false;
  for (const f of parsed.frames) {
    const field = FIELD_BY_FRAME[f.id];
    if (field && f.data.length) {
      let v = decodeText(f.data.subarray(1), f.data[0]);
      if (field === 'genre') v = v.split(' / ').map(parseGenre).join(' / ');
      if (!tags[field]) tags[field] = v;
      continue;
    }
    if (f.id === 'TDRC' || f.id === 'TORY' || f.id === 'TDOR') {
      const v = decodeText(f.data.subarray(1), f.data[0]);
      if (f.id === 'TDRC' || !tags.year) tags.year = tags.year || v.slice(0, 4);
      if (f.id === 'TDRC') continue;
    }
    if (f.id === 'COMM' && !commentTaken) {
      const c = parseComm(f.data);
      if (c && !c.description) { tags.comment = c.text; commentTaken = true; continue; }
    }
    if (f.id === 'APIC') {
      const p = parseApic(f.data);
      if (p) pictures.push(p);
      continue;
    }
    extra.push(f);
  }
  const cover = pictures.find((p) => p.type === 3) || pictures[0] || null;
  return { tags, cover, extra };
}

// ---------------------------------------------------------------- writing 2.3

/** Converts a preserved frame (from a UTF-8-encoded 2.4 tag) to the 2.3 format. */
function convertExtra(f) {
  if (f.major !== 4) return f.data;
  if (V24_ONLY.has(f.id)) return null;
  const d = f.data;
  if (!d.length) return null;
  try {
    if (f.id === 'TXXX') {
      const enc = d[0];
      const desc = readTerminated(d, 1, enc);
      const value = decodeText(d.subarray(desc.next), enc);
      // description and value share the same encoding
      if (isLatin1(desc.value + value)) {
        return Buffer.concat([Buffer.from([0]), Buffer.from(desc.value, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]);
      }
      const u = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
      return Buffer.concat([Buffer.from([1]), u(desc.value), Buffer.from([0, 0]), u(value)]);
    }
    if (f.id === 'WXXX') {
      const enc = d[0];
      const desc = readTerminated(d, 1, enc);
      const e = encodeText(desc.value);
      return Buffer.concat([Buffer.from([e.enc]), e.bytes, e.term, d.subarray(desc.next)]);
    }
    if (f.id[0] === 'T') return textFrameData(decodeText(d.subarray(1), d[0]));
    if (f.id === 'COMM' || f.id === 'USLT') {
      const c = parseComm(d);
      return commData(c.text, c.description, c.lang);
    }
    if (f.id === 'GEOB' && d[0] === 3) {
      let i = 1;
      while (i < d.length && d[i] !== 0) i++;
      const mime = d.subarray(1, i + 1);
      const fname = readTerminated(d, i + 1, 3);
      const desc = readTerminated(d, fname.next, 3);
      const u = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
      return Buffer.concat([Buffer.from([1]), mime, u(fname.value), u(desc.value), d.subarray(desc.next)]);
    }
  } catch (_) {
    return null;
  }
  return d;
}

function commData(text, description = '', lang = 'eng') {
  const both = (description || '') + text;
  if (isLatin1(both)) {
    return Buffer.concat([Buffer.from([0]), Buffer.from((lang || 'eng').slice(0, 3).padEnd(3, ' '), 'latin1'), Buffer.from(description || '', 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
  }
  const u = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
  return Buffer.concat([Buffer.from([1]), Buffer.from((lang || 'eng').slice(0, 3).padEnd(3, ' '), 'latin1'), u(description || ''), Buffer.from([0, 0]), u(text)]);
}

function apicData(cover) {
  return Buffer.concat([Buffer.from([0]), Buffer.from((cover.mime || 'image/jpeg') + '\0', 'latin1'), Buffer.from([3, 0]), cover.data]);
}

/**
 * Builds a complete ID3v2.3 tag.
 * @param tags   editable fields (empty values remove the frame)
 * @param cover  { data, mime } or null
 * @param extra  frames preserved from the original tag
 */
function buildTag({ tags = {}, cover = null, extra = [] }, padding = 512) {
  const parts = [];
  for (const [field, id] of Object.entries(TEXT_FRAMES)) {
    let v = (tags[field] ?? '').toString().trim();
    if (!v) continue;
    if (field === 'year') {
      const m = v.match(/^(\d{4})/);
      if (m) v = m[1];
    }
    parts.push(frame23(id, textFrameData(v)));
  }
  if (tags.comment && tags.comment.trim()) parts.push(frame23('COMM', commData(tags.comment.trim())));
  const editedIds = new Set([...Object.values(TEXT_FRAMES), 'TDRC']);
  for (const f of extra) {
    if (editedIds.has(f.id) || f.id === 'APIC') continue;
    const data = convertExtra(f);
    if (data && data.length) parts.push(frame23(f.id, data));
  }
  if (cover && cover.data && cover.data.length) parts.push(frame23('APIC', apicData(cover)));

  const body = Buffer.concat([...parts, Buffer.alloc(padding)]);
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), toSyncsafe(body.length)]);
  return Buffer.concat([header, body]);
}

/** Shortcut: tag buffer → { tags, cover, extra } */
function readTag(buf) {
  const parsed = parseFrames(buf);
  if (!parsed) return null;
  return framesToTags(parsed);
}

module.exports = { readTag, buildTag, tagSizeFromHeader, parseFrames, TEXT_FRAMES, GENRES };
