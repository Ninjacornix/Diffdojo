'use strict';
// Shared low-level helpers: paths, hashing, logging, process execution.
// Kept dependency-free and cheap to require so hook scripts start fast.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function home() {
  return process.env.DIFFDOJO_HOME || path.join(os.homedir(), '.diffdojo');
}

function normPath(p) {
  let r = path.resolve(p);
  try {
    // Resolves symlinks and, on Windows, 8.3 short names (C:\Users\NINJAC~1),
    // so one project always gets one id however its path was spelled.
    r = fs.realpathSync.native(r);
  } catch {
    /* path does not exist (yet): keep it as resolved */
  }
  if (process.platform === 'win32') r = r.replace(/\\/g, '/').toLowerCase();
  return r;
}

function repoId(repoRoot) {
  return crypto.createHash('sha256').update(normPath(repoRoot)).digest('hex').slice(0, 16);
}

function repoDir(id) {
  return path.join(home(), id);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Walk up from `start` looking for a `.git` entry (dir or file). Pure fs, no git spawn. */
function findGitRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The project DiffDojo works in: the enclosing git repository, or else the
 * folder itself (tracked through a shadow repository under ~/.diffdojo, see
 * git.js). Never the home folder or a filesystem root, which are too broad to
 * snapshot. Pure fs, no git spawn.
 */
function findRepoRoot(start) {
  const dir = path.resolve(start || process.cwd());
  const gitRoot = findGitRoot(dir);
  if (gitRoot) return gitRoot;
  if (path.dirname(dir) === dir) return null; // / or C:\
  if (normPath(dir) === normPath(os.homedir())) return null;
  if (normPath(dir) === normPath(home()) || normPath(dir).startsWith(normPath(home()) + '/')) return null; // DiffDojo's own data
  return dir;
}

/** Shadow repository for a project folder that has no git of its own, else null. */
function shadowGitDir(root) {
  if (!root || fs.existsSync(path.join(root, '.git'))) return null;
  return path.join(repoDir(repoId(root)), 'shadow.git');
}

/**
 * Is DiffDojo on for this repo? An explicit `/diffdojo:stop` (a `disabled`
 * marker) wins, then an explicit `/diffdojo:start`; otherwise the global
 * `autoEnable` setting decides, which is on by default: once the plugin is
 * enabled in Claude Code it runs in every project folder, git or not.
 */
function isEnabled(id) {
  const d = repoDir(id);
  if (fs.existsSync(path.join(d, 'disabled'))) return false;
  if (fs.existsSync(path.join(d, 'enabled'))) return true;
  return autoEnable();
}

function autoEnable() {
  const cfg = readJson(path.join(home(), 'config.json'), {});
  return cfg.autoEnable !== false;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function log(scope, err) {
  try {
    const dir = ensureDir(path.join(home(), 'logs'));
    const day = new Date().toISOString().slice(0, 10);
    const msg = err && err.stack ? err.stack : String(err);
    fs.appendFileSync(path.join(dir, `${day}.log`), `[${new Date().toISOString()}] ${scope}: ${msg}\n`);
  } catch {
    /* logging must never throw */
  }
}

/** Run a command without a shell. Returns {code, stdout, stderr, timedOut}. */
// What a snippet keeps of the environment: enough to find compilers, runtimes
// and temp space on every platform, and nothing that usually holds a secret.
const SAFE_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);

function cleanEnv() {
  // Keys are matched without case (Windows spells it Path) and kept as spelled.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (SAFE_ENV.has(k.toUpperCase())) env[k] = v;
  return env;
}

/**
 * Run a program. `opts.cleanEnv` starts from a minimal environment (no API
 * keys, tokens or cloud credentials) instead of this process's own.
 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...(opts.cleanEnv ? cleanEnv() : process.env), DIFFDOJO_CHILD: '1', ...(opts.env || {}) },
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeout || 30000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    code: r.status === null ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: (r.stderr || '') + (r.error && r.error.code !== 'ETIMEDOUT' ? String(r.error.message) : ''),
    timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM',
    error: r.error,
  };
}

/**
 * Run a CLI found on PATH (claude, gh). On Windows an npm or scoop install is
 * often a .cmd shim, which Node can only start through cmd.exe: the command
 * line is then built by hand and passed verbatim, so the quoted path survives.
 * Input goes over stdin; the arguments are fixed flags.
 */
function runTool(name, args, { input, timeout = 60000, env, cwd } = {}) {
  const bin = which(name) || name;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    // cmd.exe gives " % ^ & | < > ! special meaning even inside quotes: refuse such
    // arguments rather than try to escape them (DiffDojo's own are fixed flags,
    // model names and ids, so a real one never has them).
    const bad = args.find((a) => /["%^&|<>!\r\n]/.test(a));
    if (bad !== undefined) return { code: -1, stdout: '', stderr: `refusing to pass ${JSON.stringify(bad)} through cmd.exe` };
    const line = [`"${bin}"`, ...args.map((a) => (a === '' ? '""' : /^[\w.:=\/@+-]+$/.test(a) ? a : `"${a}"`))].join(' ');
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      cwd, input, encoding: 'utf8', timeout, windowsHide: true, windowsVerbatimArguments: true,
      env: { ...process.env, DIFFDOJO_CHILD: '1', ...(env || {}) }, maxBuffer: 32 * 1024 * 1024,
    });
    return { code: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? String(r.error.message) : '') };
  }
  return run(bin, args, { input, timeout, env, cwd });
}

/** Run a user-configured shell command (only ever the configured test/lint command). */
function runShell(command, opts = {}) {
  const env = { ...process.env, DIFFDOJO_CHILD: '1', ...(opts.env || {}) };
  // A parent `node --test` run leaks this into children and makes a nested
  // `node --test` report success regardless of results.
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(command, {
    cwd: opts.cwd,
    shell: true,
    env,
    encoding: 'utf8',
    timeout: opts.timeout || 120000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    code: r.status === null ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'),
  };
}

function which(bin) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    // On Windows a file without an extension can't be run: try PATHEXT first.
    for (const ext of process.platform === 'win32' ? [...exts, ''] : ['']) {
      const p = path.join(dir, bin + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // Windows app-execution aliases (e.g. the Store python.exe) can't be stat'ed but do run.
        try {
          if (process.platform === 'win32' && ext && fs.lstatSync(p)) return p;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'item';
}

function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr, rnd = Math.random) {
  return arr[Math.floor(rnd() * arr.length)];
}

/** Deterministic PRNG (mulberry32) for reproducible generation in tests. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey(d = new Date()) {
  // Local calendar day, so streaks follow the user's day.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = {
  runTool, cleanEnv, home, normPath, repoId, repoDir, ensureDir, findRepoRoot, findGitRoot, shadowGitDir, isEnabled, autoEnable,
  readJson, writeJson, log, run, runShell, which, readStdin, nowIso, slug,
  shuffle, pick, rng, dayKey,
};
