'use strict';
// DiffDojo in a folder that is not a git repository: the folder is tracked
// through a shadow repository in DIFFDOJO_HOME and nothing is written into it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isolate, write, fixture, runHook } = require('./helpers');

const home = isolate();
const util = require('../src/util');
const store = require('../src/store');

function plainFolder(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-plain-'));
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  return dir;
}

function waitFor(file) {
  const until = Date.now() + 120000;
  while (!fs.existsSync(file) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  return util.readJson(file, null);
}

test('the project root is the folder itself, but never home or a filesystem root', () => {
  const dir = plainFolder();
  assert.strictEqual(util.findRepoRoot(dir), dir);
  assert.strictEqual(util.findRepoRoot(os.homedir()), null);
  assert.strictEqual(util.findRepoRoot(path.parse(dir).root), null);
  assert.strictEqual(util.findRepoRoot(home), null, "DiffDojo's own data folder is not a project");
  assert.ok(util.shadowGitDir(dir).startsWith(home));
});

test('hooks in a folder without git generate questions about the change', () => {
  const dir = plainFolder({ 'mathutil.py': 'def add(a, b):\n    return a + b\n' });
  const repoId = util.repoId(dir);
  assert.strictEqual(runHook('on-session-start.js', { session_id: 'P1', cwd: dir, source: 'startup' }).status, 0);
  write(dir, 'sched.py', fixture('scheduler.py'));
  assert.strictEqual(runHook('on-edit.js', { session_id: 'P1', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'sched.py') } }).status, 0);
  assert.strictEqual(runHook('on-stop.js', { session_id: 'P1', cwd: dir, hook_event_name: 'Stop' }).status, 0);
  const last = waitFor(path.join(home, repoId, 'last-stop.json'));
  assert.ok(last && last.questions >= 1, `expected questions, got ${JSON.stringify(last)}`);

  const qs = store.open().all('SELECT * FROM questions WHERE repo_id = ?', repoId).map(store.hydrate);
  assert.ok(qs.some((q) => q.code_file === 'sched.py'), 'a question cites the new file');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['mathutil.py', 'sched.py'], 'nothing written into the folder');
});

test('the CLI api answers in a folder without git', () => {
  const dir = plainFolder({ 'a.py': 'x = 1\n' });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'diffdojo'), 'api', 'status'], { cwd: dir, encoding: 'utf8', env: process.env });
  const s = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.battleAllowed, true);
});
