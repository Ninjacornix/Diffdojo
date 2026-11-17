'use strict';
// No Mercy: a question about Claude's proposed edit, built before it is applied.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isolate, write, fixture } = require('./helpers');

isolate();
const store = require('../src/store');
const gate = require('../src/gate');
const { rng } = require('../src/util');

function folder(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-gate-'));
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  return dir;
}

const CLAMP = 'def clamp(x, lo, hi):\n    if x < lo:\n        return lo\n    if x > hi:\n        return hi\n    return x\n';

test('the proposed file: Edit, Write and MultiEdit applied in memory, the folder untouched', () => {
  const dir = folder({ 'a.py': 'x = 1\ny = 2\n' });
  const e = gate.proposed({ tool: 'Edit', file_path: path.join(dir, 'a.py'), old_string: 'y = 2', new_string: 'y = 3' }, dir);
  assert.strictEqual(e.after, 'x = 1\ny = 3\n');
  assert.strictEqual(e.file, 'a.py');
  const w = gate.proposed({ tool: 'Write', file_path: 'b.py', content: 'z = 1\n' }, dir);
  assert.strictEqual(w.before, '');
  assert.strictEqual(w.after, 'z = 1\n');
  const m = gate.proposed({ tool: 'MultiEdit', file_path: 'a.py', edits: [{ old_string: 'x = 1', new_string: 'x = 5' }, { old_string: 'y = 2', new_string: 'y = 6' }] }, dir);
  assert.strictEqual(m.after, 'x = 5\ny = 6\n');
  assert.strictEqual(gate.proposed({ tool: 'Edit', file_path: 'a.py', old_string: 'nope', new_string: 'x' }, dir), null);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.py'), 'utf8'), 'x = 1\ny = 2\n');
});

test('changed lines are the edited region', () => {
  assert.deepStrictEqual(gate.changedLines('a\nb\nc\n', 'a\nB\nB2\nc\n'), [2, 3]);
  assert.deepStrictEqual(gate.changedLines('', 'a\n\nb\n'), [1, 3]);
});

test('a new function gets a "which line did Claude write" question with the real line among look-alikes', async () => {
  const dir = folder();
  const db = store.open();
  const g = gate.create(db, { tool: 'Write', file_path: 'clamp.py', content: CLAMP }, { root: dir, rnd: rng(7) });
  assert.ok(g.id, JSON.stringify(g));
  assert.match(g.prompt, /clamp\.py/);
  assert.match(g.code, /\?\?\?/);
  assert.ok(g.options.length >= 3 && g.options.length <= 4);
  assert.strictEqual(new Set(g.options).size, g.options.length, 'options are distinct');
  const hidden = CLAMP.split('\n').map((l) => l.trim()).filter((l) => g.options.includes(l));
  assert.strictEqual(hidden.length, 1, 'exactly one option is a line Claude wrote');
  assert.strictEqual(db.get('SELECT status FROM questions WHERE id = ?', g.id).status, 'gate', 'not queued for the normal quiz');

  const right = await gate.answer(db, g.id, hidden[0], {});
  assert.strictEqual(right.correct, true);
  assert.ok(right.xp > 0);
  assert.strictEqual((await gate.answer(db, g.id, hidden[0], {})).error, 'no such gate', 'a gate is answered once');
});

test('a wrong pick, a typed letter and an empty answer are graded', async () => {
  const dir = folder();
  const db = store.open();
  const g = gate.create(db, { tool: 'Write', file_path: 'clamp.py', content: CLAMP }, { root: dir, rnd: rng(3) });
  const right = CLAMP.split('\n').map((l) => l.trim()).find((l) => g.options.includes(l));
  const wrong = g.options.find((o) => o !== right);
  assert.strictEqual((await gate.answer(db, g.id, wrong, {})).correct, false);
  const g2 = gate.create(db, { tool: 'Write', file_path: 'clamp.py', content: CLAMP }, { root: dir, rnd: rng(3) });
  const letter = 'abcd'[g2.options.indexOf(right)];
  assert.strictEqual((await gate.answer(db, g2.id, letter, {})).correct, true);
  const g3 = gate.create(db, { tool: 'Write', file_path: 'clamp.py', content: CLAMP }, { root: dir, rnd: rng(3) });
  assert.strictEqual((await gate.answer(db, g3.id, '', {})).correct, false);
});

test('an edit using a known API gets a technical question about it', () => {
  const dir = folder({ 'sched.py': fixture('scheduler.py') });
  const db = store.open();
  const src = fs.readFileSync(path.join(dir, 'sched.py'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('heapq.heappush'));
  const g = gate.create(db, { tool: 'Edit', file_path: path.join(dir, 'sched.py'), old_string: line, new_string: `${line}\n        self.seen = Counter(self.jobs)` }, { root: dir, rnd: rng(1) });
  assert.ok(g.id, JSON.stringify(g));
  assert.ok(g.options.length >= 3);
});

test('a new file longer than the excerpt still gets a fair question (regression: bfs.cpp)', () => {
  // A 40-line new C++ file used to crash the line question (it read past its
  // 14-line excerpt), and No Mercy then let the edit through unasked.
  const dir = folder();
  const db = store.open();
  const content = fixture('bfs.cpp');
  for (let seed = 1; seed <= 25; seed++) {
    const g = gate.create(db, { tool: 'Write', file_path: path.join(dir, 'bfs.cpp'), content }, { root: dir, rnd: rng(seed) });
    assert.ok(g.id, `seed ${seed}: ${JSON.stringify(g)}`);
    assert.ok(g.options.length >= 3);
    for (const o of g.options) {
      assert.ok(!/\/\/|#include/.test(o), `seed ${seed}: options are code only: ${o}`);
      assert.ok(!/\w(<=|>=)\w+>/.test(o), `seed ${seed}: template brackets left alone: ${o}`);
    }
    if (g.code && /\?\?\?/.test(g.code)) {
      const right = g.options.filter((o) => content.split('\n').some((l) => l.trim().startsWith(o)));
      assert.strictEqual(right.length, 1, `seed ${seed}: exactly one option is Claude's line: ${JSON.stringify(g.options)}`);
      assert.ok(!g.options.some((o) => o !== right[0] && o.replace('!=', '<') === right[0]), `seed ${seed}: no equivalent option`);
    }
  }
  assert.ok(!fs.existsSync(path.join(require('../src/util').home(), 'logs')), 'nothing failed along the way');
});

test('non-code files pass without a question', () => {
  const dir = folder();
  const g = gate.create(store.open(), { tool: 'Write', file_path: 'README.md', content: '# hi\n' }, { root: dir });
  assert.ok(g.skip);
});
