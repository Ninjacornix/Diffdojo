#!/usr/bin/env node
// Renders the README's battle screenshot (docs/evil-claude-battle.svg) from the
// real scene renderer, so the image always matches the game.
//   node scripts/screenshot.mjs [out.svg]
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const battle = require(join(root, 'src', 'battle.js'))
const scene = await import(new URL('../hooks/scene.mts', import.meta.url).href)

const W = 76
const boss = battle.LADDERS.professional.find(e => e.boss)
const view = {
  mode: 'professional', modeLabel: 'Professional', stage: 2, stages: 3, wave: 1, lives: 2, maxLives: 3,
  player: { name: 'ALEX', hp: 70, maxHp: battle.PLAYER_MAX },
  enemy: { id: boss.id, name: boss.name, level: boss.level, hp: 108, maxHp: boss.hp, boss: true },
}
const field = scene.battlefield({ view, width: W, tick: 0, intro: scene.INTRO_STEPS, anim: null, enemyHp: 108, playerHp: 70 })
const rows = [
  ...scene.wrap(['EVIL CLAUDE asks: One line was changed in this copy of `drain()` from src/net/retry_queue.cpp:27-36. Pick the changed line.'], W - 6).map(text => ({ text })),
  { text: 'Code challenge · medium · src/net/retry_queue.cpp:27-36', dim: true },
  { text: 'a) line 4: while (!pending_.empty() || top().deadline <= now) {', selected: true },
  { text: 'b) line 6:     pending_.pop();' },
  { text: 'c) line 2: std::lock_guard<std::mutex> guard(mu_);' },
  { text: 'd) line 7:     n++;' },
]
const lines = field.concat(scene.box(rows, W, 0, false))

// ---- SVG: a dark terminal window
const FONT = 14
const LH = 18
const CW = 8.43
const PAD = 18
const TOP = 40
const fg = c => (!c ? '#d4d4d4' : c === 'gray' ? '#7f7f7f' : c)
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const width = Math.ceil(W * CW + PAD * 2)
const height = TOP + lines.length * LH + PAD
// Every character sits at its own column, so viewers' font widths can't skew the art.
const body = lines
  .map((l, i) => {
    const y = TOP + (i + 1) * LH - 4
    let col = 0
    const out = []
    for (const s of l) {
      const chars = [...s.t]
      for (let k = 0; k < chars.length; ) {
        const ch = chars[k]
        let n = 1
        // Runs of one block/rule glyph are stretched to their exact width, so bars stay solid.
        if (/[█░═─]/.test(ch)) while (chars[k + n] === ch) n++
        if (ch === '█' || ch === '░') {
          // HP bars as solid shapes: full blocks in the bar's color, empty cells dimmed.
          out.push(`<rect x="${(PAD + col * CW).toFixed(1)}" y="${y - FONT + 3}" width="${(n * CW).toFixed(1)}" height="${FONT - 1}" fill="${fg(s.c)}"${ch === '░' ? ' opacity="0.35"' : ''}/>`)
        } else if (ch !== ' ') {
          const fit = n > 1 ? ` textLength="${(n * CW).toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : ''
          out.push(`<text x="${(PAD + col * CW).toFixed(1)}" y="${y}" fill="${fg(s.c)}"${s.b ? ' font-weight="700"' : ''}${fit}>${esc(ch.repeat(n))}</text>`)
        }
        col += n
        k += n
      }
    }
    return out.join('')
  })
  .join('\n  ')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="DiffDojo Battle: fighting Evil Claude in the terminal">
  <rect width="${width}" height="${height}" rx="10" fill="#1e1e1e"/>
  <rect width="${width}" height="28" rx="10" fill="#2d2d2d"/>
  <rect y="18" width="${width}" height="10" fill="#2d2d2d"/>
  <circle cx="18" cy="14" r="6" fill="#ff5f57"/><circle cx="38" cy="14" r="6" fill="#febc2e"/><circle cx="58" cy="14" r="6" fill="#28c840"/>
  <text x="${width / 2}" y="18" fill="#9a9a9a" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12" text-anchor="middle">claude - DiffDojo Battle</text>
  <g font-family="Cascadia Mono, Consolas, Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace" font-size="${FONT}">
  ${body}
  </g>
</svg>
`
const out = process.argv[2] || join(root, 'docs', 'evil-claude-battle.svg')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, svg)
console.log(`wrote ${out} (${lines.length} rows)`)
