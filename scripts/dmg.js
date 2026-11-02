'use strict';

// For each built app: copy it to a temp folder (outside iCloud), sign it, and pack it into a .dmg
// (app + Applications shortcut) with macOS's built-in hdiutil:
//   dist/Pochette-<version>-arm64.dmg  (Apple Silicon)
//   dist/Pochette-<version>-x64.dmg    (Intel)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { version } = require('../package.json');
const { distDir } = require('./arch');
const { sign, cleanCopy } = require('./sign');

const dist = path.join(__dirname, '..', 'dist');
let made = 0;
for (const arch of ['arm64', 'x64']) {
  const app = path.join(dist, distDir(arch), 'Pochette.app');
  if (!fs.existsSync(app)) continue;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `pochette-${arch}-`));
  try {
    const staging = path.join(work, 'Pochette');
    fs.mkdirSync(staging);
    const staged = path.join(staging, 'Pochette.app');
    cleanCopy(app, staged);
    sign(staged);
    fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
    const tmpDmg = path.join(work, `Pochette-${version}-${arch}.dmg`);
    execFileSync('hdiutil', ['create', '-volname', 'Pochette', '-srcfolder', staging, '-ov', '-format', 'UDZO', tmpDmg], { stdio: 'inherit' });
    const out = path.join(dist, path.basename(tmpDmg));
    fs.copyFileSync(tmpDmg, out);
    console.log(`✓ ${path.relative(path.join(dist, '..'), out)}`);
    made++;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
if (!made) throw new Error('No Pochette.app found in dist/');
