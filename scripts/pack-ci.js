#!/usr/bin/env node
'use strict';
// Pack CI: schema validation, one unambiguous answer, duplicate detection,
// and compile-and-run of every predict_output snippet so "what does this
// print" answers are machine-verified.  Usage: node scripts/pack-ci.js [--no-run]

const packs = require('../src/packs');
const { runDeterministic, normalizeOutput } = require('../src/runner');

const noRun = process.argv.includes('--no-run');
const p = packs.load({ fresh: true });
let problems = 0;
for (const e of p.errors) {
  console.log(`✗ ${e.file}${e.id ? ` [${e.id}]` : ''}: ${e.error}`);
  problems++;
}
for (const [a, b] of packs.duplicates(p.questions)) {
  console.log(`✗ duplicate question: ${a} / ${b}`);
  problems++;
}
let ran = 0;
let skipped = 0;
if (!noRun) {
  for (const q of p.questions.filter((x) => x.format === 'predict_output')) {
    const r = runDeterministic(q.code, q.language, { timeoutSec: 20 });
    if (r.stage === 'unsupported') {
      skipped++;
      console.log(`- ${q.id}: skipped (${r.stderr})`);
      continue;
    }
    ran++;
    if (!r.ok) {
      problems++;
      console.log(`✗ ${q.id}: snippet failed at ${r.stage}: ${(r.stderr || '').slice(0, 300)}`);
    } else if (!r.deterministic) {
      problems++;
      console.log(`✗ ${q.id}: output is not deterministic`);
    } else if (normalizeOutput(r.stdout) !== normalizeOutput(q.answer)) {
      problems++;
      console.log(`✗ ${q.id}: answer "${q.answer}" but the snippet prints "${normalizeOutput(r.stdout)}"`);
    }
  }
}
const byPack = {};
for (const q of p.questions) byPack[q.pack] = (byPack[q.pack] || 0) + 1;
console.log(`\n${p.questions.length} questions in ${Object.keys(byPack).length} packs: ${Object.entries(byPack).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`${ran} snippets executed${skipped ? `, ${skipped} skipped (toolchain missing)` : ''}; ${problems} problem${problems === 1 ? '' : 's'}.`);
process.exitCode = problems ? 1 : 0;
