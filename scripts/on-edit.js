#!/usr/bin/env node
'use strict';
// PostToolUse on Edit|Write|MultiEdit (async): append {ts, path, session} to
// events.jsonl. File paths and timestamps only — never contents or tool output.
const fs = require('fs');
const path = require('path');
const { context, guard } = require('./hook-common');

const MID_TURN_MS = 45000; // at most one mid-turn generation per 45 s

guard('on-edit', () => {
  const c = context();
  if (!c) return;
  const ti = c.input.tool_input || {};
  const paths = [ti.file_path, ti.path, ti.notebook_path].concat((ti.edits || []).map((e) => e && e.file_path)).filter(Boolean);
  if (!paths.length) return;
  const { load } = require('../src/config');
  const { matchesAny } = require('../src/glob');
  const cfg = load(c.repoId);
  const lines = [];
  for (const p of [...new Set(paths)]) {
    const abs = path.resolve(c.input.cwd || c.root, p);
    const rel = path.relative(c.root, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (matchesAny(rel, cfg.deny)) continue;
    lines.push(JSON.stringify({ ts: new Date().toISOString(), path: rel, session: c.sessionId, tool: c.input.tool_name || null }));
  }
  if (!lines.length) return;
  const util = require('../src/util');
  const dir = util.ensureDir(util.repoDir(c.repoId));
  fs.appendFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');

  // Questions while Claude works: generate in the background from the edits
  // so far, at most once per MID_TURN_MS. The Stop hook covers the rest.
  if (cfg.quiet || process.env.DIFFDOJO_NO_MIDTURN === '1') return;
  const mark = path.join(dir, 'last-midturn');
  let last = 0;
  try {
    last = fs.statSync(mark).mtimeMs;
  } catch {
    /* never ran */
  }
  if (Date.now() - last < MID_TURN_MS) return;
  fs.writeFileSync(mark, new Date().toISOString());
  const job = path.join(util.ensureDir(path.join(dir, 'pending')), `edit-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(job, JSON.stringify({ root: c.root, repoId: c.repoId, sessionId: c.sessionId, transcriptPath: c.input.transcript_path || null, lastAssistantMessage: null }));
  const { spawn } = require('child_process');
  spawn(process.execPath, [path.join(__dirname, 'stop-worker.js'), job], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
});
