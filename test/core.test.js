'use strict';

/*
 * Tag engine tests. Requires ffmpeg/ffprobe (brew install ffmpeg) to generate
 * the test files and to check, with an independent reader, that the audio is intact.
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
require('../src/i18n').setLang('en'); // the messages checked below are in English
const core = require('../src/core');
const iff = require('../src/core/iff');
const { FileSource, imageSize } = require('../src/core/util');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pochette-test-'));
const ff = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { cwd: dir });
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', f], { cwd: dir }).toString());
const pcmMd5 = (f) => require('crypto').createHash('md5')
  .update(execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-map', '0:a', '-f', 's32le', '-'], { cwd: dir, maxBuffer: 1 << 28 }))
  .digest('hex');
const P = (f) => path.join(dir, f);

ff('-f', 'lavfi', '-i', 'mandelbrot=size=600x600:rate=1', '-frames:v', '1', 'cover.jpg');
ff('-f', 'lavfi', '-i', 'sine=f=440:d=2', '-ac', '2', '-c:a', 'pcm_s16le', '-metadata', 'title=Vieux Titre', '-metadata', 'artist=Old', 's16.wav');
ff('-f', 'lavfi', '-i', 'sine=f=330:d=2', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s24le', 's24.wav');
ff('-f', 'lavfi', '-i', 'sine=f=220:d=2', '-ac', '2', '-c:a', 'pcm_s16be', 'native.aiff');
ff('-f', 'lavfi', '-i', 'sine=f=550:d=2', '-i', 'cover.jpg', '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata', 'title=Café Dé', '-metadata', 'TBPM=124', '-id3v2_version', '4', 't.mp3');
ff('-f', 'lavfi', '-i', 'sine=f=660:d=2', '-c:a', 'flac', '-metadata', 'title=Flac T', 't.flac');
const coverJpg = { data: fs.readFileSync(P('cover.jpg')), mime: 'image/jpeg' };

const tags = {
  title: 'Sunshine (Extended Mix)', artist: 'Chinonegro, Rob The Bank', album: 'Bombero Calling — EP', albumArtist: 'Chinonegro',
  genre: 'Tech House', year: '2026', track: '3', bpm: '126', key: '8A', label: 'Club Sweat', comment: 'Peak time — café, déjà vu, Ünïcode ✨',
};

for (const f of ['s16.wav', 's24.wav', 'native.aiff', 't.mp3', 't.flac']) {
  test(`write + read back: ${f}`, () => {
    const before = pcmMd5(P(f));
    core.write(P(f), { tags, cover: coverJpg });
    const r = core.read(P(f));
    for (const k of Object.keys(tags)) {
      const expected = r.format === 'wav' && ['albumArtist', 'bpm', 'key', 'label'].includes(k) ? tags[k] : tags[k];
      assert.strictEqual(r.tags[k], expected, `${f} ${k}`);
    }
    assert.ok(r.cover, 'cover present');
    assert.ok(r.cover.data.equals(coverJpg.data), 'same cover');
    assert.strictEqual(pcmMd5(P(f)), before, 'audio intact');
    // independent read-back with ffprobe
    const p = probe(P(f));
    const t = Object.fromEntries(Object.entries(p.format.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
    assert.strictEqual(t.title, tags.title);
    assert.strictEqual(t.artist, tags.artist);
  });
}

test('WAV: INFO block (read by rekordbox) + "id3 " chunk at the end of the file', () => {
  const src = new FileSource(P('s16.wav'));
  const { chunks } = iff.listChunks(src);
  const ids = chunks.map((c) => c.id + (c.listType ? ':' + c.listType : ''));
  const info = chunks.find((c) => c.listType === 'INFO');
  const infoText = src.read(info.dataPos, info.size).toString('latin1');
  src.close();
  assert.deepStrictEqual(ids.slice(-2), ['LIST:INFO', 'id3 ']);
  assert.ok(infoText.includes('INAM') && infoText.includes('Sunshine (Extended Mix)'));
  assert.strictEqual(ids.filter((i) => i === 'LIST:INFO').length, 1, 'old INFO replaced, not duplicated');
});

test('second save: fast rewrite at the end of the file, correct RIFF size', () => {
  const size1 = fs.statSync(P('s16.wav')).size;
  core.write(P('s16.wav'), { tags: { ...tags, title: 'X' } });
  core.write(P('s16.wav'), { tags: { ...tags, title: 'A much longer title than before, with accents éàü' } });
  const buf = fs.readFileSync(P('s16.wav'));
  assert.strictEqual(buf.readUInt32LE(4), buf.length - 8);
  const r = core.read(P('s16.wav'));
  assert.strictEqual(r.tags.title, 'A much longer title than before, with accents éàü');
  assert.ok(r.cover, 'the cover is kept when it is not touched');
  assert.ok(Math.abs(fs.statSync(P('s16.wav')).size - size1) < 400);
});

test('removing the cover and clearing fields', () => {
  core.write(P('t.mp3'), { tags: { ...tags, label: '' }, cover: null });
  const r = core.read(P('t.mp3'));
  assert.strictEqual(r.cover, null);
  assert.strictEqual(r.tags.label, '');
  assert.strictEqual(r.tags.bpm, '126');
});

test('lossless WAV → AIFF conversion, tags + cover', () => {
  for (const f of ['s16.wav', 's24.wav']) {
    core.write(P(f), { tags, cover: coverJpg });
    const r = core.read(P(f));
    const out = core.wavToAiff(P(f), { tags: r.tags, cover: r.cover });
    assert.strictEqual(pcmMd5(out), pcmMd5(P(f)), `${f}: identical samples`);
    const a = core.read(out);
    assert.strictEqual(a.format, 'aiff');
    assert.strictEqual(a.tags.title, tags.title);
    assert.strictEqual(a.tags.key, '8A');
    assert.ok(a.cover.data.equals(coverJpg.data));
    const s = probe(out).streams.find((x) => x.codec_type === 'audio');
    assert.strictEqual(+s.sample_rate, r.audio.sampleRate);
    assert.throws(() => core.wavToAiff(P(f), { tags: r.tags, cover: r.cover }), /already exists/);
  }
});

test('reading ID3v2.4 UTF-8 (file written by ffmpeg), then keeping unknown frames', () => {
  ff('-f', 'lavfi', '-i', 'sine=f=500:d=1', '-c:a', 'libmp3lame', '-metadata', 'title=Été 2026', '-metadata', 'TXXX=Note', '-metadata', 'mood=Groovy', '-id3v2_version', '4', 'v24.mp3');
  const r = core.read(P('v24.mp3'));
  assert.strictEqual(r.tags.title, 'Été 2026');
  core.write(P('v24.mp3'), { tags: { ...r.tags, artist: 'Ünïcode' } });
  const p = probe(P('v24.mp3'));
  const t = Object.fromEntries(Object.entries(p.format.tags).map(([k, v]) => [k.toLowerCase(), v]));
  assert.strictEqual(t.title, 'Été 2026');
  assert.strictEqual(t.artist, 'Ünïcode');
  assert.strictEqual(t.mood, 'Groovy', 'TXXX kept');
});

test('JPEG dimensions', () => {
  const s = imageSize(coverJpg.data);
  assert.deepStrictEqual([s.width, s.height], [600, 600]);
});

test('Finder icon: transparent margin, rounded corners, opaque center', () => {
  const { composeIcon, SIZE, BOX } = require('../src/core/icon');
  const out = composeIcon(Buffer.alloc(BOX * BOX * 4, 255));
  const alpha = (x, y) => out[(y * SIZE + x) * 4 + 3];
  assert.strictEqual(out.length, SIZE * SIZE * 4);
  assert.strictEqual(alpha(512, 512), 255, 'opaque center');
  assert.strictEqual(alpha(5, 5), 0, 'transparent margin');
  assert.ok(alpha(73, 73) < 128, 'rounded corner (no solid pixel in the corner)');
  assert.ok(alpha(512, 960) > 0 && alpha(512, 960) < 120, 'shadow under the icon');
});

test('FLAC → AIFF conversion (16 and 24-bit): identical sound, tags and cover copied', async () => {
  const { toAiff } = require('../src/convert');
  ff('-f', 'lavfi', '-i', 'sine=f=300:d=2', '-ac', '2', '-c:a', 'flac', 'f16.flac');
  ff('-f', 'lavfi', '-i', 'sine=f=350:d=2', '-ac', '2', '-ar', '96000', '-c:a', 'pcm_s24le', 'f24src.wav');
  ff('-i', 'f24src.wav', '-c:a', 'flac', 'f24.flac');
  for (const f of ['f16.flac', 'f24.flac']) {
    core.write(P(f), { tags, cover: coverJpg });
    const src = core.read(P(f));
    const out = await toAiff(P(f), { tools: ['ffmpeg'] }); // afconvert only exists on macOS
    const a = core.read(out);
    assert.strictEqual(pcmMd5(out), pcmMd5(P(f)), `${f}: identical samples`);
    assert.strictEqual(a.audio.bits, src.audio.bits);
    assert.strictEqual(a.audio.sampleRate, src.audio.sampleRate);
    assert.strictEqual(a.tags.title, tags.title);
    assert.strictEqual(a.tags.comment, tags.comment);
    assert.ok(a.cover && a.cover.data.equals(coverJpg.data), 'cover copied');
    await assert.rejects(toAiff(P(f), { tools: ['ffmpeg'] }), /already exists/);
  }
  await assert.rejects(toAiff(P('t.mp3')), /only WAV and FLAC/);
});
