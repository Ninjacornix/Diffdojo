'use strict';
const test = require('node:test');
const assert = require('node:assert');
const yaml = require('../src/yaml');
const { matches, matchesAny } = require('../src/glob');
const { DEFAULT_DENY } = require('../src/config');

test('yaml: mappings, sequences, block and flow scalars', () => {
  const doc = yaml.parse([
    'id: q-1   # trailing comment',
    'n: 42',
    'f: 1.5',
    'yes: true',
    'nothing: ~',
    'quoted: "a: b # not a comment"',
    "single: 'it''s'",
    'folded: >',
    '  one',
    '  two',
    'literal: |',
    '  #include <x>',
    '  int main() {}',
    'strip: |-',
    '  last',
    'list:',
    '  - a',
    '  - "b, c"',
    'flow: [x, "y, z", 3]',
    'map: {k: v, n: 2}',
    'items:',
    '  - id: one',
    '    tags: [t1]',
    '  - id: two',
    '    nested:',
    '      deep: yes-ish',
  ].join('\n'));
  assert.strictEqual(doc.id, 'q-1');
  assert.strictEqual(doc.n, 42);
  assert.strictEqual(doc.f, 1.5);
  assert.strictEqual(doc.yes, true);
  assert.strictEqual(doc.nothing, null);
  assert.strictEqual(doc.quoted, 'a: b # not a comment');
  assert.strictEqual(doc.single, "it's");
  assert.strictEqual(doc.folded, 'one two\n');
  assert.strictEqual(doc.literal, '#include <x>\nint main() {}\n', 'a # inside a block scalar is content');
  assert.strictEqual(doc.strip, 'last');
  assert.deepStrictEqual(doc.list, ['a', 'b, c']);
  assert.deepStrictEqual(doc.flow, ['x', 'y, z', 3]);
  assert.deepStrictEqual(doc.map, { k: 'v', n: 2 });
  assert.deepStrictEqual(doc.items, [{ id: 'one', tags: ['t1'] }, { id: 'two', nested: { deep: 'yes-ish' } }]);
});

test('yaml: multiple documents and errors carry line numbers', () => {
  assert.deepStrictEqual(yaml.parseAll('a: 1\n---\nb: 2\n'), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => yaml.parse('a: 1\na: 2\n'), /line 2: duplicate key "a"/);
  assert.throws(() => yaml.parse('a: "unterminated\n'), /line 1/);
  assert.throws(() => yaml.parse('a:\n\t- x\n'), /tabs/);
});

test('glob: basename patterns, ** and braces', () => {
  assert.ok(matches('config/.env.local', '.env*'));
  assert.ok(matches('a/b/server.pem', '*.pem'));
  assert.ok(matches('secrets/prod/key.txt', 'secrets/**'));
  assert.ok(matches('web/node_modules/x/index.js', '**/node_modules/**'));
  assert.ok(matches('src/a.ts', 'src/*.{ts,js}'));
  assert.ok(!matches('src/deep/a.ts', 'src/*.ts'));
  assert.ok(matches('src/deep/a.ts', 'src/**/*.ts'));
  assert.ok(matches('src/a.ts', 'src/**/*.ts'), '**/ matches zero directories');
});

test('default deny globs cover secrets, deps, builds, lockfiles and binaries', () => {
  for (const f of ['.env', 'app/.env.production', 'certs/server.key', 'secrets/db.txt', 'node_modules/a/b.js',
    'build/out.o', 'dist/app.js', 'package-lock.json', 'yarn.lock', 'img/logo.png', 'lib/x.so']) {
    assert.ok(matchesAny(f, DEFAULT_DENY), `${f} should be denied`);
  }
  for (const f of ['src/main.cpp', 'app/server.py', 'lib/util.ts', 'README.md']) assert.ok(!matchesAny(f, DEFAULT_DENY), `${f} should be allowed`);
});
