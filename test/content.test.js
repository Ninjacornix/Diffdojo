'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isolate, fixture, hasBin } = require('./helpers');

isolate();
const rationale = require('../src/rationale');
const packs = require('../src/packs');
const model = require('../src/model');
const { analyze } = require('../src/lang/structure');
const { buildPredict, mutantChangesBehaviour } = require('../src/generators/predict');
const { hasSecret } = require('../src/secrets');

function transcript(lines) {
  const f = path.join(os.tmpdir(), `dd-t-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'));
  return f;
}

test('rationale: only the last turn, reasons only, linked to files; todos and commits included', () => {
  const f = transcript([
    { type: 'user', version: '2.1.0', uuid: 'u1', message: { content: 'first task' } },
    { type: 'assistant', version: '2.1.0', uuid: 'a0', message: { content: [{ type: 'text', text: 'I changed old.py because the old reason should be ignored entirely.' }] } },
    { type: 'user', version: '2.1.0', uuid: 'u2', message: { content: 'second task' } },
    { type: 'assistant', version: '2.1.0', uuid: 'a1', message: { content: [
      { type: 'text', text: 'I switched the socket in server.cpp to non-blocking mode so that one slow client cannot stall the event loop. This line has no reason marker at all, just a statement.' },
      { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Add jitter to retry delays to avoid synchronized retries after an outage' }] } },
      { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "Use a heap for timers because lookups of the earliest deadline must be fast"' } },
    ] } },
    { type: 'user', version: '2.1.0', uuid: 'tr', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  ]);
  const r = rationale.extract(f, { files: ['src/server.cpp'], symbols: ['on_readable'] });
  assert.strictEqual(r.turn, 2);
  const texts = r.sentences.map((s) => s.sentence);
  assert.ok(!texts.some((t) => t.includes('old reason')), 'earlier turns ignored');
  assert.ok(!texts.some((t) => t.includes('no reason marker')));
  const sock = r.sentences.find((s) => s.sentence.includes('non-blocking'));
  assert.deepStrictEqual(sock.files, ['src/server.cpp']);
  assert.strictEqual(sock.ref, 'a1');
  assert.ok(r.sentences.some((s) => s.kind === 'todo'));
  assert.ok(r.sentences.some((s) => s.kind === 'commit'));
  const parts = rationale.splitReason(sock.sentence);
  assert.match(parts.action, /^switched the socket/);
  assert.match(parts.reason, /^so that one slow client/);
});

test('rationale: fails safe on unknown transcript versions, missing files and secrets', () => {
  const f = transcript([{ type: 'user', version: '9.0.0', message: { content: 'x' } }, { type: 'assistant', version: '9.0.0', message: { content: [{ type: 'text', text: 'Did a thing because of another thing entirely.' }] } }]);
  assert.strictEqual(rationale.extract(f), null);
  assert.strictEqual(rationale.extract(path.join(os.tmpdir(), 'does-not-exist.jsonl')), null);
  const s = transcript([{ type: 'user', version: '2.1.0', message: { content: 'x' } }, { type: 'assistant', version: '2.1.0', message: { content: [{ type: 'text', text: 'I hardcoded api_key = "sk-ant-abcdefghijklmnopqrstuvwxyz" because the tests needed it.' }] } }]);
  assert.strictEqual(rationale.extract(s).sentences.length, 0, 'sentences with secrets are dropped');
});

test('secret scan', () => {
  assert.ok(hasSecret('-----BEGIN RSA PRIVATE KEY-----'));
  assert.ok(hasSecret('token = "ghp_' + 'a'.repeat(36) + '"'));
  assert.ok(hasSecret('password = "hunter2hunter2"'));
  assert.ok(hasSecret('postgres://user:secretpw@db/x'));
  assert.ok(!hasSecret('int password_length = 12;'));
});

test('shipped packs load with no errors, no duplicates and enough questions', () => {
  const p = packs.load({ fresh: true });
  assert.deepStrictEqual(p.errors, []);
  assert.deepStrictEqual(packs.duplicates(p.questions), []);
  assert.ok(p.questions.length >= 200);
  const per = {};
  for (const q of p.questions) per[q.pack] = (per[q.pack] || 0) + 1;
  for (const name of ['cpp-core', 'cpp-concurrency', 'linux-networking', 'python', 'dsa', 'javascript']) assert.ok(per[name] >= 20, `${name}: ${per[name]}`);
});

test('invalid pack questions are rejected with clear errors', () => {
  const errs = packs.validate({ id: 'Bad Id', topic: 'x', difficulty: 'insane', format: 'multiple_choice', question: 'q', choices: { a: 'same', b: 'same' }, answer: 'z' });
  const msg = errs.join('\n');
  for (const re of [/id must be/, /difficulty must be/, /explanation is required/, /answer must be exactly one key/, /choices must be distinct/]) assert.match(msg, re);
  assert.match(packs.validate({ id: 'o', topic: 'a/b', difficulty: 'easy', format: 'ordering', question: 'q', explanation: 'e', items: { a: 'x', b: 'y' }, answer: ['a'] }).join(), /permutation/);
  assert.deepStrictEqual(packs.validate({ id: 'ok-1', topic: 'a/b', difficulty: 'easy', format: 'true_false', question: 'q', explanation: 'e', answer: false }), []);
});

test('local packs in ~/.diffdojo/packs are loaded and validated too', () => {
  const dir = path.join(process.env.DIFFDOJO_HOME, 'packs', 'mine');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'q.yaml'), 'id: mine-001\ntopic: sql/core\ndifficulty: easy\nformat: true_false\nquestion: SELECT reads data.\nanswer: true\nexplanation: yes\n---\nid: mine-002\ntopic: sql/core\n');
  const p = packs.load({ fresh: true });
  assert.ok(p.byId.get('mine-001') && p.byId.get('mine-001').origin === 'local');
  assert.strictEqual(p.byId.get('mine-001').track, 'databases');
  assert.ok(p.errors.some((e) => e.id === 'mine-002'));
  fs.rmSync(dir, { recursive: true });
});

test('predict-the-output: typed pure functions only, answers recorded by running them', { skip: !hasBin('python') && !hasBin('python3') }, () => {
  const src = fixture('mathutil.py');
  const s = analyze(src, 'python');
  const clamp = s.functions.find((f) => f.name === 'clamp');
  const p = buildPredict(clamp, 'python', s, src);
  assert.ok(p);
  const args = p.call.match(/clamp\((.*)\)/)[1].split(',').map(Number);
  assert.strictEqual(Number(p.output), Math.min(Math.max(args[0], args[1]), args[2]));
  const sched = analyze(fixture('scheduler.py'), 'python');
  assert.strictEqual(buildPredict(sched.functions.find((f) => f.name === 'due'), 'python', sched, fixture('scheduler.py')), null, 'methods are skipped');
  // Equivalent mutant detection: clamp's `x < lo` -> `x <= lo` returns lo either way.
  const code = src.split('\n').slice(clamp.start - 1, clamp.end).join('\n');
  assert.strictEqual(mutantChangesBehaviour(clamp, 'python', s, src, code.replace('x < lo', 'x <= lo')), false);
  assert.strictEqual(mutantChangesBehaviour(clamp, 'python', s, src, code.replace('return hi', 'return lo')), true);
});

test('predict-the-output for TypeScript runs under Node', () => {
  const src = fixture('strings.ts');
  const s = analyze(src, 'typescript');
  const p = buildPredict(s.functions.find((f) => f.name === 'countVowels'), 'typescript', s, src);
  assert.ok(p && /^\d+$/.test(p.output));
});

test('model output is schema-validated (fixed schema, no extra keys)', () => {
  const good = { question: 'q', choices: { a: '1', b: '2', c: '3', d: '4' }, answer: 'b', explanation: 'e' };
  assert.ok(model.validate(good, model.MC_SCHEMA));
  assert.ok(!model.validate({ ...good, answer: 'e' }, model.MC_SCHEMA));
  assert.ok(!model.validate({ ...good, run: 'rm -rf /' }, model.MC_SCHEMA));
  assert.ok(!model.validate({ ...good, choices: { a: '1', b: '2', c: '3' } }, model.MC_SCHEMA));
  assert.deepStrictEqual(model.extractJson('noise {"a": 1} trailing'), { a: 1 });
});

test('model path is off by default and rate-limited when on', () => {
  const store = require('../src/store');
  const db = store.open();
  const config = require('../src/config');
  const cfg = config.load(null);
  assert.strictEqual(cfg.model.enabled, false);
  assert.match(model.available(db, cfg).reason, /off/);
  const on = { ...cfg, model: { ...cfg.model, enabled: true, perHour: 2 } };
  for (let i = 0; i < 2; i++) db.run("INSERT INTO gen_log(ts, kind) VALUES (?, 'model:why')", new Date().toISOString());
  assert.match(model.available(db, on).reason, /hourly model limit/);
});
