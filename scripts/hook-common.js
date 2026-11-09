'use strict';
// Shared hook prelude. Hooks must never affect Claude Code: they exit 0 on
// every path, never write to stdout, and bail out immediately when the repo
// isn't enabled or when running inside DiffDojo's own `claude -p` child.

const path = require('path');
const util = require('../src/util');

function context() {
  if (process.env.DIFFDOJO_CHILD === '1') return null;
  let input = {};
  try {
    input = JSON.parse(util.readStdin() || '{}');
  } catch {
    return null;
  }
  // Every real hook payload carries a session id; anything else is not from Claude Code.
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.session_id !== 'string') return null;
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = util.findRepoRoot(cwd);
  if (!root) return null;
  const repoId = util.repoId(root);
  if (!util.isEnabled(repoId)) return null;
  return { input, root, repoId, sessionId: input.session_id || 'unknown' };
}

function guard(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      r.catch((e) => util.log(name, e)).finally(() => process.exit(0));
      return;
    }
  } catch (e) {
    util.log(name, e);
  }
  process.exitCode = 0;
}

function rememberPluginRoot() {
  // Lets skills/CLI find the plugin even when ${CLAUDE_PLUGIN_ROOT} isn't substituted.
  try {
    const fs = require('fs');
    const file = path.join(util.home(), 'plugin-root.txt');
    const root = path.resolve(__dirname, '..');
    let cur = null;
    try {
      cur = fs.readFileSync(file, 'utf8');
    } catch {
      /* none */
    }
    if (cur !== root) {
      util.ensureDir(util.home());
      fs.writeFileSync(file, root);
    }
  } catch {
    /* ignore */
  }
}

module.exports = { context, guard, rememberPluginRoot };
