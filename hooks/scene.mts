// The battle screen as plain data: a list of lines of colored text segments.
// Pure (no engine, no Node), so the same code draws the in-app pane
// (hooks/battle.tsx) and the standalone terminal game (`diffdojo battle`).
//
// Look: a classic handheld RPG battle — pale screen, dark pixel-art sprites
// drawn with half-block characters, the enemy top right with its status
// bracket, you from behind bottom left, and a text box along the bottom.
// All characters are original.

// `c` null = the terminal's own text color; nothing paints a background.
export type Seg = { t: string; c: string | null; b?: boolean }
export type Line = Seg[]

// Drawn on the terminal's own background: the main ink is the terminal's text
// color, so it reads on dark and light themes alike.
export const PALETTE = {
  ink: null as string | null, // the terminal's text color
  mid: 'gray', // secondary text, empty HP
  light: 'gray',
  hurt: '#e0533d', // a hit flashes red
  low: '#d9a13b', // HP getting low
  boss: '#d97757', // Evil Claude's orange
  skynet: '#e0533d', // SKYNET, No Mercy's boss: red
  freellm: '#c94fd6', // FREE CHINESE LLM, Bug Hunter's boss
  clock: '#d9a13b', // THE CLOCK, Rush
}

// ---------------------------------------------------------------- sprites
// ASCII line art. '@' marks an eye: drawn 'o', blinking to '-' on the second
// idle frame, which also bobs the sprite down one row.

const R = String.raw

const ART: Record<string, string[]> = {
  player: [
    R`         _______         `,
    R`       .'       '.       `,
    R`      /   _____   \      `,
    R`     |   /     \   |     `,
    R`    [|  |       |  |]    `,
    R`     |   \_____/   |     `,
    R`      '.         .'      `,
    R`    ___|'-.___.-'|___    `,
    R`   /    \   |   /    \   `,
    R`  /      |  |  |      \  `,
    R` |   |   |  |  |   |   | `,
  ],
  typo: [
    R`       \   ~   /       `,
    R`     .-'"""""""'-.     `,
    R`    /   @     @   \    `,
    R`   |       ^       |   `,
    R`   |   \__/ \__/   |   `,
    R`    \   t  y  p   /    `,
    R`     '-.._____..-'     `,
    R`       /   |   \       `,
    R`      ~    ~    ~      `,
  ],
  gremlin: [
    R`   /\             /\   `,
    R`  /  \___________/  \  `,
    R`  \   _         _   /  `,
    R`   | (@)       (@) |   `,
    R`   |      /_\      |   `,
    R`   |   \/\/\/\/\   |   `,
    R`    \_____________/    `,
    R`   _/ |  L I N T  | \_ `,
    R`  /__ |___________| __\ `,
  ],
  imp: [
    R`     ^         ^              `,
    R`    / \_______/ \     _____   `,
    R`   |   @     @   |   | +1  |  `,
    R`   |     ___     |   |_____|  `,
    R`    \   \___/   /       ||    `,
    R`  ---\_________/--------'|    `,
    R`     /   | |   \         |    `,
    R`    /____| |____\             `,
  ],
  null: [
    R`        _.-----._        `,
    R`      .'  _   _  '.      `,
    R`     /   (@) (@)   \     `,
    R`    |      ___      |    `,
    R`    |    [ NULL ]   |    `,
    R`     \   '-...-'   /     `,
    R`      '._       _.'      `,
    R`         '-----'         `,
    R`          | | |          `,
  ],
  leak: [
    R`         _______         `,
    R`       .'       '.       `,
    R`      /  @     @  \      `,
    R`     |     ___     |     `,
    R`     |    (___)    |     `,
    R`     |  ~~~~~~~~~  |     `,
    R`      \_ _ _ _ _ _/      `,
    R`       ' ' ' ' ' '       `,
    R`       .  .  .  .        `,
  ],
  flaky: [
    R`     _______________     `,
    R`    | [v]  [x]  [?] |    `,
    R`    |---------------|    `,
    R`    |   @       @   |    `,
    R`    |       ~       |    `,
    R`    |   \_______/   |    `,
    R`    |_______________|    `,
    R`      /|         |\      `,
    R`     /_|         |_\     `,
  ],
  race: [
    R`    __          __      `,
    R`   / @\  >>>>  /@ \     `,
    R`  |    | >>>> |    |    `,
    R`   \__/  >>>>  \__/     `,
    R`     \\        //       `,
    R`      \\      //        `,
    R`       \\    //         `,
    R`        \\  //          `,
    R`         \\//           `,
  ],
  deadlock: [
    R`    .--.          .--.    `,
    R`   |    |        |    |   `,
    R`  _|____|_      _|____|_  `,
    R` |  @  @  |====|  @  @  | `,
    R` |   __   |====|   __   | `,
    R` |  (__)  |    |  (__)  | `,
    R` '--------'    '--------' `,
  ],
  heisen: [
    R`   ?     \   /     ?    `,
    R`          \ /           `,
    R`     .--.-(_)-.--.      `,
    R`    / @ |     | @ \     `,
    R` ? |    |     |    | ?  `,
    R`   /\   '-----'   /\    `,
    R`  /  \  /     \  /  \   `,
    R`       /       \        `,
    R`   ?                 ?  `,
  ],
  segfault: [
    R`        .-""""""-.       `,
    R`       /  @    @  \      `,
    R`      |     __     |     `,
    R`      |   0xDEAD   |     `,
    R`      |            |     `,
    R`      |  ,      ,  |     `,
    R`       \/ \/\/\/ \/      `,
  ],
  monolith: [
    R`   _________________   `,
    R`  |  _____________  |  `,
    R`  | |   @     @   | |  `,
    R`  | |     ___     | |  `,
    R`  | |_____________| |  `,
    R`  | [==] [==] [==]  |  `,
    R`  | [==] [==] [==]  |  `,
    R`  | [==] [==] [==]  |  `,
    R`  |_________________|  `,
  ],
}

// FREE CHINESE LLM, Bug Hunter's boss: a chat bubble that "helpfully" rewrites your code.
const FREELLM: string[][] = [
  [
    R`    _____________________    `,
    R`   /                     \   `,
    R`  |   FREE!    @     @    |  `,
    R`  |   $0.00       __      |  `,
    R`  |   tokens   \_/  \_/   |  `,
    R`   \_______   ___________/   `,
    R`           \ |               `,
    R`            \|  "I fixed it" `,
  ],
  [
    R`    _____________________    `,
    R`   /                     \   `,
    R`  |   FREE!    -     -    |  `,
    R`  |   $0.00       __      |  `,
    R`  |   tokens   \_/  \_/   |  `,
    R`   \_______   ___________/   `,
    R`           \ |               `,
    R`            \|  "trust me"   `,
  ],
]

// THE CLOCK, Rush: an alarm clock whose hands swing between two times.
const CLOCK: string[][] = [
  [
    R`    _         _    `,
    R`   (_)_______(_)   `,
    R`   /  .  12 .  \   `,
    R`  | 9    |    3 |  `,
    R`  |      |__    |  `,
    R`  | .         . |  `,
    R`   \  .  6  .  /   `,
    R`    '-._____.-'    `,
    R`     /       \     `,
  ],
  [
    R`    _         _    `,
    R`   (_)_______(_)   `,
    R`   /  .  12 .  \   `,
    R`  | 9      /  3 |  `,
    R`  |    __/      |  `,
    R`  | .         . |  `,
    R`   \  .  6  .  /   `,
    R`    '-._____.-'    `,
    R`     /       \     `,
  ],
]

// SKYNET, No Mercy's boss: a server rack with one great eye, guarding your files.
const SKYNET: string[][] = [
  [
    R`   ___________________   `,
    R`  |  _______________  |  `,
    R`  | |    _______    | |  `,
    R`  | |   /  ___  \   | |  `,
    R`  | |  |  (( ))  |  | |  `,
    R`  | |   \_______/   | |  `,
    R`  | |_______________| |  `,
    R`  |  ::::  :::  ::::  |  `,
    R`  |  [##]  [#]  [##]  |  `,
    R`  |___________________|  `,
  ],
  [
    R`   ___________________   `,
    R`  |  _______________  |  `,
    R`  | |    _______    | |  `,
    R`  | |   /  ___  \   | |  `,
    R`  | |  |  ( O )  |  | |  `,
    R`  | |   \_______/   | |  `,
    R`  | |_______________| |  `,
    R`  |  ::::  :::  ::::  |  `,
    R`  |  [##]  [ ]  [##]  |  `,
    R`  |___________________|  `,
  ],
]

// Evil Claude: an angry starburst; its rays swing between two angles.
const EVIL: string[][] = [
  [
    R`              |              `,
    R`       \      |      /       `,
    R`         \    |    /         `,
    R`           \  |  /           `,
    R`  -------- ( >_< ) --------  `,
    R`           /  |  \           `,
    R`         /    |    \         `,
    R`       /      |      \       `,
    R`              |              `,
  ],
  [
    R`        \           /        `,
    R`    .    \         /    .    `,
    R`      '.  \       /  .'      `,
    R`   ---  '. \     / .'  ---   `,
    R`  ======== ( >o< ) ========  `,
    R`   ---  .' /     \ '.  ---   `,
    R`      .'  /       \  '.      `,
    R`    '    /         \    '    `,
    R`        /           \        `,
  ],
]

/** The text rows of a character's idle frame (0 or 1). */
export function art(id: string, frame: number): string[] {
  if (id === 'evil') return EVIL[frame % 2]
  if (id === 'skynet') return SKYNET[frame % 2]
  if (id === 'clock') return CLOCK[frame % 2]
  if (id === 'freellm') return FREELLM[frame % 2].map(r => r.replace(/@/g, 'o'))
  const src = ART[id] || ART.typo
  const w = Math.max(...src.map(r => r.length))
  const rows = src.map(r => r.padEnd(w))
  if (frame % 2 === 0) return rows.map(r => r.replace(/@/g, 'o')).concat([' '.repeat(w)])
  return [' '.repeat(w)].concat(rows.map(r => r.replace(/@/g, '-')))
}

export function spriteLines(id: string, frame: number, hurt = false): Line[] {
  const c = hurt ? PALETTE.hurt : id === 'evil' ? PALETTE.boss : id === 'skynet' ? PALETTE.skynet : id === 'freellm' ? PALETTE.freellm : id === 'clock' ? PALETTE.clock : PALETTE.ink
  return art(id, frame).map(t => [{ t, c, b: !!c }])
}

// ---------------------------------------------------------------- layout helpers

function seg(t: string, c: string | null = PALETTE.ink, b = false): Seg {
  return { t, c, b }
}

function width(line: Line): number {
  return line.reduce((n, s) => n + [...s.t].length, 0)
}

export function pad(line: Line, w: number): Line {
  const n = width(line)
  return n >= w ? clip(line, w) : line.concat([seg(' '.repeat(w - n))])
}

function clip(line: Line, w: number): Line {
  const out: Line = []
  let n = 0
  for (const s of line) {
    const chars = [...s.t]
    if (n + chars.length <= w) {
      out.push(s)
      n += chars.length
    } else {
      out.push({ ...s, t: chars.slice(0, w - n).join('') })
      break
    }
  }
  return out
}

/** Place `right` so it starts at column `at`, after `left` (padded). */
export function join(left: Line, right: Line, at: number): Line {
  return pad(left, at).concat(right)
}

/** Health is a token budget: the bar shows the tokens a fighter has left. */
export const BAR_LABEL = 'TOKENS'

export function hpBar(hp: number, max: number, cells = 16): Line {
  const n = Math.max(0, Math.min(cells, Math.round((hp / Math.max(1, max)) * cells)))
  const c = hp / max > 0.5 ? PALETTE.ink : hp / max > 0.2 ? PALETTE.low : PALETTE.hurt
  return [seg(BAR_LABEL, PALETTE.ink, true), seg('▐'), seg('█'.repeat(n), c), seg('░'.repeat(cells - n), PALETTE.light), seg('▌')]
}

// What falls out of a fighter's bar when it is hit: tokens, as a tokenizer would cut them.
export const SPILL = ['▁def', 'await', '##ing', '</s>', 'Ġreturn', 'self', '{', '};', '=>', '::', 'null', 'ion', '▁the', 'std', '0x1F', '##er', 'Ġif', 'tok', '\\n', 'import', '▁func', '++', 'err', '<|eot|>']

function hash(text: string): number {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

/**
 * Two to five words per hit (more for a bigger hit), side by side without
 * overlapping inside `room` columns, each with a small random delay.
 */
export function spillWords(seed: string, lost: number, room = 24): { word: string; dx: number; delay: number }[] {
  const n = Math.max(2, Math.min(5, Math.round(lost / 10)))
  const out: { word: string; dx: number; delay: number }[] = []
  let h = hash(seed)
  let x = 0
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
    const word = SPILL[h % SPILL.length]
    x += i === 0 ? (h >>> 8) % 2 : 1 + ((h >>> 8) % 2)
    if (x + [...word].length > room) break
    out.push({ word, dx: x, delay: (h >>> 12) % 3 })
    x += [...word].length
  }
  return out
}

/** Characters from `from` on (by columns). */
function tail(line: Line, from: number): Line {
  const out: Line = []
  let n = 0
  for (const s of line) {
    const chars = [...s.t]
    const end = n + chars.length
    if (end > from) out.push({ ...s, t: chars.slice(Math.max(0, from - n)).join('') })
    n = end
  }
  return out
}

/** Write `text` over `line` at column `at`, keeping the line's width. */
function overlay(line: Line, at: number, text: string, c: string | null): Line {
  const w = width(line)
  if (at >= w) return line
  const t = [...text].slice(0, w - at).join('')
  return clip(pad(line, at), at).concat([seg(t, c, true)], tail(line, at + [...t].length))
}

function balls(full: number, total: number): string {
  return '●'.repeat(Math.max(0, full)) + '○'.repeat(Math.max(0, total - full))
}

// ---------------------------------------------------------------- the scene

export type SceneView = {
  mode: string | null
  modeLabel: string | null
  stage: number
  stages: number | null
  wave: number
  lives: number
  maxLives: number
  player: { name?: string; hp: number; maxHp: number }
  enemy: { id: string; name: string; level: number; hp: number; maxHp: number; boss: boolean } | null
  /** No Mercy: no health bars on either side. */
  noHealth?: boolean
  /** No Mercy: edits answered right in this fight. */
  passed?: number
  /** Rush: when the clock runs out (epoch ms; null before the first question), score, best. */
  rush?: { endsAt: number | null; score: number; best: number } | null
}

export type SceneInput = {
  view: SceneView
  width: number
  tick: number
  /** Intro slide-in, 0..INTRO_STEPS; at INTRO_STEPS the fighters are in place. */
  intro: number
  /** Hit animation, or null. */
  anim: { kind: 'enemyHit' | 'playerHit' | 'dodge'; frame: number } | null
  enemyHp: number
  playerHp: number
  /** Tokens the hit fighter lost: how many words spill out of its bar. */
  lost?: number
  /** Now, in epoch ms (Rush's clock). */
  now?: number
}

/** Rush: seconds left as m:ss, and a bar that drains with them. */
export function rushTime(endsAt: number | null, now: number, total = 60000): { text: string; bar: Line; left: number } {
  const left = endsAt === null ? total : Math.max(0, endsAt - now)
  const sec = Math.ceil(left / 1000)
  const text = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
  const cells = 16
  const n = Math.max(0, Math.min(cells, Math.round((left / total) * cells)))
  const c = left > total / 2 ? PALETTE.ink : left > total / 5 ? PALETTE.low : PALETTE.hurt
  return { text, left, bar: [seg('TIME', PALETTE.ink, true), seg('▐'), seg('█'.repeat(n), c), seg('░'.repeat(cells - n), PALETTE.light), seg('▌ ' + text, c, true)] }
}

export const INTRO_STEPS = 8
export const ANIM_FRAMES = 10

/** The battlefield: both fighters and their status brackets (no text box). */
export function battlefield(s: SceneInput): Line[] {
  const W = Math.max(56, s.width)
  const v = s.view
  const e = v.enemy
  const lines: Line[] = []
  const hit = !!s.anim && s.anim.frame < 6
  const flash = hit && s.anim!.frame % 2 === 1
  const inPlace = s.intro >= INTRO_STEPS

  // ---- enemy row: status bracket left, sprite right
  const eSprite = e ? spriteLines(e.id, s.tick % 2, s.anim?.kind === 'enemyHit' && flash) : []
  const eW = eSprite.length ? width(eSprite[0]) : 0
  const slideIn = Math.round(((INTRO_STEPS - Math.min(s.intro, INTRO_STEPS)) / INTRO_STEPS) * (W - eW))
  const shake = s.anim?.kind === 'enemyHit' && hit ? (s.anim.frame % 2 ? 2 : -1) : 0
  const eAt = Math.max(0, Math.min(W - eW, W - eW - 2 + slideIn + shake))
  const remaining = v.stages ? v.stages - v.stage : 1
  const bossColor = e && e.id === 'skynet' ? PALETTE.skynet : e && e.id === 'freellm' ? PALETTE.freellm : e && e.id === 'clock' ? PALETTE.clock : PALETTE.boss
  const rt = v.rush ? rushTime(v.rush.endsAt, s.now ?? Date.now()) : null
  const status: Line[] = !e
    ? []
    : inPlace && rt
      ? [
          [seg(' ' + e.name, bossColor, true)],
          [seg(`      :L${e.level}`, PALETTE.ink, true)],
          [seg('   '), ...rt.bar],
          [seg(' │ right +2s, wrong -5s', PALETTE.mid)],
          [seg(' └' + '─'.repeat(26) + '▶', PALETTE.ink)],
        ]
    : inPlace && v.noHealth
      ? [
          [seg(' ' + e.name, bossColor, true)],
          [seg(`      :L${e.level}`, PALETTE.ink, true)],
          [seg('   no health bar', PALETTE.mid)],
          [seg(' │ falls when Claude is done', PALETTE.ink)],
          [seg(' └' + '─'.repeat(26) + '▶', PALETTE.ink)],
        ]
    : inPlace
      ? [
          [seg(' ' + e.name, e.boss ? bossColor : PALETTE.ink, true)],
          [seg(`      :L${e.level}`, PALETTE.ink, true)],
          [seg('   '), ...hpBar(s.enemyHp, e.maxHp)],
          [seg(` │ ${v.stages ? balls(remaining, v.stages) : `WAVE ${v.wave}`}`, PALETTE.ink)],
          [seg(' └' + '─'.repeat(26) + '▶', PALETTE.ink)],
        ]
      : [
          [seg('')],
          [seg('')],
          [seg(v.noHealth ? ' │' : ` │ ${v.stages ? balls(remaining, v.stages) : `WAVE ${v.wave}`}`, PALETTE.ink)],
          [seg(' └' + '─'.repeat(26) + '▶', PALETTE.ink)],
        ]
  const top = Math.max(eSprite.length, status.length + 1)
  for (let i = 0; i < top; i++) {
    const left = status[i] || []
    const sp = eSprite[i - (top - eSprite.length)] || []
    lines.push(pad(sp.length ? join(left, sp, eAt) : left, W))
  }
  // sparks / miss
  const fx = s.anim?.kind === 'enemyHit' && hit ? (s.anim.frame % 2 ? '*  +  *' : '+  *  +') : s.anim?.kind === 'dodge' && hit ? 'MISS!' : ''
  lines.push(pad(fx ? join([], [seg(fx, PALETTE.hurt, true)], Math.max(0, eAt + Math.floor(eW / 2) - 3)) : [], W))

  // ---- player row: sprite left, status bracket right
  const pSprite = spriteLines('player', (s.tick + 1) % 2, s.anim?.kind === 'playerHit' && flash)
  const pW = width(pSprite[0])
  const pSlide = Math.round(((INTRO_STEPS - Math.min(s.intro, INTRO_STEPS)) / INTRO_STEPS) * (pW + 2))
  const pShake = s.anim?.kind === 'playerHit' && hit ? (s.anim.frame % 2 ? 2 : 0) : 0
  const dodge = s.anim?.kind === 'dodge' && hit ? Math.min(s.anim.frame, 6 - s.anim.frame) : 0
  const pAt = Math.max(0, 2 - pSlide + pShake + dodge)
  const sx = Math.max(pW + 6, W - 31)
  const pStatus: Line[] = inPlace && v.rush
    ? [
        [seg(v.player.name || 'YOU', PALETTE.ink, true)],
        [seg(`  score: ${v.rush.score}`, PALETTE.ink, true)],
        [seg(`  best:  ${v.rush.best}`, PALETTE.mid)],
        [seg('')],
        [seg('◀' + '─'.repeat(26) + '┘', PALETTE.ink)],
      ]
    : inPlace && v.noHealth
    ? [
        [seg(v.player.name || 'YOU', PALETTE.ink, true)],
        [seg('  one wrong answer: you lose', PALETTE.mid)],
        [seg(`  edits passed: ${v.passed || 0}`, PALETTE.ink, true)],
        [seg('')],
        [seg('◀' + '─'.repeat(26) + '┘', PALETTE.ink)],
      ]
    : inPlace
    ? [
        [seg(v.player.name || 'YOU', PALETTE.ink, true)],
        [seg(`  ${balls(v.lives, v.maxLives)}  `, PALETTE.ink), seg(`${String(s.playerHp).padStart(3)}/${v.player.maxHp} tokens`, PALETTE.ink, true)],
        [...hpBar(s.playerHp, v.player.maxHp)],
        [seg('')], // tokens fall through here when you are hit
        [seg('◀' + '─'.repeat(26) + '┘', PALETTE.ink)],
      ]
    : [[seg('')], [seg('')], [seg(`${balls(v.lives, v.maxLives)}       │`, PALETTE.ink)], [seg('◀' + '─'.repeat(26) + '┘', PALETTE.ink)]]
  const rows = Math.max(pSprite.length, pStatus.length)
  for (let i = 0; i < rows; i++) {
    const sp = pSprite[i] || []
    const st = pStatus[i - (rows - pStatus.length)] || []
    const visible = pAt < 0 ? [] : sp
    lines.push(pad(join(join([], visible, pAt), st, sx), W))
  }

  // ---- tokens spilling out of the bar of whoever was hit, falling a row every few frames
  const kind = s.anim?.kind
  if (inPlace && !v.noHealth && (kind === 'enemyHit' || kind === 'playerHit') && s.anim!.frame < ANIM_FRAMES) {
    const barRow = kind === 'enemyHit' ? 2 : top + 1 + (rows - pStatus.length) + 2
    const barCol = kind === 'enemyHit' ? 8 : sx + 2 // the enemy's start clear of its stage balls
    const below = kind === 'enemyHit' ? 3 : 2 // rows under the bar the words can fall through
    const seed = `${kind}|${v.stage}|${v.wave}|${v.lives}|${e ? e.hp : 0}|${v.player.hp}`
    for (const w of spillWords(seed, s.lost ?? 30, kind === 'enemyHit' ? 20 : 25)) {
      const f = s.anim!.frame - w.delay
      if (f < 0) continue
      const drop = 1 + Math.floor(f / 3)
      if (drop > below) continue
      const row = barRow + drop
      if (row < lines.length) lines[row] = overlay(lines[row], barCol + w.dx, w.word, drop === 1 ? PALETTE.hurt : PALETTE.mid)
    }
  }
  return lines
}

/** Word-wrap paragraphs to a width (code-ish lines are cut, not wrapped). */
export function wrap(text: string[], w: number): string[] {
  const out: string[] = []
  for (const para of text) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (line && (line + ' ' + word).length > w) {
        out.push(line)
        line = word
      } else line = line ? line + ' ' + word : word
    }
    out.push(line)
  }
  return out
}

export type BoxRow = { text: string; dim?: boolean; selected?: boolean }

/** The text box along the bottom: a double rule, rows, a blinking ▼ when waiting for Enter. */
export function box(rows: BoxRow[], w: number, tick: number, arrow: boolean, minRows = 3): Line[] {
  const W = Math.max(56, w)
  const body = rows.slice()
  while (body.length < minRows) body.push({ text: '' })
  const out: Line[] = [pad([seg('═'.repeat(W))], W)]
  body.forEach((r, i) => {
    const last = i === body.length - 1
    const mark = last && arrow && tick % 2 === 0 ? '▼' : ' '
    const lead = r.selected ? '▶ ' : '  '
    const text = (lead + r.text).slice(0, W - 3)
    out.push(pad([seg(text, r.dim ? PALETTE.mid : PALETTE.ink, !r.dim)], W - 2).concat([seg(mark + ' ')]))
  })
  out.push(pad([seg('═'.repeat(W))], W))
  return out
}

/** Convenience: a box of wrapped paragraphs. */
export function textBox(text: string[], w: number, tick: number, arrow: boolean, minRows = 3): Line[] {
  return box(wrap(text, Math.max(56, w) - 6).map(t => ({ text: t })), w, tick, arrow, minRows)
}

/** A full-width row of plain text on the screen's background. */
export function plain(text: string, w: number, c: string | null = PALETTE.ink, b = false): Line {
  return pad([seg(text, c, b)], Math.max(56, w))
}

export const TITLE = [
  ' ___  _  __  __ ___      _      ',
  '|   \\(_)/ _|/ _|   \\ ___(_)___  ',
  '| |) | |  _|  _| |) / _ \\ / _ \\ ',
  '|___/|_|_| |_| |___/\\___/ \\___/ ',
  '                     |__/  BATTLE',
]

// ---------------------------------------------------------------- trophy art
// One small original picture per trophy (src/rewards.js TROPHIES), shown on the
// battle menu's Achievements screen: bright when earned, grey while locked.

const CUP = [
  R`   ___________   `,
  R`  '._==_==_=_.'  `,
  R`  .-\:      /-.  `,
  R` | (|:.     |) | `,
  R`  '-|:.     |-'  `,
  R`    \::.    /    `,
  R`     '::. .'     `,
  R`       ) (       `,
  R`     _.' '._     `,
]

export const TROPHY_ART: Record<string, string[]> = {
  'first-catch': [
    R`     _________     `,
    R`    |         |    `,
    R`    |   \o/   |    `,
    R`    |  -( )-  |    `,
    R`    |__/   \__|    `,
    R`   =============   `,
    R`   caught: 1 bug   `,
  ],
  'bug-hunter-1': [
    R`     .---.         `,
    R`    ( o o )    x5  `,
    R`     \ ^ /         `,
    R`   ---| |---       `,
    R`     /   \         `,
    R`    ^     ^        `,
  ],
  'bug-hunter-2': [
    R`    _/\_/\_/\_     `,
    R`     .-----.       `,
    R`    ( o   o )  x25 `,
    R`     \  ^  /       `,
    R`   ---|   |---     `,
    R`     /     \       `,
  ],
  'bug-hunter-3': [
    R`      _______      `,
    R`     /       \     `,
    R`    |  () ()  | x100`,
    R`     \   ^   /     `,
    R`      |||||||      `,
    R`    \/       \/    `,
    R`    /\       /\    `,
  ],
  'mutant-slayer': [
    R`          /|       `,
    R`         / |       `,
    R`  o====[===|=====> `,
    R`         \ |       `,
    R`          \|       `,
    R`   25 mutants down `,
  ],
  'clean-sweep': [
    R`          ||       `,
    R`          ||       `,
    R`          ||       `,
    R`         /  \      `,
    R`        //////\    `,
    R`       ////////    `,
    R`    not one miss   `,
  ],
  'iron-streak': [
    R`       (  )        `,
    R`      (    )       `,
    R`     ( (  ) )   30 `,
    R`      \ \/ /   days`,
    R`       \__/        `,
    R`     [======]      `,
  ],
  polyglot: [
    R` .----. .----. .----. `,
    R` | C++| | Py | | JS | `,
    R` '----' '----' '----' `,
    R`    \      |      /   `,
    R`     '--[GREEN]--'    `,
  ],
  architect: [
    R`        /\         `,
    R`       /  \        `,
    R`      /____\       `,
    R`      | [] |       `,
    R`      | [] |       `,
    R`    __|____|__     `,
  ],
  'mind-reader': [
    R`      .-""-.       `,
    R`     /  ()  \      `,
    R`    |  .--.  |     `,
    R`     \ '--' /      `,
    R`      '-..-'       `,
    R`   "I know why."   `,
  ],
  'second-opinion': [
    R` .------.  .------. `,
    R` | bug? |  | yes! | `,
    R` '--.---'  '---.--' `,
    R`    |          |    `,
    R`   (o)        (o)   `,
  ],
  scholar: [
    R`    ______ ______    `,
    R`   /      Y      \   `,
    R`  | ===== | ===== |  `,
    R`  | ===== | ===== |  `,
    R`  |_______|_______|  `,
    R`    every answer     `,
  ],
  'pack-author': [
    R`    _________        `,
    R`   | ======= |   __  `,
    R`   | ======= |  / /  `,
    R`   | =====   | / /   `,
    R`   |_________|/_/    `,
    R`    merged!          `,
  ],
  skeptic: [
    R`      ____         `,
    R`     /    \        `,
    R`         _/        `,
    R`        |          `,
    R`        o          `,
    R`   no bug here x5  `,
  ],
  'battle-easy': [
    R`     ______        `,
    R`    |  /\  |       `,
    R`    | /  \ |  ROOKIE`,
    R`    | \  / |       `,
    R`     \_\/_/        `,
  ],
  'battle-medium': [
    R`   \\        //    `,
    R`    \\      //     `,
    R`     \\    //      `,
    R`      \\  //       `,
    R`       \\//        `,
    R`       //\\        `,
    R`    BUG SQUASHER   `,
  ],
  'battle-hard': [
    R`       .--.        `,
    R`      /    \       `,
    R`     _|____|_      `,
    R`    |   ()   |     `,
    R`    |   ||   |     `,
    R`    |________|     `,
    R`   no more races   `,
  ],
  'evil-claude': [
    R`         \  |  /         `,
    R`       \  \ | /  /       `,
    R`  ------ ( x_x ) ------  `,
    R`       /  / | \  \       `,
    R`         /  |  \         `,
    R`      EVIL CLAUDE: 0     `,
  ],
  skynet: [
    R`   ___________________   `,
    R`  |  _______________  |  `,
    R`  | |    ( x   x )  | |  `,
    R`  | |_______________| |  `,
    R`  |  ::  [ OFFLINE ]  |  `,
    R`  |___________________|  `,
  ],
  'rush-first': [
    R`      _______      `,
    R`     /  12   \     `,
    R`    |    |    |    `,
    R`    | 9  o  3 |    `,
    R`     \   6   /     `,
    R`      '-----'      `,
    R`   made it: 60s    `,
  ],
  'rush-10': [
    R`       .--.        `,
    R`      /  /|   10   `,
    R`     / ./ |  right `,
    R`    /./   |        `,
    R`   '-'    '        `,
    R`   quick thinker   `,
  ],
  'rush-25': [
    R`   _____  _____    `,
    R`  |     \/     |   `,
    R`  | ==== | ====|   `,
    R`  | ==== | ====| >>`,
    R`  |______|_____|   `,
    R`   25 in a minute  `,
  ],
  'rush-50': [
    R`    .---------.    `,
    R`    | CPU 50  |    `,
    R`  --|  ////   |--  `,
    R`  --|  ////   |--  `,
    R`    '---------'    `,
    R`    ~ 5.0 GHz ~    `,
  ],
  'battle-bughunter': [
    R` [==][==][==][==][==] `,
    R` [=][==][==][==][==][]`,
    R` [==][==][==][==][==] `,
    R` [=][==][==][==][==][]`,
    R`       FIREWALL       `,
    R`   "I fixed it": no.  `,
  ],
}

/** A trophy's picture (rows padded to one width): its own, else a cup. */
export function trophyArt(id: string): string[] {
  const rows = TROPHY_ART[id] || CUP
  const w = Math.max(...rows.map(r => [...r].length))
  return rows.map(r => r + ' '.repeat(w - [...r].length))
}
