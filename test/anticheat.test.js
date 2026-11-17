'use strict';
// No unlimited score: the same question (by content) earns XP once, however
// many times it is re-created (battles, Bug Hunter, Prepare, generate), and
// practice XP (packs, battles, Bug Hunter, prepared topics) is capped per day.
// Questions about Claude's real changes are bounded by the real changes.
const test = require('node:test');
const assert = require('node:assert');
const { isolate } = require('./helpers');

isolate();
const store = require('../src/store');
const grader = require('../src/grader');
const rewards = require('../src/rewards');
const packs = require('../src/packs');

const db = store.open();
const totalXp = () => db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM xp_events').n;

function row(q) {
  const id = store.insertQuestion(db, q);
  return store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', id));
}

test('the same pack question re-created five times earns XP once', async () => {
  const pq = packs.load().questions.find((q) => q.format === 'multiple_choice');
  const before = totalXp();
  const got = [];
  for (let i = 0; i < 5; i++) {
    const q = row({ ...packs.toQuestion(pq), status: 'battle' });
    got.push((await grader.answer(db, q, q.answer, { mode: 'battle' })).xp);
  }
  assert.ok(got[0] > 0, 'the first right answer earns XP');
  assert.deepStrictEqual(got.slice(1), [0, 0, 0, 0], 'repeats earn nothing');
  assert.strictEqual(totalXp() - before, got[0]);
});

test('a re-created Bug Hunter bug or Claude question with the same content earns once', async () => {
  const base = { family: 'code', type: 'bug_fix', format: 'choice', grading: 'verified', xp: 10, difficulty: 'medium', track: 'python',
    prompt: 'Which line fixes clamp?', code: 'def clamp(x, lo, hi):\n    if x <= lo:', choices: { a: 'if x < lo:', b: 'if x <= lo:' }, answer: 'a',
    source: 'bughunt:mathutil.py:clamp', meta: { op: 'boundary', line: 5 } };
  const a = await grader.answer(db, row({ ...base, status: 'battle' }), 'a', { mode: 'battle' });
  const b = await grader.answer(db, row({ ...base, status: 'battle' }), 'a', { mode: 'battle' });
  assert.ok(a.xp > 0);
  assert.strictEqual(b.xp, 0);
  // A different bug in the same function is a different question.
  const c = await grader.answer(db, row({ ...base, meta: { op: 'arith', line: 6 }, status: 'battle' }), 'a', { mode: 'battle' });
  assert.ok(c.xp > 0);
});

test('practice XP is capped per day; questions about Claude\'s real changes are not', async () => {
  const cap = rewards.PRACTICE_XP_PER_DAY;
  assert.ok(cap > 0 && cap <= 1000);
  let practice = 0;
  for (let i = 0; i < 200 && practice < cap + 50; i++) {
    const q = row({ family: 'questionnaire', type: 'prepared', format: 'choice', grading: 'model', xp: 10, difficulty: 'medium', track: 'python',
      prompt: `Prepared question #${i}?`, choices: { a: 'yes', b: 'no' }, answer: 'a', status: 'battle' });
    const r = await grader.answer(db, q, 'a', { mode: 'battle' });
    practice += r.xp;
    if (!r.xp) assert.strictEqual(r.xpCapped, true, 'says why there was no XP');
  }
  const today = rewards.practiceXpToday(db);
  assert.ok(today <= cap, `practice XP today ${today} <= ${cap}`);
  // A question about Claude's change still pays after the cap.
  const real = row({ family: 'code', type: 'project', format: 'choice', grading: 'model', xp: 8, difficulty: 'medium', track: 'python',
    prompt: 'What does due(5) return when two jobs tie?', code: 'heapq.heappush(self.jobs, (when, job))', choices: { a: 'backup', b: 'email' }, answer: 'a' });
  assert.ok((await grader.answer(db, real, 'a', {})).xp > 0);
});

test('review mode re-awards half XP once, not on every review', async () => {
  const q = row({ family: 'code', type: 'concept', format: 'choice', grading: 'verified', xp: 10, difficulty: 'easy', track: 'python',
    prompt: 'What does heapq.heappush do?', choices: { a: 'keeps a heap', b: 'sorts' }, answer: 'a' });
  await grader.answer(db, q, 'b', {});
  const first = await grader.answer(db, q, 'a', { mode: 'review' });
  const again = await grader.answer(db, q, 'a', { mode: 'review' });
  assert.ok(first.xp > 0);
  assert.strictEqual(again.xp, 0);
});
