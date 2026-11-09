'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { analyze, changedFunctions } = require('../src/lang/structure');
const { mutants } = require('../src/mutate');
const { mask, detect } = require('../src/lang');
const { fixture } = require('./helpers');

test('mask blanks comments and strings but keeps length and lines', () => {
  const src = 'int a = 1; // if (x < y) {\nconst char* s = "a < b";\n/* { */ int b;\n';
  const m = mask(src, 'cpp');
  assert.strictEqual(m.length, src.length);
  assert.strictEqual(m.split('\n').length, src.split('\n').length);
  assert.ok(!m.includes('x < y') && !m.includes('a < b') && !m.includes('{ */'));
  const py = mask('x = "#not"  # comment < here\ny = """a\n<b"""\n', 'python');
  assert.ok(!py.includes('comment') && !py.includes('<b'));
});

test('language detection', () => {
  assert.strictEqual(detect('a/b.hpp'), 'cpp');
  assert.strictEqual(detect('x.py'), 'python');
  assert.strictEqual(detect('x.tsx'), 'typescript');
  assert.strictEqual(detect('README.md'), null);
});

test('C++ structure: methods, members with container types, calls, includes', () => {
  const s = analyze(fixture('retry_queue.cpp'), 'cpp');
  const names = s.functions.map((f) => f.qualified);
  for (const n of ['RetryQueue::push', 'RetryQueue::drain', 'RetryQueue::drop', 'sum_upto']) assert.ok(names.includes(n), `missing ${n}`);
  const push = s.functions.find((f) => f.name === 'push');
  assert.deepStrictEqual([push.start, push.end], [17, 25]);
  assert.ok(push.calls.includes('drop'));
  const pending = s.members.find((m) => m.name === 'pending_');
  assert.strictEqual(pending.type, 'std::priority_queue<Request, std::vector<Request>, ByDeadline>');
  assert.strictEqual(pending.scope, 'member');
  assert.ok(s.members.find((m) => m.name === 'mu_' && m.type === 'std::mutex'));
  assert.deepStrictEqual(s.imports.map((i) => i.name), ['queue', 'mutex', 'vector', 'net/request.hpp']);
  assert.ok(!names.some((n) => /^(if|for|while)$/.test(n)), 'control blocks are not functions');
});

test('Python structure: methods, heapq-managed list, defaultdict, deque', () => {
  const s = analyze(fixture('scheduler.py'), 'python');
  assert.deepStrictEqual(s.functions.map((f) => f.qualified), ['Scheduler.__init__', 'Scheduler.add', 'Scheduler.due', 'clamp']);
  const types = Object.fromEntries(s.members.map((m) => [m.name, m.type]));
  assert.strictEqual(types.jobs, 'list used as a binary heap (heapq)');
  assert.strictEqual(types.by_owner, 'collections.defaultdict(list)');
  assert.strictEqual(types.recent, 'collections.deque');
  const clamp = s.functions.find((f) => f.name === 'clamp');
  assert.strictEqual(clamp.params, 'x: int, lo: int, hi: int');
  assert.strictEqual(clamp.retType, 'int');
});

test('TypeScript structure: class methods, arrow functions, Map member', () => {
  const s = analyze(fixture('cache.ts'), 'typescript');
  const names = s.functions.map((f) => f.qualified);
  for (const n of ['LruCache.get', 'LruCache.set', 'fetchAll', 'fetchOne']) assert.ok(names.includes(n), `missing ${n}`);
  assert.ok(s.functions.find((f) => f.name === 'fetchAll').calls.includes('fetchOne'));
  assert.ok(s.members.find((m) => m.name === 'items' && /^Map/.test(m.type)));
});

test('changedFunctions selects functions overlapping changed lines', () => {
  const s = analyze(fixture('scheduler.py'), 'python');
  assert.deepStrictEqual(changedFunctions(s, [18]).map((f) => f.name), ['due']);
});

function fnCode(file, lang, name) {
  const src = fixture(file);
  const f = analyze(src, lang).functions.find((x) => x.name === name);
  return src.split('\n').slice(f.start - 1, f.end).join('\n');
}

const cases = [
  ['retry_queue.cpp', 'cpp', 'sum_upto', 'boundary', 'i <= n'],
  ['retry_queue.cpp', 'cpp', 'sum_upto', 'loop-start', 'int i = 1;'],
  ['retry_queue.cpp', 'cpp', 'sum_upto', 'arith', 'total -= i'],
  ['retry_queue.cpp', 'cpp', 'drain', 'logic', '|| pending_'],
  ['retry_queue.cpp', 'cpp', 'drain', 'negation', '(pending_.empty()'],
  ['retry_queue.cpp', 'cpp', 'push', 'incdec', '--count_'],
  ['scheduler.py', 'python', 'clamp', 'boundary', 'if x <= lo:'],
  ['scheduler.py', 'python', 'due', 'py-logic', 'self.jobs or self.jobs'],
  ['cache.ts', 'typescript', 'get', 'equality', 'v === undefined'],
  ['cache.ts', 'typescript', 'set', 'negation', '&& this.items.has(key)'],
];

for (const [file, lang, fn, op, expect] of cases) {
  test(`mutation operator ${op} on ${fn} (${lang})`, () => {
    const ms = mutants(fnCode(file, lang, fn), lang, { categories: ['basic'] }).filter((m) => m.op === op);
    assert.ok(ms.length, `no ${op} mutant`);
    assert.ok(ms.some((m) => m.code.includes(expect)), `expected "${expect}" in a ${op} mutant`);
    for (const m of ms) assert.notStrictEqual(m.code, fnCode(file, lang, fn));
  });
}

test('concurrency and lifetime operators are gated by category', () => {
  const code = fnCode('retry_queue.cpp', 'cpp', 'push');
  assert.ok(!mutants(code, 'cpp', { categories: ['basic'] }).some((m) => m.op === 'drop-lock'));
  const all = mutants(code, 'cpp', { categories: ['basic', 'concurrency', 'lifetime'] });
  const lock = all.find((m) => m.op === 'drop-lock');
  assert.ok(lock && lock.removed && lock.difficulty === 'hard');
  assert.ok(!lock.code.includes('lock_guard'));
  assert.deepStrictEqual(lock.acceptLines, [1, 2]);
  assert.ok(all.some((m) => m.op === 'drop-move' && !m.code.includes('std::move')));
  const ts = mutants(fnCode('cache.ts', 'typescript', 'fetchAll'), 'typescript', { categories: ['basic', 'concurrency'] });
  assert.ok(ts.some((m) => m.op === 'drop-await' && !m.code.includes('await')));
});

test('mutations never touch comments, strings or the signature line', () => {
  const code = 'int f(int a, int b) {\n    // if (a < b) return a + b;\n    const char* s = "a < b";\n    return a;\n}';
  const ms = mutants(code, 'cpp', { categories: ['basic'] });
  for (const m of ms) {
    assert.ok(m.code.includes('// if (a < b) return a + b;'));
    assert.ok(m.code.includes('"a < b"'));
    assert.ok(m.code.startsWith('int f(int a, int b) {'));
  }
});

test('for-loop increments are not flipped into infinite loops', () => {
  const ms = mutants(fnCode('retry_queue.cpp', 'cpp', 'sum_upto'), 'cpp', { categories: ['basic'] });
  assert.ok(!ms.some((m) => m.op === 'incdec'));
});
