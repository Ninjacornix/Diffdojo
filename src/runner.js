'use strict';
// Execution: snippets run in a fresh temp directory with a timeout (and with
// no network via `unshare -rn` on Linux when available). Project tests run in
// a temp *copy* of the workspace, never in the working tree, and only with the
// user-configured test command.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, runShell, which } = require('./util');
const git = require('./git');

let unshareOk = null;
function sandboxPrefix() {
  if (process.platform !== 'linux') return null;
  if (unshareOk === null) {
    unshareOk = !!which('unshare') && run('unshare', ['-rn', 'true'], { timeout: 3000 }).code === 0;
  }
  return unshareOk ? ['unshare', '-rn'] : null;
}

function tempDir(prefix = 'diffdojo-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(d) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
}

function exec(cmd, args, opts) {
  const pre = sandboxPrefix();
  if (pre) return run(pre[0], [...pre.slice(1), cmd, ...args], opts);
  return run(cmd, args, opts);
}

function pythonBin() {
  return which('python3') || which('python') || null;
}

function cxxBin(lang) {
  if (lang === 'c') return which('gcc') || which('clang') || which('cc');
  return which('g++') || which('clang++') || which('c++');
}

/**
 * Compile (if needed) and run a snippet. Returns {ok, stdout, stderr, stage}.
 * stage: 'compile' | 'run' | 'unsupported'.
 */
function runSnippet(code, lang, { timeoutSec = 5, stdin } = {}) {
  const dir = tempDir();
  const timeout = timeoutSec * 1000;
  try {
    if (lang === 'python') {
      const py = pythonBin();
      if (!py) return { ok: false, stage: 'unsupported', stdout: '', stderr: 'python not found' };
      fs.writeFileSync(path.join(dir, 'snippet.py'), code);
      const r = exec(py, ['-I', '-B', 'snippet.py'], { cwd: dir, timeout, input: stdin, env: { PYTHONHASHSEED: '0' } });
      return { ok: r.code === 0 && !r.timedOut, stage: 'run', stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    }
    if (lang === 'javascript' || lang === 'typescript') {
      const file = lang === 'typescript' ? 'snippet.ts' : 'snippet.js';
      fs.writeFileSync(path.join(dir, file), code);
      const r = exec(process.execPath, ['--no-warnings', file], { cwd: dir, timeout, input: stdin });
      return { ok: r.code === 0 && !r.timedOut, stage: 'run', stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    }
    if (lang === 'cpp' || lang === 'c') {
      const cc = cxxBin(lang);
      if (!cc) return { ok: false, stage: 'unsupported', stdout: '', stderr: 'no C/C++ compiler found' };
      const src = lang === 'c' ? 'snippet.c' : 'snippet.cpp';
      fs.writeFileSync(path.join(dir, src), code);
      const exe = path.join(dir, process.platform === 'win32' ? 'snippet.exe' : 'snippet');
      const flags = lang === 'c' ? ['-std=c11'] : ['-std=c++20', '-pthread'];
      // Put the compiler's own directory first so it (and the program) load matching runtime DLLs.
      const env = { PATH: path.dirname(cc) + path.delimiter + (process.env.PATH || '') };
      const c = run(cc, [...flags, '-O1', '-o', exe, src], { cwd: dir, timeout: 60000, env });
      if (c.code !== 0) return { ok: false, stage: 'compile', stdout: c.stdout, stderr: c.stderr };
      const r = exec(exe, [], { cwd: dir, timeout, input: stdin, env });
      return { ok: r.code === 0 && !r.timedOut, stage: 'run', stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    }
    return { ok: false, stage: 'unsupported', stdout: '', stderr: `cannot run ${lang}` };
  } finally {
    rmrf(dir);
  }
}

/** Run a snippet twice; only accept if both runs succeed with identical output. */
function runDeterministic(code, lang, opts) {
  const a = runSnippet(code, lang, opts);
  if (!a.ok) return { ...a, deterministic: false };
  const b = runSnippet(code, lang, opts);
  return { ...a, deterministic: b.ok && b.stdout === a.stdout };
}

function normalizeOutput(s) {
  return String(s).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).join('\n').trim();
}

const LINK_DIRS = ['node_modules', '.venv', 'venv', 'env', '.tox', 'vendor', 'target', 'build', '_deps'];
const MAX_COPY_FILES = 20000;

/**
 * Copy the repository (tracked + untracked, non-ignored files) into a temp dir.
 * Heavy dependency directories are linked rather than copied so tests can run.
 * `overrides` is {relPath: content} applied after copying.
 */
function copyWorkspace(root, overrides = {}) {
  const files = git.listFiles(root);
  if (files.length > MAX_COPY_FILES) throw new Error(`workspace too large to copy (${files.length} files)`);
  const dir = tempDir('diffdojo-ws-');
  for (const f of files) {
    const src = path.join(root, f);
    const dst = path.join(dir, f);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch {
      /* deleted or unreadable file: skip */
    }
  }
  for (const d of LINK_DIRS) {
    const src = path.join(root, d);
    const dst = path.join(dir, d);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        /* ignore */
      }
    }
  }
  for (const [rel, content] of Object.entries(overrides)) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
  }
  return dir;
}

function removeWorkspace(dir) {
  // Unlink junctions first so rmSync never follows them into the real tree.
  for (const d of LINK_DIRS) {
    const p = path.join(dir, d);
    try {
      if (fs.lstatSync(p).isSymbolicLink() || process.platform === 'win32') {
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) fs.unlinkSync(p);
        else if (process.platform === 'win32') {
          try {
            fs.rmdirSync(p); // junctions are removed by rmdir without touching the target
          } catch {
            /* real directory: leave for rmrf */
          }
        }
      }
    } catch {
      /* missing */
    }
  }
  rmrf(dir);
}

/** Run the configured test command in a temp copy of the repo with file overrides. */
function runTests(root, testCommand, overrides = {}, { timeoutSec = 120 } = {}) {
  if (!testCommand) return { ran: false, reason: 'no test command configured' };
  let dir;
  try {
    dir = copyWorkspace(root, overrides);
    const r = runShell(testCommand, { cwd: dir, timeout: timeoutSec * 1000 });
    return { ran: true, passed: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, output: (r.stdout + '\n' + r.stderr).slice(-6000) };
  } catch (e) {
    return { ran: false, reason: e.message };
  } finally {
    if (dir) removeWorkspace(dir);
  }
}

/** Quick syntax check of a whole file (used to drop mutants that don't parse). */
function syntaxOk(content, lang) {
  if (lang === 'python') {
    const py = pythonBin();
    if (!py) return null;
    const r = run(py, ['-I', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: content, timeout: 10000 });
    return r.code === 0;
  }
  if (lang === 'javascript') {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, 'f.js'), content);
      return run(process.execPath, ['--check', path.join(dir, 'f.js')], { timeout: 10000 }).code === 0;
    } finally {
      rmrf(dir);
    }
  }
  return null; // unknown: not checked
}

module.exports = { runSnippet, runDeterministic, normalizeOutput, copyWorkspace, removeWorkspace, runTests, syntaxOk, tempDir, rmrf, pythonBin, cxxBin };
