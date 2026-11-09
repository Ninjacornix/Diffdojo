// DiffDojo inside Claude Code: while Claude works, the current question is
// drawn in a band right above the prompt, with its answer controls; `/dojo`
// opens a pane with the full question and its code. A status-line counter and
// a toast say when new questions arrive. Nothing here reaches Claude's
// conversation: questions and answers go through the local DiffDojo CLI.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DojoQuestion, DojoResult } from '../types'
import { battleSessionStart, openBattle, registerBattle } from './battle'

const PANE = 'diffdojo'
const KEYS = ['a', 'b', 'c', 'd', 'e', 'f']

const current = atom({ plugin: 'diffdojo', key: 'current' } as const, null, { shape: 'question-1' })
const result = atom({ plugin: 'diffdojo', key: 'result' } as const, null, { shape: 'result-1' })
const queued = atom({ plugin: 'diffdojo', key: 'queued' } as const, 0)
const header = atom({ plugin: 'diffdojo', key: 'header' } as const, '')
const enabled = atom({ plugin: 'diffdojo', key: 'enabled' } as const, false)
const working = atom({ plugin: 'diffdojo', key: 'working' } as const, false)
const isHidden = atom({ plugin: 'diffdojo', key: 'isHidden' } as const, false)
// The same value hooks/battle.tsx owns: whether fights replace the plain question box.
const battleOn = atom({ plugin: 'diffdojo', key: 'battleOn' } as const, true)
const isBusy = atom({ plugin: 'diffdojo', key: 'isBusy' } as const, false)

type Api = {
  enabled?: boolean
  queued?: number
  header?: string
  question?: DojoQuestion | null
  error?: string
  added?: number
} & Partial<Omit<DojoResult, 'questionId'>>

type Engine = EngineInterface

// The module's own timers and counters (they start over on a reload).
let poll: { cancel: () => void } | null = null
let lastQueued = -1


async function api($: Engine, args: string[]): Promise<Api> {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/bin/diffdojo`, 'api', ...args], { timeoutMs: 300000 })
    const line = r.stdout.trim().split('\n').pop() || '{}'
    return JSON.parse(line) as Api
  } catch (err) {
    $.ui.log(`diffdojo: ${String(err)}`, { to: 'debug' })
    return { error: String(err) }
  }
}

async function apply($: Engine, s: Api) {
  if (s.enabled !== undefined) await update($, enabled, () => !!s.enabled)
  if (s.header !== undefined) await update($, header, () => s.header || '')
  if (s.queued !== undefined) {
    const n = s.queued
    await update($, queued, () => n)
    if (s.enabled) {
      $.ui.status(n > 0 ? `🥋 DiffDojo: ${n} question${n === 1 ? '' : 's'} · /dojo` : undefined)
      if (lastQueued >= 0 && n > lastQueued) $.ui.toast(`🥋 ${n - lastQueued} new DiffDojo question${n - lastQueued === 1 ? '' : 's'} about Claude's change`)
    } else $.ui.status(undefined)
    lastQueued = n
  }
}

async function refresh($: Engine) {
  const s = await api($, ['next'])
  if (s.error) return
  await apply($, s)
  // Keep a result on screen until the person moves on; otherwise show the next question.
  if (!(await read($, result))) await update($, current, () => s.question ?? null)
}

async function next($: Engine) {
  await update($, result, () => null)
  await refresh($)
}

async function submit($: Engine, q: DojoQuestion, response: string) {
  if (await read($, isBusy)) return
  await update($, isBusy, () => true)
  try {
    const r = await api($, ['answer', String(q.id), response])
    if (r.error) {
      $.ui.toast(`DiffDojo: ${r.error}`)
      return
    }
    await apply($, { ...r, question: undefined })
    await update($, result, () => ({
      questionId: q.id,
      correct: r.correct ?? null,
      xp: r.xp ?? 0,
      answerText: r.answerText ?? null,
      explanation: r.explanation ?? null,
      evidence: r.evidence ?? null,
      detail: r.detail ?? null,
      feedback: r.feedback ?? null,
      trophies: r.trophies ?? [],
    }))
    for (const t of r.trophies ?? []) $.ui.toast(`🏆 Trophy unlocked: ${t.name}`, { timeoutMs: 8000 })
  } finally {
    await update($, isBusy, () => false)
  }
}

async function act($: Engine, q: DojoQuestion, what: 'skip' | 'snooze' | 'bad') {
  await api($, [what, String(q.id)])
  await next($)
}

export const register: Register = on => {
  registerBattle(on)

  on('session.start', async ($, e, nextHook) => {
    const started = await nextHook(e)
    await $.command.register({ name: 'dojo', description: 'Open the DiffDojo quiz pane (questions about what Claude just wrote)' })
    await battleSessionStart($)
    void refresh($)
    return started
  })

  on('command.run', { command: 'dojo' }, async $ => {
    await update($, isHidden, () => false)
    await refresh($)
    await $.ui.open({ id: PANE, title: 'DiffDojo', focus: true })
    return { text: 'DiffDojo pane opened.' }
  })

  // Claude starts working: make sure there is something to answer, and watch
  // for new questions the background worker adds.
  on('prompt.submit', async ($, e, nextHook) => {
    const r = await nextHook(e)
    await update($, working, () => true)
    if ((await read($, battleOn)) && (await read($, enabled))) void openBattle($, true)
    void (async () => {
      const s = await api($, ['fill'])
      if (!s.error) await apply($, s)
      await refresh($)
    })()
    poll?.cancel()
    poll = $.clock.every(15000, () => refresh($))
    return r
  })

  on('turn.complete', async ($, e, nextHook) => {
    const r = await nextHook(e)
    await update($, working, () => false)
    poll?.cancel()
    // Questions about this turn are generated in the background over the next ~10-60 s.
    poll = $.clock.every(20000, () => refresh($))
    $.clock.after(90000, () => {
      poll?.cancel()
      poll = null
    })
    return r
  })

  // ---- the band above the prompt (shown while Claude works) ----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, nextHook) => {
    const q = await read($, current)
    const res = await read($, result)
    const busy = e.props.isWorking || (await read($, working))
    const on_ = await read($, enabled)
    if ((await read($, battleOn)) || e.props.hasSurvey || !on_ || (await read($, isHidden)) || !q || (!busy && !res)) return nextHook(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)

    if (res && res.questionId === q.id) {
      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold color={res.correct === false ? 'red' : 'green'}>
            {res.correct === true ? `✓ Correct${res.xp ? `  +${res.xp} XP` : ''}` : res.correct === false ? '✗ Not quite' : 'Saved.'}
            {res.answerText ? <Text color="white">{`  answer: ${res.answerText}`}</Text> : null}
          </Text>
          {res.detail ? <Text dimColor wrap="truncate-end">{res.detail.split('\n')[0]}</Text> : null}
          {res.explanation ? <Text wrap="wrap">{res.explanation}</Text> : null}
          {res.feedback ? <Text color="cyan">{`Feedback: ${res.feedback}`}</Text> : null}
          <Box>
            <Button key="next" label="Next question" hotkey="1" onPress={() => next($)} />
            <Text> </Text>
            <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
          </Box>
        </Box>
      )
    }

    const codeLines = q.code ? q.code.split('\n') : []
    const choiceKeys = q.choices ? Object.keys(q.choices) : []
    const pressable = !!q.choices && (q.format === 'choice' || q.format === 'multiple_choice')
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text>
          <Text bold color="cyan">🥋 DiffDojo</Text>
          <Text dimColor>{` · ${q.family} · ${q.type} · ${q.grading}${q.xp ? ` · ${q.xp} XP` : ''}${q.location ? ` · ${q.location}` : ''}`}</Text>
        </Text>
        <Text wrap="wrap">{q.prompt}</Text>
        {codeLines.length > 0 && codeLines.length <= 14 ? <Text dimColor>{q.code}</Text> : null}
        {codeLines.length > 14 ? <Text dimColor>{`(${codeLines.length} lines of code — /dojo to see them)`}</Text> : null}
        {pressable
          ? choiceKeys.map((k, i) => (
              <Button key={`c-${k}`} hotkey={String(i + 1)} onPress={() => submit($, q, k)}>
                {`${k}) ${q.choices![k]}`}
              </Button>
            ))
          : q.choices
            ? choiceKeys.map(k => <Text key={`t-${k}`}>{`  ${k}) ${q.choices![k]}`}</Text>)
            : null}
        {!pressable ? (
          <Input
            key="answer"
            label="answer"
            placeholder={`${q.hint} (ctrl+x tab to type here)`}
            rows={q.format === 'text' ? 2 : 1}
            submitLabel="answer"
            onSubmit={value => submit($, q, value)}
          />
        ) : null}
        <Box>
          <Text dimColor>{pressable ? 'Press 1-' + choiceKeys.length + ' in the empty prompt · ' : ''}</Text>
          <Button key="skip" label="Skip" onPress={() => act($, q, 'skip')} />
          <Text> </Text>
          <Button key="snooze" label="Snooze" onPress={() => act($, q, 'snooze')} />
          <Text> </Text>
          <Button key="bad" label="Bad question" onPress={() => act($, q, 'bad')} />
          <Text> </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })

  // ---- the pane: the full question, code included ----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Code } = $.ui.resolve(e)
    const q = await read($, current)
    const res = await read($, result)
    const head = await read($, header)
    if (!(await read($, enabled))) {
      return (
        <Box flexDirection="column">
          <Text>DiffDojo isn't enabled for this project.</Text>
          <Text dimColor>Run /diffdojo:start to turn it on.</Text>
        </Box>
      )
    }
    if (!q) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{head}</Text>
          <Text>No questions queued yet.</Text>
          <Text dimColor>They appear after Claude changes code. Concept questions are added when you send a prompt.</Text>
          <Button key="refresh" label="Check again" onPress={() => refresh($)} />
        </Box>
      )
    }
    const isAnswered = !!res && res.questionId === q.id
    return (
      <Box flexDirection="column">
        <Text dimColor>{head}</Text>
        <Text bold color="cyan">{`[${q.family} · ${q.type} · ${q.grading}]`}</Text>
        <Text dimColor>{`${q.topic || 'general'} · ${q.difficulty} · ~${q.est} min${q.xp ? ` · ${q.xp} XP` : ''}${q.location ? ` · ${q.location}` : ''}`}</Text>
        {q.selectedBy ? <Text dimColor>{`selected by ${q.selectedBy}`}</Text> : null}
        <Text wrap="wrap">{q.prompt}</Text>
        {q.code ? <Code source={q.code} /> : null}
        {q.choices
          ? Object.entries(q.choices).map(([k, v], i) =>
              !isAnswered && (q.format === 'choice' || q.format === 'multiple_choice') ? (
                <Button key={`p-${k}`} hotkey={String(i + 1)} onPress={() => submit($, q, k)}>{`${k}) ${v}`}</Button>
              ) : (
                <Text key={`pt-${k}`}>{`  ${k}) ${v}`}</Text>
              ),
            )
          : null}
        {!isAnswered && !(q.choices && (q.format === 'choice' || q.format === 'multiple_choice')) ? (
          <Input key="p-answer" label="answer" placeholder={q.hint} rows={q.format === 'text' ? 3 : 1} autoFocus submitLabel="answer" onSubmit={value => submit($, q, value)} />
        ) : null}
        {isAnswered ? (
          <Box flexDirection="column">
            <Text bold color={res!.correct === false ? 'red' : 'green'}>
              {res!.correct === true ? `✓ Correct${res!.xp ? `  +${res!.xp} XP` : ''}` : res!.correct === false ? '✗ Not quite' : 'Saved.'}
            </Text>
            {res!.answerText ? <Text>{`Answer: ${res!.answerText}`}</Text> : null}
            {res!.detail ? <Text dimColor>{res!.detail}</Text> : null}
            {res!.explanation ? <Text color="yellow" wrap="wrap">{res!.explanation}</Text> : null}
            {res!.evidence ? <Text dimColor wrap="wrap">{`Evidence: ${res!.evidence}`}</Text> : null}
            {res!.feedback ? <Text color="cyan" wrap="wrap">{`Feedback (no XP): ${res!.feedback}`}</Text> : null}
            <Button key="p-next" label="Next question" hotkey="n" onPress={() => next($)} />
          </Box>
        ) : (
          <Box>
            <Button key="p-skip" label="Skip" hotkey="s" onPress={() => act($, q, 'skip')} />
            <Text> </Text>
            <Button key="p-snooze" label="Snooze" hotkey="z" onPress={() => act($, q, 'snooze')} />
            <Text> </Text>
            <Button key="p-bad" label="Bad question" hotkey="b" onPress={() => act($, q, 'bad')} />
          </Box>
        )}
      </Box>
    )
  })
}
