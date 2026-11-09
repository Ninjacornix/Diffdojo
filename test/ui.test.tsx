// Tests for the in-app UI (hooks/ui.tsx), run with `claude plugin test .`.
// The DiffDojo CLI is faked under `$.process.run`, so these never touch disk.
import { expect, test } from 'claude-code/testing'

const QUESTION = {
  id: 7,
  family: 'Code challenge',
  type: 'Seeded bug hunt',
  grading: 'verified',
  topic: 'python/mutation/boundary',
  difficulty: 'medium',
  xp: 20,
  est: 2,
  prompt: 'One line was changed in this copy of `due()`. Which line?',
  code: 'def due(self, now):\n    out = []\n    while self.jobs and self.jobs[0][0] < now:\n        out.append(1)\n    return out',
  location: 'sched.py:16-22',
  choices: null,
  format: 'line',
  hint: 'Line number',
  exam: false,
}
const CHOICE = {
  ...QUESTION,
  id: 8,
  family: 'Design',
  type: 'Data structure',
  prompt: '`jobs` is declared in sched.py:8. What is it?',
  code: null,
  choices: { a: 'dict', b: 'list used as a binary heap (heapq)', c: 'set', d: 'tuple' },
  format: 'choice',
  hint: 'Enter a letter',
}

/** A fake `diffdojo api` that records every call. */
function fakeCli(on: any, question: any, answer: Record<string, unknown> = {}) {
  const calls: string[][] = []
  let current = question
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? e[0] ?? []
    const args = argv.slice(argv.indexOf('api') + 1)
    calls.push(args)
    let body: Record<string, unknown> = { enabled: true, queued: current ? 1 : 0, header: 'White belt Python (20 / 150)' }
    if (args[0] === 'next' || args[0] === 'fill') body = { ...body, question: current }
    if (args[0] === 'battle-state') body = { ...body, battle: false, state: { phase: 'menu', mode: null } }
    if (args[0] === 'answer') {
      body = { ...body, queued: 0, correct: true, xp: 20, answerText: null, explanation: 'The boundary moved by one.', evidence: 'line 3', detail: null, feedback: null, trophies: [], ...answer }
      current = null
    }
    if (['skip', 'snooze', 'bad'].includes(args[0])) {
      current = null
      body = { ...body, ok: true, queued: 0 }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '' } }
  })
  return calls
}

const BAND = (surface: 'terminal' | 'desktop', isWorking: boolean) =>
  ({
    plugin: 'diffdojo',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking },
  }) as const

async function boot($: any, on: any) {
  on('command.register', () => ({ value: { command: 'dojo' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('while Claude works the band shows the question and grades a typed answer', async ($, on) => {
  const calls = fakeCli(on, QUESTION)
  await boot($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(surface, true) as any)
    expect((await ui.find({ type: 'Text', text: /Which line\?/ }))?.text).toContain('due()')
    expect(await ui.find({ key: 'answer' })).toBeTruthy()
    await ui.unmount()
  }
  const ui = await $.ui.mount(BAND('terminal', true) as any)
  await ui.input({ key: 'answer', text: '3' })
  expect(calls.some(c => c[0] === 'answer' && c[1] === '7' && c[2] === '3')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Correct/ }))?.text).toContain('+20 XP')
  expect(await ui.find({ type: 'Text', text: /boundary moved/ })).toBeTruthy()
  await ui.unmount()
})

test('the band stays out of the way when Claude is idle', async ($, on) => {
  fakeCli(on, QUESTION)
  await boot($, on)
  const ui = await $.ui.mount(BAND('terminal', false) as any)
  expect(await ui.find({ type: 'Text', text: /Which line/ })).toBeFalsy()
  await ui.unmount()
})

test('multiple choice is answered with one press', async ($, on) => {
  const calls = fakeCli(on, CHOICE)
  await boot($, on)
  const ui = await $.ui.mount(BAND('terminal', true) as any)
  await ui.press({ key: 'c-b' })
  expect(calls.some(c => c[0] === 'answer' && c[1] === '8' && c[2] === 'b')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Correct/ })).toBeTruthy()
  await ui.unmount()
})

test('skip moves on, and the pane shows the full question', async ($, on) => {
  const calls = fakeCli(on, QUESTION)
  await boot($, on)
  const pane = await $.ui.mount({
    plugin: 'diffdojo',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'diffdojo',
    props: { title: 'DiffDojo', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as any)
  expect(await pane.find({ type: 'Text', text: /Seeded bug hunt/ })).toBeTruthy()
  await pane.press({ key: 'p-skip' })
  expect(calls.some(c => c[0] === 'skip' && c[1] === '7')).toBe(true)
  expect(await pane.find({ type: 'Text', text: /No questions queued/ })).toBeTruthy()
  await pane.unmount()
})

// ---------------- battle mode ----------------

const FIGHT = {
  mode: 'easy', modeLabel: 'Easy', phase: 'fight', stage: 0, stages: 3, wave: 1, lives: 3, maxLives: 3,
  player: { name: 'YOU', hp: 100, maxHp: 100 },
  enemy: { id: 'typo', name: 'TYPO SPRITE', level: 3, hp: 60, maxHp: 60, boss: false, color: null },
  best: {}, wins: {}, hasQuestion: true,
}
const BQ = { id: 11, prompt: 'Which search finds shortest paths in an unweighted graph?', code: null, choices: { a: 'DFS', b: 'BFS', c: 'Topological sort', d: 'Dijkstra with negative weights' }, type: 'pack', family: 'questionnaire', difficulty: 'easy', location: null }

function fakeBattle(on: any) {
  const calls: string[][] = []
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? e[0] ?? []
    const args = argv.slice(argv.indexOf('api') + 1)
    calls.push(args)
    let body: Record<string, unknown> = { enabled: true, queued: 0, header: '' }
    if (args[0] === 'battle-state') body = { ...body, battle: true, state: { ...FIGHT, phase: 'menu', mode: null, enemy: null } }
    if (args[0] === 'battle-start') body = { state: FIGHT }
    if (args[0] === 'battle-question') body = { question: BQ, state: FIGHT }
    if (args[0] === 'battle-answer')
      body = {
        correct: args[1] === 'b', correctKey: 'b', xp: 5, explanation: 'BFS explores by distance.', enemyName: 'TYPO SPRITE', playerName: 'MILAN',
        damage: 35, enemyDamage: 15, enemyHpBefore: 60, enemyHpAfter: 25, playerHpBefore: 100, playerHpAfter: args[1] === 'b' ? 100 : 85,
        trophies: [], state: { ...FIGHT, enemy: { ...FIGHT.enemy, hp: 25 } },
      }
    return { value: { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '' } }
  })
  return calls
}

const BATTLE_PANE = {
  plugin: 'diffdojo',
  component: 'Pane',
  requestId: 'dojo-battle',
  props: { title: 'DiffDojo Battle', isFocused: true, bodyColumns: 90, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('battle: pick a mode, fight with arrows + Enter, see the hit, continue', async ($, on) => {
  const calls = fakeBattle(on)
  await boot($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BATTLE_PANE, surface } as any)
    expect(await ui.find({ key: 'mode' })).toBeTruthy()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await ui.select({ key: 'mode', value: 'easy' })
  expect(await ui.find({ type: 'Text', text: /TYPO SPRITE wants to fight!/ })).toBeTruthy()
  await ui.select({ key: 'intro', value: 'go' }) // skip the slide-in
  await ui.select({ key: 'intro', value: 'go' }) // continue
  expect(calls.some(c => c[0] === 'battle-start' && c[1] === 'easy')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /TYPO SPRITE asks/ })).toBeTruthy()
  expect(await ui.find({ key: 'q-11' })).toBeTruthy()
  await ui.select({ key: 'q-11', value: 'b' })
  expect(calls.some(c => c[0] === 'battle-answer' && c[1] === 'b')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /MILAN hits TYPO SPRITE for 35/ }))?.text).toContain('+5 XP')
  await ui.select({ key: 'continue', value: 'go' })
  expect(await ui.find({ key: 'q-11' })).toBeTruthy()
  await ui.unmount()
})

test('battle: a wrong answer shows the enemy striking back', async ($, on) => {
  fakeBattle(on)
  await boot($, on)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await ui.select({ key: 'mode', value: 'easy' })
  expect(await ui.find({ type: 'Text', text: /TYPO SPRITE wants to fight!/ })).toBeTruthy()
  await ui.select({ key: 'intro', value: 'go' }) // skip the slide-in
  await ui.select({ key: 'intro', value: 'go' }) // continue
  await ui.select({ key: 'q-11', value: 'a' })
  expect(await ui.find({ type: 'Text', text: /Wrong, it was b! TYPO SPRITE hits MILAN for 15/ })).toBeTruthy()
  await ui.unmount()
})
