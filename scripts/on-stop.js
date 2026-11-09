#!/usr/bin/env node
'use strict';
// Stop (async): hand the turn to a detached background worker and exit at once.
// Detaching matters: Claude Code may exit right after its last turn (e.g. `claude -p`
// or the user quitting), which would otherwise kill generation half-way.
// Claude is never told anything; output is ignored.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { context, guard } = require('./hook-common');

guard('on-stop', () => {
  const c = context();
  if (!c) return;
  const util = require('../src/util');
  const dir = util.ensureDir(path.join(util.repoDir(c.repoId), 'pending'));
  const job = path.join(dir, `stop-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(job, JSON.stringify({
    root: c.root,
    repoId: c.repoId,
    sessionId: c.sessionId,
    transcriptPath: c.input.transcript_path || null,
    lastAssistantMessage: c.input.last_assistant_message || null,
  }));
  if (process.env.DIFFDOJO_STOP_INLINE === '1') {
    // Tests and debugging: run in-process.
    return require('./stop-worker').runJob(job);
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'stop-worker.js'), job], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
});
