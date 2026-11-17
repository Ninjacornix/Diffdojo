// DiffDojo Battle inside Claude Code: the turn-based quiz fight drawn while
// Claude works. The screen itself comes from ./scene.mts (shared with the
// terminal game `diffdojo battle`); this module adds input, timers and state.
// Rules and questions live in the CLI (src/battle.js).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Achievements, Scores, BattleQuestion, BattleResult, BattleView, BattleAnim, GateAsk, ModelSettings } from '../types'
import { ANIM_FRAMES, INTRO_STEPS, PALETTE, TITLE, battlefield, box, plain, spriteLines, join, pad, wrap, trophyArt } from './scene.mts'
import type { BoxRow, Line } from './scene.mts'

type Engine = EngineInterface

export const BATTLE_PANE = 'dojo-battle'

const battleOn = atom({ plugin: 'diffdojo', key: 'battleOn' } as const, true)
// False only when DiffDojo is switched off here (/diffdojo:stop or autoEnable: false).
// Battles also run outside git repositories, on concept questions.
const battleAllowed = atom({ plugin: 'diffdojo', key: 'battleAllowed' } as const, true)
const scene = atom({ plugin: 'diffdojo', key: 'battleScene' } as const, null, { shape: 'scene-2' })
const after = atom({ plugin: 'diffdojo', key: 'battleAfter' } as const, null, { shape: 'scene-2' })
const question = atom({ plugin: 'diffdojo', key: 'battleQuestion' } as const, null, { shape: 'bq-1' })
const outcome = atom({ plugin: 'diffdojo', key: 'battleResult' } as const, null, { shape: 'br-1' })
const anim = atom({ plugin: 'diffdojo', key: 'battleAnim' } as const, null, { shape: 'anim-1' })
const intro = atom({ plugin: 'diffdojo', key: 'battleIntro' } as const, -1)
const tick = atom({ plugin: 'diffdojo', key: 'battleTick' } as const, 0)
const busy = atom({ plugin: 'diffdojo', key: 'battleBusy' } as const, false)
// Whether a No Mercy fight is on (hooks/nomercy.tsx gates Claude's edits on it), and whether SKYNET's screen is showing.
const noMercy = atom({ plugin: 'diffdojo', key: 'noMercy' } as const, false)
const skynetView = atom({ plugin: 'diffdojo', key: 'skynetView' } as const, false)
// The menu's screens, and what they show.
const menuTab = atom({ plugin: 'diffdojo', key: 'menuTab' } as const, 'main')
const achievements = atom({ plugin: 'diffdojo', key: 'achievements' } as const, null, { shape: 'ach-1' })
// The trophy opened on the Achievements screen ('' = the list).
const trophyView = atom({ plugin: 'diffdojo', key: 'trophyView' } as const, '')
const scores = atom({ plugin: 'diffdojo', key: 'scores' } as const, null, { shape: 'sco-1' })
// Sharing the score card: the preview being confirmed, and where it was shared.
const sharePreview = atom({ plugin: 'diffdojo', key: 'sharePreview' } as const, '')
const sharedAt = atom({ plugin: 'diffdojo', key: 'sharedAt' } as const, '')
const sharing = atom({ plugin: 'diffdojo', key: 'sharing' } as const, false)
const settings = atom({ plugin: 'diffdojo', key: 'modelSettings' } as const, null, { shape: 'set-1' })
const topics = atom({ plugin: 'diffdojo', key: 'prepareTopics' } as const, [] as string[])
const preparing = atom({ plugin: 'diffdojo', key: 'preparing' } as const, '')
// SKYNET's question about an edit Claude is about to make, asked in this pane.
const gateAsk = atom({ plugin: 'diffdojo', key: 'gateAsk' } as const, null, { shape: 'ga-1' })

const IDLE_MS = 650
const FRAME_MS = 90

// Module timers (a reload drops them; the next open restarts them).
let idleTimer: { cancel: () => void } | null = null
let frameTimer: { cancel: () => void } | null = null
// Who is waiting for the answer to SKYNET's question in the pane (hooks/nomercy.tsx).
let gateWaiter: ((label: string | null) => void) | null = null

/** Settle the pane question: an option label, or null when the pane can't take the answer. */
async function settleGate($: Engine, label: string | null) {
  const w = gateWaiter
  gateWaiter = null
  await update($, gateAsk, () => null)
  w?.(label)
}

/**
 * Ask SKYNET's question in the battle pane, opening it if needed. Resolves to
 * the option chosen, or null if the pane can't be shown or is closed before
 * an answer (the caller then asks in Claude Code's question dialog instead).
 */
export async function askInPane($: Engine, g: GateAsk): Promise<string | null> {
  if (gateWaiter) await settleGate($, null)
  const opened = await $.ui.open({ id: BATTLE_PANE, title: 'DiffDojo Battle', rows: 32, closeOnEscape: true, focus: true })
  if (!opened.isPlaced) return null
  if (!idleTimer) idleTimer = $.clock.every(IDLE_MS, () => update($, tick, n => (n + 1) % 1000))
  const answered = new Promise<string | null>(resolve => {
    gateWaiter = resolve
  })
  await update($, gateAsk, () => g)
  return answered
}

/** Drop a question that no longer matters (Claude's turn ended under it). */
export async function cancelPaneAsk($: Engine) {
  if (gateWaiter) await settleGate($, null)
}

type Api = Record<string, any>

// This Claude Code session's id: a No Mercy fight belongs to the session that started it.
let sessionId = ''

/** Tell the CLI which session is asking (see src/battle.js noMercyActive). */
export function sessionEnv(): Record<string, string> {
  return sessionId ? { DIFFDOJO_SESSION: sessionId } : {}
}

async function cli($: Engine, args: string[]): Promise<Api> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/bin/diffdojo`, 'api', ...args], { timeoutMs: 300000, env: sessionEnv() })
    return JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as Api
  } catch (err) {
    $.ui.log(`diffdojo battle: ${String(err)}`, { to: 'debug' })
    return { error: String(err) }
  }
}

/** The fight as the CLI last reported it; also arms or disarms SKYNET's ability. */
async function setScene($: Engine, v: BattleView | null) {
  await update($, scene, () => v)
  await track($, v)
}

async function track($: Engine, v: BattleView | null) {
  const armed = !!v && v.mode === 'nomercy' && v.phase === 'fight'
  if ((await read($, noMercy)) !== armed) {
    await update($, noMercy, () => armed)
    $.ui.status(armed ? 'DiffDojo: NO MERCY · SKYNET intercepts every edit Claude makes' : undefined)
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
    if (sliding) {
      await update($, intro, n => Math.min(INTRO_STEPS, n + 1))
      // Once the enemy is in place the fight starts by itself (Enter skips the wait).
      if (i + 1 >= INTRO_STEPS) $.clock.after(900, async () => {
        if ((await read($, intro)) === INTRO_STEPS) await endIntro($)
      })
    }
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
  if (r.state) await setScene($, r.state as BattleView)
  await update($, question, () => (r.question as BattleQuestion) ?? null)
}

async function sync($: Engine) {
  const r = await cli($, ['battle-state'])
  if (r.battle !== undefined) await update($, battleOn, () => r.battle !== false)
  if (r.battleAllowed !== undefined) await update($, battleAllowed, () => r.battleAllowed !== false)
  if (!r.state) return
  await setScene($, r.state as BattleView)
  if (r.state.phase === 'fight' && !(await read($, question)) && !(await read($, outcome)) && (await read($, intro)) < 0) await startIntro($)
}

/**
 * Open the battle pane. The open comes first, before any CLI call, so Claude
 * Code still counts it as answering the person's command or prompt: an open it
 * sees as unasked waits undrawn on terminals narrower than 144 columns.
 */
export async function openBattle($: Engine, focus: boolean) {
  const opened = await $.ui.open({
    id: BATTLE_PANE,
    title: 'DiffDojo Battle',
    rows: 32,
    closeOnEscape: true,
    ...(focus ? { focus: true as const } : {}),
  })
  if (opened.isPlaced) {
    idleTimer?.cancel()
    idleTimer = $.clock.every(IDLE_MS, () => update($, tick, n => (n + 1) % 1000))
  } else {
    $.ui.log(`diffdojo battle: pane not placed: ${opened.reason}`, { to: 'debug' })
  }
  await sync($)
  return opened
}

/** Whether prompts should start a fight: battle mode on and DiffDojo not switched off here. */
export async function battleAutoStart($: Engine) {
  return (await read($, battleOn)) && (await read($, battleAllowed))
}

/**
 * SKYNET's ability landed: Claude's edit was intercepted and answered
 * (hooks/nomercy.tsx). Shown as an exchange; a wrong answer ends the fight.
 */
export async function showIntercept($: Engine, hit: BattleResult & { state: BattleView }, prompt: string) {
  await update($, outcome, () => ({ ...hit, picked: '', prompt }))
  await update($, after, () => hit.state)
  await track($, hit.state)
  await update($, intro, () => -1)
  await update($, anim, () => ({ kind: hit.correct ? 'enemyHit' : 'playerHit', frame: 0 }) as BattleAnim)
  frames($)
}

/** Claude finished the prompt with every edit answered: SKYNET falls. */
export async function showTurnEnd($: Engine, state: BattleView) {
  await update($, outcome, () => null)
  await update($, anim, () => null)
  await update($, question, () => null)
  await setScene($, state)
}

/** SKYNET's screen with its warning (the menu's No Mercy, and /nomercy). */
export async function showSkynet($: Engine) {
  const s = await read($, scene)
  if (s && s.mode && s.phase !== 'menu') await toMenu($)
  await update($, skynetView, () => true)
}

/** Start a fight in `mode` (the menu, and /nomercy for SKYNET). */
export async function startFight($: Engine, mode: string) {
  await update($, skynetView, () => false)
  await choose($, mode)
}

/** End the fight and go back to the menu (RUN, /battle menu, /nomercy off). */
export async function endFight($: Engine) {
  await update($, skynetView, () => false)
  await toMenu($)
}

async function choose($: Engine, mode: string) {
  const r = await cli($, ['battle-start', mode])
  if (r.error || !r.state) return $.ui.toast(`DiffDojo: could not start the battle${r.error ? `: ${r.error}` : ''}`)
  await update($, outcome, () => null)
  await update($, question, () => null)
  await setScene($, r.state as BattleView)
  await startIntro($)
}

async function endIntro($: Engine) {
  const i = await read($, intro)
  if (i >= 0 && i < INTRO_STEPS) {
    await update($, intro, () => INTRO_STEPS) // Enter skips the slide-in
    return
  }
  await update($, intro, () => -1)
  // SKYNET asks nothing between edits: it waits for Claude's next edit.
  if (!(await read($, scene))?.noHealth) await loadQuestion($)
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
    await track($, r.state as BattleView)
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
  if (next) await setScene($, next)
  if (!next || next.phase !== 'fight' || next.noHealth) return
  if (res && res.enemyDefeated) await startIntro($) // a new enemy slides in
  else await loadQuestion($)
}

async function again($: Engine) {
  const r = await cli($, ['battle-resume'])
  if (r.error || !r.state) return $.ui.toast(`DiffDojo: could not restart the battle${r.error ? `: ${r.error}` : ''}`)
  await setScene($, r.state as BattleView)
  await update($, outcome, () => null)
  await startIntro($)
}

async function toMenu($: Engine) {
  await update($, menuTab, () => 'main')
  const r = await cli($, ['battle-quit'])
  if (r.error || !r.state) return $.ui.toast(`DiffDojo: ${r.error || 'could not return to the menu'}`)
  await setScene($, r.state as BattleView)
  await update($, outcome, () => null)
  await update($, question, () => null)
  await update($, intro, () => -1)
}

// The option in every fight that ends it and goes back to the menu.
const RUN = '__run'

/** Model choices in Settings: cheapest first. */
const MODELS: [string, string][] = [
  ['claude-haiku-5-5', 'Haiku 5.5 (cheapest)'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-opus-5-5', 'Opus 5.5 (smartest)'],
]
const EFFORTS = ['low', 'medium', 'high']

async function setConfig($: Engine, key: string, value: string) {
  await $.process.run(['node', `${$.plugin.root}/bin/diffdojo`, 'config', 'set', key, value, '--global'])
}

/** Go to a menu screen, loading what it shows. */
async function goTab($: Engine, tab: string) {
  await update($, trophyView, () => '')
  if (tab === 'scores') {
    const r = await cli($, ['scores'])
    await update($, scores, () => (r.error ? null : (r as unknown as Scores)))
    const p = await cli($, ['share-preview'])
    await update($, sharedAt, () => (p.shared && p.shared.url ? String(p.shared.url) : ''))
    await update($, sharePreview, () => '')
  }
  if (tab === 'achievements') {
    const r = await cli($, ['achievements'])
    await update($, achievements, () => (r.error ? null : (r as unknown as Achievements)))
  }
  if (tab === 'settings' || tab === 'main') {
    const r = await cli($, ['settings'])
    if (!r.error) await update($, settings, () => r as unknown as ModelSettings)
  }
  if (tab === 'prepare') {
    const r = await cli($, ['topics'])
    await update($, topics, () => (Array.isArray(r.topics) ? (r.topics as string[]) : []))
  }
  await update($, menuTab, () => tab)
}

/** Scores → Share: show exactly what would be published, then publish on Publish. */
async function shareStep($: Engine, step: string) {
  if (step === 'preview') {
    const p = await cli($, ['share-preview'])
    await update($, sharePreview, () => (p.text ? String(p.text) : ''))
    return
  }
  if (step === 'cancel') return update($, sharePreview, () => '')
  if (step === 'remove') {
    const r = await cli($, ['share-remove'])
    $.ui.toast(r.removed ? 'Your shared score is deleted.' : `DiffDojo: ${r.error}`, { timeoutMs: 8000 })
    if (r.removed) await update($, sharedAt, () => '')
    return
  }
  if (await read($, sharing)) return
  await update($, sharing, () => true)
  try {
    const r = await cli($, ['share'])
    if (r.error) $.ui.toast(`DiffDojo: ${r.error}`, { timeoutMs: 10000 })
    else {
      await update($, sharedAt, () => String(r.url))
      $.ui.toast(`${r.created ? 'Shared' : 'Updated'}: ${r.url}`, { timeoutMs: 10000 })
    }
  } finally {
    await update($, sharing, () => false)
    await update($, sharePreview, () => '')
  }
}

/** Questions written in advance on a topic, for the next fights. */
async function prepare($: Engine, topic: string) {
  const t = topic.trim()
  if (!t || (await read($, preparing))) return
  await update($, preparing, () => t)
  try {
    const r = await cli($, ['prepare', t])
    if (r.error) $.ui.toast(`DiffDojo: ${r.error}`)
    else if (!r.added) $.ui.toast(`DiffDojo: no questions found on "${t}". Try another topic, or turn on Claude in Settings.`)
    else $.ui.toast(`Prepared ${r.added} questions on "${t}" (${r.via === 'claude' ? 'written by Claude' : 'from the question packs'}). They come up in your next fights.`, { timeoutMs: 8000 })
  } finally {
    await update($, preparing, () => '')
  }
}

const MODES = [
  ['easy', 'Easy', 'Typo Sprite, Lint Gremlin, Off-by-One Imp'],
  ['medium', 'Medium', 'Null Pointer, Memory Leak, Flaky Test'],
  ['hard', 'Hard', 'Race Condition, Deadlock Twins, Heisenbug'],
  ['professional', 'Professional', 'Segfault Specter, Legacy Monolith, EVIL CLAUDE'],
  ['endless', 'Endless', 'waves that keep coming'],
]

// Not a ladder: No Mercy's boss guards Claude's edits (hooks/nomercy.tsx).
const NO_MERCY = 'nomercy'
const BUG_HUNTER = 'bughunter'
const SPECIAL = [
  [NO_MERCY, 'No Mercy', 'SKYNET: answer for every edit Claude makes'],
  [BUG_HUNTER, 'Bug Hunter', 'FREE CHINESE LLM slips a bug into Claude\'s code: find the fix'],
]
const TABS: [string, string][] = [
  ['ladders', 'FIGHT'],
  ['special', 'SPECIAL'],
  ['prepare', 'PREPARE'],
  ['scores', 'SCORES'],
  ['achievements', 'ACHIEVEMENTS'],
  ['settings', 'SETTINGS'],
]

/** Called from the plugin's one session.start hook. */
export async function battleSessionStart($: Engine) {
  try {
    sessionId = await $.session.id()
  } catch {
    sessionId = ''
  }
  void (async () => {
    const r = await cli($, ['settings'])
    if (!r.error) await update($, settings, () => r as unknown as ModelSettings)
  })()
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
    if (arg === 'menu') await endFight($)
    await openBattle($, true)
    return { text: 'DiffDojo Battle opened. Up/down and Enter to fight, Esc to return to the prompt.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === BATTLE_PANE) {
      idleTimer?.cancel()
      idleTimer = null
      // Closed with SKYNET's question open: it is asked in the question dialog instead.
      if (gateWaiter) await settleGate($, null)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: BATTLE_PANE }, async ($, e) => {
    const { Box, Text, Select, Input } = $.ui.resolve(e)
    const s = await read($, scene)
    const q = await read($, question)
    const res = await read($, outcome)
    const a = await read($, anim)
    const i = await read($, intro)
    const t = await read($, tick)
    const ask = await read($, gateAsk)
    const W = Math.max(56, Math.min((e.props.bodyColumns || 80) - 1, 92))

    // Scene lines; single-segment rows stay one Text so they read as one string.
    const draw = (lines: Line[]) =>
      lines.map(l =>
        l.length === 1 ? (
          <Text color={l[0].c ?? undefined} bold={!!l[0].b}>{l[0].t}</Text>
        ) : (
          <Text>
            {l.map(sg => (
              <Text color={sg.c ?? undefined} bold={!!sg.b}>{sg.t}</Text>
            ))}
          </Text>
        ),
      )
    const rule = <Text>{'═'.repeat(W)}</Text>
    const rowsOf = (rows: BoxRow[]) => draw(box(rows, W, t, false, 0).slice(1, -1))

    // ---- SKYNET intercepts one of Claude's edits: its question, answered here
    if (ask) {
      const field = s && s.enemy ? battlefield({ view: s, width: W, tick: t, intro: INTRO_STEPS, anim: null, enemyHp: s.enemy.hp, playerHp: s.player.hp }) : []
      const codeRows = ask.code ? ask.code.split('\n').slice(0, 14).map(c => ({ text: '  ' + c, dim: true })) : []
      return (
        <Box flexDirection="column">
          {draw(field)}
          {rule}
          {rowsOf([
            { text: `SKYNET intercepts Claude's edit to ${ask.file}!` },
            ...wrap([ask.prompt], W - 6).map(text => ({ text })),
            ...codeRows,
          ])}
          <Select
            key={`gate-${ask.id}`}
            autoFocus
            options={ask.options.map((label, n) => ({ value: String(n), label: `${'abcd'[n]}) ${label}` }))}
            onSelect={v => settleGate($, ask.options[Number(v)] ?? '')}
          />
          {rule}
          <Text dimColor>up/down choose · Enter answer · one wrong answer and SKYNET wins</Text>
        </Box>
      )
    }

    // ---- No Mercy: SKYNET's screen, with the warning, before the fight starts
    if ((await read($, skynetView)) && (!s || !s.mode || s.phase === 'menu')) {
      return (
        <Box flexDirection="column">
          {draw([plain('', W), plain('   N O   M E R C Y', W, PALETTE.skynet, true), plain('', W)])}
          {draw(spriteLines('skynet', t).map(l => pad(join([], l, 8), W)))}
          {rule}
          {rowsOf(
            wrap(
              [
                "SKYNET guards your files. While you fight it, every edit Claude makes waits for your answer to one question about it. Answer right and the edit goes through. Answer wrong and SKYNET rejects it and Claude stops.",
                'Between edits it attacks like any enemy. RUN, a win or a loss ends the fight, and Claude edits freely again.',
              ],
              W - 6,
            ).map(text => ({ text })),
          )}
          <Select
            key="skynet"
            autoFocus
            options={[
              { value: 'fight', label: 'Fight SKYNET' },
              { value: 'menu', label: 'Back to the menu' },
            ]}
            onSelect={v => (v === 'fight' ? startFight($, NO_MERCY) : update($, skynetView, () => false))}
          />
          {rule}
          <Text dimColor>up/down choose · Enter select · Esc back to the prompt</Text>
        </Box>
      )
    }

    // ---- menu: a main screen and a screen per tab
    if (!s || !s.mode || s.phase === 'menu') {
      const best = (s && s.best) || {}
      const wins = (s && s.wins) || {}
      const tab = await read($, menuTab)
      const tabBar = plain('   ' + TABS.map(([id, name]) => (id === tab ? `[${name}]` : ` ${name} `)).join(' '), W, PALETTE.ink, true)
      const back = { value: 'back', label: '< Back to the menu' }
      const goBack = () => goTab($, 'main')
      const footer = <Text dimColor>up/down choose · Enter select · Esc back to the prompt</Text>
      const titled = (title: string, body: unknown) => (
        <Box flexDirection="column">
          {draw([plain('', W), tabBar, plain('', W), plain(`   ${title}`, W, PALETTE.ink, true), plain('', W)])}
          {rule}
          {body}
          {rule}
          {footer}
        </Box>
      )
      const cleared = (id: string) => (wins[id] ? `  cleared x${wins[id]}` : '')

      if (tab === 'ladders')
        return titled(
          'Battle ladders: answer right to strike, answer wrong and they strike back. 3 lives.',
          <Select
            key="mode"
            autoFocus
            options={[
              ...MODES.map(([value, label, who]) => ({ value, label: `${label.padEnd(13)} ${who}${value === 'endless' && best.endless ? `  (best wave ${best.endless})` : ''}${cleared(value)}` })),
              back,
            ]}
            onSelect={value => (value === 'back' ? goBack() : choose($, value))}
          />,
        )

      if (tab === 'special')
        return titled(
          'Special fights',
          <Select
            key="mode"
            autoFocus
            options={[...SPECIAL.map(([value, label, who]) => ({ value, label: `${label.padEnd(13)} ${who}${cleared(value)}` })), back]}
            onSelect={value => (value === 'back' ? goBack() : value === NO_MERCY ? update($, skynetView, () => true) : choose($, value))}
          />,
        )

      if (tab === 'scores') {
        const sc = await read($, scores)
        const num = (n: number) => n.toLocaleString('en-US')
        const pct = (n: number | null) => (n === null ? '  -' : `${String(n).padStart(3)}%`)
        const nameW = Math.max(12, Math.min(28, W - 40))
        const rows: BoxRow[] = !sc
          ? [{ text: 'Loading...' }]
          : [
              { text: `All projects: ${num(sc.xp)} XP  ·  ${sc.belt.toUpperCase()} belt  ·  streak ${sc.streak} day${sc.streak === 1 ? '' : 's'}  ·  today +${num(sc.xpToday)} XP` },
              { text: `${num(sc.answered)} answers, ${sc.accuracy === null ? 'none graded yet' : `${sc.accuracy}% right`}  ·  ${sc.trophies} troph${sc.trophies === 1 ? 'y' : 'ies'}` },
              { text: '' },
              { text: `${'Project'.padEnd(nameW)}  ${'XP'.padStart(7)}  ${'answers'.padStart(7)}  right`, dim: true },
              ...sc.projects.slice(0, 14).map(p => {
                const n = (p.here ? '> ' : '  ') + p.name
                return { text: `${(n.length > nameW ? n.slice(0, nameW - 1) + '…' : n).padEnd(nameW)}  ${num(p.xp).padStart(7)}  ${(p.answered === null ? '-' : num(p.answered)).padStart(7)}  ${pct(p.accuracy)}` }
              }),
              ...(sc.projects.length > 14 ? [{ text: `  ... and ${sc.projects.length - 14} more (diffdojo stats lists them all)`, dim: true }] : []),
              ...(sc.projects.length ? [] : [{ text: '  No projects yet: answer a question about Claude\'s code to start.', dim: true }]),
            ]
        const preview = await read($, sharePreview)
        const url = await read($, sharedAt)
        if (preview)
          return titled(
            'Share your score: this is exactly what will be published',
            <Box flexDirection="column">
              {rowsOf(preview.split('\n').filter(l => l.trim()).slice(0, 18).flatMap(l => wrap([l], W - 6)).map(text => ({ text })))}
              {rowsOf(wrap(['As a public GitHub Gist on your account (through the GitHub CLI, gh), with the same numbers as JSON and your badge. No code, questions or project names.'], W - 6).map(text => ({ text, dim: true })))}
              <Select
                key="share"
                autoFocus
                options={[
                  { value: 'publish', label: (await read($, sharing)) ? 'Publishing...' : url ? 'Publish (updates your gist)' : 'Publish' },
                  { value: 'cancel', label: 'Cancel' },
                ]}
                onSelect={v => shareStep($, v)}
              />
            </Box>,
          )
        if (url) rows.push({ text: '' }, { text: `Shared at ${url}`, dim: true })
        return titled(
          'Scores across all your projects',
          <Box flexDirection="column">
            {rowsOf(rows)}
            <Select
              key="scores"
              autoFocus
              options={[
                { value: 'preview', label: url ? 'Update my shared score (GitHub Gist)' : 'Share my score (GitHub Gist)...' },
                ...(url ? [{ value: 'remove', label: 'Delete my shared score' }] : []),
                back,
              ]}
              onSelect={v => (v === 'back' ? goBack() : shareStep($, v))}
            />
          </Box>,
        )
      }

      if (tab === 'achievements') {
        const ach = await read($, achievements)
        const open = await read($, trophyView)
        const trophy = ach && open ? ach.trophies.find(x => x.id === open) : null
        if (ach && trophy) {
          // One trophy, with its picture: bright when earned, grey while locked.
          const [title, how] = trophy.name.split(' — ')
          return titled(
            trophy.earned ? `Trophy: ${title}` : `Locked: ${title}`,
            <Box flexDirection="column">
              {draw(trophyArt(trophy.id).map(r => pad(join([], [{ t: r, c: trophy.earned ? PALETTE.low : PALETTE.mid, b: trophy.earned }], 6), W)))}
              {rowsOf(
                wrap(
                  [
                    how ? `${how[0].toUpperCase()}${how.slice(1)}.` : '',
                    trophy.earned ? `Earned ${trophy.at ? trophy.at.slice(0, 10) : ''}.` : 'Not earned yet.',
                  ].filter(Boolean),
                  W - 6,
                ).map(text => ({ text, dim: !trophy.earned })),
              )}
              <Select key="trophy" autoFocus options={[{ value: 'list', label: '< Back to achievements' }]} onSelect={() => update($, trophyView, () => '')} />
            </Box>,
          )
        }
        const got = ach ? ach.trophies.filter(x => x.earned) : []
        const rows: BoxRow[] = !ach
          ? [{ text: 'Loading...' }]
          : [
              { text: `Belt: ${ach.belt.toUpperCase()}  ·  ${ach.xp} XP  ·  streak ${ach.streak} day${ach.streak === 1 ? '' : 's'}  ·  trophies: ${got.length} of ${ach.trophies.length}` },
              ...ach.tracks.slice(0, 4).map(x => ({ text: `  ${x.name}: ${x.belt}, ${x.xp} XP${x.nextAt ? ` (next belt at ${x.nextAt})` : ''}`, dim: true })),
            ]
        const list = ach ? [...got, ...ach.trophies.filter(x => !x.earned)] : []
        return titled(
          'Achievements: pick a trophy to see it',
          <Box flexDirection="column">
            {rowsOf(rows.flatMap(r => wrap([r.text], W - 6).map(text => ({ ...r, text }))))}
            <Select
              key="trophies"
              autoFocus
              options={[...list.map(x => ({ value: x.id, label: `${x.earned ? '[x]' : '[ ]'} ${x.name.split(' — ')[0]}` })), back]}
              onSelect={v => (v === 'back' ? goBack() : update($, trophyView, () => v))}
            />
          </Box>,
        )
      }

      if (tab === 'settings') {
        const m = await read($, settings)
        const name = (id: string | null) => MODELS.find(([v]) => v === id)?.[1] || id || 'default'
        return titled(
          'Settings: how Claude writes your questions',
          <Box flexDirection="column">
            {rowsOf(wrap(['Claude writes technical questions about each change in the background, on your own plan. A bigger model or more effort writes harder questions and uses more of your plan.'], W - 6).map(text => ({ text, dim: true })))}
            <Select
              key="settings"
              autoFocus
              options={[
                { value: 'model', label: `Model:   ${name(m?.model ?? null)}   (Enter: next)` },
                { value: 'effort', label: `Effort:  ${m?.effort || 'low'}   (Enter: next)` },
                { value: 'enabled', label: `Claude writes questions: ${m?.enabled ? 'on' : 'off'}   (Enter: switch)` },
                back,
              ]}
              onSelect={async value => {
                if (value === 'back') return goBack()
                if (value === 'model') {
                  const k = MODELS.findIndex(([v]) => v === m?.model)
                  await setConfig($, 'model.model', MODELS[(k + 1) % MODELS.length][0])
                }
                if (value === 'effort') await setConfig($, 'model.effort', EFFORTS[(EFFORTS.indexOf(m?.effort || 'low') + 1) % EFFORTS.length])
                if (value === 'enabled') await setConfig($, 'model.enabled', m?.enabled ? 'false' : 'true')
                await goTab($, 'settings')
              }}
            />
          </Box>,
        )
      }

      if (tab === 'prepare') {
        const list = await read($, topics)
        const busyWith = await read($, preparing)
        return titled(
          'Prepare questions on a topic, for your next fights',
          <Box flexDirection="column">
            {rowsOf(
              wrap(
                [busyWith ? `Preparing questions on "${busyWith}"... (Claude writes and checks them; this takes a moment)` : 'Pick a topic, or type your own below (ctrl+x tab to reach the box). Claude writes the questions; without Claude they come from the question packs.'],
                W - 6,
              ).map(text => ({ text, dim: !busyWith })),
            )}
            <Select key="prepare" autoFocus options={[...list.map(x => ({ value: x, label: x })), back]} onSelect={value => (value === 'back' ? goBack() : prepare($, value))} />
            <Input key="topic" label="topic" placeholder="your own topic, e.g. Rust lifetimes" submitLabel="prepare" onSubmit={value => prepare($, value)} />
          </Box>,
        )
      }

      // The main screen
      const m = await read($, settings)
      return (
        <Box flexDirection="column">
          {draw([plain('', W), ...TITLE.map((l, n) => plain('   ' + l, W, n % 2 === t % 2 ? PALETTE.ink : PALETTE.mid, true)), plain('', W)])}
          {rule}
          <Select
            key="menu"
            label="Menu"
            autoFocus
            options={[
              { value: 'ladders', label: 'Fight           Easy, Medium, Hard, Professional, Endless' },
              { value: 'special', label: 'Special fights  No Mercy (SKYNET), Bug Hunter (FREE CHINESE LLM)' },
              { value: 'prepare', label: 'Prepare         questions on a topic, before you fight' },
              { value: 'scores', label: 'Scores          XP and accuracy across all your projects' },
              { value: 'achievements', label: 'Achievements    trophies, belts and records' },
              { value: 'settings', label: `Settings        model: ${MODELS.find(([v]) => v === m?.model)?.[1] || m?.model || '...'}, effort: ${m?.effort || 'low'}` },
            ]}
            onSelect={value => goTab($, value)}
          />
          {rule}
          {footer}
        </Box>
      )
    }

    // ---- game over / victory
    if (s.phase === 'gameover' || s.phase === 'victory') {
      const won = s.phase === 'victory'
      const id = s.noHealth ? (won ? 'player' : 'skynet') : won && s.mode === 'professional' ? 'evil' : !won && s.mode === BUG_HUNTER ? 'freellm' : 'player'
      const message = s.noHealth
        ? won
          ? `Claude finished your prompt, and you answered for all ${s.passed} of its edits. SKYNET falls!`
          : "SKYNET wins. Claude's edit was rejected and Claude stopped. Look at what it was doing, then face SKYNET again."
        : won
          ? `You cleared ${s.modeLabel}!${s.mode === 'professional' ? ' Evil Claude is defeated.' : s.mode === BUG_HUNTER ? ' FREE CHINESE LLM is defeated: no more "fixes".' : ''}`
          : 'Out of lives. Back to the first enemy with full health and 3 lives.'
      return (
        <Box flexDirection="column">
          {draw([plain('', W), plain(won ? '        V I C T O R Y' : '        G A M E   O V E R', W, won ? PALETTE.ink : PALETTE.hurt, true), plain('', W)])}
          {draw(spriteLines(id, t).map(l => pad(join([], l, 8), W)))}
          {rule}
          {rowsOf(wrap([message], W - 6).map(text => ({ text })))}
          <Select
            key="end"
            autoFocus
            options={[
              { value: 'again', label: s.noHealth ? 'Face SKYNET again (next prompt)' : won ? 'Fight this ladder again' : 'Try again' },
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
    const enemyHp = res && !res.intercept ? (a?.kind === 'enemyHit' ? lerp(res.enemyHpBefore, res.enemyHpAfter) : res.enemyHpAfter) : enemy.hp
    const playerHp = res && !res.intercept ? (a?.kind === 'playerHit' ? lerp(res.playerHpBefore, res.playerHpAfter) : res.playerHpAfter) : s.player.hp
    const sliding = i >= 0
    const lost = res && !res.intercept ? (a?.kind === 'enemyHit' ? res.enemyHpBefore - res.enemyHpAfter : res.playerHpBefore - res.playerHpAfter) : 0
    const field = battlefield({ view: s, width: W, tick: t, intro: sliding ? i : INTRO_STEPS, anim: a, enemyHp, playerHp, lost })

    let rows: BoxRow[] = []
    let control: unknown = null
    if (sliding) {
      rows = wrap([enemy.boss ? `${enemy.name} appears! The final battle begins!` : `${enemy.name} wants to fight!`], W - 6).map(text => ({ text }))
      control = <Select key="intro" autoFocus options={[{ value: 'go', label: 'Fight! (Enter)' }]} onSelect={() => endIntro($)} />
    } else if (res) {
      const lines: string[] = []
      if (res.intercept) lines.push(`${res.enemyName} intercepted Claude's edit${res.file ? ` to ${res.file}` : ''}!`)
      if (res.intercept && res.correct) lines.push(`Correct! The edit goes through. Edits passed: ${res.passed ?? 0}.${res.xp ? ` +${res.xp} XP` : ''}`)
      else if (res.intercept) lines.push(`Wrong! ${res.enemyName} rejects the edit and stops Claude. You lose.${res.correctKey ? ` (Claude wrote: ${res.correctKey})` : ''}`)
      else if (res.correct) lines.push(`Correct! ${res.playerName || 'You'} hits ${res.enemyName} for ${res.damage} tokens!${res.xp ? ` +${res.xp} XP` : res.xpCapped ? ' (daily practice XP limit reached: XP again tomorrow)' : ''}`)
      else if (res.enemyMissed) lines.push(`Wrong, it was ${res.correctKey}... but ${res.enemyName} missed!`)
      else lines.push(`Wrong, it was ${res.correctKey}! ${res.enemyName} hits ${res.playerName || 'You'} for ${res.enemyDamage} tokens!`)
      if (res.enemyDefeated && !res.victory) lines.push(`${res.enemyName} ran out of tokens! ${res.playerName || 'You'}'s tokens are restored.`)
      if (res.victory) lines.push(`${res.enemyName} is defeated! You cleared the ladder!`)
      if (res.lifeLost && !res.gameOver) lines.push(`${res.playerName || 'You'} ran out of tokens! One life lost, tokens restored.`)
      if (res.gameOver) lines.push('No lives left...')
      rows = lines.map(text => ({ text }))
      if (res.explanation) for (const x of wrap([res.explanation], W - 6).slice(0, 3)) rows.push({ text: x, dim: true })
      const done = !a || a.frame >= ANIM_FRAMES
      control = <Select key="continue" autoFocus options={[{ value: 'go', label: done ? 'Continue (Enter)' : '...' }]} onSelect={() => proceed($)} />
    } else if (q) {
      rows = wrap([`${enemy.name} asks: ${q.prompt}`], W - 6).map(text => ({ text }))
      if (q.location) rows.push({ text: `${q.family} · ${q.difficulty} · ${q.location}`, dim: true })
      if (q.code && q.code.split('\n').length <= 10) for (const c of q.code.split('\n')) rows.push({ text: '  ' + c, dim: true })
      control = (
        <Select
          key={`q-${q.id}`}
          autoFocus
          options={[
            ...Object.entries(q.choices).map(([k, val]) => ({ value: k, label: `${k}) ${val}` })),
            { value: RUN, label: 'RUN: end this battle and go back to the menu' },
          ]}
          onSelect={value => (value === RUN ? endFight($) : attack($, value))}
        />
      )
    } else {
      rows = s.noHealth
        ? wrap([`${enemy.name} is watching Claude${'.'.repeat((t % 3) + 1)} Every edit Claude makes for your prompt waits for your answer. Survive them all and SKYNET falls when Claude is done.`], W - 6).map(text => ({ text }))
        : [{ text: `${enemy.name} is thinking${'.'.repeat((t % 3) + 1)}` }]
      control = <Select key="run" options={[{ value: RUN, label: 'RUN: end this battle and go back to the menu' }]} onSelect={() => endFight($)} />
    }

    return (
      <Box flexDirection="column">
        {draw(field)}
        {rule}
        {rowsOf(rows)}
        {control}
        {rule}
      </Box>
    )
  })
}
