'use strict';
// `diffdojo export` and `diffdojo purge`: one JSON file with everything, or delete it.

const fs = require('fs');
const path = require('path');
const { home, repoDir, readJson } = require('./util');
const store = require('./store');

const REPO_TABLES = {
  sessions: 'repo_id', code_units: 'repo_id', questions: 'repo_id', bug_reports: 'repo_id',
  topic_profile: 'repo_id', rationale: 'repo_id', notes: 'repo_id', xp_events: 'repo_id',
};
const GLOBAL_TABLES = ['repos', 'answers', 'settings', 'xp_events', 'belts', 'exams', 'trophies', 'topic_state', 'gen_log'];

function exportAll(db, { repoId } = {}) {
  const out = { exportedAt: new Date().toISOString(), tool: 'diffdojo', scope: repoId ? { repo: repoId } : 'all', tables: {} };
  if (repoId) {
    for (const [t, col] of Object.entries(REPO_TABLES)) out.tables[t] = db.all(`SELECT * FROM ${t} WHERE ${col} = ?`, repoId);
    const qids = out.tables.questions.map((q) => q.id);
    out.tables.answers = qids.length ? db.all(`SELECT * FROM answers WHERE question_id IN (${qids.map(() => '?').join(',')})`, ...qids) : [];
    out.tables.repos = db.all('SELECT * FROM repos WHERE id = ?', repoId);
    out.events = (() => {
      try {
        return fs.readFileSync(path.join(repoDir(repoId), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    })();
    out.config = readJson(path.join(repoDir(repoId), 'config.json'), {});
  } else {
    const all = new Set([...Object.keys(REPO_TABLES), ...GLOBAL_TABLES]);
    for (const t of all) out.tables[t] = db.all(`SELECT * FROM ${t}`);
    out.config = readJson(path.join(home(), 'config.json'), {});
  }
  return out;
}

function purge(db, { repoId } = {}) {
  if (repoId) {
    const qids = db.all('SELECT id FROM questions WHERE repo_id = ?', repoId).map((r) => r.id);
    db.tx(() => {
      for (const id of qids) db.run('DELETE FROM answers WHERE question_id = ?', id);
      for (const [t, col] of Object.entries(REPO_TABLES)) db.run(`DELETE FROM ${t} WHERE ${col} = ?`, repoId);
      db.run('DELETE FROM repos WHERE id = ?', repoId);
    });
    fs.rmSync(repoDir(repoId), { recursive: true, force: true });
    return { removed: repoDir(repoId) };
  }
  store.close();
  for (const f of ['diffdojo.db', 'diffdojo.db-wal', 'diffdojo.db-shm']) fs.rmSync(path.join(home(), f), { force: true });
  for (const ent of fs.existsSync(home()) ? fs.readdirSync(home(), { withFileTypes: true }) : []) {
    if (ent.isDirectory() && /^[0-9a-f]{16}$/.test(ent.name)) fs.rmSync(path.join(home(), ent.name), { recursive: true, force: true });
  }
  fs.rmSync(path.join(home(), 'logs'), { recursive: true, force: true });
  return { removed: home() };
}

module.exports = { exportAll, purge };
