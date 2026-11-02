'use strict';

const { t } = require('../i18n');

const fs = require('fs');
const pathMod = require('path');
const { FileSource } = require('./util');
const iff = require('./iff');
const mp3 = require('./mp3');
const flac = require('./flac');
const id3 = require('./id3');

const EXTENSIONS = new Set(['.wav', '.wave', '.aif', '.aiff', '.aifc', '.mp3', '.flac']);
const FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'track', 'bpm', 'key', 'label', 'comment'];

function detect(path) {
  const src = new FileSource(path);
  try {
    const h = src.read(0, 12);
    const m = h.toString('latin1', 0, 4);
    if (m === 'RIFF' && h.toString('latin1', 8, 12) === 'WAVE') return 'wav';
    if (m === 'FORM') return 'aiff';
    if (m === 'fLaC') return 'flac';
    if (m.startsWith('ID3')) {
      const size = id3.tagSizeFromHeader(h);
      return src.read(size, 4).toString('latin1') === 'fLaC' ? 'flac' : 'mp3';
    }
    if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0) return 'mp3';
    if (m === 'RF64') throw new Error(t('err.rf64'));
  } finally {
    src.close();
  }
  throw new Error(t('err.unknownFormat'));
}

const handler = (format) => ({ wav: iff, aiff: iff, mp3, flac }[format]);

function clean(tags) {
  const out = {};
  for (const f of FIELDS) out[f] = (tags[f] ?? '').toString();
  return out;
}

/** → { format, tags, cover: {data, mime} | null, audio } */
function read(path) {
  const format = detect(path);
  const r = handler(format).read(path);
  return { format, tags: clean(r.tags), cover: r.cover ? { data: r.cover.data, mime: r.cover.mime } : null, audio: r.audio || {} };
}

/**
 * @param cover  undefined = keep the current cover, null = remove it, {data, mime} = replace it
 */
function write(path, { tags, cover }) {
  const format = detect(path);
  const coverChanged = cover !== undefined;
  let finalCover = cover;
  if (!coverChanged) finalCover = read(path).cover;
  handler(format).write(path, { tags: clean(tags), cover: finalCover, coverChanged });
  return format;
}

/**
 * Lossless WAV → AIFF conversion: the same PCM samples, simply switched to big-endian.
 * Tags and cover go into the AIFF's ID3 chunk, which rekordbox reads (cover included).
 */
function wavToAiff(path, { tags, cover }, outPath) {
  const src = new FileSource(path);
  let pcm; let info;
  try {
    const layout = iff.listChunks(src);
    if (!layout.le) throw new Error(t('err.notWav'));
    info = iff.audioInfo(src, layout);
    if (info.float) throw new Error(t('err.float'));
    if (info.codec !== 'PCM') throw new Error(t('err.codec', info.codec));
    const data = layout.chunks.find((c) => c.id === 'data');
    if (!data) throw new Error(t('err.noAudio'));
    pcm = src.read(data.dataPos, data.size);
  } finally {
    src.close();
  }

  const bytes = info.blockAlign / info.channels;
  const usable = pcm.length - (pcm.length % info.blockAlign);
  pcm = Buffer.from(pcm.subarray(0, usable));
  if (bytes === 1) for (let i = 0; i < pcm.length; i++) pcm[i] ^= 0x80; // 8-bit: unsigned → signed
  else if (bytes === 2) pcm.swap16();
  else if (bytes === 4) pcm.swap32();
  else if (bytes === 3) {
    for (let i = 0; i < pcm.length; i += 3) { const t = pcm[i]; pcm[i] = pcm[i + 2]; pcm[i + 2] = t; }
  } else throw new Error(t('err.depth', info.bits));

  const frames = usable / info.blockAlign;
  const comm = Buffer.alloc(18);
  comm.writeUInt16BE(info.channels, 0);
  comm.writeUInt32BE(frames, 2);
  comm.writeUInt16BE(info.bits, 6);
  writeExtended(info.sampleRate, comm, 8);
  const ssndHead = Buffer.alloc(8); // offset + blockSize = 0
  const tag = id3.buildTag({ tags: clean(tags), cover });

  const body = Buffer.concat([
    Buffer.from('AIFF', 'latin1'),
    iff.chunk('COMM', comm, false),
    iff.chunk('SSND', Buffer.concat([ssndHead, pcm]), false),
    iff.chunk('ID3 ', tag, false),
  ]);
  const head = Buffer.alloc(8);
  head.write('FORM', 0, 'latin1');
  head.writeUInt32BE(body.length, 4);

  if (!outPath) outPath = pathMod.join(pathMod.dirname(path), pathMod.basename(path, pathMod.extname(path)) + '.aiff');
  if (fs.existsSync(outPath)) throw new Error(t('err.exists', pathMod.basename(outPath)));
  fs.writeFileSync(outPath, Buffer.concat([head, body]), { flag: 'wx' });
  return outPath;
}

function writeExtended(num, buf, off) {
  if (!num) { buf.fill(0, off, off + 10); return; }
  const exp = Math.floor(Math.log2(num));
  const mant = BigInt(Math.round(num * 2 ** (63 - exp)));
  buf.writeUInt16BE(exp + 16383, off);
  buf.writeBigUInt64BE(mant, off + 2);
}

module.exports = { read, write, wavToAiff, detect, EXTENSIONS, FIELDS };
