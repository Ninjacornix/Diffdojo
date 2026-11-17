'use strict';
// Claude's questions about the change: a cheap model writes them with `claude -p`
// and a blind second call answers them; only agreed questions are kept.
// A fake `claude` on PATH stands in for the real CLI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isolate, makeRepo, write, fixture, git: g } = require('./helpers');

const home = isolate();
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-fake-claude-'));
const argsLog = path.join(bin, 'args.log');

// Two questions; the blind call agrees only with the first.
const QUESTIONS = {
  questions: [
    { question: 'Why does `add` use heapq.heappush on self.jobs?', file: 'sched.py', line_start: 12, line_end: 14,
      choices: { a: 'To sort by owner', b: 'To keep the earliest job at index 0', c: 'To remove duplicates', d: 'To make it thread-safe' },
      answer: 'b', explanation: 'heappush keeps the list a min-heap ordered by `when`.', difficulty: 'medium' },
    { question: 'What does due() return when no job is due?', file: 'sched.py', line_start: 16, line_end: 22,
      choices: { a: 'None', b: 'It raises', c: 'An empty list', d: 'The next job' },
      answer: 'c', explanation: 'out starts empty.', difficulty: 'easy' },
  ],
};
fs.writeFileSync(path.join(bin, 'claude.js'), `
const fs = require('fs');
if (process.env.FAKE_REJECT && process.argv.includes(process.env.FAKE_REJECT)) {
  process.stderr.write("error: unknown option '" + process.env.FAKE_REJECT + "'\\n");
  process.exit(1);
}
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2).concat(['@cwd', process.cwd()])) + '\\n');
const input = fs.readFileSync(0, 'utf8');
const TOPIC = { questions: [
  { question: 'What does EPOLLET change?', choices: { a: 'Nothing', b: 'Edge-triggered: you are told once per change, so read until EAGAIN', c: 'It blocks', d: 'It closes the fd' }, answer: 'b', explanation: 'Edge-triggered.', difficulty: 'medium' },
  { question: 'Which call adds an fd to an epoll set?', choices: { a: 'epoll_wait', b: 'epoll_create1', c: 'epoll_ctl with EPOLL_CTL_ADD', d: 'poll' }, answer: 'c', explanation: 'epoll_ctl.', difficulty: 'easy' },
] };
const reply = input.includes('Answer each multiple-choice') ? (input.includes('EPOLLET') ? { answers: ['b', 'c'] } : { answers: ['b', 'a'] }) : input.includes('technical questions about:') ? TOPIC : ${JSON.stringify(QUESTIONS)};
process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify(reply) }));
`);
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec node "${path.join(bin, 'claude.js')}" "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'claude.cmd'), `@node "%~dp0claude.js" %*\r\n`);
process.env.PATH = bin + path.delimiter + process.env.PATH;
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: { enabled: true } }));

const util = require('../src/util');
const store = require('../src/store');
const config = require('../src/config');
const pipeline = require('../src/pipeline');

test('the model path is on by default and uses a cheap model', () => {
  const defaults = require('../src/config').DEFAULTS;
  assert.strictEqual(defaults.model.enabled, true);
  assert.match(defaults.model.model, /haiku/);
});

test("Claude's questions about the change come first; ones the blind check disagrees with are dropped", async () => {
  const repo = makeRepo({ 'sched.py': 'x = 1\n' });
  const repoId = util.repoId(repo);
  const db = store.open();
  const from = require('../src/git').snapshot(repo);
  write(repo, 'sched.py', fixture('scheduler.py'));
  const to = require('../src/git').snapshot(repo);
  const r = await pipeline.generate({ db, root: repo, repoId, sessionId: 'M1', cfg: config.load(repoId), fromTree: from, toTree: to, onlyFiles: ['sched.py'] });
  assert.ok(r.questions >= 1);

  const qs = db.all('SELECT * FROM questions WHERE repo_id = ? ORDER BY id', repoId).map(store.hydrate);
  const mine = qs.filter((q) => q.type === 'project');
  assert.strictEqual(mine.length, 1, 'only the question both calls agree on is kept');
  assert.strictEqual(qs[0].type, 'project', "Claude's question is first in the queue");
  assert.match(mine[0].prompt, /heapq\.heappush/);
  assert.strictEqual(mine[0].answer, 'b');
  assert.strictEqual(mine[0].grading, 'model');
  assert.strictEqual(mine[0].code_file, 'sched.py');
  assert.match(mine[0].code, /heappush/, 'shows the lines it is about');

  const calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(calls.length, 2, 'one call writes, one call checks (no extra algorithm call)');
  for (const a of calls) {
    assert.ok(a.includes('-p'));
    assert.strictEqual(a[a.indexOf('--model') + 1], 'claude-haiku-5-5');
    // Isolated: not a session in the user's project.
    for (const f of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(a.includes(f), f);
    assert.strictEqual(a[a.indexOf('--setting-sources') + 1], 'user');
    const cwd = a[a.indexOf('@cwd') + 1];
    assert.ok(!cwd.startsWith(repo) && /diffdojo-claude-/.test(cwd), `runs from a temp folder, not the project: ${cwd}`);
  }
  assert.strictEqual(g(repo, 'status', '--porcelain').includes('diffdojo'), false);
});

test('battles ask Claude\'s project questions', () => {
  const battle = require('../src/battle');
  const db = store.open();
  const repoId = db.get("SELECT repo_id FROM questions WHERE type = 'project'").repo_id;
  battle.start('professional');
  const r = battle.nextQuestion(db, { repoId, rnd: () => 0.9 });
  assert.strictEqual(r.question.type, 'project');
});

test('model.enabled false keeps everything local', async () => {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: { enabled: false } }));
  fs.writeFileSync(argsLog, '');
  const repo = makeRepo({ 'a.py': 'x = 1\n' });
  const repoId = util.repoId(repo);
  const git = require('../src/git');
  const from = git.snapshot(repo);
  write(repo, 'a.py', fixture('scheduler.py'));
  await pipeline.generate({ db: store.open(), root: repo, repoId, sessionId: 'M2', cfg: config.load(repoId), fromTree: from, toTree: git.snapshot(repo), onlyFiles: ['a.py'] });
  assert.strictEqual(fs.readFileSync(argsLog, 'utf8'), '', 'claude was never called');
});

test('Prepare: Claude writes questions on a topic in advance, checked blind, with the model and effort set', async () => {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: { enabled: true, model: 'claude-sonnet-5-5', effort: 'medium' } }));
  fs.writeFileSync(argsLog, '');
  const { spawnSync } = require('child_process');
  const dir = makeRepo({ 'a.py': 'x = 1\n' });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'diffdojo'), 'api', 'prepare', 'epoll', 'edge', 'triggered'], { cwd: dir, encoding: 'utf8', env: process.env });
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepStrictEqual([out.added, out.via], [2, 'claude'], r.stderr);
  const calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(calls.length, 2);
  for (const a of calls) {
    assert.strictEqual(a[a.indexOf('--model') + 1], 'claude-sonnet-5-5');
    assert.strictEqual(a[a.indexOf('--effort') + 1], 'medium');
  }
  const qs = store.open().all("SELECT * FROM questions WHERE type = 'prepared'").map(store.hydrate);
  assert.strictEqual(qs.length, 2);
  assert.ok(qs.every((q) => q.topic === 'prepared/epoll-edge-triggered' && q.grading === 'model'));
});

test('Prepare without Claude picks questions on the topic from the packs', () => {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: { enabled: false } }));
  fs.writeFileSync(argsLog, '');
  const { spawnSync } = require('child_process');
  const dir = makeRepo({ 'a.py': 'x = 1\n' });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'diffdojo'), 'api', 'prepare', 'epoll'], { cwd: dir, encoding: 'utf8', env: process.env });
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(out.via, 'packs');
  assert.ok(out.added > 0);
  assert.strictEqual(fs.readFileSync(argsLog, 'utf8'), '', 'claude was not called');
});

test('an older claude CLI that rejects a flag still gets the call, without that flag', async () => {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: { enabled: true } }));
  fs.writeFileSync(argsLog, '');
  process.env.FAKE_REJECT = '--disable-slash-commands';
  try {
    const db = store.open();
    const out = await require('../src/model').call(db, config.load(null), 'test', 'Say hi', { type: 'object', additionalProperties: true, required: [], properties: {} });
    assert.ok(out);
    const a = JSON.parse(fs.readFileSync(argsLog, 'utf8').trim().split('\n').pop());
    assert.ok(!a.includes('--disable-slash-commands'));
    assert.ok(a.includes('--no-session-persistence'));
  } finally {
    delete process.env.FAKE_REJECT;
  }
});
