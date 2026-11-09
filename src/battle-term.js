'use strict';
// `diffdojo battle`: DiffDojo Battle in any terminal, no Claude Code needed.
// Same scene renderer (hooks/scene.ts), same questions and rules as the
// in-app battle. Arrow keys + Enter, Esc or q to quit.
// `diffdojo battle --snapshot` prints a few frames as plain text instead.

const path = require('path');
const { pathToFileURL } = require('url');
const battle = require('./battle');
const store = require('./store');
const config = require('./config');
const util = require('./util');

const FRAME_MS = 90;
const IDLE_EVERY = 7; // frames per idle tick (~650 ms)

async function loadScene() {
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/Type Stripping|strip-types/i.test(String((w && w.message) || w)) ? undefined : origEmit.call(process, w, ...rest));
  return import(pathToFileURL(path.join(__dirname, '..', 'hooks', 'scene.mts')).href);
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ansi(lines, color = true) {
  if (!color) return lines.map((l) => l.map((s) => s.t).join('')).join('\n');
  return lines
    .map((l) => l.map((s) => {
      const [r, g, b] = rgb(s.c);
      const [R, G, B] = rgb(s.bg);
      return `\x1b[38;2;${r};${g};${b}m\x1b[48;2;${R};${G};${B}m${s.b ? '\x1b[1m' : ''}${s.t}\x1b[0m`;
    }).join(''))
    .join('\n');
}

const MODES = [
  ['easy', 'Easy', 'Typo Sprite, Lint Gremlin, Off-by-One Imp'],
  ['medium', 'Medium', 'Null Pointer, Memory Leak, Flaky Test'],
  ['hard', 'Hard', 'Race Condition, Deadlock Twins, Heisenbug'],
  ['professional', 'Professional', 'Segfault Specter, Legacy Monolith, EVIL CLAUDE'],
  ['endless', 'Endless', 'waves that keep coming'],
];

/** The whole game as a small state machine; draw() returns the screen lines. */
function game(scene, { db, repoId, root, cfg, width, rnd = Math.random }) {
  const g = {
    phase: 'menu', // menu | intro | question | result | over
    cursor: 0,
    frame: 0,
    intro: 0,
    view: battle.view(),
    question: null,
    result: null,
    shown: null, // the view drawn during a result (before the next enemy appears)
    anim: null,
    message: null,
  };
  if (g.view.mode && g.view.phase === 'fight') g.phase = 'intro';
  const tick = () => Math.floor(g.frame / IDLE_EVERY);

  function nextQuestion() {
    const r = battle.nextQuestion(db, { repoId, rnd });
    if (r.error) {
      g.message = r.error;
      return;
    }
    g.question = r.question;
    g.view = r.state;
    g.cursor = 0;
    g.phase = 'question';
  }

  async function press(key) {
    if (key === 'up') g.cursor = Math.max(0, g.cursor - 1);
    if (key === 'down') g.cursor += 1;
    if (key !== 'enter') return;
    if (g.phase === 'menu') {
      const mode = MODES[Math.min(g.cursor, MODES.length - 1)][0];
      g.view = battle.view(battle.start(mode));
      g.phase = 'intro';
      g.intro = 0;
    } else if (g.phase === 'intro') {
      if (g.intro < scene.INTRO_STEPS) g.intro = scene.INTRO_STEPS;
      else nextQuestion();
    } else if (g.phase === 'question') {
      const keys = Object.keys(g.question.choices);
      const r = await battle.answer(db, keys[Math.min(g.cursor, keys.length - 1)], { cfg, root, rnd });
      if (r.error) {
        g.message = r.error;
        return;
      }
      g.result = r;
      g.shown = g.view;
      g.view = r.state;
      g.anim = { kind: r.correct ? 'enemyHit' : r.enemyMissed ? 'dodge' : 'playerHit', frame: 0 };
      g.phase = 'result';
    } else if (g.phase === 'result') {
      const r = g.result;
      g.result = null;
      g.anim = null;
      g.shown = null;
      if (r.victory || r.gameOver) {
        g.phase = 'over';
        g.cursor = 0;
      } else if (r.enemyDefeated) {
        g.phase = 'intro';
        g.intro = 0;
      } else nextQuestion();
    } else if (g.phase === 'over') {
      if (g.cursor % 2 === 0) {
        g.view = battle.view(battle.resume());
        g.phase = 'intro';
        g.intro = 0;
      } else {
        g.view = battle.view(battle.quit());
        g.phase = 'menu';
        g.cursor = 0;
      }
    }
  }

  function step() {
    g.frame++;
    if (g.phase === 'intro' && g.intro < scene.INTRO_STEPS) g.intro++;
    if (g.anim && g.anim.frame < scene.ANIM_FRAMES) g.anim.frame++;
  }

  function draw() {
    const W = width;
    const t = tick();
    if (g.phase === 'menu') {
      const v = battle.view();
      const lines = [scene.plain('', W)];
      for (const [i, l] of scene.TITLE.entries()) lines.push(scene.plain('   ' + l, W, i % 2 === t % 2 ? scene.PALETTE.ink : scene.PALETTE.mid, true));
      lines.push(scene.plain('', W), scene.plain('   Answer right to strike. Answer wrong and they strike back. 3 lives.', W), scene.plain('', W));
      const rows = MODES.map(([value, label, who], i) => ({
        text: `${label.padEnd(13)} ${who}${value === 'endless' && v.best.endless ? `  (best wave ${v.best.endless})` : ''}${v.wins[value] ? `  cleared x${v.wins[value]}` : ''}`,
        selected: i === Math.min(g.cursor, MODES.length - 1),
      }));
      rows.push({ text: 'up/down choose · enter fight · q quit', dim: true });
      return lines.concat(scene.box(rows, W, t, false));
    }
    if (g.phase === 'over') {
      const v = battle.load();
      const victory = v.phase === 'victory';
      const lines = [scene.plain('', W), scene.plain(victory ? '        V I C T O R Y' : '        G A M E   O V E R', W, victory ? scene.PALETTE.ink : scene.PALETTE.hurt, true), scene.plain('', W)];
      const id = victory && g.view.mode === 'professional' ? 'evil' : 'player';
      for (const l of scene.spriteLines(id, t)) lines.push(scene.pad(scene.join([], l, 8), W));
      lines.push(scene.plain('', W));
      const msg = victory ? `You cleared ${g.view.modeLabel}!${g.view.mode === 'professional' ? ' Evil Claude is defeated.' : ''}` : 'Out of lives. Back to the first enemy with full health and 3 lives.';
      return lines.concat(scene.box([{ text: msg }, { text: victory ? 'Fight this ladder again' : 'Try again', selected: g.cursor % 2 === 0 }, { text: 'Choose another mode', selected: g.cursor % 2 === 1 }], W, t, false));
    }
    const v = g.shown || g.view;
    const r = g.result;
    const p = g.anim ? g.anim.frame / scene.ANIM_FRAMES : 1;
    const lerp = (a, b) => Math.round(a + (b - a) * Math.min(1, p));
    const enemyHp = r ? (g.anim && g.anim.kind === 'enemyHit' ? lerp(r.enemyHpBefore, r.enemyHpAfter) : r.enemyHpAfter) : v.enemy.hp;
    const playerHp = r ? (g.anim && g.anim.kind === 'playerHit' ? lerp(r.playerHpBefore, r.playerHpAfter) : r.playerHpAfter) : v.player.hp;
    const field = scene.battlefield({ view: v, width: W, tick: t, intro: g.phase === 'intro' ? g.intro : scene.INTRO_STEPS, anim: g.anim, enemyHp, playerHp });
    let rows;
    if (g.phase === 'intro') {
      const name = v.enemy.name;
      rows = scene.wrap([v.enemy.boss ? `${name} appears! The final battle begins!` : `${name} wants to fight!`], W - 6).map((text) => ({ text }));
      return field.concat(scene.box(rows, W, t, g.intro >= scene.INTRO_STEPS));
    }
    if (g.phase === 'question') {
      const q = g.question;
      rows = scene.wrap([`${v.enemy.name} asks: ${q.prompt}`], W - 6).map((text) => ({ text }));
      if (q.code && q.code.split('\n').length <= 10) for (const c of q.code.split('\n')) rows.push({ text: '  ' + c, dim: true });
      const keys = Object.keys(q.choices);
      g.cursor = Math.min(g.cursor, keys.length - 1);
      keys.forEach((k, i) => scene.wrap([`${k}) ${q.choices[k]}`], W - 8).forEach((text, j) => rows.push({ text: j ? '   ' + text : text, selected: i === g.cursor && j === 0 })));
      if (g.message) rows.push({ text: g.message, dim: true });
      return field.concat(scene.box(rows, W, t, false));
    }
    // result
    const lines = [];
    if (r.correct) lines.push(`Correct! You hit ${r.enemyName} for ${r.damage}!${r.xp ? ` +${r.xp} XP` : ''}`);
    else if (r.enemyMissed) lines.push(`Wrong, it was ${r.correctKey}... but ${r.enemyName} missed!`);
    else lines.push(`Wrong, it was ${r.correctKey}! ${r.enemyName} hits you for ${r.enemyDamage}!`);
    if (r.enemyDefeated && !r.victory) lines.push(`${r.enemyName} fainted! Your HP is restored.`);
    if (r.victory) lines.push(`${r.enemyName} is defeated! You cleared the ladder!`);
    if (r.lifeLost && !r.gameOver) lines.push('You fainted! One life lost, HP restored.');
    if (r.gameOver) lines.push('No lives left...');
    for (const t2 of r.trophies || []) lines.push(`Trophy: ${t2.name}`);
    rows = scene.wrap(lines, W - 6).map((text) => ({ text }));
    if (r.explanation) for (const e of scene.wrap([r.explanation], W - 6).slice(0, 3)) rows.push({ text: e, dim: true });
    return field.concat(scene.box(rows, W, t, !g.anim || g.anim.frame >= scene.ANIM_FRAMES));
  }

  return { g, press, step, draw };
}

function context() {
  const root = util.findRepoRoot(process.cwd());
  const repoId = root ? util.repoId(root) : null;
  return { root, repoId: root && util.isEnabled(repoId) ? repoId : null, cfg: config.load(repoId) };
}

/** Non-interactive: print intro, question and hit frames as plain text. */
async function snapshot({ mode = 'easy', width = 72, color = false } = {}) {
  const scene = await loadScene();
  const db = store.open();
  const { root, repoId, cfg } = context();
  battle.start(mode);
  const G = game(scene, { db, repoId, root, cfg, width, rnd: util.rng(1) });
  const out = [];
  const shot = (title) => out.push(`--- ${title} ---\n${ansi(G.draw(), color)}`);
  G.g.phase = 'intro';
  G.g.intro = 3;
  shot('intro (fighters sliding in)');
  G.g.intro = scene.INTRO_STEPS;
  shot('intro: wants to fight!');
  await G.press('enter');
  shot('question');
  const right = battle.load().pending.correctKey;
  G.g.cursor = Object.keys(G.g.question.choices).indexOf(right);
  await G.press('enter');
  G.g.anim.frame = 3;
  shot('hit (mid-animation)');
  G.g.anim.frame = scene.ANIM_FRAMES;
  shot('result');
  battle.quit();
  return out.join('\n\n');
}

/** Interactive game in the terminal. */
async function play({ width } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('diffdojo battle needs an interactive terminal (try --snapshot)');
  const scene = await loadScene();
  const db = store.open();
  const { root, repoId, cfg } = context();
  const W = width || Math.max(56, Math.min((process.stdout.columns || 80) - 2, 92));
  const G = game(scene, { db, repoId, root, cfg, width: W });
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l');
  const restore = () => out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  let busy = false;
  const render = () => out.write('\x1b[H\x1b[2J' + ansi(G.draw()) + '\n');
  const timer = setInterval(() => {
    G.step();
    render();
  }, FRAME_MS);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  await new Promise((resolve) => {
    process.stdin.on('data', async (k) => {
      if (k === '\u0003' || k === 'q' || k === '\u001b') return resolve();
      const key = k === '\u001b[A' || k === 'k' ? 'up' : k === '\u001b[B' || k === 'j' ? 'down' : k === '\r' || k === '\n' || k === ' ' ? 'enter' : null;
      if (!key || busy) return;
      busy = true;
      try {
        await G.press(key);
      } catch (e) {
        G.g.message = e.message;
      } finally {
        busy = false;
      }
      render();
    });
  });
  clearInterval(timer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  restore();
}

module.exports = { play, snapshot, game, ansi, loadScene, MODES };
