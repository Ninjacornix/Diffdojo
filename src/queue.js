'use strict';
// Question queue: what to ask next, plus on-demand builders for standalone
// topic quizzes, review mode, belt exams, boss fights and audit mode.

const store = require('./store');
const rewards = require('./rewards');
const config = require('./config');
const codeGen = require('./generators/code');
const { pickPack } = require('./generators/questionnaire');
const { nowIso, shuffle } = require('./util');

function repoPath(db, repoId) {
  const r = db.get('SELECT path FROM repos WHERE id = ?', repoId);
  return r ? r.path : null;
}

/** Wake snoozed questions whose time has come. */
function wake(db) {
  db.run("UPDATE questions SET status = 'queued', snooze_until = NULL WHERE status = 'snoozed' AND snooze_until <= ?", nowIso());
}

function next(db, { repoId, family, topic, examId, exclude = [] } = {}) {
  wake(db);
  const where = [];
  const params = [];
  if (examId) {
    where.push("q.exam_id = ? AND q.status = 'exam'");
    params.push(examId);
  } else {
    where.push("q.status = 'queued'");
    if (repoId) {
      where.push('(q.repo_id = ? OR q.repo_id IS NULL)');
      params.push(repoId);
    }
  }
  if (family) {
    where.push('q.family = ?');
    params.push(family);
  }
  if (topic) {
    where.push("(q.topic = ? OR q.topic LIKE ? || '/%')");
    params.push(topic, topic);
  }
  if (exclude.length) where.push(`q.id NOT IN (${exclude.map(() => '?').join(',')})`);
  const row = db.get(`SELECT q.* FROM questions q WHERE ${where.join(' AND ')} ORDER BY q.batch DESC, q.id ASC LIMIT 1`, ...params, ...exclude);
  return store.hydrate(row);
}

function queuedCount(db, repoId) {
  wake(db);
  const r = repoId
    ? db.get("SELECT COUNT(*) AS n FROM questions WHERE status = 'queued' AND (repo_id = ? OR repo_id IS NULL)", repoId)
    : db.get("SELECT COUNT(*) AS n FROM questions WHERE status = 'queued'");
  return r.n;
}

/** Standalone questionnaire on a topic (works without any Claude session). */
function topicQuiz(db, { topic, count = 5, difficulty }) {
  const qs = pickPack(db, { topics: [{ topic, score: 1 }], topicFilter: topic, count, difficulty });
  const batch = `${nowIso()}#topic`;
  return qs.map((q) => store.insertQuestion(db, { ...q, batch }));
}

/** Review mode: questions answered wrong (latest answer), not marked bad. Half XP. */
function reviewIds(db, { repoId, limit = 10 } = {}) {
  const rows = db.all(
    `SELECT q.id FROM questions q
     WHERE q.status = 'answered' AND q.grading != 'feedback' ${repoId ? 'AND (q.repo_id = ? OR q.repo_id IS NULL)' : ''}
       AND (SELECT a.correct FROM answers a WHERE a.question_id = q.id ORDER BY a.id DESC LIMIT 1) = 0
       AND q.type NOT IN ('kill_test')
     ORDER BY q.id DESC LIMIT ?`,
    ...(repoId ? [repoId, limit] : [limit]),
  );
  return rows.map((r) => r.id);
}

function get(db, id) {
  return store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', id));
}

function recentUnits(db, track, limit = 60) {
  return db
    .all('SELECT * FROM code_units ORDER BY id DESC LIMIT 400')
    .filter((u) => JSON.parse(u.tracks).includes(track))
    .slice(0, limit);
}

function ctxFor(db, unit) {
  const root = repoPath(db, unit.repo_id);
  return { root, cfg: config.load(unit.repo_id) };
}

/** Build a seeded-bug challenge from stored code (used by exams). */
function challengeFrom(db, units, { difficulty, track, rnd }) {
  for (const u of shuffle(units, rnd)) {
    const ctx = ctxFor(db, u);
    const q = codeGen.seededBug(ctx, u, { categories: rewards.categoriesFor(db, track).concat(['concurrency', 'lifetime']), wantDifficulty: difficulty, rnd, budget: { testRuns: 0, deadline: 0 } });
    if (q && (difficulty !== 'hard' || q.difficulty !== 'easy')) return { q: { ...q, track, repo_id: u.repo_id }, unit: u };
  }
  return null;
}

/**
 * Start (or resume) a belt exam in a track. Returns {examId, count} or {error}.
 */
function startExam(db, track, { rnd = Math.random } = {}) {
  const st = rewards.examStatus(db, track);
  if (!st.ok) return { error: st.reason };
  if (st.inProgress) {
    const left = db.get("SELECT COUNT(*) AS n FROM questions WHERE exam_id = ? AND status = 'exam'", st.inProgress.id).n;
    return { examId: st.inProgress.id, count: left, resumed: true, target: st.inProgress.target_belt };
  }
  const spec = st.spec;
  const units = recentUnits(db, track);
  const questions = [];
  let reused = [];
  if (spec.boss) {
    const realBugs = db.get('SELECT COUNT(*) AS n FROM bug_reports WHERE confirmed = 1 AND track = ?', track).n;
    if (realBugs < spec.realBugs) return { error: `The black belt needs at least ${spec.realBugs} confirmed real bug in ${track} (diffdojo report-bug).` };
    const byRepo = units.filter((u) => ctxFor(db, u).root);
    const q = codeGen.bossFight({}, byRepo, { rnd });
    if (!q) return { error: `Not enough recent ${track} code for a boss fight. Keep working in this track.` };
    questions.push({ ...q, track, repo_id: byRepo[0].repo_id });
  } else {
    const codeNeeded = Math.ceil(spec.n / 2);
    // killing tests
    for (let k = 0; k < spec.kills; k++) {
      let made = null;
      for (const u of shuffle(units, rnd)) {
        const ctx = ctxFor(db, u);
        if (!ctx.root || !ctx.cfg.testCommand) continue;
        made = codeGen.killTest(ctx, u, { categories: rewards.categoriesFor(db, track), rnd, budget: { testRuns: 1, deadline: Date.now() + 180000 } });
        if (made) {
          questions.push({ ...made, track, repo_id: u.repo_id });
          break;
        }
      }
      if (!made) return { error: `The ${st.target} exam needs ${spec.kills} killing-test question(s): configure a test command (diffdojo config testCommand "...") in a repo with recent ${track} code.` };
    }
    const used = new Set();
    while (questions.filter((q) => q.family === 'code').length < codeNeeded) {
      const c = challengeFrom(db, units.filter((u) => !used.has(u.id)), { difficulty: spec.difficulty, track, rnd });
      if (!c) return { error: `Not enough recent ${track} code to build the ${st.target} exam (needs ${codeNeeded} code challenges). Keep working in this track and try again.` };
      used.add(c.unit.id);
      questions.push(c.q);
    }
    // verified design questions already generated for this track
    const designRows = db.all(
      "SELECT * FROM questions WHERE status = 'queued' AND family = 'design' AND grading = 'verified' AND track = ? ORDER BY id DESC LIMIT 10", track,
    ).map(store.hydrate);
    const reuse = [];
    for (const d of designRows) {
      if (questions.length + reuse.length >= spec.n) break;
      reuse.push(d.id);
    }
    // curated pack questions for the track
    const need = spec.n - questions.length - reuse.length;
    if (need > 0) {
      let packQs = pickPack(db, { track, count: need, difficulty: spec.difficulty, rnd, allowHard: true });
      if (packQs.length < need) packQs = packQs.concat(pickPack(db, { track, count: need - packQs.length, rnd, allowHard: true }));
      questions.push(...packQs);
    }
    if (questions.length + reuse.length < spec.n) {
      // Fill remaining slots with more code challenges.
      while (questions.length + reuse.length < spec.n) {
        const c = challengeFrom(db, units.filter((u) => !used.has(u.id)), { difficulty: spec.difficulty, track, rnd });
        if (!c) return { error: `Not enough verified ${track} material for a ${spec.n}-question exam yet.` };
        used.add(c.unit.id);
        questions.push(c.q);
      }
    }
    reused = reuse;
  }
  const examId = Number(
    db.run('INSERT INTO exams(track, target_belt, kind, started_at, required, total) VALUES (?,?,?,?,?,?)',
      track, st.target, spec.boss ? 'boss' : 'exam', nowIso(), spec.boss ? 1 : spec.need, spec.boss ? 1 : spec.n).lastInsertRowid,
  );
  const batch = `${nowIso()}#exam${examId}`;
  db.tx(() => {
    for (const q of questions) store.insertQuestion(db, { ...q, status: 'exam', exam_id: examId, batch });
    for (const id of reused) db.run("UPDATE questions SET status = 'exam', exam_id = ? WHERE id = ?", examId, id);
  });
  return { examId, count: questions.length + reused.length, target: st.target };
}

/** On-demand boss fight (Blue+). */
function boss(db, track, { rnd = Math.random } = {}) {
  if (!rewards.unlocked(db, track, 'boss')) return { error: `Boss fights unlock at Blue belt in ${track}.` };
  const units = recentUnits(db, track);
  const q = codeGen.bossFight({}, units, { rnd });
  if (!q) return { error: `Not enough recent ${track} code for a boss fight.` };
  return { id: store.insertQuestion(db, { ...q, track, repo_id: units[0].repo_id, batch: `${nowIso()}#boss` }) };
}

/** On-demand audit question (Brown+). */
function auditQ(db, track, { rnd = Math.random } = {}) {
  if (!rewards.unlocked(db, track, 'audit')) return { error: `Audit mode unlocks at Brown belt in ${track}.` };
  const units = recentUnits(db, track);
  if (!units.length) return { error: `No recent ${track} code to audit.` };
  const u = shuffle(units, rnd)[0];
  const q = codeGen.audit({}, u, { rnd });
  return { id: store.insertQuestion(db, { ...q, track, repo_id: u.repo_id, batch: `${nowIso()}#audit` }) };
}

/** Tracks the user can pick for a boss/audit/exam, with a sensible default. */
function defaultTrack(db, repoId) {
  const row = db.get(
    "SELECT track, COUNT(*) AS n FROM questions WHERE repo_id = ? AND family = 'code' GROUP BY track ORDER BY n DESC LIMIT 1", repoId || '',
  );
  if (row) return row.track;
  const any = db.get('SELECT tracks FROM code_units ORDER BY id DESC LIMIT 1');
  return any ? JSON.parse(any.tracks)[0] : 'cpp';
}

module.exports = { next, queuedCount, topicQuiz, reviewIds, get, startExam, boss, auditQ, defaultTrack, repoPath, recentUnits, wake };
