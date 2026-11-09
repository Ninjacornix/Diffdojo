'use strict';
// Grader: compares answers with ground truth established before the question
// was shown (execution, parsed code, reviewed packs, Claude's cited reasoning)
// and books XP / adaptive difficulty / trophies / exam progress.

const fs = require('fs');
const path = require('path');
const { normalizeOutput, runTests } = require('./runner');
const rewards = require('./rewards');
const { recordResult } = require('./generators/questionnaire');
const { replaceRange } = require('./generators/code');
const model = require('./model');
const { nowIso } = require('./util');

function normShort(s) {
  return String(s)
    .toLowerCase()
    .replace(/[×·*]/g, '')
    .replace(/\s+/g, '')
    .replace(/[.,;:!]+$/, '')
    .replace(/^the/, '');
}

function letters(s) {
  const t = String(s).toLowerCase().trim();
  if (/^[a-z]+$/.test(t) && t.length <= 8) return t.split('');
  return t.split(/[\s,;>-]+/).filter(Boolean);
}

function ints(s) {
  return (String(s).match(/-?\d+/g) || []).map(Number);
}

function unquote(s) {
  return s.replace(/^(['"])(.*)\1$/s, '$2');
}

/** Pure correctness check. Returns {correct: true|false|null, detail?} */
function check(q, response) {
  const r = response == null ? '' : String(response).trim();
  const a = q.answer;
  switch (q.format) {
    case 'choice':
    case 'multiple_choice':
      return { correct: letters(r)[0] === a };
    case 'multi':
    case 'multiple_select': {
      const got = [...new Set(letters(r))].sort().join(',');
      return { correct: got === [...a].sort().join(',') };
    }
    case 'ordering':
      return { correct: letters(r).join(',') === a.join(',') };
    case 'true_false': {
      const m = /^\s*(true|false|t|f|yes|no|y|n)\b[\s,;:.-]*(.*)$/is.exec(r);
      if (!m) return { correct: false };
      const v = /^(true|t|yes|y)$/i.test(m[1]);
      return { correct: v === a, reason: m[2].trim() };
    }
    case 'short_answer': {
      const accepted = [a.value, ...(a.accept || [])].map(normShort);
      return { correct: accepted.includes(normShort(r)) };
    }
    case 'output':
    case 'predict_output': {
      const expected = normalizeOutput(typeof a === 'object' && a !== null ? a.output : a);
      const got = normalizeOutput(r);
      return { correct: got === expected || unquote(got) === unquote(expected) };
    }
    case 'line': {
      const n = ints(r)[0];
      const why = r.replace(/^\s*-?\d+\s*[,:;.-]?\s*/, '');
      return { correct: n !== undefined && a.lines.includes(n), why };
    }
    case 'audit': {
      if (/^\s*(none|no|clean|no bug|0)\s*$/i.test(r)) return { correct: a.lines.length === 0 };
      const n = ints(r)[0];
      return { correct: n !== undefined && a.lines.includes(n) };
    }
    case 'lines': {
      const got = [...new Set(ints(r))];
      const found = got.filter((n) => a.lines.includes(n));
      const wrong = got.length - found.length;
      return { correct: found.length === a.lines.length && wrong <= 1, wrong, found: found.length };
    }
    case 'text':
      return { correct: null };
    default:
      return { correct: false };
  }
}

/** Grade a killing test: must pass on the original and fail on the hidden mutant. */
function gradeKillTest(q, testPath, root, cfg) {
  if (!cfg.testCommand) return { correct: false, detail: 'No test command configured (diffdojo config testCommand "<cmd>").' };
  const rel = path.isAbsolute(testPath) ? path.relative(root, testPath) : testPath;
  if (!rel || rel.startsWith('..')) return { correct: false, detail: 'The test file must be inside the repository.' };
  if (!fs.existsSync(path.join(root, rel))) return { correct: false, detail: `Test file not found: ${rel}` };
  const a = q.answer;
  let src;
  try {
    src = fs.readFileSync(path.join(root, a.file), 'utf8');
  } catch {
    return { correct: false, detail: `${a.file} no longer exists.` };
  }
  const orig = src.split('\n').slice(a.start - 1, a.end).join('\n');
  if (orig !== q.code) return { correct: false, detail: `${a.file} changed since the question was generated; the mutant can't be applied. Mark it bad (b) to drop it.` };
  const mutated = replaceRange(src, a.start, a.end, a.mutantCode);
  const t = { timeoutSec: cfg.testTimeoutSec };
  const onOrig = runTests(root, cfg.testCommand, {}, t);
  if (!onOrig.ran) return { correct: false, detail: onOrig.reason };
  if (!onOrig.passed) return { correct: false, detail: `Your test suite fails on the ORIGINAL code, so the test can't be accepted.\n${onOrig.output.slice(-1500)}` };
  const onMut = runTests(root, cfg.testCommand, { [a.file]: mutated }, t);
  if (!onMut.ran) return { correct: false, detail: onMut.reason };
  if (onMut.passed) return { correct: false, detail: 'All tests still pass on the mutant: your test does not catch it yet.' };
  return { correct: true, detail: `Passed on the original, failed on the mutant.\n${onMut.output.slice(-1200)}` };
}

const MODE_FACTOR = { normal: 1, exam: 1, review: 0.5, boss: 1, audit: 1 };

/**
 * Grade and record an answer.
 * @returns {Promise<{correct, xp, explanation, evidence, detail, feedback, trophies, examResult}>}
 */
async function answer(db, q, response, { mode = 'normal', root, cfg, timeMs } = {}) {
  let res;
  if (q.format === 'killtest') res = gradeKillTest(q, String(response || '').trim(), root, cfg);
  else res = check(q, response);

  let feedback = null;
  const wantsFeedback = q.format === 'text' || (q.format === 'line' && res.why) || (q.format === 'true_false' && res.reason);
  if (wantsFeedback && cfg && model.available(db, cfg).ok) {
    feedback = await model.feedback(db, cfg, { question: q.prompt, code: q.code, answer: String(response) });
  }
  if (q.format === 'text') {
    db.run('INSERT INTO notes(question_id, repo_id, body, created_at) VALUES (?,?,?,?)', q.id, q.repo_id, String(response || ''), nowIso());
  }

  // XP: only once per question for a correct answer (review mode re-awards at half).
  let xp = 0;
  const already = db.get('SELECT 1 AS x FROM answers WHERE question_id = ? AND correct = 1', q.id);
  if (res.correct === true && (!already || mode === 'review')) {
    let base = q.xp * (MODE_FACTOR[mode] || 1);
    if (q.type === 'boss' && mode !== 'exam') base = 100;
    xp = rewards.award(db, { track: q.track, base: Math.round(base), reason: `${q.type} (${q.difficulty})`, questionId: q.id, repoId: q.repo_id });
  }
  const fb = q.format === 'lines' ? JSON.stringify({ wrong: res.wrong, found: res.found }) : feedback;
  db.run(
    'INSERT INTO answers(question_id, response, correct, xp, feedback, mode, time_ms, answered_at) VALUES (?,?,?,?,?,?,?,?)',
    q.id, response == null ? null : String(response), res.correct === null ? null : res.correct ? 1 : 0, xp, fb, mode, timeMs || null, nowIso(),
  );
  db.run("UPDATE questions SET status = 'answered' WHERE id = ?", q.id);
  if (res.correct !== null && q.grading !== 'feedback') recordResult(db, q.topic, res.correct);

  let examResult = null;
  if (q.exam_id) examResult = rewards.finishExam(db, q.exam_id);
  const trophies = rewards.checkTrophies(db);
  return {
    correct: res.correct,
    xp,
    detail: res.detail || null,
    wrong: res.wrong,
    explanation: q.explanation,
    evidence: q.evidence,
    feedback,
    trophies,
    examResult,
  };
}

function skip(db, q) {
  db.run("UPDATE questions SET status = 'skipped' WHERE id = ?", q.id);
}

function snooze(db, q, minutes = 60) {
  db.run("UPDATE questions SET status = 'snoozed', snooze_until = ? WHERE id = ?", new Date(Date.now() + minutes * 60000).toISOString(), q.id);
}

/** "Bad question": excluded from stats; model-checked questions are removed (disputed). */
function bad(db, q, note) {
  db.run("UPDATE questions SET status = ? WHERE id = ?", q.grading === 'model' ? 'disputed' : 'bad', q.id);
  if (note) db.run('INSERT INTO notes(question_id, repo_id, body, created_at) VALUES (?,?,?,?)', q.id, q.repo_id, `[bad question] ${note}`, nowIso());
}

module.exports = { check, answer, skip, snooze, bad, gradeKillTest, normShort };
