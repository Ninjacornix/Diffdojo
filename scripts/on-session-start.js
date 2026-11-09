#!/usr/bin/env node
'use strict';
// SessionStart (async): record the session's diff base (HEAD + a snapshot of
// uncommitted work). Resumed sessions keep their original base.
const { context, guard, rememberPluginRoot } = require('./hook-common');

guard('on-session-start', () => {
  rememberPluginRoot();
  const c = context();
  if (!c) return;
  require('../src/pipeline').startSession(c.root, c.repoId, c.sessionId);
  const store = require('../src/store');
  store.ensureRepo(store.open(), c.root, c.repoId, true); // tracked globally from the first session
});
