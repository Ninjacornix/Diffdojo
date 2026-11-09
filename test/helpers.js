'use strict';
// Test helpers: an isolated DIFFDOJO_HOME per test file and throwaway git repos.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function isolate() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-home-'));
  process.env.DIFFDOJO_HOME = home;
  delete process.env.DIFFDOJO_DB;
  delete process.env.DIFFDOJO_CHILD;
  return home;
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  if (Object.keys(files).length) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
  }
  return dir;
}

function write(dir, f, content) {
  const p = path.join(dir, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

/** Run a hook script with a JSON payload; returns {status, stdout, stderr, ms}. */
function runHook(script, payload, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, DIFFDOJO_NO_MIDTURN: '1', ...env },
    timeout: 120000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

function hasBin(name) {
  return require('../src/util').which(name) !== null;
}

module.exports = { isolate, git, makeRepo, write, fixture, runHook, hasBin };
