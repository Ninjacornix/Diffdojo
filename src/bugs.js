'use strict';
// Real bug reports. The user points at code Claude wrote and proves the bug
// with a failing test. If the configured test command FAILS on the current
// code, the report is confirmed and saved under ~/.diffdojo/<repo-id>/bugs/.
// Nothing is ever sent anywhere.

const fs = require('fs');
const path = require('path');
const { runTests } = require('./runner');
const git = require('./git');
const lang = require('./lang');
const rewards = require('./rewards');
const { repoDir, ensureDir, slug, nowIso, dayKey } = require('./util');

/** Detect the project's test framework for scaffolding. */
function detectFramework(root, file) {
  const l = lang.detect(file || '') || '';
  const has = (f) => fs.existsSync(path.join(root, f));
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    /* none */
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (l === 'python' || (!l && (has('pyproject.toml') || has('setup.py')))) return { framework: 'pytest', lang: 'python', command: 'python -m pytest -q' };
  if (l === 'javascript' || l === 'typescript' || has('package.json')) {
    if (deps.vitest) return { framework: 'vitest', lang: l || 'javascript', command: 'npx vitest run' };
    if (deps.jest) return { framework: 'jest', lang: l || 'javascript', command: 'npx jest' };
    return { framework: 'node:test', lang: l || 'javascript', command: 'node --test' };
  }
  if (l === 'cpp' || l === 'c' || has('CMakeLists.txt')) {
    let cm = '';
    try {
      cm = fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8');
    } catch {
      /* none */
    }
    if (/Catch2/i.test(cm)) return { framework: 'catch2', lang: 'cpp', command: 'ctest --test-dir build --output-on-failure' };
    return { framework: 'gtest', lang: 'cpp', command: 'ctest --test-dir build --output-on-failure' };
  }
  return { framework: 'unknown', lang: l, command: null };
}

function scaffold(root, { file, fn, title }) {
  const fw = detectFramework(root, file);
  const name = slug(title || `${fn || 'bug'} regression`).replace(/-/g, '_');
  const mod = file ? file.replace(/\.[^.]+$/, '').replace(/[\\/]/g, '.') : 'module';
  const rel = file ? path.relative(path.join(root, 'tests'), path.join(root, file)).replace(/\\/g, '/').replace(/\.[^.]+$/, '') : './module';
  const T = {
    pytest: { path: `tests/test_${name}.py`, code: `from ${mod} import ${fn || 'function_under_test'}\n\n\ndef test_${name}():\n    # Arrange: the input that exposes the bug\n    # Act\n    result = ${fn || 'function_under_test'}(...)\n    # Assert: what the correct behaviour is\n    assert result == ...\n` },
    'node:test': { path: `tests/${name}.test.${fw.lang === 'typescript' ? 'ts' : 'js'}`, code: `const test = require('node:test');\nconst assert = require('node:assert');\nconst { ${fn || 'fn'} } = require('${rel}');\n\ntest('${title || name}', () => {\n  assert.deepStrictEqual(${fn || 'fn'}(/* input that exposes the bug */), /* expected */);\n});\n` },
    jest: { path: `tests/${name}.test.${fw.lang === 'typescript' ? 'ts' : 'js'}`, code: `import { ${fn || 'fn'} } from '${rel}';\n\ntest('${title || name}', () => {\n  expect(${fn || 'fn'}(/* input */)).toEqual(/* expected */);\n});\n` },
    vitest: { path: `tests/${name}.test.${fw.lang === 'typescript' ? 'ts' : 'js'}`, code: `import { test, expect } from 'vitest';\nimport { ${fn || 'fn'} } from '${rel}';\n\ntest('${title || name}', () => {\n  expect(${fn || 'fn'}(/* input */)).toEqual(/* expected */);\n});\n` },
    gtest: { path: `tests/${name}_test.cpp`, code: `#include <gtest/gtest.h>\n#include "${file || 'header.hpp'}"\n\nTEST(DiffDojo, ${name}) {\n  // input that exposes the bug\n  EXPECT_EQ(${fn || 'function_under_test'}(/* ... */), /* expected */);\n}\n` },
    catch2: { path: `tests/${name}_test.cpp`, code: `#include <catch2/catch_test_macros.hpp>\n#include "${file || 'header.hpp'}"\n\nTEST_CASE("${title || name}") {\n  REQUIRE(${fn || 'function_under_test'}(/* ... */) == /* expected */);\n}\n` },
  };
  return { ...fw, ...(T[fw.framework] || { path: `tests/${name}`, code: '// write a test that fails because of the bug\n' }) };
}

/** Was this file/line changed by Claude in a recorded session? */
function inClaudeChanges(db, repoId, file, lines) {
  const units = db.all('SELECT start_line, end_line FROM code_units WHERE repo_id = ? AND file = ?', repoId, file);
  if (!units.length) return false;
  if (!lines) return true;
  const [a, b] = lines;
  return units.some((u) => !(b < u.start_line || a > u.end_line));
}

function parseLines(s) {
  if (!s) return null;
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(s).trim());
  return m ? [+m[1], +(m[2] || m[1])] : null;
}

/**
 * Run the user's failing test and, if it fails on the current code, save a confirmed report.
 */
function report(db, { root, repoId, cfg, title, file, lines, testPath, critiqueId, testCommand }) {
  const cmd = testCommand || cfg.testCommand;
  if (!cmd) return { confirmed: false, reason: 'No test command. Pass --cmd "<command>" or run: diffdojo config testCommand "<command>"' };
  if (!testPath || !fs.existsSync(path.resolve(root, testPath))) return { confirmed: false, reason: `Test file not found: ${testPath}` };
  const lineRange = parseLines(lines);
  const fromClaude = file ? inClaudeChanges(db, repoId, file.replace(/\\/g, '/'), lineRange) : false;
  const r = runTests(root, cmd, {}, { timeoutSec: cfg.testTimeoutSec });
  if (!r.ran) return { confirmed: false, reason: r.reason };
  if (r.passed) return { confirmed: false, reason: 'The test passes on the current code, so it does not demonstrate a bug yet.', output: r.output };

  const dir = ensureDir(path.join(repoDir(repoId), 'bugs'));
  const reportPath = path.join(dir, `${dayKey()}-${slug(title)}.md`);
  let excerpt = '';
  if (file) {
    try {
      const src = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
      const [a, b] = lineRange || [1, Math.min(src.length, 40)];
      excerpt = src.slice(Math.max(0, a - 3), Math.min(src.length, b + 2)).map((l, i) => `${Math.max(1, a - 2) + i}| ${l}`).join('\n');
    } catch {
      /* file gone */
    }
  }
  let diffText = '';
  if (file) {
    const d = git.diff(root, git.head(root) || 'HEAD', git.snapshot(root) || 'HEAD', [file]);
    diffText = d.split('\n').slice(0, 80).join('\n');
  }
  const test = fs.readFileSync(path.resolve(root, testPath), 'utf8');
  const track = file ? lang.trackFor(lang.detect(file)) : 'general';
  const md = [
    `# ${title}`,
    '',
    `- Date: ${nowIso()}`,
    `- File: ${file || 'n/a'}${lines ? `:${lines}` : ''}`,
    `- In a Claude-recorded change: ${fromClaude ? 'yes' : 'not verified'}`,
    `- Test: ${testPath}`,
    `- Command: \`${cmd}\``,
    critiqueId ? `- From critique question #${critiqueId}` : null,
    '',
    '## Code',
    '```',
    excerpt || '(no excerpt)',
    '```',
    diffText ? '\n## Diff (vs HEAD)\n```diff\n' + diffText + '\n```' : '',
    '',
    '## Failing test',
    '```',
    test.slice(0, 6000),
    '```',
    '',
    '## Test output',
    '```',
    r.output.slice(-4000),
    '```',
    '',
    'Next step is yours: fix it, ask Claude to fix it, or open an issue. DiffDojo never sends this anywhere.',
  ].filter((x) => x !== null).join('\n');
  fs.writeFileSync(reportPath, md);
  const id = Number(db.run(
    'INSERT INTO bug_reports(repo_id, title, file, lines, test_path, test_command, output, report_path, track, critique_question_id, confirmed, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)',
    repoId, title, file, lines, testPath, cmd, r.output.slice(-4000), reportPath, track, critiqueId || null, nowIso(),
  ).lastInsertRowid);
  const xp = rewards.award(db, { track, base: 50, reason: 'real bug confirmed by a failing test', repoId });
  const trophies = rewards.checkTrophies(db);
  return { confirmed: true, id, reportPath, xp, trophies, fromClaude, output: r.output };
}

module.exports = { report, scaffold, detectFramework, inClaudeChanges };
