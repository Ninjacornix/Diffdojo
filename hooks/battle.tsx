// DiffDojo Battle inside Claude Code: the turn-based quiz fight drawn while
// Claude works. The screen itself comes from ./scene.mts (shared with the
// terminal game `diffdojo battle`); this module adds input, timers and state.
// Rules and questions live in the CLI (src/battle.js).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { BattleQuestion, BattleResult, BattleView, BattleAnim } from '../types'
import { ANIM_FRAMES, INTRO_STEPS, PALETTE, TITLE, battlefield, box, plain, spriteLines, join, pad, wrap } from './scene.mts'
import type { BoxRow, Line } from './scene.mts'

type Engine = EngineInterface

export const BATTLE_PANE = 'dojo-battle'

const battleOn = atom({ plugin: 'diffdojo', key: 'battleOn' } as const, true)
const scene = atom({ plugin: 'diffdojo', key: 'battleScene' } as const, null, { shape: 'scene-2' })
const after = atom({ plugin: 'diffdojo', key: 'battleAfter' } as const, null, { shape: 'scene-2' })
const question = atom({ plugin: 'diffdojo', key: 'battleQuestion' } as const, null, { shape: 'bq-1' })
const outcome = atom({ plugin: 'diffdojo', key: 'battleResult' } as const, null, { shape: 'br-1' })
const anim = atom({ plugin: 'diffdojo', key: 'battleAnim' } as const, null, { shape: 'anim-1' })
const intro = atom({ plugin: 'diffdojo', key: 'battleIntro' } as const, -1)
const tick = atom({ plugin: 'diffdojo', key: 'battleTick' } as const, 0)
const busy = atom({ plugin: 'diffdojo', key: 'battleBusy' } as const, false)

const IDLE_MS = 650
const FRAME_MS = 90

// Module timers (a reload drops them; the next open restarts them).
let idleTimer: { cancel: () => void } | null = null
let frameTimer: { cancel: () => void } | null = null

type Api = Record<string, any>

async function cli($: Engine, args: string[]): Promise<Api> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/bin/diffdojo`, 'api', ...args], { timeoutMs: 300000 })
    return JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as Api
  } catch (err) {
    $.ui.log(`diffdojo battle: ${String(err)}`, { to: 'debug' })
    return { error: String(err) }
  }
}

/** One timer drives the intro slide-in and the hit animation. */
function frames($: Engine) {
  if (frameTimer) return
  frameTimer = $.clock.every(FRAME_MS, async () => {
    const i = await read($, intro)
    const a = await read($, anim)
    const sliding = i >= 0 && i < INTRO_STEPS
    const hitting = !!a && a.frame < ANIM_FRAMES
    if (sliding) await update($, intro, n => Math.min(INTRO_STEPS, n + 1))
    if (hitting) await update($, anim, cur => (cur ? { ...cur, frame: cur.frame + 1 } : cur))
    if (!sliding && !hitting) {
      frameTimer?.cancel()
      frameTimer = null
    }
  })
}

async function startIntro($: Engine) {
  await update($, intro, () => 0)
  frames($)
}

async function loadQuestion($: Engine) {
  const r = await cli($, ['battle-question'])
  if (r.error) {
    $.ui.toast(`DiffDojo: ${r.error}`)
    return
  }
  if (r.state) await update($, scene, () => r.state as BattleView)
  await update($, question, () => (r.question as BattleQuestion) ?? null)
}

async function sync($: Engine) {
  const r = await cli($, ['battle-state'])
  if (r.battle !== undefined) await update($, battleOn, () => r.battle !== false)
  if (!r.state) return
  await update($, scene, () => r.state as BattleView)
  if (r.state.phase === 'fight' && !(await read($, question)) && !(await read($, outcome)) && (await read($, intro)) < 0) await startIntro($)
}

export async function openBattle($: Engine, focus: boolean) {
  await sync($)
  const opened = await $.ui.open({
    id: BATTLE_PANE,
    title: 'DiffDojo Battle',
    rows: 32,
    closeOnEscape: true,
    backgroundColor: PALETTE.bg,
    ...(focus ? { focus: true as const } : {}),
  })
  if (opened.isPlaced) {
    idleTimer?.cancel()
    idleTimer = $.clock.every(IDLE_MS, () => update($, tick, n => (n + 1) % 1000))
  }
}

async function choose($: Engine, mode: string) {
  const r = await cli($, ['battle-start', mode])
  if (r.error) return $.ui.toast(`DiffDojo: ${r.error}`)
  await update($, outcome, () => null)
  await update($, question, () => null)
  await update($, scene, () => r.state as BattleView)
  await startIntro($)
}

async function endIntro($: Engine) {
  const i = await read($, intro)
  if (i >= 0 && i < INTRO_STEPS) {
    await update($, intro, () => INTRO_STEPS) // Enter skips the slide-in
    return
  }
  await update($, intro, () => -1)
  await loadQuestion($)
}

async function attack($: Engine, key: string) {
  if (await read($, busy)) return
  const q = await read($, question)
  if (!q) return
  await update($, busy, () => true)
  try {
    const r = await cli($, ['battle-answer', key])
    if (r.error) return $.ui.toast(`DiffDojo: ${r.error}`)
    await update($, outcome, () => ({ ...(r as BattleResult), picked: key, prompt: q.prompt }))
    await update($, after, () => r.state as BattleView)
    await update($, anim, () => ({ kind: r.correct ? 'enemyHit' : r.enemyMissed ? 'dodge' : 'playerHit', frame: 0 }) as BattleAnim)
    frames($)
    for (const t of r.trophies ?? []) $.ui.toast(`Trophy unlocked: ${t.name}`, { timeoutMs: 9000 })
  } finally {
    await update($, busy, () => false)
  }
}

async function proceed($: Engine) {
  const res = await read($, outcome)
  const next = await read($, after)
  await update($, outcome, () => null)
  await update($, question, () => null)
  await update($, anim, () => null)
  if (next) await update($, scene, () => next)
  if (!next || next.phase !== 'fight') return
  if (res && res.enemyDefeated) await startIntro($) // a new enemy slides in
  else await loadQuestion($)
}

async function again($: Engine) {
  const r = await cli($, ['battle-resume'])
  await update($, scene, () => r.state as BattleView)
  await update($, outcome, () => null)
  await startIntro($)
}

async function toMenu($: Engine) {
  const r = await cli($, ['battle-quit'])
  await update($, scene, () => r.state as BattleView)
  await update($, outcome, () => null)
  await update($, question, () => null)
  await update($, intro, () => -1)
}

const MODES = [
  ['easy', 'Easy', 'Typo Sprite, Lint Gremlin, Off-by-One Imp'],
  ['medium', 'Medium', 'Null Pointer, Memory Leak, Flaky Test'],
  ['hard', 'Hard', 'Race Condition, Deadlock Twins, Heisenbug'],
  ['professional', 'Professional', 'Segfault Specter, Legacy Monolith, EVIL CLAUDE'],
  ['endless', 'Endless', 'waves that keep coming'],
]

/** Called from the plugin's one session.start hook. */
export async function battleSessionStart($: Engine) {
  await $.command.register({ name: 'battle', description: 'DiffDojo Battle: fight bugs by answering questions (on | off | menu)', argumentHint: '[on|off|menu]' })
  void sync($)
}

export function registerBattle(on: On) {
  on('command.run', { command: 'battle' }, async ($, e) => {
    const arg = (e.args || '').trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await $.process.run(['node', `${$.plugin.root}/bin/diffdojo`, 'config', 'set', 'battle', arg === 'on' ? 'true' : 'false', '--global'])
      await update($, battleOn, () => arg === 'on')
      if (arg === 'off') await $.ui.close({ id: BATTLE_PANE })
      return { text: arg === 'on' ? 'Battle mode on: fights start while Claude works.' : 'Battle mode off: questions show in the plain box above the prompt.' }
    }
    if (arg === 'menu') await toMenu($)
    await openBattle($, true)
    return { text: 'DiffDojo Battle opened. Up/down and Enter to fight, Esc to return to the prompt.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === BATTLE_PANE) {
      idleTimer?.cancel()
      idleTimer = null
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: BATTLE_PANE }, async ($, e) => {
    const { Box, Text, Select } = $.ui.resolve(e)
    const s = await read($, scene)
    const q = await read($, question)
    const res = await read($, outcome)
    const a = await read($, anim)
    const i = await read($, intro)
    const t = await read($, tick)
    const W = Math.max(56, Math.min((e.props.bodyColumns || 80) - 1, 92))

    // Scene lines; single-segment rows stay one Text so they read as one string.
    const draw = (lines: Line[]) =>
      lines.map(l =>
        l.length === 1 ? (
          <Text color={l[0].c} backgroundColor={l[0].bg} bold={!!l[0].b}>{l[0].t}</Text>
        ) : (
          <Text>
            {l.map(sg => (
              <Text color={sg.c} backgroundColor={sg.bg} bold={!!sg.b}>{sg.t}</Text>
            ))}
          </Text>
        ),
      )
    const rule = <Text color={PALETTE.ink} backgroundColor={PALETTE.bg}>{'═'.repeat(W)}</Text>
    const rowsOf = (rows: BoxRow[]) => draw(box(rows, W, t, false, 0).slice(1, -1))

    // ---- menu
    if (!s || !s.mode || s.phase === 'menu') {
      const best = (s && s.best) || {}
      const wins = (s && s.wins) || {}
      return (
        <Box flexDirection="column" backgroundColor={PALETTE.bg}>
          {draw([plain('', W), ...TITLE.map((l, n) => plain('   ' + l, W, n % 2 === t % 2 ? PALETTE.ink : PALETTE.mid, true)), plain('', W)])}
          {draw([plain('   Answer right to strike. Answer wrong and they strike back. 3 lives.', W), plain('', W)])}
          {rule}
          <Select
            key="mode"
            label="Choose your fight"
            autoFocus
            options={MODES.map(([value, label, who]) => ({
              value,
              label: `${label.padEnd(13)} ${who}${value === 'endless' && best.endless ? `  (best wave ${best.endless})` : ''}${wins[value] ? `  cleared x${wins[value]}` : ''}`,
            }))}
            onSelect={value => choose($, value)}
          />
          {rule}
          <Text dimColor>up/down choose · Enter fight · Esc back to the prompt</Text>
        </Box>
      )
    }

    // ---- game over / victory
    if (s.phase === 'gameover' || s.phase === 'victory') {
      const won = s.phase === 'victory'
      const id = won && s.mode === 'professional' ? 'evil' : 'player'
      return (
        <Box flexDirection="column" backgroundColor={PALETTE.bg}>
          {draw([plain('', W), plain(won ? '        V I C T O R Y' : '        G A M E   O V E R', W, won ? PALETTE.ink : PALETTE.hurt, true), plain('', W)])}
          {draw(spriteLines(id, t).map(l => pad(join([], l, 8), W)))}
          {rule}
          {rowsOf([{ text: won ? `You cleared ${s.modeLabel}!${s.mode === 'professional' ? ' Evil Claude is defeated.' : ''}` : 'Out of lives. Back to the first enemy with full health and 3 lives.' }])}
          <Select
            key="end"
            autoFocus
            options={[
              { value: 'again', label: won ? 'Fight this ladder again' : 'Try again' },
              { value: 'menu', label: 'Choose another mode' },
            ]}
            onSelect={v => (v === 'again' ? again($) : toMenu($))}
          />
          {rule}
        </Box>
      )
    }

    // ---- the fight (the scene stays the pre-answer one until Continue)
    const enemy = s.enemy!
    const progress = a ? a.frame / ANIM_FRAMES : 1
    const lerp = (x: number, y: number) => Math.round(x + (y - x) * Math.min(1, progress))
    const enemyHp = res ? (a?.kind === 'enemyHit' ? lerp(res.enemyHpBefore, res.enemyHpAfter) : res.enemyHpAfter) : enemy.hp
    const playerHp = res ? (a?.kind === 'playerHit' ? lerp(res.playerHpBefore, res.playerHpAfter) : res.playerHpAfter) : s.player.hp
    const sliding = i >= 0
    const field = battlefield({ view: s, width: W, tick: t, intro: sliding ? i : INTRO_STEPS, anim: a, enemyHp, playerHp })

    let rows: BoxRow[] = []
    let control: unknown = null
    if (sliding) {
      rows = wrap([enemy.boss ? `${enemy.name} appears! The final battle begins!` : `${enemy.name} wants to fight!`], W - 6).map(text => ({ text }))
      control = <Select key="intro" autoFocus options={[{ value: 'go', label: i >= INTRO_STEPS ? (t % 2 ? '▼' : ' ') : '...' }]} onSelect={() => endIntro($)} />
    } else if (res) {
      const lines: string[] = []
      if (res.correct) lines.push(`Correct! You hit ${res.enemyName} for ${res.damage}!${res.xp ? ` +${res.xp} XP` : ''}`)
      else if (res.enemyMissed) lines.push(`Wrong, it was ${res.correctKey}... but ${res.enemyName} missed!`)
      else lines.push(`Wrong, it was ${res.correctKey}! ${res.enemyName} hits you for ${res.enemyDamage}!`)
      if (res.enemyDefeated && !res.victory) lines.push(`${res.enemyName} fainted! Your HP is restored.`)
      if (res.victory) lines.push(`${res.enemyName} is defeated! You cleared the ladder!`)
      if (res.lifeLost && !res.gameOver) lines.push('You fainted! One life lost, HP restored.')
      if (res.gameOver) lines.push('No lives left...')
      rows = lines.map(text => ({ text }))
      if (res.explanation) for (const x of wrap([res.explanation], W - 6).slice(0, 3)) rows.push({ text: x, dim: true })
      const done = !a || a.frame >= ANIM_FRAMES
      control = <Select key="continue" autoFocus options={[{ value: 'go', label: done ? (t % 2 ? '▼' : ' ') : '...' }]} onSelect={() => proceed($)} />
    } else if (q) {
      rows = wrap([`${enemy.name} asks: ${q.prompt}`], W - 6).map(text => ({ text }))
      if (q.location) rows.push({ text: `${q.family} · ${q.difficulty} · ${q.location}`, dim: true })
      if (q.code && q.code.split('\n').length <= 10) for (const c of q.code.split('\n')) rows.push({ text: '  ' + c, dim: true })
      control = (
        <Select
          key={`q-${q.id}`}
          autoFocus
          options={Object.entries(q.choices).map(([k, val]) => ({ value: k, label: `${k}) ${val}` }))}
          onSelect={value => attack($, value)}
        />
      )
    } else {
      rows = [{ text: `${enemy.name} is thinking${'.'.repeat((t % 3) + 1)}` }]
    }

    return (
      <Box flexDirection="column" backgroundColor={PALETTE.bg}>
        {draw(field)}
        {rule}
        {rowsOf(rows)}
        {control}
        {rule}
      </Box>
    )
  })
}
