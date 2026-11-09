'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isolate } = require('./helpers');

isolate();
const store = require('../src/store');
const grader = require('../src/grader');
const rewards = require('../src/rewards');
const stats = require('../src/stats');
const config = require('../src/config');
const { recordResult, topicLevel } = require('../src/generators/questionnaire');

const db = store.open();
const cfg = config.load(null);

function q(over) {
  const id = store.insertQuestion(db, {
    family: 'questionnaire', type: 'pack', format: 'choice', topic: 'cpp/core', track: 'cpp', difficulty: 'medium',
    grading: 'verified', xp: 10, prompt: 'p', answer: 'b', choices: { a: 'x', b: 'y' }, ...over,
  });
  return store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', id));
}

test('check(): every answer format', () => {
  const c = (format, answer, resp) => grader.check({ format, answer }, resp).correct;
  assert.ok(c('choice', 'b', ' B '));
  assert.ok(!c('choice', 'b', 'a'));
  assert.ok(c('multi', ['a', 'c'], 'c, a'));
  assert.ok(c('multi', ['a', 'c'], 'ca'));
  assert.ok(!c('multi', ['a', 'c'], 'a'));
  assert.ok(c('ordering', ['b', 'a', 'c'], 'b,a,c'));
  assert.ok(c('ordering', ['b', 'a', 'c'], 'bac'));
  assert.ok(!c('ordering', ['b', 'a', 'c'], 'a,b,c'));
  assert.ok(c('true_false', true, 'true because x'));
  assert.ok(c('true_false', false, 'F'));
  assert.ok(c('short_answer', { value: 'O(n log n)', accept: [] }, 'o(nlogn)'));
  assert.ok(c('short_answer', { value: 'O(1)', accept: ['constant'] }, 'Constant'));
  assert.ok(c('output', { output: '"abc"' }, 'abc'));
  assert.ok(c('predict_output', '1 2\n3', '1  2\n3\n'));
  assert.ok(c('line', { lines: [3] }, '3 off by one'));
  assert.ok(c('line', { lines: [2, 3] }, '2'));
  assert.ok(!c('line', { lines: [3] }, 'line four'));
  assert.ok(c('audit', { lines: [] }, 'none'));
  assert.ok(!c('audit', { lines: [] }, '4'));
  assert.ok(c('audit', { lines: [4] }, '4'));
  const boss = grader.check({ format: 'lines', answer: { lines: [3, 9] } }, '3, 9, 12');
  assert.ok(boss.correct && boss.wrong === 1, 'one wrong guess still clears');
  assert.ok(!grader.check({ format: 'lines', answer: { lines: [3, 9] } }, '3, 12, 14').correct);
  assert.strictEqual(grader.check({ format: 'text' }, 'anything').correct, null);
});

test('XP is awarded once per question, in the right track, and review gives half', async () => {
  const a = q({ xp: 10 });
  const r1 = await grader.answer(db, a, 'b', { cfg });
  assert.strictEqual(r1.correct, true);
  assert.strictEqual(r1.xp, 10);
  const r2 = await grader.answer(db, a, 'b', { cfg });
  assert.strictEqual(r2.xp, 0, 'no double XP');
  const r3 = await grader.answer(db, a, 'b', { cfg, mode: 'review' });
  assert.strictEqual(r3.xp, 5, 'review mode is half XP');
  const wrong = await grader.answer(db, q({ xp: 10 }), 'a', { cfg });
  assert.strictEqual(wrong.xp, 0);
  const fb = await grader.answer(db, q({ format: 'text', grading: 'feedback', xp: 0, answer: undefined, choices: null }), 'my critique', { cfg });
  assert.strictEqual(fb.correct, null);
  assert.ok(db.get("SELECT 1 AS x FROM notes WHERE body = 'my critique'"), 'critique saved as a note');
  assert.strictEqual(rewards.trackXp(db, 'cpp'), 15);
});

test('skip, snooze and bad question', () => {
  const a = q({});
  grader.skip(db, a);
  assert.strictEqual(db.get('SELECT status FROM questions WHERE id = ?', a.id).status, 'skipped');
  const b = q({});
  grader.snooze(db, b, 60);
  assert.strictEqual(db.get('SELECT status FROM questions WHERE id = ?', b.id).status, 'snoozed');
  const c = q({});
  grader.bad(db, c, 'ambiguous');
  assert.strictEqual(db.get('SELECT status FROM questions WHERE id = ?', c.id).status, 'bad');
  const m = q({ grading: 'model' });
  grader.bad(db, m);
  assert.strictEqual(db.get('SELECT status FROM questions WHERE id = ?', m.id).status, 'disputed');
});

test('adaptive difficulty: two right raise, two wrong lower', () => {
  const t = 'networking/epoll';
  assert.strictEqual(topicLevel(db, t), 1);
  recordResult(db, t, true);
  recordResult(db, t, true);
  assert.strictEqual(topicLevel(db, t), 2);
  recordResult(db, t, true);
  recordResult(db, t, false);
  recordResult(db, t, false);
  assert.strictEqual(topicLevel(db, t), 1);
});

test('streak bonus: +10%/day from day 3, capped at 50%', () => {
  assert.strictEqual(rewards.streakBonus(1), 0);
  assert.strictEqual(rewards.streakBonus(2), 0);
  assert.strictEqual(rewards.streakBonus(3), 0.1);
  assert.ok(Math.abs(rewards.streakBonus(5) - 0.3) < 1e-9);
  assert.strictEqual(rewards.streakBonus(30), 0.5);
});

test('streak counts consecutive local days with answers', () => {
  const d = new Date();
  const iso = (daysAgo) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, 12).toISOString();
  const qq = q({});
  db.run('DELETE FROM answers');
  for (const ago of [0, 1, 2, 4]) db.run('INSERT INTO answers(question_id, response, correct, xp, mode, answered_at) VALUES (?,?,?,?,?,?)', qq.id, 'b', 1, 0, 'normal', iso(ago));
  assert.strictEqual(rewards.streak(db), 3);
});

test('belts: exam unlock threshold, pass awards belt, fail has 24h retake', () => {
  db.run("DELETE FROM xp_events WHERE track = 'python'");
  assert.match(rewards.examStatus(db, 'python').reason, /150 more python XP/);
  db.run("INSERT INTO xp_events(ts, day, track, amount, base) VALUES (?, '2026-01-01', 'python', 150, 150)", new Date().toISOString());
  const st = rewards.examStatus(db, 'python');
  assert.ok(st.ok && st.target === 'yellow' && st.spec.n === 5 && st.spec.need === 4);
  // simulate an exam with 5 questions, 4 correct
  const examId = Number(db.run("INSERT INTO exams(track, target_belt, started_at, required, total) VALUES ('python','yellow',?,4,5)", new Date().toISOString()).lastInsertRowid);
  for (let i = 0; i < 5; i++) {
    const id = store.insertQuestion(db, { family: 'code', type: 'seeded_bug', format: 'line', track: 'python', grading: 'verified', xp: 20, prompt: 'p', answer: { lines: [1] }, status: 'exam', exam_id: examId });
    db.run('INSERT INTO answers(question_id, response, correct, xp, mode, answered_at) VALUES (?,?,?,?,?,?)', id, '1', i < 4 ? 1 : 0, 0, 'exam', new Date().toISOString());
  }
  const done = rewards.finishExam(db, examId);
  assert.strictEqual(done.passed, 1);
  assert.strictEqual(rewards.beltOf(db, 'python'), 'yellow');
  assert.ok(rewards.unlocked(db, 'python', 'killtest'));
  assert.ok(!rewards.unlocked(db, 'python', 'hard'));
  // failed exam -> retake lock
  db.run("INSERT INTO xp_events(ts, day, track, amount, base) VALUES (?, '2026-01-01', 'python', 300, 300)", new Date().toISOString());
  db.run("INSERT INTO exams(track, target_belt, started_at, finished_at, passed, score, required, total) VALUES ('python','orange',?,?,0,2,4,5)", new Date().toISOString(), new Date().toISOString());
  assert.match(rewards.examStatus(db, 'python').reason, /retake available in 24 h/);
});

test('overall belt is the second-highest track belt', () => {
  db.run('DELETE FROM belts');
  db.run("INSERT INTO belts VALUES ('cpp','green',?), ('python','yellow',?), ('dsa','blue',?)", 'x', 'x', 'x');
  assert.strictEqual(rewards.overallBelt(db), 'green');
  db.run('DELETE FROM belts');
  db.run("INSERT INTO belts VALUES ('cpp','black',?)", 'x');
  assert.strictEqual(rewards.overallBelt(db), 'white', 'one specialty is not breadth');
});

test('trophies: first catch, polyglot, skeptic', () => {
  db.run("INSERT INTO bug_reports(repo_id, title, report_path, confirmed, created_at) VALUES ('r','t','/tmp/r.md',1,'x')");
  db.run('DELETE FROM belts');
  db.run("INSERT INTO belts VALUES ('cpp','green',?), ('python','blue',?), ('dsa','green',?)", 'x', 'x', 'x');
  for (let i = 0; i < 5; i++) {
    const id = store.insertQuestion(db, { family: 'code', type: 'audit', format: 'audit', track: 'cpp', grading: 'verified', xp: 20, prompt: 'p', answer: { lines: [] } });
    db.run('INSERT INTO answers(question_id, response, correct, xp, mode, answered_at) VALUES (?,?,?,?,?,?)', id, 'none', 1, 0, 'audit', new Date().toISOString());
  }
  const got = rewards.checkTrophies(db).map((t) => t.id);
  for (const t of ['first-catch', 'polyglot', 'skeptic']) assert.ok(got.includes(t), `missing ${t}`);
  assert.deepStrictEqual(rewards.checkTrophies(db), [], 'trophies are granted once');
  assert.strictEqual(db.get("SELECT link FROM trophies WHERE id = 'first-catch'").link, '/tmp/r.md', 'real-bug trophy links its report');
});

test('stats match a hand-computed fixture', () => {
  // Fresh, fully known state.
  for (const t of ['answers', 'questions', 'xp_events', 'belts', 'trophies', 'bug_reports', 'exams']) db.run(`DELETE FROM ${t}`);
  const mk = (over) => store.insertQuestion(db, { family: 'code', type: 'seeded_bug', format: 'line', topic: 'cpp/mutation', track: 'cpp', grading: 'verified', xp: 20, prompt: 'p', answer: { lines: [1] }, status: 'answered', ...over });
  const ans = (id, correct, ms) => db.run('INSERT INTO answers(question_id, response, correct, xp, mode, time_ms, answered_at) VALUES (?,?,?,?,?,?,?)', id, 'x', correct, 0, 'normal', ms, new Date().toISOString());
  ans(mk({}), 1, 10000);
  ans(mk({}), 0, 20000);
  ans(mk({ family: 'design', type: 'data_structure', topic: 'dsa/containers' }), 1, 30000);
  ans(mk({ family: 'design', type: 'algorithm', grading: 'model', topic: 'dsa/algorithm' }), 1, 40000);
  ans(mk({ status: 'bad' }), 0, 5000); // excluded
  mk({ status: 'queued' });
  mk({ status: 'skipped' });
  db.run("INSERT INTO xp_events(ts, day, track, amount, base) VALUES ('x','2026-01-01','cpp',120,120), ('x','2026-01-01','dsa',30,30)");
  const s = stats.compute(db);
  assert.strictEqual(s.totalXp, 150);
  assert.strictEqual(s.accuracy.answered, 4);
  assert.strictEqual(s.accuracy.verified, 67, '2 of 3 verified answers correct');
  assert.deepStrictEqual(s.byFamily.map((g) => [g.key, g.answered, g.accuracy]), [['code', 2, 50], ['design', 2, 100]]);
  assert.deepStrictEqual(s.counts, { generated: 7, answered: 4, queued: 1, skipped: 1, snoozed: 0, bad: 1 });
  assert.strictEqual(s.badRate, 20);
  assert.strictEqual(s.medianAnswerSec, 30);
  assert.strictEqual(s.tracks[0].track, 'cpp');
  assert.ok(stats.format(s).includes('150 XP'));
});
