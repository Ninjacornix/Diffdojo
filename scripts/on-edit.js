#!/usr/bin/env node
'use strict';
// PostToolUse on Edit|Write|MultiEdit (async): append {ts, path, session} to
// events.jsonl. File paths and timestamps only — never contents or tool output.
const fs = require('fs');
const path = require('path');
const { context, guard } = require('./hook-common');

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
  if (lines.length) {
    const util = require('../src/util');
    fs.appendFileSync(path.join(util.ensureDir(util.repoDir(c.repoId)), 'events.jsonl'), lines.join('\n') + '\n');
  }
});
