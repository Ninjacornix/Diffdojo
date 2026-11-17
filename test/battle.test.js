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

test('every trophy has its own ASCII art, rows of one width', async () => {
  const scene = await require('../src/battle-term').loadScene();
  const seen = new Set();
  for (const id of Object.keys(require('../src/rewards').TROPHIES)) {
    assert.ok(scene.TROPHY_ART[id], `art for ${id}`);
    const rows = scene.trophyArt(id);
    assert.strictEqual(new Set(rows.map((r) => [...r].length)).size, 1, `${id}: rows line up`);
    assert.ok(rows.every((r) => [...r].length <= 30), `${id}: fits the pane`);
    const key = rows.join('\n');
    assert.ok(!seen.has(key), `${id}: its own picture`);
    seen.add(key);
  }
});

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

test('health is a token budget, and a hit spills tokens out of the bar', async () => {
  const scene = await require('../src/battle-term').loadScene();
  const view = { mode: 'easy', modeLabel: 'Easy', stage: 0, stages: 3, wave: 1, lives: 3, maxLives: 3, player: { name: 'MILAN', hp: 100, maxHp: 100 }, enemy: { id: 'typo', name: 'TYPO SPRITE', level: 3, hp: 60, maxHp: 60, boss: false } };
  const text = (lines) => lines.map((l) => l.map((x) => x.t).join(''));
  const calm = text(scene.battlefield({ view, width: 72, tick: 0, intro: scene.INTRO_STEPS, anim: null, enemyHp: 60, playerHp: 100 }));
  assert.ok(calm.some((l) => l.includes('TOKENS▐')), 'bars are token bars');
  assert.ok(!calm.some((l) => /\bHP\b/.test(l)), 'no HP left on screen');
  assert.ok(calm.some((l) => l.includes('100/100 tokens')));

  // Words never overlap, and more tokens lost means more words (2 to 5).
  for (const lost of [5, 15, 35, 50, 90]) {
    const ws = scene.spillWords(`seed${lost}`, lost, 25);
    assert.ok(ws.length >= 2 && ws.length <= 5, `${lost}: ${ws.length} words`);
    for (let i = 1; i < ws.length; i++) assert.ok(ws[i].dx >= ws[i - 1].dx + [...ws[i - 1].word].length + 1, 'a gap between words');
    assert.ok(ws.every((w) => w.dx + [...w.word].length <= 25), 'inside the room given');
  }

  for (const kind of ['enemyHit', 'playerHit']) {
    const seen = new Set();
    for (let frame = 0; frame < scene.ANIM_FRAMES; frame++) {
      const lines = text(scene.battlefield({ view, width: 72, tick: 0, intro: scene.INTRO_STEPS, anim: { kind, frame }, enemyHp: kind === 'enemyHit' ? 25 : 60, playerHp: kind === 'playerHit' ? 85 : 100, lost: 35 }));
      for (const l of lines) assert.strictEqual([...l].length, 72, 'every row keeps the screen width');
      for (const w of scene.SPILL) if (lines.some((l) => l.includes(w))) seen.add(w);
      const status = lines.find((l) => l.includes('/100 tokens'));
      assert.ok(status && status.includes('85/100 tokens') === (kind === 'playerHit'), 'the token count stays readable');
    }
    assert.ok(seen.size >= 2, `${kind}: tokens fall out (${[...seen].join(' ')})`);
  }
});

test('No Mercy: no health bars, one wrong answer loses, Claude finishing the prompt defeats SKYNET', () => {
  battle.start('nomercy');
  let v = battle.view();
  assert.strictEqual(v.enemy.name, 'SKYNET');
  assert.strictEqual(v.noHealth, true);
  assert.ok(battle.noMercyActive());
  assert.match(battle.nextQuestion(db, {}).error, /only asks about the edits/);
  // Claude's turn ends before any edit: nothing happens, the fight waits for edits.
  assert.strictEqual(battle.turnEnd(db, { reason: 'answer' }).victory, false);
  assert.ok(battle.noMercyActive());
  // Two edits answered right, then an interrupted turn: no win.
  assert.strictEqual(battle.intercept(db, { correct: true, file: 'a.py' }).passed, 1);
  assert.strictEqual(battle.intercept(db, { correct: true, file: 'b.py' }).passed, 2);
  assert.strictEqual(battle.turnEnd(db, { reason: 'aborted' }).victory, false);
  // Claude finishes: SKYNET falls, with a trophy, and the gate is off.
  const end = battle.turnEnd(db, { reason: 'answer' });
  assert.strictEqual(end.victory, true);
  assert.strictEqual(end.passed, 2);
  assert.strictEqual(battle.load().phase, 'victory');
  assert.ok(!battle.noMercyActive());
  // Again: one wrong answer ends it at once.
  battle.resume();
  assert.ok(battle.noMercyActive());
  assert.strictEqual(battle.view().passed, 0);
  const lost = battle.intercept(db, { correct: false, answerText: 'heap', file: 'a.py' });
  assert.strictEqual(lost.defeat, true);
  assert.strictEqual(battle.load().phase, 'gameover');
  assert.ok(!battle.noMercyActive());
  assert.strictEqual(battle.intercept(db, { correct: true }), null, 'no fight, no intercepts');
  // Other modes never gate edits.
  battle.start('easy');
  assert.ok(!battle.noMercyActive());
  assert.strictEqual(battle.intercept(db, { correct: true }), null);
});

test('Bug Hunter: FREE CHINESE LLM breaks one of Claude\'s functions; the right fix strikes it', async () => {
  battle.start('bughunter');
  assert.strictEqual(battle.view().enemy.name, 'FREE CHINESE LLM');
  // Before Claude has written anything here, the demo project's functions are used.
  const r = battle.nextQuestion(db, { repoId: null, rnd: () => 0.3 });
  assert.ok(r.question, JSON.stringify(r));
  assert.strictEqual(r.question.type, 'bug_fix');
  assert.match(r.question.prompt, /FREE CHINESE LLM "optimised" Claude's `\w+`.* slipped a bug into line \d+\. Which line fixes it\?/);
  assert.strictEqual(Object.keys(r.question.choices).length, 4);
  const q = store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', r.question.id));
  assert.strictEqual(q.status, 'battle', 'bug-fix questions stay out of the plain quiz queue');
  const pending = battle.load().pending;
  const hit = await battle.answer(db, pending.correctKey, { cfg: {}, root: null });
  assert.strictEqual(hit.correct, true);
  assert.ok(hit.damage > 0);
  assert.match(hit.explanation, /was changed from/);
});

test('Rush: 60 seconds from the first question, +2s right, -5s wrong, late answers don\'t count', async () => {
  battle.start('rush');
  let v = battle.view();
  assert.strictEqual(v.enemy.name, 'THE CLOCK');
  assert.strictEqual(v.rush.endsAt, null, 'the clock waits for the first question');
  const q1 = battle.nextQuestion(db, { repoId: null, rnd: () => 0.4 });
  assert.ok(q1.question, JSON.stringify(q1));
  const started = battle.load().rush.endsAt;
  assert.ok(Math.abs(started - (Date.now() + battle.RUSH_MS)) < 2000);
  // Right: +2s and a point.
  let r = await battle.answer(db, battle.load().pending.correctKey, { cfg: {}, root: null });
  assert.strictEqual(r.rush, true);
  assert.strictEqual(r.correct, true);
  assert.strictEqual(r.score, 1);
  assert.strictEqual(battle.load().rush.endsAt, started + battle.RUSH_BONUS_MS);
  // Wrong: -5s, no point.
  battle.nextQuestion(db, { repoId: null, rnd: () => 0.6 });
  const p = battle.load().pending;
  const wrong = ['a', 'b', 'c', 'd'].find((k) => k !== p.correctKey);
  r = await battle.answer(db, wrong, { cfg: {}, root: null });
  assert.strictEqual(r.correct, false);
  assert.strictEqual(r.score, 1);
  assert.strictEqual(battle.load().rush.endsAt, started + battle.RUSH_BONUS_MS - battle.RUSH_PENALTY_MS);
  // An answer after the clock ran out doesn't count and ends the run.
  battle.nextQuestion(db, { repoId: null, rnd: () => 0.2 });
  const st = battle.load();
  st.rush.endsAt = Date.now() - 1;
  battle.save(st);
  r = await battle.answer(db, st.pending.correctKey, { cfg: {}, root: null });
  assert.strictEqual(r.late, true);
  assert.strictEqual(r.rushOver, true);
  assert.strictEqual(r.score, 1, 'the late right answer is not counted');
  assert.strictEqual(battle.load().phase, 'gameover');
  assert.strictEqual(battle.load().best.rush, 1);
  assert.ok(r.trophies.some((t) => t.id === 'rush-first'), 'first Rush trophy');
  // Rush again; a run that times out with nobody answering ends via rushCheck.
  battle.resume();
  battle.nextQuestion(db, { repoId: null });
  const s2 = battle.load();
  s2.rush.endsAt = Date.now() - 1;
  battle.save(s2);
  const c = battle.rushCheck(db);
  assert.strictEqual(c.over, true);
  assert.strictEqual(battle.load().best.rush, 1, 'best kept');
});

test('Rush trophies: 10, 25 and 50 right in one run', () => {
  const rewards = require('../src/rewards');
  battle.start('rush');
  battle.nextQuestion(db, { repoId: null });
  const s = battle.load();
  s.rush.score = 26;
  s.rush.endsAt = Date.now() - 1;
  battle.save(s);
  const c = battle.rushCheck(db);
  const ids = c.trophies.map((t) => t.id);
  assert.ok(ids.includes('rush-10') && ids.includes('rush-25') && !ids.includes('rush-50'), JSON.stringify(ids));
  assert.ok(rewards.hasTrophy(db, 'rush-25'));
  assert.strictEqual(battle.load().best.rush, 26);
});

test('the terminal game: RUN ends the battle and goes back to the menu', async () => {
  const term = require('../src/battle-term');
  const scene = await term.loadScene();
  battle.start('easy');
  const G = term.game(scene, { db, repoId: null, root: null, cfg, width: 72, rnd: never });
  const text = () => G.draw().map((l) => l.map((s) => s.t).join('')).join('\n');
  await G.press('enter');
  await G.press('enter');
  assert.match(text(), /RUN: end this battle/);
  for (let i = 0; i < 6; i++) await G.press('down'); // past the answers, onto RUN
  await G.press('enter');
  assert.strictEqual(G.g.phase, 'menu');
  assert.strictEqual(battle.load().mode, null, 'the battle is over');
  assert.match(text(), /Choose|Easy/);
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
