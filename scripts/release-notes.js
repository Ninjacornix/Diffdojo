#!/usr/bin/env node
'use strict';
// Prints one version's section of CHANGELOG.md (used by .github/workflows/release.yml).
//   node scripts/release-notes.js 0.4.0
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('usage: release-notes.js <version>');
  process.exit(1);
}
const lines = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
const install = [
  '',
  '---',
  '',
  'Install in Claude Code: `/plugin install diffdojo --marketplace Ninjacornix/Diffdojo`. Already installed? `/plugin update`, then restart Claude Code.',
];
process.stdout.write(`${body}\n${install.join('\n')}\n`);
