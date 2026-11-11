'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isolate } = require('./helpers');

isolate();
const store = require('../src/store');
const battle = require('../src/battle');
const config = require('../src/config');
const util = require('../src/util');

const db = store.open();
const cfg = config.load(null);
const never = () => 0.99; // never a lucky miss
const always = () => 0; // always a lucky miss

async function hit(rnd = never) {
  const q = battle.nextQuestion(db, { rnd: util.rng(1) });
  assert.ok(q.question, q.error);
  assert.deepStrictEqual(Object.keys(q.question.choices), ['a', 'b', 'c', 'd'], 'always four answers');
  return battle.answer(db, battle.load().pending.correctKey, { cfg, rnd });
}

async function miss(rnd = never) {
  battle.nextQuestion(db, { rnd: util.rng(2) });
  const right = battle.load().pending.correctKey;
  return battle.answer(db, ['a', 'b', 'c', 'd'].find((k) => k !== right), { cfg, rnd });
}

test('a correct answer damages the enemy; beating it heals you and brings the next one', async () => {
  battle.start('easy');
  await miss();
  assert.strictEqual(battle.load().playerHp, 85);
  let r;
  do r = await hit();
  while (!r.enemyDefeated);
  assert.strictEqual(r.nextEnemy, 'LINT GREMLIN');
  const s = battle.load();
  assert.strictEqual(s.stage, 1);
  assert.strictEqual(s.playerHp, battle.PLAYER_MAX, 'HP refills for the next enemy');
  assert.strictEqual(s.enemyHp, battle.LADDERS.easy[1].hp);
});

test('wrong answers can be dodged, and the game is forgiving', async () => {
  battle.start('professional');
  const r = await miss(always);
  assert.ok(r.enemyMissed);
  assert.strictEqual(battle.load().playerHp, 100);
  // Even the final boss allows at least 3 mistakes per life.
  const boss = battle.LADDERS.professional.find((e) => e.boss);
  assert.strictEqual(boss.name, 'EVIL CLAUDE');
  assert.ok(Math.ceil(100 / boss.dmg) >= 3);
});

test('losing all 3 lives sends you back to the first enemy', async () => {
  battle.start('medium');
  let r;
  do r = await hit();
  while (!r.enemyDefeated);
  assert.strictEqual(battle.load().stage, 1);
  let lifeLosses = 0;
  do {
    r = await miss();
    if (r.lifeLost) lifeLosses++;
  } while (!r.gameOver);
  assert.strictEqual(lifeLosses, 3);
  const s = battle.load();
  assert.deepStrictEqual([s.phase, s.stage, s.lives, s.playerHp], ['gameover', 0, 3, 100]);
  battle.resume();
  assert.strictEqual(battle.load().phase, 'fight');
});

test('clearing Professional defeats Evil Claude and earns the trophy', async () => {
  battle.start('professional');
  let r;
  do r = await hit();
  while (!r.victory);
  assert.strictEqual(r.enemyName, 'EVIL CLAUDE');
  assert.ok(db.get("SELECT 1 AS x FROM trophies WHERE id = 'evil-claude'"));
  assert.strictEqual(battle.load().phase, 'victory');
  assert.strictEqual(battle.load().wins.professional, 1);
});

test('endless mode scales waves and records the best wave', async () => {
  battle.start('endless');
  const first = battle.enemyOf(battle.load());
  for (let i = 0; i < 2; i++) {
    let r;
    do r = await hit();
    while (!r.enemyDefeated);
  }
  const s = battle.load();
  assert.strictEqual(s.wave, 3);
  assert.strictEqual(s.best.endless, 2);
  assert.ok(battle.enemyOf(s).hp > first.hp, 'enemies grow stronger');
});

test('XP is booked through the normal grader', async () => {
  const before = db.get('SELECT COALESCE(SUM(amount),0) AS n FROM xp_events').n;
  battle.start('easy');
  await hit();
  assert.ok(db.get('SELECT COALESCE(SUM(amount),0) AS n FROM xp_events').n > before);
});

test('seeded-bug questions become four line choices', () => {
  const q = {
    format: 'line', code: 'def f(xs):\n    total = 0\n    for x in xs:\n        total -= x\n    return total',
    answer: { lines: [4] }, prompt: 'One line was changed. Which line? Enter its number (optionally...)', meta: {},
  };
  const four = battle.toFour(q, util.rng(3));
  assert.strictEqual(Object.keys(four.choices).length, 4);
  assert.strictEqual(four.map[four.correctKey], '4');
  assert.match(four.choices[four.correctKey], /line 4: total -= x/);
});

test('every enemy has ASCII art in the scene renderer', async () => {
  const scene = await import(require('url').pathToFileURL(require('path').join(__dirname, '..', 'hooks', 'scene.mts')).href)
  for (const ladder of Object.values(battle.LADDERS)) {
    for (const e of ladder) {
      for (const f of [0, 1]) {
        const rows = scene.art(e.id, f)
        assert.ok(rows.length >= 7 && rows.length <= 12, `${e.id}: ${rows.length} rows`)
        assert.ok(rows.some((r) => /[|/_]/.test(r)), e.id)
        assert.ok(rows.every((r) => !r.includes('@')), `${e.id}: eye markers are drawn`)
      }
    }
  }
  assert.notDeepStrictEqual(scene.art('evil', 0), scene.art('evil', 1), 'Evil Claude turns while idle')
})

test('the terminal game plays a full exchange: intro, question, hit, next enemy', async () => {
  const term = require('../src/battle-term');
  const scene = await term.loadScene();
  battle.start('easy');
  const G = term.game(scene, { db, repoId: null, root: null, cfg, width: 72, rnd: never });
  assert.strictEqual(G.g.phase, 'intro');
  const text = () => G.draw().map((l) => l.map((s) => s.t).join('')).join('\n');
  assert.match(text(), /TYPO SPRITE wants to fight!/);
  await G.press('enter'); // skip slide-in
  await G.press('enter'); // continue
  assert.strictEqual(G.g.phase, 'question');
  assert.match(text(), /TYPO SPRITE asks:/);
  assert.match(text(), /▶ a\)/);
  G.g.cursor = Object.keys(G.g.question.choices).indexOf(battle.load().pending.correctKey);
  await G.press('enter');
  assert.strictEqual(G.g.phase, 'result');
  for (let i = 0; i < 20; i++) G.step();
  assert.match(text(), /Correct! [A-Z0-9_.-]+ hits TYPO SPRITE/);
  for (const line of G.draw()) assert.strictEqual(line.reduce((n, s) => n + [...s.t].length, 0), 72, 'every row fills the screen width');
});

test('the demo makes a sandbox project with questions about a simulated Claude change', async () => {
  const os = require('os');
  const path = require('path');
  const dir = path.join(require('fs').mkdtempSync(path.join(os.tmpdir(), 'dd-demo-')), 'demo');
  const r = await require('../src/demo').create({ dir });
  assert.ok(r.questions >= 5, `questions: ${r.questions}`);
  const kinds = new Set(db.all('SELECT type FROM questions WHERE repo_id = ?', r.repoId).map((x) => x.type));
  assert.ok(kinds.has('concept'), 'technical questions about what Claude used');
  const concepts = db.all("SELECT prompt FROM questions WHERE repo_id = ? AND type = 'concept'", r.repoId);
  assert.ok(concepts.length >= 3, `concept questions: ${concepts.length}`);
  for (const c of concepts) assert.match(c.prompt, /^Claude used `[^`]+` in \w+\.(py|cpp):\d+\. /);
  await assert.rejects(require('../src/demo').create({ dir }), /not empty/);
});

test('the player is named after the user, in caps', async () => {
  const name = battle.playerName();
  assert.match(name, /^[\p{Lu}\p{N}_.-]{1,12}$/u);
  assert.strictEqual(battle.view().player.name, name);
  battle.start('easy');
  const r = await hit();
  assert.strictEqual(r.playerName, name);
});

test('code concepts: technical questions about the APIs Claude used, never on import lines', () => {
  const { conceptQs } = require('../src/generators/concepts');
  const src = 'import heapq\nfrom collections import deque\n\nq = deque(maxlen=3)\n# heappush in a comment\nheapq.heappush(jobs, (1, "x"))\n';
  const qs = conceptQs([{ file: 'jobs.py', lang: 'python', src, added: [1, 2, 3, 4, 5, 6] }], { max: 5, rnd: util.rng(1) });
  const about = qs.map((q) => q.meta.about).sort();
  assert.deepStrictEqual(about, ['deque', 'heappush']);
  for (const q of qs) {
    assert.strictEqual(q.type, 'concept');
    assert.strictEqual(q.format, 'multiple_choice');
    assert.strictEqual(Object.keys(q.choices).length, 4);
    assert.match(q.prompt, /^Claude used `(deque|heappush)` in jobs\.py:(4|6)\. /);
  }
  // Language scoping: a C++ token in a Python file is not matched.
  assert.strictEqual(conceptQs([{ file: 'a.py', lang: 'python', src: 'x = lock_guard\n', added: [1] }]).length, 0);
});

test('the battle only serves technical questions from the project queue', () => {
  const qid = (over) => store.insertQuestion(db, { repo_id: 'tech', family: 'code', format: 'choice', grading: 'verified', xp: 10, prompt: 'p', choices: { a: '1', b: '2', c: '3', d: '4' }, answer: 'a', difficulty: 'hard', ...over });
  const why = qid({ type: 'why' });
  const line = qid({ type: 'seeded_bug', format: 'line', code: 'a\nbb\nccc\ndddd\neeeee', answer: { lines: [2] } });
  const concept = qid({ type: 'concept' });
  battle.start('professional');
  const q = battle.nextQuestion(db, { repoId: 'tech', rnd: never });
  assert.strictEqual(q.question.id, concept);
  assert.notStrictEqual(q.question.id, why);
  assert.notStrictEqual(q.question.id, line);
});
