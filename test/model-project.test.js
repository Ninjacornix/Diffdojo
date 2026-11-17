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
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const input = fs.readFileSync(0, 'utf8');
const reply = input.includes('Answer each multiple-choice') ? { answers: ['b', 'a'] } : ${JSON.stringify(QUESTIONS)};
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
