'use strict';
// SQLite store at ~/.diffdojo/diffdojo.db using Node's built-in node:sqlite
// (no native add-on to compile, so the plugin works without `npm install`).

const path = require('path');
const { home, ensureDir } = require('./util');

// node:sqlite prints an ExperimentalWarning on some Node versions; silence only that one.
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite/i.test(msg)) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, started_at TEXT NOT NULL,
  base_head TEXT, base_tree TEXT, last_tree TEXT, last_stop_at TEXT, turns INTEGER DEFAULT 0,
  generated INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS code_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, session_id TEXT,
  file TEXT NOT NULL, language TEXT NOT NULL, name TEXT NOT NULL,
  start_line INTEGER, end_line INTEGER, code TEXT NOT NULL, tracks TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT, session_id TEXT, batch TEXT,
  family TEXT NOT NULL, type TEXT NOT NULL, format TEXT NOT NULL,
  topic TEXT, track TEXT, difficulty TEXT NOT NULL DEFAULT 'medium',
  grading TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, est_seconds INTEGER DEFAULT 60,
  title TEXT, prompt TEXT NOT NULL, code TEXT, code_lang TEXT, code_file TEXT, code_start INTEGER, code_end INTEGER,
  choices TEXT, answer TEXT, explanation TEXT, evidence TEXT, meta TEXT, source TEXT,
  status TEXT NOT NULL DEFAULT 'queued', snooze_until TEXT, exam_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS q_status ON questions(status, repo_id);
CREATE INDEX IF NOT EXISTS q_source ON questions(source);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL,
  response TEXT, correct INTEGER, xp INTEGER NOT NULL DEFAULT 0, feedback TEXT,
  mode TEXT NOT NULL DEFAULT 'normal', time_ms INTEGER, answered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS a_q ON answers(question_id);
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, title TEXT NOT NULL,
  file TEXT, lines TEXT, test_path TEXT, test_command TEXT, output TEXT, report_path TEXT,
  track TEXT, critique_question_id INTEGER, confirmed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS xp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, track TEXT NOT NULL,
  amount INTEGER NOT NULL, base INTEGER NOT NULL, reason TEXT, question_id INTEGER, repo_id TEXT
);
CREATE TABLE IF NOT EXISTS belts (track TEXT PRIMARY KEY, belt TEXT NOT NULL, awarded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT, track TEXT NOT NULL, target_belt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'exam', started_at TEXT NOT NULL, finished_at TEXT,
  passed INTEGER, score INTEGER, required INTEGER, total INTEGER
);
CREATE TABLE IF NOT EXISTS trophies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, awarded_at TEXT NOT NULL, detail TEXT, link TEXT
);
CREATE TABLE IF NOT EXISTS topic_profile (
  repo_id TEXT NOT NULL, topic TEXT NOT NULL, score REAL NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, topic)
);
CREATE TABLE IF NOT EXISTS topic_state (
  topic TEXT PRIMARY KEY, level INTEGER NOT NULL DEFAULT 1, right_run INTEGER NOT NULL DEFAULT 0,
  wrong_run INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rationale (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, session_id TEXT, turn INTEGER,
  message_ref TEXT, sentence TEXT NOT NULL, files TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gen_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER, repo_id TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

let shared = null;

function dbPath() {
  return process.env.DIFFDOJO_DB || path.join(home(), 'diffdojo.db');
}

function open() {
  if (shared) return shared;
  ensureDir(path.dirname(dbPath()));
  const db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  shared = wrap(db);
  return shared;
}

function close() {
  if (shared) {
    try {
      shared.raw.close();
    } catch {
      /* ignore */
    }
    shared = null;
  }
}

function clean(params) {
  // node:sqlite rejects undefined and booleans; normalise.
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function wrap(db) {
  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmts.set(sql, s);
    }
    return s;
  };
  return {
    raw: db,
    all: (sql, ...p) => prep(sql).all(...clean(p)),
    get: (sql, ...p) => prep(sql).get(...clean(p)),
    run: (sql, ...p) => prep(sql).run(...clean(p)),
    exec: (sql) => db.exec(sql),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    getSetting(key, fallback) {
      const r = prep('SELECT value FROM settings WHERE key = ?').get(key);
      return r ? JSON.parse(r.value) : fallback;
    },
    setSetting(key, value) {
      prep('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        JSON.stringify(value),
      );
    },
  };
}

/** Record a repository (path + enabled flag) so progress is tracked across all projects. */
function ensureRepo(db, root, id, enabled = true) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO repos(id, path, enabled, created_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, path = excluded.path, updated_at = excluded.updated_at`,
    id, root, enabled ? 1 : 0, now, now,
  );
}

/** Insert a question object; JSON-encodes structured fields. Returns id. */
function insertQuestion(db, q) {
  const r = db.run(
    `INSERT INTO questions (repo_id, session_id, batch, family, type, format, topic, track, difficulty, grading, xp,
      est_seconds, title, prompt, code, code_lang, code_file, code_start, code_end, choices, answer, explanation,
      evidence, meta, source, status, exam_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    q.repo_id, q.session_id, q.batch, q.family, q.type, q.format, q.topic, q.track, q.difficulty || 'medium',
    q.grading, q.xp || 0, q.est_seconds || 60, q.title, q.prompt, q.code, q.code_lang, q.code_file, q.code_start,
    q.code_end, q.choices ? JSON.stringify(q.choices) : null, q.answer !== undefined ? JSON.stringify(q.answer) : null,
    q.explanation, q.evidence, q.meta ? JSON.stringify(q.meta) : null, q.source, q.status || 'queued', q.exam_id,
    q.created_at || new Date().toISOString(),
  );
  return Number(r.lastInsertRowid);
}

function hydrate(row) {
  if (!row) return row;
  const parse = (v) => (v == null ? null : JSON.parse(v));
  return { ...row, choices: parse(row.choices), answer: parse(row.answer), meta: parse(row.meta) || {} };
}

module.exports = { open, close, dbPath, insertQuestion, hydrate, ensureRepo };
