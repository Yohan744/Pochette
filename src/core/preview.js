'use strict';

/*
 * Audio source for the in-app preview player, read in byte ranges (seeking without loading the file).
 * Chromium plays WAV, MP3 and FLAC directly; AIFF is not supported, so it is exposed as a virtual WAV:
 * the same PCM samples, switched from big-endian to little-endian on the fly.
 */

const fs = require('fs');
const pathMod = require('path');
const { FileSource } = require('./util');
const iff = require('./iff');

const MIME = { '.wav': 'audio/wav', '.wave': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac' };

function fileSource(path, mime) {
  const size = fs.statSync(path).size;
  return {
    size,
    mime,
    read(start, end) {
      const src = new FileSource(path);
      try { return src.read(start, end - start + 1); } finally { src.close(); }
    },
  };
}

function wavHeader({ channels, sampleRate, bits, float }, dataLen) {
  const bps = Math.ceil(bits / 8);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(float ? 3 : 1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * bps, 28);
  h.writeUInt16LE(channels * bps, 32);
  h.writeUInt16LE(bps * 8, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(dataLen, 40);
  return h;
}

function aiffSource(path) {
  const src = new FileSource(path);
  let audioStart; let dataLen; let info; let swap = true; let float = false;
  try {
    const layout = iff.listChunks(src);
    info = iff.audioInfo(src, layout);
    const ssnd = layout.chunks.find((c) => c.id === 'SSND');
    if (!ssnd || !info.channels || !info.bits) throw new Error('No audio in this AIFF');
    const codec = (info.codec || '').replace(/^AIFC\s*/, '').trim().toLowerCase();
    if (codec === 'sowt') swap = false;
    else if (codec === 'fl32') float = true;
    else if (codec && codec !== 'pcm' && codec !== 'none' && codec !== 'twos') throw new Error(`AIFF codec “${codec}” can't be previewed`);
    const offset = src.read(ssnd.dataPos, 4).readUInt32BE(0);
    audioStart = ssnd.dataPos + 8 + offset;
    const bps = Math.ceil(info.bits / 8);
    const block = bps * info.channels;
    const avail = Math.max(0, ssnd.size - 8 - offset);
    dataLen = avail - (avail % block);
  } finally {
    src.close();
  }
  const bps = Math.ceil(info.bits / 8);
  const header = wavHeader({ ...info, float }, dataLen);
  const size = 44 + dataLen;

  function convert(buf) {
    if (bps === 1) { for (let i = 0; i < buf.length; i++) buf[i] ^= 0x80; return buf; } // signed → unsigned
    if (!swap) return buf;
    if (bps === 2) return buf.swap16();
    if (bps === 4) return buf.swap32();
    if (bps === 3) { for (let i = 0; i + 2 < buf.length; i += 3) { const t = buf[i]; buf[i] = buf[i + 2]; buf[i + 2] = t; } return buf; }
    return buf;
  }

  return {
    size,
    mime: 'audio/wav',
    read(start, end) {
      end = Math.min(end, size - 1);
      const parts = [];
      if (start < 44) parts.push(header.subarray(start, Math.min(44, end + 1)));
      if (end >= 44) {
        const d0 = Math.max(0, start - 44);
        const d1 = end - 44;
        const a0 = Math.floor(d0 / bps) * bps;
        const a1 = Math.min(dataLen, (Math.floor(d1 / bps) + 1) * bps);
        const f = new FileSource(path);
        let raw;
        try { raw = Buffer.from(f.read(audioStart + a0, a1 - a0)); } finally { f.close(); }
        parts.push(convert(raw).subarray(d0 - a0, d1 - a0 + 1));
      }
      return Buffer.concat(parts);
    },
  };
}

/** → { size, mime, read(start, end) } — end is inclusive */
function previewSource(path) {
  const ext = pathMod.extname(path).toLowerCase();
  if (ext === '.aif' || ext === '.aiff' || ext === '.aifc') return aiffSource(path);
  if (!MIME[ext]) throw new Error('Not an audio file');
  return fileSource(path, MIME[ext]);
}

module.exports = { previewSource };
