// DiffDojo No Mercy: every edit Claude makes waits for one question about that
// exact change, asked by No Mercy's boss, SKYNET, who stands between Claude and
// your files.
//
// exact change. Answer right and the edit goes through; answer wrong (or close
// the question) and the edit is rejected and Claude's turn is stopped.
// The question and its grading come from the CLI (`diffdojo api gate`); the
// answer key never reaches this module.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

type Engine = EngineInterface
type Gate = { id?: number; skip?: string; file?: string; prompt?: string; code?: string | null; options?: string[]; error?: string }
type Graded = { correct?: boolean; xp?: number; answerText?: string; explanation?: string | null; error?: string }

const noMercy = atom({ plugin: 'diffdojo', key: 'noMercy' } as const, false)

// MultiEdit only exists in some Claude Code versions; a pattern matches it where it does.
// No Mercy's boss: it guards every edit.
const BOSS = 'SKYNET'

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

/** Turn No Mercy on or off (the /nomercy command and the battle menu); returns what to tell the person. */
export async function setNoMercy($: Engine, want: boolean): Promise<string> {
  await $.process.run(['node', `${$.plugin.root}/bin/diffdojo`, 'config', 'set', 'noMercy', want ? 'true' : 'false', '--global'])
  await update($, noMercy, () => want)
  $.ui.status(want ? `DiffDojo: NO MERCY · ${BOSS} is watching` : undefined)
  return want
    ? `No Mercy is on. ${BOSS} now guards your files: before each of Claude's edits it asks you a question about the change. Right: you beat it and the edit goes through. Wrong: ${BOSS} rejects the edit and Claude stops. /nomercy off to end it.`
    : 'No Mercy is off: Claude\'s edits go through without a question.'
}

/** Called from the plugin's one session.start hook. */
export async function noMercySessionStart($: Engine) {
  await $.command.register({ name: 'nomercy', description: 'DiffDojo No Mercy: answer a question about each of Claude\'s edits before it is applied (on | off)', argumentHint: '[on|off]' })
  const s = await cli($, ['status'])
  if (s.noMercy !== undefined) await update($, noMercy, () => !!s.noMercy)
  if (s.noMercy) $.ui.status(`DiffDojo: NO MERCY · ${BOSS} is watching`)
}

export function registerNoMercy(on: On) {
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) mainTurn = e.turnId
    return next(e)
  })

  on('command.run', { command: 'nomercy' }, async ($, e) => {
    const arg = (e.args || '').trim().toLowerCase()
    const want = arg === 'on' ? true : arg === 'off' ? false : !(await read($, noMercy))
    return { text: await setNoMercy($, want) }
  })

  {
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

      if (r.correct) {
        $.ui.toast(`Correct! ${BOSS} is beaten${r.xp ? `  +${r.xp} XP` : ''}. Claude's edit to ${g.file} goes through.`)
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
}
