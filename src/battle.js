'use strict';
// DiffDojo Battle: a turn-based quiz fight in the style of classic handheld
// RPG battles (original characters). An enemy asks a question with four
// answers; a correct answer damages it, a wrong one lets it hit you. Your HP
// refills for each new enemy; lose 3 lives and the ladder starts over.
// Modes: easy, medium, hard, professional (final boss: Evil Claude), endless.
// State is global and kept in ~/.diffdojo/battle.json.

const path = require('path');
const { home, readJson, writeJson, shuffle, nowIso } = require('./util');
const store = require('./store');


// Sprites (pixel art) live in hooks/scene.ts, keyed by each enemy's id.

// Balanced to be beatable: wrong answers hurt, but you get several mistakes per
// life, and a wrong answer sometimes misses (MISS_CHANCE).
const LADDERS = {
  easy: [
    { id: 'typo', name: 'TYPO SPRITE', level: 3, hp: 60, dmg: 15 },
    { id: 'gremlin', name: 'LINT GREMLIN', level: 5, hp: 70, dmg: 18 },
    { id: 'imp', name: 'OFF-BY-ONE IMP', level: 8, hp: 80, dmg: 20 },
  ],
  medium: [
    { id: 'null', name: 'NULL POINTER', level: 12, hp: 80, dmg: 20 },
    { id: 'leak', name: 'MEMORY LEAK', level: 15, hp: 90, dmg: 22 },
    { id: 'flaky', name: 'FLAKY TEST', level: 18, hp: 100, dmg: 25 },
  ],
  hard: [
    { id: 'race', name: 'RACE CONDITION', level: 25, hp: 100, dmg: 25 },
    { id: 'deadlock', name: 'DEADLOCK TWINS', level: 30, hp: 110, dmg: 28 },
    { id: 'heisen', name: 'HEISENBUG', level: 35, hp: 120, dmg: 30 },
  ],
  professional: [
    { id: 'segfault', name: 'SEGFAULT SPECTER', level: 45, hp: 120, dmg: 30 },
    { id: 'monolith', name: 'LEGACY MONOLITH', level: 55, hp: 140, dmg: 32 },
    { id: 'evil', name: 'EVIL CLAUDE', level: 99, hp: 180, dmg: 34, boss: true, color: '#d97757' },
  ],
};

const MISS_CHANCE = 0.2;

const MODES = {
  easy: { label: 'Easy', difficulties: ['easy'] },
  medium: { label: 'Medium', difficulties: ['medium', 'easy'] },
  hard: { label: 'Hard', difficulties: ['hard', 'medium'] },
  professional: { label: 'Professional', difficulties: ['hard'], preferCode: true },
  endless: { label: 'Endless', difficulties: null },
};

const PLAYER_MAX = 100;
const LIVES = 3;
const DAMAGE = { easy: 35, medium: 40, hard: 50 };

let cachedName = null;

/**
 * The player's name, shown in caps like the classic games: the configured
 * playerName, else the git user name (first word), else the OS username.
 */
function playerName() {
  if (cachedName) return cachedName;
  let name = null;
  try {
    name = require('./config').load(null).playerName || null;
  } catch {
    /* no config */
  }
  if (!name) {
    try {
      const r = require('child_process').spawnSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      name = (r.stdout || '').trim() || null;
    } catch {
      /* no git */
    }
  }
  if (!name) {
    try {
      name = require('os').userInfo().username;
    } catch {
      name = 'YOU';
    }
  }
  const first = String(name).trim().split(/\s+/)[0] || 'YOU';
  cachedName = first.replace(/[^\p{L}\p{N}_.-]/gu, '').toUpperCase().slice(0, 12) || 'YOU';
  return cachedName;
}

function file() {
  return path.join(home(), 'battle.json');
}

function load() {
  return readJson(file(), { mode: null, stage: 0, wave: 1, lives: LIVES, playerHp: PLAYER_MAX, enemyHp: null, best: {}, wins: {}, pending: null, phase: 'menu' });
}

function save(s) {
  writeJson(file(), s);
  return s;
}

/** The enemy for the current stage (endless scales a cycling roster by wave). */
function enemyOf(s) {
  if (!s.mode) return null;
  if (s.mode === 'endless') {
    const roster = [].concat(LADDERS.easy, LADDERS.medium, LADDERS.hard, LADDERS.professional.filter((e) => !e.boss));
    const base = roster[(s.wave - 1) % roster.length];
    const w = s.wave;
    return { ...base, level: base.level + Math.floor(w / 2), hp: 60 + 10 * w, dmg: Math.min(40, 15 + 2 * w), boss: false };
  }
  return LADDERS[s.mode][Math.min(s.stage, LADDERS[s.mode].length - 1)];
}

function difficultiesFor(s) {
  if (s.mode !== 'endless') return MODES[s.mode].difficulties;
  if (s.wave <= 3) return ['easy'];
  if (s.wave <= 6) return ['medium', 'easy'];
  if (s.wave <= 10) return ['medium', 'hard'];
  return ['hard'];
}

/** Public view of the state for the UI. */
function view(s = load()) {
  const enemy = enemyOf(s);
  return {
    mode: s.mode,
    modeLabel: s.mode ? MODES[s.mode].label : null,
    phase: s.phase,
    stage: s.stage,
    stages: s.mode && s.mode !== 'endless' ? LADDERS[s.mode].length : null,
    wave: s.wave,
    lives: s.lives,
    maxLives: LIVES,
    player: { name: playerName(), hp: s.playerHp, maxHp: PLAYER_MAX },
    enemy: enemy ? { name: enemy.name, level: enemy.level, hp: s.enemyHp == null ? enemy.hp : s.enemyHp, maxHp: enemy.hp, id: enemy.id, boss: !!enemy.boss, color: enemy.color || null } : null,
    best: s.best,
    wins: s.wins,
    hasQuestion: !!s.pending,
  };
}

function start(mode) {
  if (!MODES[mode]) throw new Error(`unknown mode ${mode} (easy, medium, hard, professional, endless)`);
  const s = load();
  Object.assign(s, { mode, stage: 0, wave: 1, lives: LIVES, playerHp: PLAYER_MAX, enemyHp: null, pending: null, phase: 'fight' });
  s.enemyHp = enemyOf(s).hp;
  return save(s);
}

function quit() {
  const s = load();
  Object.assign(s, { mode: null, pending: null, phase: 'menu' });
  return save(s);
}

// ---- questions with exactly four answers

const KEYS = ['a', 'b', 'c', 'd'];

// The battle asks technical questions only: what Claude's code uses and what it
// is (code concepts, data structures, algorithms, complexity) and concept quizzes;
// never "which line changed" or "why did Claude...".
const BATTLE_TYPES = ['concept', 'data_structure', 'algorithm', 'complexity', 'pack'];

/** Turn a stored question into a 4-answer battle question, or null. */
function toFour(q, rnd = Math.random) {
  if ((q.format === 'choice' || q.format === 'multiple_choice') && q.choices && Object.keys(q.choices).length >= 4) {
    const others = shuffle(Object.keys(q.choices).filter((k) => k !== q.answer), rnd).slice(0, 3);
    const picked = shuffle([q.answer, ...others], rnd);
    return {
      prompt: q.prompt,
      code: q.code || null,
      choices: Object.fromEntries(picked.map((k, i) => [KEYS[i], q.choices[k]])),
      map: Object.fromEntries(picked.map((k, i) => [KEYS[i], k])),
      correctKey: KEYS[picked.indexOf(q.answer)],
    };
  }
  if (q.format === 'line' && q.code && q.answer && q.answer.lines && !q.meta.removed) {
    const lines = q.code.split('\n');
    const right = q.answer.lines[0];
    const pool = lines.map((t, i) => ({ n: i + 1, t })).filter((x) => x.t.trim().length > 2 && !q.answer.lines.includes(x.n) && x.n > 1);
    if (pool.length < 3) return null;
    const picked = shuffle([{ n: right, t: lines[right - 1] }, ...shuffle(pool, rnd).slice(0, 3)], rnd);
    const label = (x) => `line ${x.n}: ${x.t.trim().slice(0, 48)}`;
    return {
      prompt: q.prompt.replace(/ Enter its number.*$/, ' Pick the changed line.'),
      code: q.code,
      choices: Object.fromEntries(picked.map((x, i) => [KEYS[i], label(x)])),
      map: Object.fromEntries(picked.map((x, i) => [KEYS[i], String(x.n)])),
      correctKey: KEYS[picked.findIndex((x) => x.n === right)],
    };
  }
  return null;
}

/** Pick the next question: Claude's fresh code first (always for Professional), else a curated pack. */
function nextQuestion(db, { repoId, rnd = Math.random } = {}) {
  const s = load();
  if (!s.mode || s.phase !== 'fight') return { error: 'no battle in progress' };
  if (s.pending) {
    const q = store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', s.pending.id));
    if (q && q.status !== 'answered') return { question: publicQ(q, s.pending), state: view(s) };
  }
  const diffs = difficultiesFor(s);
  const preferCode = MODES[s.mode].preferCode;
  let picked = null;
  if (repoId) {
    const rows = db.all(
      `SELECT * FROM questions WHERE status = 'queued' AND repo_id = ? AND format IN ('choice','multiple_choice')
         AND type IN (${BATTLE_TYPES.map(() => '?').join(',')}) ORDER BY batch DESC, id ASC LIMIT 40`, repoId, ...BATTLE_TYPES,
    ).map(store.hydrate);
    const fit = rows.filter((q) => preferCode || diffs.includes(q.difficulty));
    for (const q of fit) {
      if (!preferCode && rnd() < 0.5) continue; // mix project questions with concept questions
      const four = toFour(q, rnd);
      if (four) {
        picked = { q, four };
        break;
      }
    }
  }
  if (!picked) {
    const packs = require('./packs');
    const answered = new Set(db.all("SELECT DISTINCT source FROM questions WHERE source LIKE 'pack:%' AND status = 'answered'").map((r) => r.source.slice(5)));
    let pool = packs.load().questions.filter((q) => q.format === 'multiple_choice' && Object.keys(q.choices).length >= 4 && diffs.includes(q.difficulty));
    const fresh = pool.filter((q) => !answered.has(q.id));
    if (fresh.length) pool = fresh;
    if (!pool.length) return { error: 'no questions available for this mode' };
    const pq = shuffle(pool, rnd)[0];
    const id = store.insertQuestion(db, { ...packs.toQuestion(pq, { meta: { pack: pq.pack, selectedBy: 'battle' } }), repo_id: repoId || null, batch: `${nowIso()}#battle` });
    const q = store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', id));
    picked = { q, four: toFour(q, rnd) };
  }
  s.pending = { id: picked.q.id, ...picked.four };
  save(s);
  return { question: publicQ(picked.q, s.pending), state: view(s) };
}

function publicQ(q, p) {
  return { id: q.id, prompt: p.prompt, code: p.code, choices: p.choices, type: q.type, family: q.family, difficulty: q.difficulty, location: q.code_file || null };
}

/**
 * Answer the pending question with a key (a-d). Grades through the normal
 * grader (XP, stats, trophies), then resolves the exchange of blows.
 */
async function answer(db, key, { cfg, root, rnd = Math.random } = {}) {
  const s = load();
  if (!s.pending) return { error: 'no question pending' };
  const p = s.pending;
  const q = store.hydrate(db.get('SELECT * FROM questions WHERE id = ?', p.id));
  if (!q) return { error: 'question vanished' };
  const k = String(key).trim().toLowerCase();
  if (!p.map[k]) return { error: 'answer with a, b, c or d' };
  const graded = await require('./grader').answer(db, q, p.map[k], { mode: 'battle', cfg, root });
  const correct = graded.correct === true;
  const enemy = enemyOf(s);
  const ev = { correct, correctKey: p.correctKey, picked: k, xp: graded.xp, explanation: q.explanation, enemyName: enemy.name, playerName: playerName(), trophies: graded.trophies || [] };
  ev.enemyHpBefore = s.enemyHp;
  ev.playerHpBefore = s.playerHp;
  if (correct) {
    ev.damage = DAMAGE[q.difficulty] || 40;
    s.enemyHp = Math.max(0, s.enemyHp - ev.damage);
    ev.enemyHpAfter = s.enemyHp; // what the hit left, before any next enemy appears
    if (s.enemyHp === 0) {
      ev.enemyDefeated = true;
      if (s.mode === 'endless') {
        s.wave += 1;
        s.best.endless = Math.max(s.best.endless || 0, s.wave - 1);
      } else if (s.stage >= LADDERS[s.mode].length - 1) {
        ev.victory = true;
        s.wins[s.mode] = (s.wins[s.mode] || 0) + 1;
        s.phase = 'victory';
        const rewards = require('./rewards');
        const t = rewards.grant(db, s.mode === 'professional' ? 'evil-claude' : `battle-${s.mode}`, `cleared ${MODES[s.mode].label}`);
        if (t) ev.trophies.push(t);
      } else {
        s.stage += 1;
        s.best[s.mode] = Math.max(s.best[s.mode] || 0, s.stage);
      }
      if (!ev.victory) {
        s.playerHp = PLAYER_MAX; // full heal for the next enemy
        s.enemyHp = enemyOf(s).hp;
        ev.nextEnemy = enemyOf(s).name;
      }
    }
  } else if (rnd() < MISS_CHANCE) {
    ev.enemyMissed = true; // lucky dodge
  } else {
    ev.enemyDamage = enemy.dmg;
    s.playerHp = Math.max(0, s.playerHp - enemy.dmg);
    ev.playerHpAfter = s.playerHp;
    if (s.playerHp === 0) {
      s.lives -= 1;
      ev.lifeLost = true;
      if (s.lives <= 0) {
        ev.gameOver = true;
        s.phase = 'gameover';
        s.stage = 0;
        s.wave = 1;
        s.lives = LIVES;
        s.playerHp = PLAYER_MAX;
        s.enemyHp = enemyOf(s).hp;
      } else {
        s.playerHp = PLAYER_MAX;
      }
    }
  }
  if (ev.enemyHpAfter === undefined) ev.enemyHpAfter = ev.enemyHpBefore;
  if (ev.playerHpAfter === undefined) ev.playerHpAfter = ev.playerHpBefore;
  s.pending = null;
  save(s);
  return { ...ev, state: view(s) };
}

/** After a game over or a victory screen: fight on (same mode, from the start). */
function resume() {
  const s = load();
  if (!s.mode) return save(s);
  if (s.phase === 'victory') return start(s.mode);
  s.phase = 'fight';
  return save(s);
}

module.exports = { playerName, load, save, view, start, quit, resume, nextQuestion, answer, toFour, enemyOf, LADDERS, MODES, PLAYER_MAX, LIVES, DAMAGE, MISS_CHANCE };
