'use strict';
// End-to-end: real hook scripts against a throwaway repo, then grading,
// killing tests, bug reports, the web server, badge, export and purge.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { isolate, makeRepo, write, fixture, runHook, git: g } = require('./helpers');

const home = isolate();
const util = require('../src/util');
const store = require('../src/store');
const config = require('../src/config');
const grader = require('../src/grader');
const queue = require('../src/queue');
const { commands } = require('../src/cli');

function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

// A small JS project with node:test so killing tests and bug reports can run anywhere Node runs.
const LIB_V1 = 'function clamp(x, lo, hi) {\n  return x;\n}\nmodule.exports = { clamp };\n';
const LIB_V2 = [
  'function clamp(x, lo, hi) {',
  '  if (x < lo) {',
  '    return lo;',
  '  }',
  '  if (x > hi) {',
  '    return hi;',
  '  }',
  '  return x;',
  '}',
  '',
  'function inRange(xs, lo, hi) {',
  '  let n = 0;',
  '  for (let i = 0; i < xs.length; i++) {',
  '    if (clamp(xs[i], lo, hi) === xs[i]) n++;',
  '  }',
  '  return n;',
  '}',
  'module.exports = { clamp, inRange };',
  '',
].join('\n');
const TEST_V1 = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { clamp } = require('../lib.js');\ntest('mid', () => assert.strictEqual(clamp(5, 0, 10), 5));\n";

let repo;
let repoId;
const transcript = path.join(os.tmpdir(), `dd-transcript-${process.pid}.jsonl`);

test('enable + session start + edits + stop generate questions in the background', () => {
  repo = makeRepo({ 'lib.js': LIB_V1, 'test/lib.test.js': TEST_V1, 'package.json': '{"name":"t"}\n' });
  repoId = util.repoId(repo);
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    quiet(() => commands.enable({ flags: { 'test-cmd': 'node --test' } }));
  } finally {
    process.chdir(cwd);
  }
  assert.ok(util.isEnabled(repoId));
  assert.strictEqual(config.load(repoId).testCommand, 'node --test');
  assert.strictEqual(g(repo, 'status', '--porcelain'), '', 'nothing written into the repository');

  assert.strictEqual(runHook('on-session-start.js', { session_id: 'S1', cwd: repo, source: 'startup' }).status, 0);
  write(repo, 'lib.js', LIB_V2);
  write(repo, 'sched.py', fixture('scheduler.py'));
  for (const f of ['lib.js', 'sched.py']) {
    assert.strictEqual(runHook('on-edit.js', { session_id: 'S1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, f) } }).status, 0);
  }
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', version: '2.1.319', uuid: 'u1', message: { role: 'user', content: 'make clamp real' } }),
    JSON.stringify({ type: 'assistant', version: '2.1.319', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'I rewrote clamp in lib.js to check both bounds explicitly so that out-of-range values are pinned to the nearest limit. I added inRange to count values that clamp leaves unchanged because the dashboard needs that number.' }] } }),
  ].join('\n'));
  // Real mode: the hook hands off to a detached worker and returns immediately.
  const r = runHook('on-stop.js', { session_id: 'S1', cwd: repo, transcript_path: transcript, hook_event_name: 'Stop' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.ok(r.ms < 2000, `stop hook should return immediately (took ${r.ms} ms)`);
  const lastFile = path.join(home, repoId, 'last-stop.json');
  const until = Date.now() + 120000;
  while (!fs.existsSync(lastFile) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  const last = util.readJson(lastFile, null);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, repoId, 'pending')), [], 'job file cleaned up');
  assert.ok(last, 'stop hook recorded its run');
  assert.ok(last.questions >= 3, `expected questions, got ${JSON.stringify(last)}`);
  assert.strictEqual(fs.existsSync(path.join(home, 'logs')) ? fs.readdirSync(path.join(home, 'logs')).length : 0, 0, 'no errors logged');

  const db = store.open();
  const qs = db.all('SELECT * FROM questions WHERE repo_id = ?', repoId).map(store.hydrate);
  const fams = new Set(qs.map((q) => q.family));
  assert.ok(fams.has('code') && fams.has('design'), `families: ${[...fams]}`);
  for (const q of qs.filter((x) => x.family !== 'questionnaire')) {
    assert.ok(q.code_file, `${q.type} cites a file`);
  }
  for (const q of qs.filter((x) => x.family === 'questionnaire')) assert.ok(q.meta.selectedBy, 'questionnaire shows which topic selected it');
  const why = qs.find((q) => q.type === 'why');
  assert.ok(why, 'why question from the transcript');
  assert.match(why.explanation, /Claude said \(turn 1\)/);
  assert.ok(db.get('SELECT COUNT(*) AS n FROM rationale').n >= 1);
  // A second Stop with no new edits doesn't regenerate code questions.
  const before = db.get('SELECT COUNT(*) AS n FROM questions WHERE family = ?', 'code').n;
  runHook('on-stop.js', { session_id: 'S1', cwd: repo, transcript_path: transcript }, { DIFFDOJO_STOP_INLINE: '1' });
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM questions WHERE family = ?', 'code').n, before);
});

test('seeded bug answers are graded against the known mutation', async () => {
  const db = store.open();
  const q = store.hydrate(db.get("SELECT * FROM questions WHERE type = 'seeded_bug' AND repo_id = ? LIMIT 1", repoId));
  assert.ok(q, 'a seeded bug question exists');
  assert.ok(q.code.split('\n').length <= 60, 'excerpt capped');
  const wrongLine = q.code.split('\n').length + 5;
  const bad = await grader.answer(db, q, String(wrongLine), { cfg: config.load(repoId), root: repo });
  assert.strictEqual(bad.correct, false);
  const good = await grader.answer(db, { ...q }, String(q.answer.lines[0]), { cfg: config.load(repoId), root: repo });
  assert.strictEqual(good.correct, true);
  assert.ok(good.xp >= 10);
});

test('killing test: must pass on the original and fail on the hidden mutant', async () => {
  const db = store.open();
  const codeGen = require('../src/generators/code');
  const unit = db.all("SELECT * FROM code_units WHERE repo_id = ? AND name = 'inRange'", repoId)[0];
  assert.ok(unit, 'inRange stored as a code unit');
  const ctx = { root: repo, cfg: config.load(repoId) };
  const kq = codeGen.killTest(ctx, unit, { categories: ['basic'], rnd: util.rng(7), budget: { testRuns: 6, deadline: Date.now() + 120000 } });
  assert.ok(kq, 'kill-test question generated (mutant survives the existing suite)');
  const id = store.insertQuestion(db, { ...kq, repo_id: repoId });
  const q = store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', id));
  // A test that doesn't exercise the mutant is rejected.
  write(repo, 'test/weak.test.js', TEST_V1.replace("'mid'", "'weak'"));
  const weak = await grader.answer(db, q, 'test/weak.test.js', { cfg: ctx.cfg, root: repo });
  assert.strictEqual(weak.correct, false);
  assert.match(weak.detail, /still pass on the mutant/);
  // A thorough test kills any clamp mutant.
  write(repo, 'test/strong.test.js', [
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "const { clamp, inRange } = require('../lib.js');",
    "test('bounds', () => {",
    '  assert.strictEqual(clamp(-1, 0, 10), 0);',
    '  assert.strictEqual(clamp(0, 0, 10), 0);',
    '  assert.strictEqual(clamp(11, 0, 10), 10);',
    '  assert.strictEqual(clamp(10, 0, 10), 10);',
    '  assert.strictEqual(clamp(3, 0, 10), 3);',
    '  assert.strictEqual(clamp(3, 5, 10), 5);',
    '  assert.strictEqual(inRange([1, 5, 20], 0, 10), 2);',
    '});',
    '',
  ].join('\n'));
  const strong = await grader.answer(db, { ...q }, 'test/strong.test.js', { cfg: ctx.cfg, root: repo });
  assert.strictEqual(strong.correct, true, strong.detail);
  assert.strictEqual(strong.xp, 30);
  fs.unlinkSync(path.join(repo, 'test/weak.test.js'));
  fs.unlinkSync(path.join(repo, 'test/strong.test.js'));
  assert.ok(fs.readFileSync(path.join(repo, 'lib.js'), 'utf8') === LIB_V2, 'working tree never mutated');
});

test('bug report: confirmed only when the test fails on the current code', () => {
  const db = store.open();
  const bugs = require('../src/bugs');
  const cfg = config.load(repoId);
  write(repo, 'test/passing.test.js', TEST_V1);
  const no = bugs.report(db, { root: repo, repoId, cfg, title: 'not a bug', file: 'lib.js', testPath: 'test/passing.test.js' });
  assert.strictEqual(no.confirmed, false);
  write(repo, 'test/bug.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst { inRange } = require('../lib.js');\ntest('empty', () => assert.strictEqual(inRange([NaN], 0, 1), 1));\n");
  const yes = bugs.report(db, { root: repo, repoId, cfg, title: 'inRange rejects NaN', file: 'lib.js', lines: '11-17', testPath: 'test/bug.test.js' });
  assert.strictEqual(yes.confirmed, true, yes.reason);
  assert.strictEqual(yes.xp, 50);
  assert.ok(yes.fromClaude, 'lines are inside a recorded Claude change');
  assert.ok(fs.existsSync(yes.reportPath) && yes.reportPath.startsWith(path.join(home, repoId, 'bugs')));
  assert.match(fs.readFileSync(yes.reportPath, 'utf8'), /## Failing test/);
  assert.ok(yes.trophies.some((t) => t.id === 'first-catch'));
  const sc = bugs.scaffold(repo, { file: 'lib.js', fn: 'inRange', title: 'NaN' });
  assert.strictEqual(sc.framework, 'node:test');
  assert.match(sc.code, /require\('node:test'\)/);
  fs.unlinkSync(path.join(repo, 'test/passing.test.js'));
  fs.unlinkSync(path.join(repo, 'test/bug.test.js'));
});

function request(port, pathname, { method = 'GET', body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: host || `127.0.0.1:${port}`, 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('web UI: localhost + token only, answer keys never sent before grading', async () => {
  const db = store.open();
  const s = await require('../src/server').start({ db, repoId, root: repo });
  try {
    assert.strictEqual(s.server.address().address, '127.0.0.1');
    assert.strictEqual((await request(s.port, '/api/next')).status, 403, 'no token');
    assert.strictEqual((await request(s.port, '/api/next?token=nope')).status, 403);
    assert.strictEqual((await request(s.port, `/api/next?token=${s.token}`, { host: 'evil.example:80' })).status, 403, 'DNS rebinding guard');
    const page = await request(s.port, `/?token=${s.token}`);
    assert.strictEqual(page.status, 200);
    const next = JSON.parse((await request(s.port, `/api/next?token=${s.token}`)).body);
    assert.ok(next.question, 'a question is served');
    const raw = JSON.stringify(next.question);
    assert.ok(!('answer' in next.question) && !('explanation' in next.question) && !('evidence' in next.question));
    assert.ok(!raw.includes('mutantCode'));
    const ans = JSON.parse((await request(s.port, `/api/answer?token=${s.token}`, { method: 'POST', body: { id: next.question.id, response: 'zzz' } })).body);
    assert.ok('correct' in ans && 'explanation' in ans);
  } finally {
    s.server.close();
  }
});

test('standalone topic quiz works without any session', () => {
  const db = store.open();
  const ids = queue.topicQuiz(db, { topic: 'networking', count: 4 });
  assert.strictEqual(ids.length, 4);
  for (const id of ids) assert.match(queue.get(db, id).topic, /^networking/);
});

test('badge, export and purge', () => {
  const db = store.open();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-badge-'));
  const b = require('../src/badge').write(db, out);
  const svg = fs.readFileSync(b.svgPath, 'utf8');
  assert.match(svg, /^<svg/);
  assert.match(b.text, /self-reported/);
  assert.ok(!svg.includes(path.basename(repo)), 'no repo names in the badge');
  const data = require('../src/data').exportAll(db, { repoId });
  assert.ok(data.tables.questions.length > 0 && data.tables.answers.length > 0 && data.events.length >= 2);
  require('../src/data').purge(db, { repoId });
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM questions WHERE repo_id = ?', repoId).n, 0);
  assert.ok(!fs.existsSync(path.join(home, repoId)));
  require('../src/data').purge(db, {});
  assert.ok(!fs.existsSync(path.join(home, 'diffdojo.db')));
});

test('questions are generated while Claude works: an edit starts background generation', () => {
  const r2 = makeRepo({ 'a.py': 'x = 1\n' });
  const id = util.repoId(r2);
  write(r2, 'sched.py', fixture('scheduler.py'));
  const hook = runHook('on-edit.js', { session_id: 'MID', cwd: r2, tool_name: 'Write', tool_input: { file_path: path.join(r2, 'sched.py') } }, { DIFFDOJO_NO_MIDTURN: '0' });
  assert.strictEqual(hook.status, 0);
  assert.ok(hook.ms < 2000, 'the edit hook returns at once');
  const db = store.open();
  const until = Date.now() + 120000;
  const count = () => db.get("SELECT COUNT(*) AS n FROM questions WHERE repo_id = ? AND family != 'questionnaire'", id).n;
  while (count() === 0 && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  assert.ok(count() > 0, 'code/design questions exist before the turn ends');
  // A second edit right away does not start another run (throttled).
  const before = fs.readdirSync(path.join(home, id, 'pending')).length;
  runHook('on-edit.js', { session_id: 'MID', cwd: r2, tool_name: 'Edit', tool_input: { file_path: path.join(r2, 'sched.py') } }, { DIFFDOJO_NO_MIDTURN: '0' });
  assert.ok(fs.readdirSync(path.join(home, id, 'pending')).length <= before);
});
