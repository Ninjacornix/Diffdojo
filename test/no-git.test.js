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

test('scores: XP and accuracy across every project, current one marked', async () => {
  const grader = require('../src/grader');
  const a = plainFolder({ 'a.py': 'x = 1\n' });
  const b = plainFolder({ 'b.py': 'y = 2\n' });
  const db = store.open();
  const ask = async (dir, right) => {
    const repoId = util.repoId(dir);
    store.ensureRepo(db, dir, repoId, true);
    const id = store.insertQuestion(db, {
      repo_id: repoId, family: 'questionnaire', type: 'pack', format: 'choice', grading: 'verified', xp: 10, difficulty: 'easy',
      prompt: `Which, in ${path.basename(dir)}, try ${right}?`, choices: { a: 'one', b: 'two' }, answer: 'a', track: 'python',
    });
    await grader.answer(db, store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', id)), right ? 'a' : 'b', { mode: 'normal' });
  };
  await ask(a, true);
  await ask(a, false);
  await ask(b, true);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'diffdojo'), 'api', 'scores'], { cwd: a, encoding: 'utf8', env: process.env });
  const s = JSON.parse(r.stdout.trim().split('\n').pop());
  const pa = s.projects.find((p) => p.path === a);
  const pb = s.projects.find((p) => p.path === b);
  assert.ok(pa && pb, JSON.stringify(s.projects));
  assert.strictEqual(pa.here, true);
  assert.strictEqual(pb.here, false);
  assert.strictEqual(pa.answered, 2);
  assert.strictEqual(pa.accuracy, 50);
  assert.strictEqual(pb.accuracy, 100);
  assert.ok(pa.xp > 0 && pb.xp > 0);
  assert.strictEqual(s.projects.reduce((n, p) => n + p.xp, 0), s.xp, 'the rows add up to the total');
});

test('a No Mercy fight never gates edits in another project, another session, or after it is forgotten', () => {
  const bin = path.join(__dirname, '..', 'bin', 'diffdojo');
  const api = (dir, session, ...args) => {
    const r = spawnSync(process.execPath, [bin, 'api', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, DIFFDOJO_SESSION: session }, input: '' });
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const a = plainFolder({ 'a.py': 'x = 1\n' });
  const b = plainFolder({ 'b.py': 'y = 1\n' });
  const edit = JSON.stringify({ tool: 'Write', file_path: 'c.py', content: 'def f(x):\n    if x < 1:\n        return 0\n    return x\n' });
  const gate = (dir, session) => {
    const r = spawnSync(process.execPath, [bin, 'api', 'gate'], { cwd: dir, encoding: 'utf8', env: { ...process.env, DIFFDOJO_SESSION: session }, input: edit });
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  api(a, 'S1', 'battle-start', 'nomercy');
  assert.strictEqual(api(a, 'S1', 'status').noMercy, true, 'on where it started');
  assert.ok(gate(a, 'S1').id, 'gates edits there');
  // A prompt with no edits, then an interrupted one: still the same session's fight.
  api(a, 'S1', 'battle-turn-end', 'answer');
  api(a, 'S1', 'battle-turn-end', 'aborted');
  assert.strictEqual(api(a, 'S1', 'status').noMercy, true);
  // Another project, same session: never gated.
  assert.strictEqual(api(b, 'S1', 'status').noMercy, false);
  assert.ok(gate(b, 'S1').skip, 'no question in another project');
  // A later session in the same project: not gated, and the leftover fight ends.
  assert.ok(gate(a, 'S2').skip, 'no question in another session');
  api(a, 'S2', 'battle-state');
  assert.strictEqual(require('../src/battle').load().phase, 'menu', 'the leftover fight is over');
  assert.strictEqual(api(a, 'S1', 'status').noMercy, false);
  // A forgotten fight (older than the limit) ends even in its own session.
  api(a, 'S3', 'battle-start', 'nomercy');
  const battle = require('../src/battle');
  const s = battle.load();
  s.owner.at = Date.now() - battle.NOMERCY_MAX_MS - 1000;
  battle.save(s);
  assert.ok(gate(a, 'S3').skip, 'too old: no question');
});
