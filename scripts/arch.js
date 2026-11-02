'use strict';

// Real CPU of this Mac, even when Node itself runs as Intel under Rosetta.
const { execFileSync } = require('child_process');

function nativeArch() {
  try {
    return execFileSync('sysctl', ['-n', 'hw.optional.arm64']).toString().trim() === '1' ? 'arm64' : 'x64';
  } catch {
    return process.arch === 'arm64' ? 'arm64' : 'x64';
  }
}

// electron-builder output folder for an arch: dist/mac (x64) or dist/mac-arm64
const distDir = (arch) => (arch === 'arm64' ? 'mac-arm64' : 'mac');

module.exports = { nativeArch, distDir };
