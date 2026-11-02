'use strict';

// Builds Pochette.app for this Mac's real CPU (Apple Silicon or Intel) into dist/.
const { execFileSync } = require('child_process');
const { nativeArch } = require('./arch');

const arch = nativeArch();
console.log(`• Building for ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'} (${arch})`);
execFileSync('npx', ['electron-builder', '--mac', 'dir', `--${arch}`, '--publish', 'never'], { stdio: 'inherit' });
