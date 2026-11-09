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
  const src = ART[id] || ART.typo
  const w = Math.max(...src.map(r => r.length))
  const rows = src.map(r => r.padEnd(w))
  if (frame % 2 === 0) return rows.map(r => r.replace(/@/g, 'o')).concat([' '.repeat(w)])
  return [' '.repeat(w)].concat(rows.map(r => r.replace(/@/g, '-')))
}

export function spriteLines(id: string, frame: number, hurt = false): Line[] {
  const c = hurt ? PALETTE.hurt : id === 'evil' ? PALETTE.boss : PALETTE.ink
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

export function hpBar(hp: number, max: number, cells = 16): Line {
  const n = Math.max(0, Math.min(cells, Math.round((hp / Math.max(1, max)) * cells)))
  const c = hp / max > 0.5 ? PALETTE.ink : hp / max > 0.2 ? PALETTE.low : PALETTE.hurt
  return [seg('HP:', PALETTE.ink, true), seg('▐'), seg('█'.repeat(n), c), seg('░'.repeat(cells - n), PALETTE.light), seg('▌')]
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
  const status: Line[] = !e
    ? []
    : inPlace
      ? [
          [seg(' ' + e.name, e.boss ? PALETTE.boss : PALETTE.ink, true)],
          [seg(`      :L${e.level}`, PALETTE.ink, true)],
          [seg('   '), ...hpBar(s.enemyHp, e.maxHp)],
          [seg(` │ ${v.stages ? balls(remaining, v.stages) : `WAVE ${v.wave}`}`, PALETTE.ink)],
          [seg(' └' + '─'.repeat(26) + '▶', PALETTE.ink)],
        ]
      : [
          [seg('')],
          [seg('')],
          [seg(` │ ${v.stages ? balls(remaining, v.stages) : `WAVE ${v.wave}`}`, PALETTE.ink)],
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
  const pStatus: Line[] = inPlace
    ? [
        [seg(v.player.name || 'YOU', PALETTE.ink, true)],
        [seg(`  ${balls(v.lives, v.maxLives)}  lives`, PALETTE.ink)],
        [...hpBar(s.playerHp, v.player.maxHp)],
        [seg(`      ${String(s.playerHp).padStart(3)}/ ${v.player.maxHp}`, PALETTE.ink, true)],
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
