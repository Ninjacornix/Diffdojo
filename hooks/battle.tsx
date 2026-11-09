// DiffDojo Battle: the in-app, turn-based quiz fight drawn while Claude works.
// Laid out like a classic handheld RPG battle (original characters): the enemy
// top right, you bottom left, HP bars, and a text box with four answers picked
// with the arrow keys and Enter. Idle frames alternate; hits shake, flash and
// drain the HP bar. Game rules live in the CLI (src/battle.js); this draws.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { BattleQuestion, BattleResult, BattleView, BattleAnim } from '../types'

type Engine = EngineInterface

export const BATTLE_PANE = 'dojo-battle'

export const battleOn = atom({ plugin: 'diffdojo', key: 'battleOn' } as const, true)
const scene = atom({ plugin: 'diffdojo', key: 'battleScene' } as const, null, { shape: 'scene-1' })
const after = atom({ plugin: 'diffdojo', key: 'battleAfter' } as const, null, { shape: 'scene-1' })
const question = atom({ plugin: 'diffdojo', key: 'battleQuestion' } as const, null, { shape: 'bq-1' })
const outcome = atom({ plugin: 'diffdojo', key: 'battleResult' } as const, null, { shape: 'br-1' })
const anim = atom({ plugin: 'diffdojo', key: 'battleAnim' } as const, null, { shape: 'anim-1' })
const tick = atom({ plugin: 'diffdojo', key: 'battleTick' } as const, 0)
const busy = atom({ plugin: 'diffdojo', key: 'battleBusy' } as const, false)

const ANIM_FRAMES = 10
const IDLE_MS = 650
const ANIM_MS = 90

// Module timers (a reload drops them; the next open restarts them).
let idleTimer: { cancel: () => void } | null = null
let animTimer: { cancel: () => void } | null = null

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
  if (r.state.phase === 'fight' && !(await read($, question)) && !(await read($, outcome))) await loadQuestion($)
}

export async function openBattle($: Engine, focus: boolean) {
  await sync($)
  const opened = await $.ui.open({ id: BATTLE_PANE, title: 'DiffDojo Battle', rows: 30, closeOnEscape: true, ...(focus ? { focus: true as const } : {}) })
  if (opened.isPlaced) startIdle($)
}

function startIdle($: Engine) {
  idleTimer?.cancel()
  idleTimer = $.clock.every(IDLE_MS, () => update($, tick, n => (n + 1) % 1000))
}

function play($: Engine, kind: BattleAnim['kind']) {
  animTimer?.cancel()
  void update($, anim, () => ({ kind, frame: 0 }))
  animTimer = $.clock.every(ANIM_MS, async () => {
    const a = await read($, anim)
    if (!a || a.frame >= ANIM_FRAMES) {
      animTimer?.cancel()
      animTimer = null
      return
    }
    await update($, anim, cur => (cur ? { ...cur, frame: cur.frame + 1 } : cur))
  })
}

async function choose($: Engine, mode: string) {
  const r = await cli($, ['battle-start', mode])
  if (r.error) return $.ui.toast(`DiffDojo: ${r.error}`)
  await update($, outcome, () => null)
  await update($, question, () => null)
  await update($, scene, () => r.state as BattleView)
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
    play($, r.correct ? 'enemyHit' : r.enemyMissed ? 'dodge' : 'playerHit')
    for (const t of r.trophies ?? []) $.ui.toast(`🏆 ${t.name}`, { timeoutMs: 9000 })
  } finally {
    await update($, busy, () => false)
  }
}

async function proceed($: Engine) {
  const next = await read($, after)
  await update($, outcome, () => null)
  await update($, question, () => null)
  await update($, anim, () => null)
  if (next) await update($, scene, () => next)
  if (next && next.phase === 'fight') await loadQuestion($)
}

async function again($: Engine) {
  const r = await cli($, ['battle-resume'])
  await update($, scene, () => r.state as BattleView)
  await update($, outcome, () => null)
  await loadQuestion($)
}

async function toMenu($: Engine) {
  const r = await cli($, ['battle-quit'])
  await update($, scene, () => r.state as BattleView)
  await update($, outcome, () => null)
  await update($, question, () => null)
}

// ---------- drawing helpers (pure)

function hpBar(hp: number, max: number, cells = 20) {
  const n = Math.max(0, Math.min(cells, Math.round((hp / max) * cells)))
  return { bar: '█'.repeat(n) + '░'.repeat(cells - n), color: hp / max > 0.5 ? 'green' : hp / max > 0.2 ? 'yellow' : 'red' }
}

function lerp(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * Math.min(1, t))
}

const TITLE = [
  ' ___  _  __  __ ___      _         ___   _ _____ _____ _    ___ ',
  '|   \\(_)/ _|/ _|   \\ ___(_)___    | _ ) /_\\_   _|_   _| |  | __|',
  '| |) | |  _|  _| |) / _ \\ / _ \\   | _ \\/ _ \\| |   | | | |__| _| ',
  '|___/|_|_| |_| |___/\\___/ \\___/   |___/_/ \\_\\_|   |_| |____|___|',
  '                     |__/                                        ',
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
    return { text: 'DiffDojo Battle opened. Arrows + Enter to fight, Esc to return to the prompt.' }
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
    const t = await read($, tick)
    const width = Math.max(40, Math.min(e.props.bodyColumns || 80, 100))

    // ---- menu
    if (!s || !s.mode || s.phase === 'menu') {
      const best = (s && s.best) || {}
      const wins = (s && s.wins) || {}
      const modes = [
        ['easy', 'Easy', 'Typo Sprite, Lint Gremlin, Off-by-One Imp'],
        ['medium', 'Medium', 'Null Pointer, Memory Leak, Flaky Test'],
        ['hard', 'Hard', 'Race Condition, Deadlock Twins, Heisenbug'],
        ['professional', 'Professional', '... and EVIL CLAUDE awaits'],
        ['endless', 'Endless', `waves that keep coming${best.endless ? ` · best wave ${best.endless}` : ''}`],
      ]
      return (
        <Box flexDirection="column">
          {TITLE.map((l, i) => (
            <Text color={i % 2 === t % 2 ? 'cyan' : 'blue'}>{l}</Text>
          ))}
          <Text> </Text>
          <Text>Answer right to strike. Answer wrong and they strike back. 3 lives.</Text>
          <Text> </Text>
          <Select
            key="mode"
            label="Choose your fight"
            autoFocus
            options={modes.map(([value, label, who]) => ({ value, label: `${label.padEnd(13)} ${who}${wins[value] ? `  ★×${wins[value]}` : ''}` }))}
            onSelect={value => choose($, value)}
          />
          <Text dimColor>↑/↓ to choose · Enter to fight · Esc back to the prompt</Text>
        </Box>
      )
    }

    // ---- game over / victory
    if (s.phase === 'gameover' || s.phase === 'victory') {
      const won = s.phase === 'victory'
      return (
        <Box flexDirection="column" alignItems="center">
          <Text bold color={won ? 'yellow' : 'red'}>{won ? '★ ★ ★   V I C T O R Y   ★ ★ ★' : 'G A M E   O V E R'}</Text>
          <Text> </Text>
          {(won ? s.enemy?.frames?.[t % 2] ?? [] : s.player.frames[t % 2]).map(l => (
            <Text color={won ? 'gray' : 'red'} dimColor>{l}</Text>
          ))}
          <Text> </Text>
          <Text>{won ? `You cleared ${s.modeLabel}!${s.mode === 'professional' ? ' Evil Claude is defeated.' : ''}` : 'Out of lives. Back to the first enemy, full health, 3 lives.'}</Text>
          <Select
            key="end"
            autoFocus
            options={[
              { value: 'again', label: won ? 'Fight this ladder again' : 'Try again' },
              { value: 'menu', label: 'Choose another mode' },
            ]}
            onSelect={v => (v === 'again' ? again($) : toMenu($))}
          />
        </Box>
      )
    }

    // ---- the fight
    const enemy = s.enemy!
    const p = s.player
    const progress = a ? a.frame / ANIM_FRAMES : 1
    const enemyHp = res && a?.kind === 'enemyHit' ? lerp(res.enemyHpBefore, res.enemyHpAfter, progress) : res ? res.enemyHpAfter : enemy.hp
    const playerHp = res && a?.kind === 'playerHit' ? lerp(res.playerHpBefore, res.playerHpAfter, progress) : res ? res.playerHpAfter : p.hp
    const hitFrame = !!a && a.frame < 6
    const enemyShake = a?.kind === 'enemyHit' && hitFrame ? (a.frame % 2 ? 3 : 0) : 0
    const playerShake = a?.kind === 'playerHit' && hitFrame ? (a.frame % 2 ? 2 : 0) : 0
    const dodgeSlide = a?.kind === 'dodge' && hitFrame ? Math.min(a.frame, 6 - a.frame) * 2 : 0
    const enemyBob = t % 2
    const eBar = hpBar(enemyHp, enemy.maxHp)
    const pBar = hpBar(playerHp, p.maxHp)
    const enemyColor = a?.kind === 'enemyHit' && hitFrame && a.frame % 2 ? 'red' : enemy.color || 'white'
    const playerColor = a?.kind === 'playerHit' && hitFrame && a.frame % 2 ? 'red' : 'white'
    const hearts = '♥'.repeat(s.lives) + '♡'.repeat(Math.max(0, s.maxLives - s.lives))
    const where = s.mode === 'endless' ? `WAVE ${s.wave}` : `${s.modeLabel} ${s.stage + 1}/${s.stages}`
    const fx = a?.kind === 'enemyHit' && hitFrame ? (a.frame % 2 ? '  ✶ ✷ ✶' : ' ✷  ✶') : a?.kind === 'dodge' && hitFrame ? '  MISS!' : ''

    return (
      <Box flexDirection="column" width={width}>
        {/* enemy: info box left, sprite right */}
        <Box justifyContent="space-between">
          <Box flexDirection="column" borderStyle="round" paddingX={1} width={34}>
            <Text bold color={enemy.boss ? enemy.color || 'magenta' : undefined}>{`${enemy.name}${enemy.boss ? ' ☠' : ''}`}</Text>
            <Text dimColor>{`Lv${enemy.level} · ${where}`}</Text>
            <Text>
              <Text dimColor>HP </Text>
              <Text color={eBar.color}>{eBar.bar}</Text>
            </Text>
            <Text dimColor>{`   ${enemyHp}/${enemy.maxHp}`}</Text>
          </Box>
          <Box flexDirection="column" marginLeft={enemyShake} marginTop={enemyBob} marginRight={2}>
            {enemy.frames[t % 2].map(l => (
              <Text color={enemyColor} bold={!!enemy.boss}>{l}</Text>
            ))}
            {fx ? <Text color="yellow" bold>{fx}</Text> : null}
          </Box>
        </Box>
        {/* you: sprite left, info box right */}
        <Box justifyContent="space-between">
          <Box flexDirection="column" marginLeft={2 + playerShake + dodgeSlide} marginTop={1 - enemyBob}>
            {p.frames[(t + 1) % 2].map(l => (
              <Text color={playerColor}>{l}</Text>
            ))}
          </Box>
          <Box flexDirection="column" borderStyle="round" paddingX={1} width={34}>
            <Text bold>
              {'YOU  '}
              <Text color="red">{hearts}</Text>
            </Text>
            <Text>
              <Text dimColor>HP </Text>
              <Text color={pBar.color}>{pBar.bar}</Text>
            </Text>
            <Text dimColor>{`   ${playerHp}/${p.maxHp}`}</Text>
          </Box>
        </Box>
        {/* text box */}
        <Box flexDirection="column" borderStyle="double" paddingX={1}>
          {res ? (
            <Box flexDirection="column">
              <Text bold color={res.correct ? 'green' : res.enemyMissed ? 'yellow' : 'red'}>
                {res.correct
                  ? `Correct! You hit ${res.enemyName} for ${res.damage}!${res.xp ? `  +${res.xp} XP` : ''}`
                  : res.enemyMissed
                    ? `Wrong (it was ${res.correctKey})... but ${res.enemyName} missed!`
                    : `Wrong, it was ${res.correctKey}! ${res.enemyName} hits you for ${res.enemyDamage}!`}
              </Text>
              {res.enemyDefeated && !res.victory ? <Text color="green">{`${res.enemyName} fainted! HP restored. ${res.nextEnemy} appears!`}</Text> : null}
              {res.victory ? <Text bold color="yellow">{`${res.enemyName} is defeated! You cleared the ladder!`}</Text> : null}
              {res.lifeLost && !res.gameOver ? <Text color="red">You fainted! One life lost, HP restored.</Text> : null}
              {res.gameOver ? <Text bold color="red">No lives left...</Text> : null}
              {res.explanation ? <Text dimColor wrap="wrap">{res.explanation}</Text> : null}
              <Select key="continue" autoFocus options={[{ value: 'go', label: '▶ Continue' }]} onSelect={() => proceed($)} />
            </Box>
          ) : q ? (
            <Box flexDirection="column">
              <Text>
                <Text bold color={enemy.color || 'cyan'}>{`${enemy.name} asks: `}</Text>
                <Text dimColor>{`${q.family} · ${q.difficulty}${q.location ? ` · ${q.location}` : ''}`}</Text>
              </Text>
              <Text wrap="wrap">{q.prompt}</Text>
              {q.code && q.code.split('\n').length <= 12 ? <Text dimColor>{q.code}</Text> : null}
              <Select
                key={`q-${q.id}`}
                autoFocus
                options={Object.entries(q.choices).map(([k, v]) => ({ value: k, label: `${k}) ${v}` }))}
                onSelect={value => attack($, value)}
              />
              <Text dimColor>↑/↓ pick · Enter attack · Esc back to the prompt</Text>
            </Box>
          ) : (
            <Text dimColor>{`${enemy.name} is thinking${'.'.repeat((t % 3) + 1)}`}</Text>
          )}
        </Box>
      </Box>
    )
  })
}
