'use strict';

// Copies Pochette.app to /Applications (replaces a previous version).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dist = path.join(__dirname, '..', 'dist');
const dir = fs.readdirSync(dist).find((d) => d.startsWith('mac') && fs.existsSync(path.join(dist, d, 'Pochette.app')));
if (!dir) throw new Error('Pochette.app not found: run npm run dist first');
const src = path.join(dist, dir, 'Pochette.app');
const dest = '/Applications/Pochette.app';
if (fs.existsSync(dest)) execFileSync('rm', ['-rf', dest]);
execFileSync('ditto', [src, dest]);
console.log(`✓ Installed: ${dest}`);
