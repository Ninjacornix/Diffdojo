#!/usr/bin/env node
'use strict';
// Detached background worker for the Stop hook: diff the turn, analyse it,
// generate and validate questions, store them. Picks up any pending jobs left
// over from earlier interrupted runs ("unfinished work is resumed").

const fs = require('fs');
const path = require('path');
const util = require('../src/util');

async function runJob(jobFile) {
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  } catch {
    return;
  }
  const { load } = require('../src/config');
  const { onStop } = require('../src/pipeline');
  let keep = false;
  try {
    const r = await onStop({ ...job, cfg: load(job.repoId) });
    if (r && r.locked) {
      keep = true; // another worker is busy; a later worker resumes this job
      return;
    }
    util.writeJson(path.join(util.repoDir(job.repoId), 'last-stop.json'), { at: new Date().toISOString(), ...r });
  } catch (e) {
    util.log('stop-worker', e);
  } finally {
    if (!keep) {
      try {
        fs.unlinkSync(jobFile);
      } catch {
        /* already gone */
      }
    }
  }
}

async function main() {
  const first = process.argv[2];
  if (!first) return;
  await runJob(first);
  // Resume older jobs for the same repo that never completed (e.g. the machine slept).
  const dir = path.dirname(first);
  let rest = [];
  try {
    rest = fs.readdirSync(dir).filter((f) => f.startsWith('stop-')).map((f) => path.join(dir, f));
  } catch {
    /* none */
  }
  for (const j of rest) {
    try {
      const age = Date.now() - fs.statSync(j).mtimeMs;
      if (age > 60000) await runJob(j);
    } catch {
      /* gone */
    }
  }
}

if (require.main === module) {
  main()
    .catch((e) => util.log('stop-worker', e))
    .finally(() => process.exit(0));
}

module.exports = { runJob };
