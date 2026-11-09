'use strict';
// Rewards engine: XP (with streak bonus), per-track belts, unlocks, belt
// exams and trophies. All local; see docs/REWARDS.md.

const { dayKey, nowIso } = require('./util');

const BELTS = ['white', 'yellow', 'orange', 'green', 'blue', 'brown', 'black'];
const THRESHOLDS = { white: 0, yellow: 150, orange: 400, green: 900, blue: 1800, brown: 3500, black: 6000 };
const EXAMS = {
  yellow: { n: 5, difficulty: 'medium', need: 4, kills: 0 },
  orange: { n: 5, difficulty: 'medium', need: 4, kills: 0 },
  green: { n: 6, difficulty: 'hard', need: 5, kills: 0 },
  blue: { n: 6, difficulty: 'hard', need: 5, kills: 1 },
  brown: { n: 8, difficulty: 'hard', need: 7, kills: 2 },
  black: { boss: true, realBugs: 1 },
};
const RETAKE_HOURS = 24;

const UNLOCKS = [
  ['yellow', 'killtest', '"Write a killing test" questions'],
  ['orange', 'hard', 'Hard difficulty and multi-function mutants'],
  ['green', 'concurrency', 'Concurrency and lifetime mutants (missing lock, use-after-move, copies instead of references)'],
  ['blue', 'boss', 'Boss fights: a whole changed file with 2-3 hidden mutations'],
  ['brown', 'audit', 'Audit mode: decide whether a seeded bug exists at all'],
  ['black', 'custom', 'Custom mutation operators (~/.diffdojo/operators/*.json)'],
];

const TROPHIES = {
  'first-catch': 'First Catch — first confirmed real bug in Claude\'s code',
  'bug-hunter-1': 'Bug Hunter I — 5 confirmed real bugs',
  'bug-hunter-2': 'Bug Hunter II — 25 confirmed real bugs',
  'bug-hunter-3': 'Bug Hunter III — 100 confirmed real bugs',
  'mutant-slayer': 'Mutant Slayer — 25 accepted killing tests',
  'clean-sweep': 'Clean Sweep — cleared a boss fight without a wrong guess',
  'iron-streak': 'Iron Streak — 30-day streak',
  polyglot: 'Polyglot — green belt in three tracks',
  architect: 'Architect — 50 correct architecture questions',
  'mind-reader': 'Mind Reader — 25 correct "why Claude did it" answers in a row',
  'second-opinion': 'Second Opinion — a critique you wrote led to a confirmed bug report',
  scholar: 'Scholar — answered every question in a curated pack correctly',
  'pack-author': 'Pack Author — got a question merged into a public pack (self-reported)',
  skeptic: 'Skeptic — correctly answered "no bug here" five times in audit mode',
};

function beltIndex(b) {
  return BELTS.indexOf(b || 'white');
}

function trackXp(db, track) {
  return db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM xp_events WHERE track = ?', track).n;
}

function totalXp(db) {
  return db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM xp_events').n;
}

function beltOf(db, track) {
  const r = db.get('SELECT belt FROM belts WHERE track = ?', track);
  return r ? r.belt : 'white';
}

function tracks(db) {
  const rows = db.all('SELECT DISTINCT track FROM xp_events UNION SELECT track FROM belts');
  return rows.map((r) => r.track).filter(Boolean).sort();
}

/** Overall belt = the second-highest track belt (breadth, not one specialty). */
function overallBelt(db) {
  const bs = tracks(db).map((t) => beltIndex(beltOf(db, t))).sort((a, b) => b - a);
  return BELTS[bs.length >= 2 ? bs[1] : 0];
}

function nextBelt(belt) {
  const i = beltIndex(belt);
  return i < BELTS.length - 1 ? BELTS[i + 1] : null;
}

function unlocked(db, track, feature) {
  const u = UNLOCKS.find((x) => x[1] === feature);
  if (!u) return true;
  return beltIndex(beltOf(db, track)) >= beltIndex(u[0]);
}

/** Mutation categories available for a track. */
function categoriesFor(db, track) {
  const cats = ['basic'];
  if (unlocked(db, track, 'concurrency')) cats.push('concurrency', 'lifetime');
  return cats;
}

// ---- streaks

function answerDays(db) {
  const rows = db.all("SELECT answered_at FROM answers WHERE correct IS NOT NULL AND mode != 'bad'");
  return new Set(rows.map((r) => dayKey(new Date(r.answered_at))));
}

function streak(db, today = new Date()) {
  const days = answerDays(db);
  let n = 0;
  const d = new Date(today);
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // streak still alive until today ends
  while (days.has(dayKey(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function streakBonus(s) {
  return s >= 3 ? Math.min(0.5, 0.1 * (s - 2)) : 0;
}

/** Record XP. Streak bonus applies from day 3 (+10%/day, capped at +50%). */
function award(db, { track, base, reason, questionId, repoId }) {
  if (!base || base <= 0) return 0;
  const s = streak(db);
  const amount = Math.round(base * (1 + streakBonus(s)));
  db.run(
    'INSERT INTO xp_events(ts, day, track, amount, base, reason, question_id, repo_id) VALUES (?,?,?,?,?,?,?,?)',
    nowIso(), dayKey(), track || 'general', amount, base, reason, questionId, repoId,
  );
  return amount;
}

// ---- trophies

function hasTrophy(db, id) {
  return !!db.get('SELECT 1 FROM trophies WHERE id = ?', id);
}

function grant(db, id, detail, link) {
  if (hasTrophy(db, id)) return null;
  db.run('INSERT INTO trophies(id, name, awarded_at, detail, link) VALUES (?,?,?,?,?)', id, TROPHIES[id] || id, nowIso(), detail || null, link || null);
  return { id, name: TROPHIES[id] || id };
}

/** Evaluate all automatic trophies; returns newly granted ones. */
function checkTrophies(db) {
  const out = [];
  const g = (id, detail, link) => {
    const t = grant(db, id, detail, link);
    if (t) out.push(t);
  };
  const bugs = db.all('SELECT id, report_path, critique_question_id FROM bug_reports WHERE confirmed = 1 ORDER BY id');
  if (bugs.length >= 1) g('first-catch', null, bugs[0].report_path);
  if (bugs.length >= 5) g('bug-hunter-1', null, bugs[4].report_path);
  if (bugs.length >= 25) g('bug-hunter-2', null, bugs[24].report_path);
  if (bugs.length >= 100) g('bug-hunter-3', null, bugs[99].report_path);
  const crit = bugs.find((b) => b.critique_question_id);
  if (crit) g('second-opinion', null, crit.report_path);

  const kills = db.get("SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.type = 'kill_test' AND a.correct = 1").n;
  if (kills >= 25) g('mutant-slayer');
  if (streak(db) >= 30) g('iron-streak');
  const greens = tracks(db).filter((t) => beltIndex(beltOf(db, t)) >= beltIndex('green'));
  if (greens.length >= 3) g('polyglot', greens.join(', '));
  const arch = db.get("SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.type = 'architecture' AND a.correct = 1").n;
  if (arch >= 50) g('architect');

  // Mind Reader: 25 consecutive correct "why" answers.
  const why = db.all("SELECT a.correct FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.type = 'why' AND a.correct IS NOT NULL ORDER BY a.id");
  let run = 0;
  let best = 0;
  for (const w of why) {
    run = w.correct ? run + 1 : 0;
    best = Math.max(best, run);
  }
  if (best >= 25) g('mind-reader');

  const skeptic = db.get("SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.type = 'audit' AND a.correct = 1 AND json_extract(q.answer, '$.lines') = '[]'").n;
  if (skeptic >= 5) g('skeptic');

  const clean = db.get("SELECT 1 AS x FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.type = 'boss' AND a.correct = 1 AND json_extract(a.feedback, '$.wrong') = 0");
  if (clean) g('clean-sweep');

  // Scholar: some curated pack fully answered correctly at least once.
  try {
    const packs = require('./packs').load();
    const correct = new Set(db.all("SELECT DISTINCT q.source FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.source LIKE 'pack:%' AND a.correct = 1").map((r) => r.source.slice(5)));
    const byPack = new Map();
    for (const q of packs.questions) {
      if (q.origin !== 'shipped') continue;
      if (!byPack.has(q.pack)) byPack.set(q.pack, []);
      byPack.get(q.pack).push(q.id);
    }
    for (const [pack, ids] of byPack) {
      if (ids.length && ids.every((id) => correct.has(id))) {
        g('scholar', pack);
        break;
      }
    }
  } catch {
    /* packs unavailable */
  }
  return out;
}

// ---- exams

function lastExam(db, track) {
  return db.get('SELECT * FROM exams WHERE track = ? ORDER BY id DESC LIMIT 1', track);
}

/** Can the user sit the next belt exam in this track? */
function examStatus(db, track, now = Date.now()) {
  const belt = beltOf(db, track);
  const target = nextBelt(belt);
  if (!target) return { ok: false, reason: 'Black belt reached: nothing left to earn in this track.', belt };
  const xp = trackXp(db, track);
  if (xp < THRESHOLDS[target]) return { ok: false, reason: `${THRESHOLDS[target] - xp} more ${track} XP to unlock the ${target} belt exam.`, belt, target, xp };
  const last = lastExam(db, track);
  if (last && !last.finished_at) return { ok: true, inProgress: last, belt, target, xp };
  if (last && last.passed === 0 && last.target_belt === target) {
    const wait = Date.parse(last.finished_at) + RETAKE_HOURS * 3600000 - now;
    if (wait > 0) return { ok: false, reason: `Exam failed; retake available in ${Math.ceil(wait / 3600000)} h.`, belt, target, xp };
  }
  return { ok: true, belt, target, xp, spec: EXAMS[target] };
}

function finishExam(db, examId) {
  const exam = db.get('SELECT * FROM exams WHERE id = ?', examId);
  if (!exam || exam.finished_at) return exam;
  const rows = db.all(
    `SELECT q.id, q.type, (SELECT a.correct FROM answers a WHERE a.question_id = q.id ORDER BY a.id DESC LIMIT 1) AS correct
     FROM questions q WHERE q.exam_id = ?`, examId,
  );
  if (rows.some((r) => r.correct === null || r.correct === undefined)) return exam; // not finished
  const score = rows.filter((r) => r.correct === 1).length;
  let passed;
  const spec = EXAMS[exam.target_belt];
  if (spec.boss) {
    const realBugs = db.get('SELECT COUNT(*) AS n FROM bug_reports WHERE confirmed = 1 AND track = ?', exam.track).n;
    passed = score === rows.length && realBugs >= spec.realBugs;
  } else {
    const kills = rows.filter((r) => r.type === 'kill_test' && r.correct === 1).length;
    passed = score >= spec.need && kills >= spec.kills;
  }
  db.run('UPDATE exams SET finished_at = ?, passed = ?, score = ? WHERE id = ?', nowIso(), passed ? 1 : 0, score, examId);
  if (passed) {
    db.run('INSERT INTO belts(track, belt, awarded_at) VALUES (?,?,?) ON CONFLICT(track) DO UPDATE SET belt = excluded.belt, awarded_at = excluded.awarded_at', exam.track, exam.target_belt, nowIso());
    if (spec.boss) award(db, { track: exam.track, base: 100, reason: 'boss fight cleared (black belt exam)' });
  }
  return db.get('SELECT * FROM exams WHERE id = ?', examId);
}

module.exports = {
  BELTS, THRESHOLDS, EXAMS, UNLOCKS, TROPHIES, RETAKE_HOURS,
  beltIndex, trackXp, totalXp, beltOf, tracks, overallBelt, nextBelt, unlocked, categoriesFor,
  streak, streakBonus, award, grant, hasTrophy, checkTrophies, examStatus, finishExam, lastExam,
};
