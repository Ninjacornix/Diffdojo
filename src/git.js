'use strict';
// Git helpers. Snapshots capture the full working tree (tracked + untracked,
// respecting .gitignore) as a tree object using a throwaway index file, so the
// user's real index and stash are never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./util');

function git(root, args, opts = {}) {
  return run('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, timeout: opts.timeout || 60000, env: opts.env });
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
  const r = run('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: root, input: '' });
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

module.exports = { git, toplevel, head, snapshot, baseTree, emptyTree, diff, changedFiles, showFile, listFiles, parseDiff };
