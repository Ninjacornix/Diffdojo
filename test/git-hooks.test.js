'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { isolate, makeRepo, write, git: g, runHook } = require('./helpers');

const home = isolate();
const git = require('../src/git');
const util = require('../src/util');
const { collect } = require('../src/pipeline');
const config = require('../src/config');

test('snapshot captures untracked files without touching the real index', () => {
  const repo = makeRepo({ 'a.py': 'x = 1\n' });
  const base = git.snapshot(repo);
  write(repo, 'a.py', 'x = 2\n');
  write(repo, 'new.py', 'def f():\n    return 1\n');
  const now = git.snapshot(repo);
  assert.notStrictEqual(base, now);
  assert.deepStrictEqual(git.changedFiles(repo, base, now).sort(), ['a.py', 'new.py']);
  assert.strictEqual(g(repo, 'diff', '--cached', '--name-only'), '', 'real index untouched');
  assert.ok(g(repo, 'status', '--porcelain').includes('?? new.py'), 'new file still untracked');
});

test('diff across commits and uncommitted changes, parsed with added line numbers', () => {
  const repo = makeRepo({ 'm.py': 'a = 1\nb = 2\n' });
  const base = git.snapshot(repo);
  write(repo, 'm.py', 'a = 1\nb = 3\nc = 4\n');
  g(repo, 'commit', '-qam', 'second');
  write(repo, 'm.py', 'a = 1\nb = 3\nc = 4\nd = 5\n');
  const now = git.snapshot(repo);
  const [d] = git.parseDiff(git.diff(repo, base, now));
  assert.strictEqual(d.file, 'm.py');
  assert.deepStrictEqual(d.added, [2, 3, 4]);
  assert.strictEqual(d.removed, 1);
});

test('collector applies deny globs, size cap and the event file filter', () => {
  const repo = makeRepo({ 'keep.py': 'x = 1\n' });
  const base = git.snapshot(repo);
  write(repo, 'keep.py', 'x = 1\n' + Array.from({ length: 50 }, (_, i) => `v${i} = ${i}`).join('\n') + '\n');
  write(repo, '.env', 'API_KEY=1\n');
  write(repo, 'secrets/token.py', 'T = 1\n');
  write(repo, 'other.py', 'y = 2\n');
  const now = git.snapshot(repo);
  const cfg = { ...config.load(null), maxChangedLines: 20 };
  const all = collect(repo, config.load(null), base, now, null);
  assert.deepStrictEqual(all.map((f) => f.file).sort(), ['keep.py', 'other.py'], '.env and secrets/** are denied');
  const files = collect(repo, cfg, base, now, null);
  assert.strictEqual(files.reduce((n, f) => n + f.added.length, 0), 20, 'size cap applied');
  const only = collect(repo, { ...config.load(null) }, base, now, ['other.py']);
  assert.deepStrictEqual(only.map((f) => f.file), ['other.py']);
});

test('hooks exit 0 silently for repos that are not enabled', () => {
  const repo = makeRepo({ 'a.py': 'x = 1\n' });
  for (const s of ['on-session-start.js', 'on-edit.js', 'on-stop.js']) {
    const r = runHook(s, { session_id: 's', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.py') } });
    assert.strictEqual(r.status, 0, s);
    assert.strictEqual(r.stdout, '', `${s} must not write to stdout`);
  }
  assert.ok(!fs.existsSync(path.join(home, util.repoId(repo), 'events.jsonl')));
});

test('hooks never fail on garbage input and never exit 2', () => {
  for (const s of ['on-session-start.js', 'on-edit.js', 'on-stop.js']) {
    for (const input of ['', 'not json', '{"cwd": 5}', '[]']) {
      const r = runHook(s, input);
      assert.strictEqual(r.status, 0, `${s} with ${JSON.stringify(input)}`);
      assert.strictEqual(r.stdout, '');
    }
  }
});

test('edit hook records only relative paths, honours deny globs, and is fast', () => {
  const repo = makeRepo({ 'a.py': 'x = 1\n' });
  const id = util.repoId(repo);
  fs.mkdirSync(path.join(home, id), { recursive: true });
  fs.writeFileSync(path.join(home, id, 'enabled'), 'x');
  const times = [];
  for (const f of ['a.py', '.env', 'node_modules/x/y.js', '../outside.py']) {
    const r = runHook('on-edit.js', { session_id: 's1', cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(repo, f), content: 'SECRET CONTENT' } });
    assert.strictEqual(r.status, 0);
    times.push(r.ms);
  }
  const events = fs.readFileSync(path.join(home, id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(events.map((e) => e.path), ['a.py']);
  assert.ok(!fs.readFileSync(path.join(home, id, 'events.jsonl'), 'utf8').includes('SECRET'), 'no contents stored');
  assert.deepStrictEqual(Object.keys(events[0]).sort(), ['path', 'session', 'tool', 'ts']);
  times.sort((a, b) => a - b);
  // Includes Node process startup; the hook's own work is a few ms.
  assert.ok(times[1] < 1500, `edit hook too slow: ${times}`);
});

test('DIFFDOJO_CHILD guard makes every hook a no-op', () => {
  const repo = makeRepo({ 'a.py': 'x = 1\n' });
  const id = util.repoId(repo);
  fs.mkdirSync(path.join(home, id), { recursive: true });
  fs.writeFileSync(path.join(home, id, 'enabled'), 'x');
  const r = runHook('on-edit.js', { session_id: 's1', cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(repo, 'a.py') } }, { DIFFDOJO_CHILD: '1' });
  assert.strictEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(home, id, 'events.jsonl')));
});
