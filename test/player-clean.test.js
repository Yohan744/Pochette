'use strict';

/*
 * Cleanup rules and AIFF preview as a virtual WAV.
 * The AIFF test needs ffmpeg (brew install ffmpeg).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const clean = require('../src/clean');
const { previewSource } = require('../src/core/preview');

// ------------------------------------------------------------------ cleanup

test('cleanup: website ads, double spaces, empty brackets, trailing dot', () => {
  const c = clean.cleanValue;
  assert.strictEqual(c('album', 'djsoundtop.com'), '');
  assert.strictEqual(c('albumArtist', 'https://djsoundtop.com'), '');
  assert.strictEqual(c('title', 'Chica - electronicfresh.com'), 'Chica');
  assert.strictEqual(c('title', 'Song (by djsoundtop.com)'), 'Song');
  assert.strictEqual(c('name', 'Track (www.blabla.net)'), 'Track');
  assert.strictEqual(c('title', 'Sunshine (Extended Mix) @ promodj.com'), 'Sunshine (Extended Mix)');
  assert.strictEqual(c('comment', 'Downloaded from https://x.com — enjoy'), '');
  assert.strictEqual(c('title', 'Simple Things  (Original Mix)'), 'Simple Things (Original Mix)');
  assert.strictEqual(c('title', 'Boogie (Original Mix).'), 'Boogie (Original Mix)');
  assert.strictEqual(c('title', 'Fancy Shit ( Extended Mix )'), 'Fancy Shit (Extended Mix)');
  assert.strictEqual(c('title', 'Go [ ]'), 'Go');
});

test('cleanup leaves real names alone', () => {
  for (const [f, v] of [['artist', 'Mr.Me'], ['title', 'Vol.1 Mix'], ['album', 'Bombero Calling EP [8BIT235]'], ['artist', 'Hot Since 82'],
    ['title', 'Fly By Night'], ['title', 'St. Germain - Rose Rouge'], ['artist', 'VITO (UK) & Marian (BR)'], ['genre', 'Minimal / Deep Tech']]) {
    assert.strictEqual(clean.cleanValue(f, v), v, v);
  }
});

test('cleanup of a whole track lists only what changes, never empties the file name', () => {
  const changes = clean.cleanTrack({ name: 'djsoundtop.com', tags: { title: 'A  B', album: 'x-music.net', artist: 'Prospa' } });
  assert.deepStrictEqual(changes.map((c) => c.field), ['title', 'album']);
  assert.strictEqual(clean.collapseSpaces('a   b  c'), 'a b c');
});

// ------------------------------------------------------------------ preview

test('AIFF preview = the same samples as a WAV, readable in ranges', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pochette-preview-'));
  const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
  const pcm = (f) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-f', 's32le', '-'], { maxBuffer: 1 << 28 });
  for (const [codec, name] of [['pcm_s16be', 'a16.aiff'], ['pcm_s24be', 'a24.aiff']]) {
    const f = path.join(dir, name);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1.5', '-ac', '2', '-c:a', codec, f]);
    const src = previewSource(f);
    assert.strictEqual(src.mime, 'audio/wav');
    // read in odd-sized ranges, like a media player seeking around
    const parts = [];
    for (let pos = 0; pos < src.size; pos += 7777) parts.push(src.read(pos, Math.min(src.size - 1, pos + 7776)));
    const wav = Buffer.concat(parts);
    assert.strictEqual(wav.length, src.size);
    const out = path.join(dir, name + '.wav');
    fs.writeFileSync(out, wav);
    assert.strictEqual(md5(pcm(out)), md5(pcm(f)), `${name}: identical samples`);
  }
  const mp3 = path.join(dir, 'x.mp3');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1', mp3]);
  const s = previewSource(mp3);
  assert.strictEqual(s.mime, 'audio/mpeg');
  assert.ok(s.read(0, 99).equals(fs.readFileSync(mp3).subarray(0, 100)));
});
