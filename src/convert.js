'use strict';

const { t } = require('./i18n');

/*
 * Conversion to AIFF (the format whose cover rekordbox reads).
 *  - WAV  : in-house conversion, bit for bit (core.wavToAiff).
 *  - FLAC : decoded by afconvert (built into macOS) or, failing that, ffmpeg if installed;
 *           then Pochette writes tags + cover into the AIFF's ID3 chunk.
 * After each conversion, sample rate, bit depth and duration are checked before keeping the file.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const core = require('./core');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      if (err) reject(new Error((String(stderr || '').trim().split('\n').pop()) || err.message));
      else resolve();
    });
  });
}

function aiffPathFor(p) {
  return path.join(path.dirname(p), path.basename(p, path.extname(p)) + '.aiff');
}

async function decodeToAiff(input, output, bits, tools) {
  const b = bits <= 16 ? 16 : bits <= 24 ? 24 : 32;
  const errors = [];
  for (const tool of tools) {
    try {
      if (tool === 'afconvert') {
        if (process.platform !== 'darwin') throw new Error(t('err.macOnly'));
        await exec('/usr/bin/afconvert', ['-f', 'AIFF', '-d', `BEI${b}`, input, output]);
      } else {
        const bin = FFMPEG.find((p) => fs.existsSync(p));
        if (!bin) throw new Error(t('err.notInstalled'));
        await exec(bin, ['-v', 'error', '-n', '-i', input, '-map', '0:a:0', '-c:a', `pcm_s${b}be`, '-f', 'aiff', output]);
      }
      return tool;
    } catch (e) {
      errors.push(`${tool} : ${e.message}`);
      try { fs.unlinkSync(output); } catch { /* nothing to clean up */ }
    }
  }
  throw new Error(t('err.flacDecode', errors.join(' ; ')));
}

/**
 * Converts a WAV or FLAC to AIFF next to the original, tags and cover included.
 * @returns path of the created AIFF
 */
async function toAiff(p, { tools = ['afconvert', 'ffmpeg'] } = {}) {
  const src = core.read(p);
  if (src.format === 'wav') return core.wavToAiff(p, { tags: src.tags, cover: src.cover });
  if (src.format !== 'flac') throw new Error(t('err.onlyWavFlac', src.format.toUpperCase()));

  const out = aiffPathFor(p);
  if (fs.existsSync(out)) throw new Error(t('err.exists', path.basename(out)));
  await decodeToAiff(p, out, src.audio.bits || 16, tools);
  try {
    const a = core.read(out);
    const same = a.format === 'aiff'
      && a.audio.sampleRate === src.audio.sampleRate
      && a.audio.channels === src.audio.channels
      && a.audio.bits >= src.audio.bits
      && Math.abs((a.audio.duration || 0) - (src.audio.duration || 0)) < 0.01;
    if (!same) throw new Error(t('err.convMismatch'));
    core.write(out, { tags: src.tags, cover: src.cover });
  } catch (e) {
    try { fs.unlinkSync(out); } catch { /* already gone */ }
    throw new Error(t('err.convCancelled', e.message));
  }
  return out;
}

module.exports = { toAiff, aiffPathFor };
