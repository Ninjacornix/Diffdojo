'use strict';
// Git helpers. Snapshots capture the full working tree (tracked + untracked,
// respecting .gitignore) as a tree object using a throwaway index file, so the
// user's real index and stash are never touched.
//
// A project folder without git of its own is tracked through a shadow
// repository in ~/.diffdojo/<id>/shadow.git with the folder as its work tree:
// the same commands work, and nothing is ever written into the folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, shadowGitDir } = require('./util');

// Never snapshotted in a shadow-tracked folder (a real repo's .gitignore decides there).
const SHADOW_EXCLUDE = [
  '.git/', 'node_modules/', '.venv/', 'venv/', 'env/', '__pycache__/', '.tox/', '.mypy_cache/', '.pytest_cache/',
  'build/', 'dist/', 'out/', 'target/', 'bin/Debug/', 'bin/Release/', 'obj/', '.next/', '.cache/', 'coverage/',
  '.idea/', '.vs/', '.vscode/', '.DS_Store', 'Thumbs.db', '*.exe', '*.dll', '*.so', '*.dylib', '*.o', '*.obj',
  '*.pyc', '*.class', '*.jar', '*.zip', '*.gz', '*.tar', '*.7z', '*.iso', '*.mp4', '*.mov', '*.mp3', '*.pdf',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.psd', '*.sqlite', '*.db', '*.log', '.env*', '*.pem', '*.key',
];
const SHADOW_MAX_FILES = 20000;

/** Count files under `dir` (skipping excluded folders), stopping past `limit`. */
function countFiles(dir, limit) {
  const skip = new Set(SHADOW_EXCLUDE.filter((p) => p.endsWith('/') && !p.includes('*')).map((p) => p.slice(0, -1)));
  let n = 0;
  const stack = [dir];
  while (stack.length && n <= limit) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!skip.has(e.name)) stack.push(path.join(cur, e.name));
      } else if (++n > limit) break;
    }
  }
  return n;
}

/** Create the shadow repository on first use. False when the folder is too big to track. */
function ensureShadow(root, gd) {
  if (fs.existsSync(path.join(gd, 'HEAD'))) return true;
  if (countFiles(root, SHADOW_MAX_FILES) > SHADOW_MAX_FILES) return false;
  fs.mkdirSync(gd, { recursive: true });
  if (run('git', ['init', '-q', '--bare', gd], { timeout: 30000 }).code !== 0) return false;
  fs.mkdirSync(path.join(gd, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'info', 'exclude'), SHADOW_EXCLUDE.join('\n') + '\n');
  return true;
}

/** The environment that points git at a folder's shadow repository, or {} for a real repo. */
function repoEnv(root) {
  const gd = shadowGitDir(root);
  if (!gd) return {};
  if (!ensureShadow(root, gd)) return { GIT_DIR: path.join(gd, 'too-large'), GIT_WORK_TREE: root };
  return { GIT_DIR: gd, GIT_WORK_TREE: root };
}

function git(root, args, opts = {}) {
  return run('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, timeout: opts.timeout || 60000, input: opts.input, env: { ...repoEnv(root), ...(opts.env || {}) } });
}

function toplevel(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? path.resolve(r.stdout.trim()) : null;
}

function head(root) {
  const r = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

function gitDir(root) {
  const r = git(root, ['rev-parse', '--absolute-git-dir']);
  return r.code === 0 ? r.stdout.trim() : path.join(root, '.git');
}

/** Write the current working tree to a git tree object. Returns tree hash or null. */
function snapshot(root) {
  const tmp = path.join(os.tmpdir(), `diffdojo-index-${process.pid}-${Date.now()}`);
  try {
    const real = path.join(gitDir(root), 'index');
    if (fs.existsSync(real)) fs.copyFileSync(real, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    const add = git(root, ['add', '-A', '--', '.'], { env, timeout: 120000 });
    if (add.code !== 0) return null;
    const w = git(root, ['write-tree'], { env });
    return w.code === 0 ? w.stdout.trim() : null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function emptyTree(root) {
  const r = git(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' });
  return r.stdout.trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

/** Base for a new session: HEAD's tree if clean, otherwise a snapshot including uncommitted work. */
function baseTree(root) {
  return snapshot(root) || (head(root) ? `${head(root)}^{tree}` : emptyTree(root));
}

function diff(root, fromTree, toTree, files) {
  const args = ['diff', '--no-color', '--no-ext-diff', '-U3', '-M', fromTree, toTree];
  if (files && files.length) args.push('--', ...files);
  const r = git(root, args);
  return r.code === 0 ? r.stdout : '';
}

function changedFiles(root, fromTree, toTree) {
  const r = git(root, ['diff', '--name-only', '-M', fromTree, toTree]);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

function showFile(root, tree, file) {
  const r = git(root, ['show', `${tree}:${file}`]);
  return r.code === 0 ? r.stdout : null;
}

/** Tracked and untracked (non-ignored) files, for copying a workspace. */
function listFiles(root) {
  const r = git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : [];
}

/**
 * Parse unified diff text into
 * [{file, oldFile, binary, added:[lineNo], removed:number, hunks:[{oldStart,newStart,lines:[{t,text,newLine}]}]}]
 */
function parseDiff(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  let newLine = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { file: null, oldFile: null, binary: false, added: [], removed: 0, hunks: [], deleted: false, created: false };
      files.push(cur);
      hunk = null;
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m) {
        cur.oldFile = m[1];
        cur.file = m[2];
      }
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('Binary files ')) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) cur.deleted = true;
    if (line.startsWith('new file mode')) cur.created = true;
    if (line.startsWith('--- ')) {
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') cur.file = p.replace(/^b\//, '');
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      hunk = { oldStart: +h[1], newStart: +h[2], lines: [] };
      cur.hunks.push(hunk);
      newLine = +h[2];
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) {
      hunk.lines.push({ t: '+', text: line.slice(1), newLine });
      cur.added.push(newLine);
      newLine++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ t: '-', text: line.slice(1), newLine: null });
      cur.removed++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ t: ' ', text: line.slice(1), newLine });
      newLine++;
    }
  }
  return files.filter((f) => f.file);
}

module.exports = { repoEnv, git, toplevel, head, snapshot, baseTree, emptyTree, diff, changedFiles, showFile, listFiles, parseDiff };
