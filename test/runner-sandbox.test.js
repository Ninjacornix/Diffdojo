'use strict';
// Code from Claude's change runs sandboxed where possible and never sees the
// session's secrets; `snippetSandbox: require` refuses to run it unsandboxed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isolate } = require('./helpers');

const ROOT = path.join(__dirname, '..');

/** Runs a JS snippet through runSnippet in a fresh process (sandboxKind is cached per process). */
function snippet(code, { sandbox, policy, env = {} } = {}) {
  const home = isolate();
  if (policy) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ snippetSandbox: policy, model: { enabled: false } }));
  const driver = `const r = require(${JSON.stringify(path.join(ROOT, 'src', 'runner'))}).runSnippet(${JSON.stringify(code)}, 'javascript'); process.stdout.write(JSON.stringify(r));`;
  const r = spawnSync(process.execPath, ['-e', driver], {
    encoding: 'utf8',
    env: { ...process.env, DIFFDOJO_HOME: home, ...(sandbox ? { DIFFDOJO_SANDBOX: sandbox } : {}), ...env },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('snippets get a minimal environment: no API keys or tokens', () => {
  const r = snippet('console.log(JSON.stringify(Object.keys(process.env).sort()))', {
    sandbox: 'none',
    env: { ANTHROPIC_API_KEY: 'sk-test', GITHUB_TOKEN: 'ghp-test', AWS_SECRET_ACCESS_KEY: 'x' },
  });
  assert.ok(r.ok, r.stderr);
  const keys = JSON.parse(r.stdout);
  for (const k of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']) assert.ok(!keys.includes(k), `${k} leaked`);
  assert.ok(keys.some((k) => k.toUpperCase() === 'PATH'), 'PATH kept');
});

test("snippetSandbox 'require' skips running when no sandbox is available", () => {
  const r = snippet('console.log(1)', { sandbox: 'none', policy: 'require' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'unsupported');
  assert.match(r.stderr, /no sandbox/);
});

test("snippetSandbox 'auto' still runs without a sandbox", () => {
  const r = snippet('console.log(6 * 7)', { sandbox: 'none', policy: 'auto' });
  assert.ok(r.ok, r.stderr);
  assert.strictEqual(r.stdout.trim(), '42');
});

test('the detected sandbox runs snippets and blocks writes outside its folder', { skip: process.platform === 'win32' && 'no sandbox on Windows' }, () => {
  const outside = path.join(require('os').homedir(), `.diffdojo-sandbox-probe-${process.pid}`);
  const code = `try { require('fs').writeFileSync(${JSON.stringify(outside)}, 'x') } catch {} console.log('done')`;
  const r = snippet(code);
  assert.ok(r.ok, r.stderr);
  const kind = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(ROOT, 'src', 'runner'))}).sandboxKind())`], { encoding: 'utf8' }).stdout;
  const wrote = fs.existsSync(outside);
  if (wrote) fs.rmSync(outside, { force: true });
  if (kind === 'bwrap' || kind === 'sandbox-exec') assert.ok(!wrote, `${kind} let a snippet write to the home folder`);
});
