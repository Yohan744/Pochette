'use strict';

// Local “ad-hoc” signature: enough to run the app on a Mac (required on Apple Silicon).
// Always sign a copy OUTSIDE iCloud Drive (Desktop/Documents may be synced): iCloud keeps adding
// extended attributes to files, and codesign rejects them (“resource fork, Finder information…”).
const { execFileSync } = require('child_process');

function sign(app) {
  execFileSync('xattr', ['-cr', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}

/** Copies an app without extended attributes / resource forks. */
function cleanCopy(src, dest) {
  execFileSync('ditto', ['--norsrc', '--noextattr', src, dest], { stdio: 'inherit' });
}

module.exports = { sign, cleanCopy };
