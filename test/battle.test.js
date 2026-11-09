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

test('every character has two idle frames of equal height', () => {
  for (const [id, frames] of Object.entries(battle.SPRITES)) {
    assert.strictEqual(frames.length, 2, id);
    assert.strictEqual(frames[0].length, frames[1].length, id);
  }
});
