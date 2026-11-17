// DiffDojo No Mercy: a fight against SKYNET with no health bars on either side.
// While it is on (picked from the battle menu, or /nomercy), SKYNET intercepts
// every edit Claude makes for your prompt and asks one question about that exact
// change. Answer right and the edit goes through. Answer wrong (or close the
// question) and you lose: the edit is rejected and Claude's turn is stopped.
// When Claude finishes the prompt with every edit answered, SKYNET falls.
// Questions and grading come from the CLI (`diffdojo api gate`); the answer
// key never reaches this module. The fight itself is drawn by ./battle.

import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { BattleResult, BattleView } from '../types'
import { endFight, openBattle, showIntercept, showSkynet, showTurnEnd } from './battle'

type Engine = EngineInterface
type Gate = { id?: number; skip?: string; file?: string; prompt?: string; code?: string | null; options?: string[]; error?: string }
type Graded = {
  correct?: boolean
  xp?: number
  answerText?: string
  explanation?: string | null
  error?: string
  fight?: BattleResult & { state: BattleView }
}

// Kept up to date by ./battle from every fight state it sees.
const noMercy = atom({ plugin: 'diffdojo', key: 'noMercy' } as const, false)

const BOSS = 'SKYNET'

// MultiEdit only exists in some Claude Code versions; a pattern matches it where it does.
const GATED = /^(Edit|Write|MultiEdit)$/

// The main loop's running turn, so a wrong answer can stop it (a reload drops it).
let mainTurn: string | null = null

async function cli($: Engine, args: string[], stdin?: string): Promise<Record<string, any>> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/bin/diffdojo`, 'api', ...args], { timeoutMs: 120000, ...(stdin !== undefined ? { stdin } : {}) })
    return JSON.parse(r.stdout.trim().split('\n').pop() || '{}')
  } catch (err) {
    $.ui.log(`diffdojo no mercy: ${String(err)}`, { to: 'debug' })
    return { error: String(err) }
  }
}

/** Called from the plugin's one session.start hook. */
export async function noMercySessionStart($: Engine) {
  await $.command.register({ name: 'nomercy', description: 'DiffDojo No Mercy: fight SKYNET, who intercepts every edit Claude makes for your next prompt (off ends the fight)', argumentHint: '[off]' })
}

/**
 * Claude's main turn ended (called from the plugin's one turn.complete hook):
 * if every edit for the prompt was answered, SKYNET falls.
 */
export async function noMercyTurnComplete($: Engine, e: { agentId?: string; reason: string }) {
  if (e.agentId !== undefined || !(await read($, noMercy))) return
  const end = await cli($, ['battle-turn-end', e.reason])
  if (!end.victory || !end.state) return
  await showTurnEnd($, end.state as BattleView)
  $.ui.log(`DiffDojo No Mercy: Claude finished your prompt and you answered for all ${end.passed} of its edits. ${BOSS} falls!`)
  for (const t of end.trophies ?? []) $.ui.toast(`Trophy unlocked: ${t.name}`, { timeoutMs: 9000 })
}

export function registerNoMercy(on: On) {
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) mainTurn = e.turnId
    return next(e)
  })

  on('command.run', { command: 'nomercy' }, async ($, e) => {
    if ((e.args || '').trim().toLowerCase() === 'off') {
      await endFight($)
      return { text: `No Mercy is over: ${BOSS} is gone and Claude edits freely again.` }
    }
    await showSkynet($)
    await openBattle($, true)
    return { text: `${BOSS} is waiting in the battle pane. Read its warning, then pick Fight SKYNET.` }
  })

  on('tool.call', { tool: GATED }, async ($, e, next) => {
    if (!(await read($, noMercy))) return next(e)
    const g: Gate = await cli($, ['gate'], JSON.stringify(e))
    if (g.id === undefined || !g.options || g.options.length < 2) {
      if (g.skip || g.error) $.ui.log(`DiffDojo No Mercy: ${g.skip || g.error}; the edit goes through.`, { to: 'debug' })
      return next(e)
    }

    // The person's question, in Claude Code's own question dialog. Closing it counts as a wrong answer.
    let picked = ''
    try {
      const intro = `${BOSS} intercepts Claude's edit to ${g.file}!`
      picked = await $.ui.ask(g.code ? `${intro}\n\n${g.code}\n\n${g.prompt}` : `${intro}\n\n${g.prompt}`, { options: g.options, header: BOSS })
    } catch {
      picked = ''
    }
    const r: Graded = await cli($, ['gate-answer', String(g.id), picked])
    if (r.fight) await showIntercept($, r.fight, g.prompt || '')

    if (r.correct) {
      $.ui.toast(`Correct! Claude's edit to ${g.file} goes through${r.xp ? `  +${r.xp} XP` : ''}.`)
      return next(e)
    }

    $.ui.log(
      `DiffDojo No Mercy: ${picked ? 'wrong answer' : 'no answer'}. ${BOSS} wins: Claude's edit to ${g.file} was rejected and Claude was stopped.` +
        (r.answerText ? ` The answer was: ${r.answerText}.` : '') +
        (r.explanation ? ` ${r.explanation}` : ''),
    )
    const turnId = mainTurn
    if (turnId) void $.turn.abort({ turnId }).catch(() => undefined)
    return {
      deny:
        `DiffDojo No Mercy: the user answered the question about this edit incorrectly, so the edit to ${g.file} was rejected. ` +
        'Stop working now: do not retry this edit or make other changes. Wait for the user\'s next message.',
    }
  }).catch(($, e, next) => next(e)) // if the gate itself breaks, never block the person's work
}
