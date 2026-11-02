'use strict';

// Local “ad-hoc” signature: enough to run the app on your own Mac (required on Apple Silicon).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dist = path.join(__dirname, '..', 'dist');
const dirs = fs.existsSync(dist) ? fs.readdirSync(dist).filter((d) => d.startsWith('mac')) : [];
for (const d of dirs) {
  const app = path.join(dist, d, 'Pochette.app');
  if (!fs.existsSync(app)) continue;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`✓ Signed: ${app}`);
}
