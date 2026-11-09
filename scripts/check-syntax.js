#!/usr/bin/env node
'use strict';
// Syntax-check every JavaScript file in the plugin (used by `npm run lint`).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.js$/.test(e.name) || p === path.join(root, 'bin', 'diffdojo')) files.push(p);
  }
})(root);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad++;
    console.log(r.stderr);
  }
}
console.log(`${files.length} files checked, ${bad} with syntax errors.`);
process.exitCode = bad ? 1 : 0;
