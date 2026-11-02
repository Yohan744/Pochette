'use strict';

// Copies Pochette.app (built for this Mac's CPU) to /Applications and signs it there.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nativeArch, distDir } = require('./arch');
const { sign, cleanCopy } = require('./sign');

const src = path.join(__dirname, '..', 'dist', distDir(nativeArch()), 'Pochette.app');
if (!fs.existsSync(src)) throw new Error('Pochette.app not found: run npm run dist first');
const dest = '/Applications/Pochette.app';
if (fs.existsSync(dest)) execFileSync('rm', ['-rf', dest]);
cleanCopy(src, dest);
sign(dest);
console.log(`✓ Installed: ${dest}`);
