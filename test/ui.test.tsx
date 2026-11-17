// Tests for the in-app UI (hooks/ui.tsx), run with `claude plugin test .`.
// The DiffDojo CLI is faked under `$.process.run`, so these never touch disk.
import { expect, mock, test } from 'claude-code/testing'

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

/** Starts a session; `toasts` collects what the plugin toasted. Settles the start's background sync. */
async function boot($: any, on: any, toasts: string[] = [], { placed = true } = {}) {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'dojo' } }))
  on('ui.open', () => ({ value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'test: no pane' } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(String(e.text ?? ''))
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
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
    if (args[0] === 'battle-quit') body = { state: { ...FIGHT, phase: 'menu', mode: null, enemy: null } }
    if (args[0] === 'achievements')
      body = { belt: 'yellow', xp: 210, streak: 3, tracks: [{ name: 'C++', belt: 'yellow', xp: 210, nextAt: 400 }], battle: { wins: {}, best: {} },
        trophies: [{ id: 'skynet', name: 'Judgment Averted — defeated SKYNET in No Mercy', earned: true, at: '2026-11-17' }, { id: 'evil-claude', name: 'Evil Claude Defeated', earned: false, at: null }] }
    if (args[0] === 'settings') body = { enabled: true, model: 'claude-haiku-5-5', effort: 'low', perHour: 30 }
    if (args[0] === 'scores')
      body = { belt: 'yellow', xp: 1240, xpToday: 60, streak: 4, answered: 312, accuracy: 78, trophies: 3, battle: { wins: {}, best: {} },
        projects: [{ name: 'sranja', path: 'C:/Users/m/sranja', xp: 900, answered: 200, accuracy: 81, last: null, here: true }, { name: 'Diffdojo', path: '/x/Diffdojo', xp: 340, answered: 112, accuracy: 72, last: null, here: false }] }
    if (args[0] === 'topics') body = { topics: ['C++', 'epoll and non-blocking sockets'] }
    if (args[0] === 'share-preview') body = { text: '# DiffDojo score\n\n**1,240 XP** · yellow belt\n', shared: null }
    if (args[0] === 'share') body = { id: 'abc123', url: 'https://gist.github.com/me/abc123', created: true }
    if (args[0] === 'prepare') body = { added: 6, via: 'claude', topic: args.slice(1).join(' ') }
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


/** Pick a fight from the menu: main screen, then the Fight or Special fights screen. */
async function pick(ui: any, mode: string) {
  await ui.select({ key: 'menu', value: ['nomercy', 'bughunter', 'rush'].includes(mode) ? 'special' : 'ladders' })
  await ui.select({ key: 'mode', value: mode })
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
    expect(await ui.find({ key: 'menu' })).toBeTruthy()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await pick(ui, 'easy')
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
  await pick(ui, 'easy')
  expect(await ui.find({ type: 'Text', text: /TYPO SPRITE wants to fight!/ })).toBeTruthy()
  await ui.select({ key: 'intro', value: 'go' }) // skip the slide-in
  await ui.select({ key: 'intro', value: 'go' }) // continue
  await ui.select({ key: 'q-11', value: 'a' })
  expect(await ui.find({ type: 'Text', text: /Wrong, it was b! TYPO SPRITE hits MILAN for 15/ })).toBeTruthy()
  await ui.unmount()
})

// ---------------- battle outside a git repository ----------------

/** The CLI as it answers in a folder with no git: no repo, but battles allowed. */
function fakeNoGit(on: any, { startState = FIGHT as unknown } = {}) {
  const calls: string[][] = []
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? e[0] ?? []
    const args = argv.slice(argv.indexOf('api') + 1)
    calls.push(args)
    let body: Record<string, unknown> = { enabled: false, battleAllowed: true, queued: 0, header: '' }
    if (args[0] === 'battle-state') body = { ...body, battle: true, state: { ...FIGHT, phase: 'menu', mode: null, enemy: null } }
    if (args[0] === 'battle-start') body = startState ? { state: startState } : {}
    if (args[0] === 'battle-question') body = { question: BQ, state: FIGHT }
    return { value: { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '' } }
  })
  return calls
}

test('battle: a prompt opens the fight even outside a git repository', async ($, on) => {
  fakeNoGit(on)
  const opened: any[] = []
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'dojo' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_: unknown, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.prompt.submit({ text: 'can you make simple a star bfs etc' })
  await clock.settle()
  expect(opened.some(o => o.id === 'dojo-battle')).toBe(true)
  // A slash command does not open it a second time on its own.
  opened.length = 0
  await $.prompt.submit({ text: '/dojo', command: { name: 'dojo', args: '' } } as any)
  await clock.settle()
  expect(opened.some(o => o.id === 'dojo-battle')).toBe(false)
})

test('battle: a failed start stays on the menu with a toast instead of silently resetting', async ($, on) => {
  fakeNoGit(on, { startState: null })
  const toasts: string[] = []
  await boot($, on, toasts)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await pick(ui, 'easy')
  expect(toasts.some(t => /could not start/.test(t))).toBe(true)
  expect(await ui.find({ key: 'mode' })).toBeTruthy()
  await ui.unmount()
})

test('battle: picking a mode outside a git repository starts the fight', async ($, on) => {
  const calls = fakeNoGit(on)
  await boot($, on)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await pick(ui, 'endless')
  expect(calls.some(c => c[0] === 'battle-start' && c[1] === 'endless')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /TYPO SPRITE wants to fight!/ })).toBeTruthy()
  await ui.unmount()
})

// ---------------- No Mercy: the fight against SKYNET ----------------

const SKYNET_FIGHT = {
  mode: 'nomercy', modeLabel: 'No Mercy', phase: 'fight', stage: 0, stages: 1, wave: 1, lives: 3, maxLives: 3,
  player: { name: 'MILAN', hp: 100, maxHp: 100 },
  enemy: { id: 'skynet', name: 'SKYNET', level: 100, hp: 1, maxHp: 1, boss: true, color: '#e0533d' },
  best: {}, wins: {}, hasQuestion: false, noHealth: true, passed: 0,
}

/** The CLI with a SKYNET fight on (or not): one gate whose right answer is "heap". */
function fakeGate(on: any, { fighting = true, gate = true } = {}) {
  const calls: string[][] = []
  let phase = fighting ? 'fight' : 'menu'
  let passed = 0
  const state = () => (phase === 'menu' ? { ...SKYNET_FIGHT, phase: 'menu', mode: null, enemy: null } : { ...SKYNET_FIGHT, phase, passed })
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? e[0] ?? []
    const args = argv.slice(argv.indexOf('api') + 1)
    calls.push(args)
    let body: Record<string, unknown> = { enabled: true, battleAllowed: true, queued: 0, header: '', noMercy: phase === 'fight' }
    if (args[0] === 'battle-state') body = { ...body, battle: true, state: state() }
    if (args[0] === 'battle-start' && args[1] === 'nomercy') {
      phase = 'fight'
      passed = 0
      body = { state: state() }
    }
    if (args[0] === 'battle-quit') {
      phase = 'menu'
      body = { state: state() }
    }
    if (args[0] === 'gate')
      body = gate
        ? { id: 42, file: 'sched.py', prompt: 'What is `jobs`?', code: 'heapq.heappush(self.jobs, job)', options: ['dict', 'heap', 'set', 'tuple'] }
        : { skip: 'no question for README.md (not code)' }
    if (args[0] === 'gate-answer') {
      const correct = args[2] === 'heap'
      if (correct) passed++
      else phase = 'gameover'
      body = { ...body, correct, xp: 10, answerText: 'heap', explanation: 'heapq keeps the list a binary heap.',
        fight: { intercept: true, correct, passed, file: 'sched.py', enemyName: 'SKYNET', playerName: 'MILAN', trophies: [], defeat: !correct, state: state() } }
    }
    if (args[0] === 'battle-turn-end') {
      const won = phase === 'fight' && args[1] === 'answer' && passed > 0
      if (won) phase = 'victory'
      body = { victory: won, passed, trophies: won ? [{ id: 'skynet', name: 'Judgment Averted' }] : [], state: state() }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '' } }
  })
  return calls
}

/** Answers the question dialog with `label`; records whether the edit itself ran. */
function person(on: any, label: string | null) {
  const seen = { asked: [] as string[], applied: false }
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    const q = e.questions[0]
    seen.asked.push(q.question)
    if (label === null) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: label } } }
  })
  on('tool.call', { tool: 'Edit' }, () => {
    seen.applied = true
    return { result: { filePath: '/p/sched.py' } }
  })
  return seen
}

const EDIT = { tool: 'Edit', file_path: '/p/sched.py', old_string: 'x = 1', new_string: 'x = 2' }

test('no mercy (dialog fallback): a right answer lets the edit through', async ($, on) => {
  const calls = fakeGate(on)
  const seen = person(on, 'heap')
  await boot($, on, [], { placed: false })
  const r: any = await $.tool.call(EDIT as any)
  expect(seen.asked[0]).toContain('What is `jobs`?')
  expect(seen.asked[0]).toContain('heapq.heappush')
  expect(seen.asked[0]).toContain('SKYNET intercepts')
  expect(calls.some(c => c[0] === 'gate-answer' && c[1] === '42' && c[2] === 'heap')).toBe(true)
  expect(seen.applied).toBe(true)
  expect(r.deny).toBeUndefined()
})

test('no mercy (dialog fallback): one wrong answer rejects the edit, tells Claude to stop and ends the fight', async ($, on) => {
  fakeGate(on)
  const seen = person(on, 'dict')
  await boot($, on, [], { placed: false })
  const r: any = await $.tool.call(EDIT as any)
  expect(seen.applied).toBe(false)
  expect(String(r.deny ?? r.text)).toContain('Stop working')
  // The fight is over: the next edit goes through without a question.
  seen.asked.length = 0
  await $.tool.call(EDIT as any)
  expect(seen.asked.length).toBe(0)
  expect(seen.applied).toBe(true)
})

test('no mercy (dialog fallback): skipping the question counts as wrong', async ($, on) => {
  fakeGate(on)
  const seen = person(on, null)
  await boot($, on, [], { placed: false })
  const r: any = await $.tool.call(EDIT as any)
  expect(seen.applied).toBe(false)
  expect(String(r.deny ?? r.text)).toContain('rejected')
})

test('no mercy: without a SKYNET fight, edits are never stopped', async ($, on) => {
  const calls = fakeGate(on, { fighting: false })
  const seen = person(on, 'heap')
  await boot($, on)
  await $.tool.call(EDIT as any)
  expect(seen.asked.length).toBe(0)
  expect(seen.applied).toBe(true)
  expect(calls.some(c => c[0] === 'gate')).toBe(false)
})

test('no mercy: an edit DiffDojo has no question for goes through', async ($, on) => {
  fakeGate(on, { gate: false })
  const seen = person(on, 'heap')
  await boot($, on)
  await $.tool.call(EDIT as any)
  expect(seen.asked.length).toBe(0)
  expect(seen.applied).toBe(true)
})

/** Starts an edit, answers SKYNET's question in the battle pane with `label`, and returns the edit's result. */
async function answerInPane($: any, label: string) {
  const call = $.tool.call(EDIT as any)
  const pane = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  let found: any = null
  for (let i = 0; i < 50 && !found; i++) {
    found = await pane.find({ key: 'gate-42' })
    if (!found) await new Promise(r => setTimeout(r, 10))
  }
  expect(found).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /SKYNET intercepts Claude's edit to sched\.py/ })).toBeTruthy()
  await pane.select({ key: 'gate-42', value: String(['dict', 'heap', 'set', 'tuple'].indexOf(label)) })
  const r = await call
  await pane.unmount()
  return r
}

test('no mercy: SKYNET asks in the battle pane, not in the chat; a right answer lets the edit through', async ($, on) => {
  const calls = fakeGate(on)
  const seen = person(on, 'heap')
  await boot($, on)
  const r: any = await answerInPane($, 'heap')
  expect(seen.asked.length).toBe(0) // the question dialog was never used
  expect(calls.some(c => c[0] === 'gate-answer' && c[1] === '42' && c[2] === 'heap')).toBe(true)
  expect(seen.applied).toBe(true)
  expect(r.deny).toBeUndefined()
})

test('no mercy: a wrong answer in the pane rejects the edit and SKYNET wins', async ($, on) => {
  fakeGate(on)
  const seen = person(on, 'heap')
  await boot($, on)
  const r: any = await answerInPane($, 'dict')
  expect(seen.applied).toBe(false)
  expect(String(r.deny ?? r.text)).toContain('Stop working')
})

test('no mercy: closing the pane while SKYNET asks moves the question to the dialog', async ($, on) => {
  fakeGate(on)
  const seen = person(on, 'heap')
  await boot($, on)
  const call = $.tool.call(EDIT as any)
  const pane = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  for (let i = 0; i < 50 && !(await pane.find({ key: 'gate-42' })); i++) await new Promise(r => setTimeout(r, 10))
  await pane.unmount()
  await $.command.run({ command: 'battle', args: 'off' } as any) // closes the battle pane
  const r: any = await call
  expect(seen.asked.length).toBe(1)
  expect(seen.applied).toBe(true)
  expect(r.deny).toBeUndefined()
})

test('no mercy: SKYNET falls when Claude finishes the prompt with every edit answered', async ($, on) => {
  const calls = fakeGate(on)
  person(on, 'heap')
  on('turn.complete', () => ({ text: 'done' }))
  await boot($, on)
  await answerInPane($, 'heap')
  await answerInPane($, 'heap')
  const pane = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  expect(calls.some(c => c[0] === 'battle-turn-end' && c[1] === 'answer')).toBe(true)
  expect(await pane.find({ type: 'Text', text: /V I C T O R Y/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /SKYNET falls/ })).toBeTruthy()
  await pane.unmount()
})

test('no mercy: /nomercy shows SKYNET and its warning; /nomercy off ends the fight', async ($, on) => {
  const calls = fakeGate(on, { fighting: false })
  person(on, 'heap')
  await boot($, on)
  const r: any = await $.command.run({ command: 'nomercy', args: '' } as any)
  expect(String(r.text)).toContain('Fight SKYNET')
  const pane = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  expect(await pane.find({ type: 'Text', text: /SKYNET guards your files/ })).toBeTruthy()
  await pane.unmount()
  const off: any = await $.command.run({ command: 'nomercy', args: 'off' } as any)
  expect(String(off.text)).toContain('Claude edits freely')
  expect(calls.some(c => c[0] === 'battle-quit')).toBe(true)
})

// ---------------- Claude writes the questions ----------------

test('the first session says once that Claude writes the questions, and how to keep a project local', async ($, on) => {
  const calls: string[][] = []
  const logs: string[] = []
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? e[0] ?? []
    const args = argv.slice(argv.indexOf('api') + 1)
    calls.push(args)
    let body: Record<string, unknown> = { enabled: true, battleAllowed: true, queued: 0, header: '', battle: false, noMercy: false }
    if (args[0] === 'status') body = { ...body, modelNotice: !calls.some(c => c[0] === 'model-notice-ack'), model: 'claude-haiku-5-5' }
    if (args[0] === 'battle-state') body = { ...body, state: { phase: 'menu', mode: null } }
    return { value: { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '' } }
  })
  on('ui.log', (_: unknown, e: any) => {
    logs.push(String(e.text ?? ''))
    return { value: undefined }
  })
  await boot($, on)
  expect(logs.some(l => l.includes('claude-haiku-5-5') && l.includes('model.enabled false'))).toBe(true)
  expect(calls.some(c => c[0] === 'model-notice-ack')).toBe(true)
})

test('battle: RUN ends the fight and goes back to the menu', async ($, on) => {
  const calls = fakeBattle(on)
  await boot($, on)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await pick(ui, 'easy')
  await ui.select({ key: 'intro', value: 'go' })
  await ui.select({ key: 'intro', value: 'go' })
  expect(await ui.find({ key: 'q-11' })).toBeTruthy()
  await ui.select({ key: 'q-11', value: '__run' })
  expect(calls.some(c => c[0] === 'battle-quit')).toBe(true)
  expect(calls.some(c => c[0] === 'battle-answer')).toBe(false)
  expect(await ui.find({ key: 'menu' })).toBeTruthy()
  await ui.unmount()
})

test('battle menu: No Mercy shows SKYNET\'s warning, then starts the fight with no health bars', async ($, on) => {
  const calls = fakeGate(on, { fighting: false })
  person(on, 'heap')
  await boot($, on)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await pick(ui, 'nomercy')
  expect(await ui.find({ type: 'Text', text: /N O   M E R C Y/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Answer wrong and SKYNET rejects it and Claude stops/ })).toBeTruthy()
  await ui.select({ key: 'skynet', value: 'fight' })
  expect(calls.some(c => c[0] === 'battle-start' && c[1] === 'nomercy')).toBe(true)
  await ui.select({ key: 'intro', value: 'go' })
  await ui.select({ key: 'intro', value: 'go' })
  expect(calls.some(c => c[0] === 'battle-question')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /no health bar/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /TOKENS/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /SKYNET is watching Claude/ })).toBeTruthy()
  await ui.unmount()
})

// ---------------- the menu's screens, the intro, Bug Hunter ----------------

test('battle: after the intro the fight starts by itself, no Enter needed', async ($, on) => {
  const calls = fakeBattle(on)
  const clock = await boot($, on)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await pick(ui, 'easy')
  expect(await ui.find({ type: 'Text', text: /TYPO SPRITE wants to fight!/ })).toBeTruthy()
  await clock.advance(3000)
  expect(calls.some(c => c[0] === 'battle-question')).toBe(true)
  expect(await ui.find({ key: 'q-11' })).toBeTruthy()
  await ui.unmount()
})

test('menu: Achievements shows trophies, belts and XP on its own screen', async ($, on) => {
  fakeBattle(on)
  await boot($, on)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await ui.select({ key: 'menu', value: 'achievements' })
  expect(await ui.find({ type: 'Text', text: /\[ACHIEVEMENTS\]/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Belt: YELLOW/ })).toBeTruthy()
  // Each trophy opens with its own picture.
  await ui.select({ key: 'trophies', value: 'skynet' })
  expect(await ui.find({ type: 'Text', text: /Trophy: Judgment Averted/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\[ OFFLINE \]/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Defeated SKYNET in No Mercy\./ })).toBeTruthy()
  await ui.select({ key: 'trophy', value: 'list' })
  await ui.select({ key: 'trophies', value: 'evil-claude' })
  expect(await ui.find({ type: 'Text', text: /Locked: Evil Claude Defeated/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\( x_x \)/ })).toBeTruthy()
  await ui.select({ key: 'trophy', value: 'list' })
  await ui.select({ key: 'trophies', value: 'back' })
  expect(await ui.find({ key: 'menu' })).toBeTruthy()
  await ui.unmount()
})

test('menu: Settings picks the model and the effort', async ($, on) => {
  const calls = fakeBattle(on)
  await boot($, on)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await ui.select({ key: 'menu', value: 'settings' })
  await ui.select({ key: 'settings', value: 'model' })
  expect(calls.some(c => c.join(' ').includes('config set model.model claude-sonnet-5-5 --global'))).toBe(true)
  await ui.select({ key: 'settings', value: 'effort' })
  expect(calls.some(c => c.join(' ').includes('config set model.effort medium --global'))).toBe(true)
  await ui.unmount()
})

test('menu: Prepare writes questions on a picked or typed topic before the fight', async ($, on) => {
  const calls = fakeBattle(on)
  const toasts: string[] = []
  await boot($, on, toasts)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await ui.select({ key: 'menu', value: 'prepare' })
  await ui.select({ key: 'prepare', value: 'epoll and non-blocking sockets' })
  expect(calls.some(c => c[0] === 'prepare' && c.slice(1).join(' ') === 'epoll and non-blocking sockets')).toBe(true)
  expect(toasts.some(t => /Prepared 6 questions/.test(t) && /written by Claude/.test(t))).toBe(true)
  await ui.input({ key: 'topic', text: 'Rust lifetimes' })
  expect(calls.some(c => c[0] === 'prepare' && c.slice(1).join(' ') === 'Rust lifetimes')).toBe(true)
  await ui.unmount()
})

test('menu: Bug Hunter starts the fight against FREE CHINESE LLM', async ($, on) => {
  const calls = fakeBattle(on)
  await boot($, on)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await ui.select({ key: 'menu', value: 'special' })
  expect(await ui.find({ type: 'Text', text: /\[SPECIAL\]/ })).toBeTruthy()
  await ui.select({ key: 'mode', value: 'bughunter' })
  expect(calls.some(c => c[0] === 'battle-start' && c[1] === 'bughunter')).toBe(true)
  await ui.unmount()
})

test('menu: Scores tracks XP and accuracy across every project', async ($, on) => {
  const calls = fakeBattle(on)
  await boot($, on)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await ui.select({ key: 'menu', value: 'scores' })
  expect(calls.some(c => c[0] === 'scores')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /\[SCORES\]/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /All projects: 1,240 XP/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /312 answers, 78% right/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /> sranja .* 900 .* 200 .* 81%/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /  Diffdojo .* 340/ })).toBeTruthy()
  await ui.unmount()
})

test('menu: Scores → Share shows the card first and publishes only on Publish', async ($, on) => {
  const calls = fakeBattle(on)
  const toasts: string[] = []
  await boot($, on, toasts)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await ui.select({ key: 'menu', value: 'scores' })
  await ui.select({ key: 'scores', value: 'preview' })
  expect(await ui.find({ type: 'Text', text: /exactly what will be published/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1,240 XP/ })).toBeTruthy()
  expect(calls.some(c => c[0] === 'share')).toBe(false)
  await ui.select({ key: 'share', value: 'cancel' })
  expect(calls.some(c => c[0] === 'share')).toBe(false)
  await ui.select({ key: 'scores', value: 'preview' })
  await ui.select({ key: 'share', value: 'publish' })
  expect(calls.some(c => c[0] === 'share')).toBe(true)
  expect(toasts.some(t => t.includes('https://gist.github.com/me/abc123'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Shared at https:\/\/gist\.github\.com\/me\/abc123/ })).toBeTruthy()
  await ui.unmount()
})

// ---------------- Rush: THE CLOCK ----------------

test('Rush: answers go straight to the next question against the clock, then TIME!', async ($, on) => {
  const calls: string[][] = []
  const RUSH = {
    ...FIGHT, mode: 'rush', modeLabel: 'Rush', stages: 1, noHealth: true,
    enemy: { id: 'clock', name: 'THE CLOCK', level: 60, hp: 1, maxHp: 1, boss: true, color: '#d9a13b' },
  }
  let score = 0
  let answers = 0
  const state = (phase = 'fight') => ({ ...RUSH, phase, rush: { endsAt: Date.now() + 40000, score, best: Math.max(score, 3) } })
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? e[0] ?? []
    const args = argv.slice(argv.indexOf('api') + 1)
    calls.push(args)
    let body: Record<string, unknown> = { enabled: true, queued: 0, header: '' }
    if (args[0] === 'battle-state') body = { ...body, battle: true, state: { ...FIGHT, phase: 'menu', mode: null, enemy: null } }
    if (args[0] === 'settings') body = { enabled: true, model: 'claude-haiku-5-5', effort: 'low', perHour: 30 }
    if (args[0] === 'battle-start') body = { state: state() }
    if (args[0] === 'battle-question') body = { question: { ...BQ, id: 20 + answers }, state: state() }
    if (args[0] === 'battle-answer') {
      answers++
      const correct = args[1] === 'b'
      if (correct) score++
      body = answers < 2
        ? { rush: true, correct, correctKey: 'b', score, xp: 5, trophies: [], state: state() }
        : { rush: true, correct, correctKey: 'b', score, rushOver: true, best: 3, trophies: [{ id: 'rush-first', name: 'Against the Clock' }], state: state('gameover') }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '' } }
  })
  const toasts: string[] = []
  await boot($, on, toasts)
  const ui = await $.ui.mount({ ...BATTLE_PANE, surface: 'terminal' } as any)
  await pick(ui, 'rush')
  expect(calls.some(c => c[0] === 'battle-start' && c[1] === 'rush')).toBe(true)
  await ui.select({ key: 'intro', value: 'go' })
  await ui.select({ key: 'intro', value: 'go' })
  expect(await ui.find({ type: 'Text', text: /TIME▐/ })).toBeTruthy()
  await ui.select({ key: 'q-20', value: 'b' })
  // No result screen: the next question is already there, with the verdict above it.
  expect(await ui.find({ key: 'continue' })).toBeFalsy()
  expect(await ui.find({ key: 'q-21' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Correct! \+2s/ })).toBeTruthy()
  await ui.select({ key: 'q-21', value: 'a' })
  expect(await ui.find({ type: 'Text', text: /T I M E !/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /You got 1 right/ })).toBeTruthy()
  expect(toasts.some(t => t.includes('Against the Clock'))).toBe(true)
  await ui.unmount()
})
