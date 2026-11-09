// State contract for DiffDojo's in-app UI (hooks/ui.tsx).

/** A question as `diffdojo api next` returns it (no answer key). */
export type DojoQuestion = {
  id: number
  family: string
  type: string
  grading: string
  topic: string | null
  difficulty: string
  xp: number
  est: number
  prompt: string
  code: string | null
  location: string | null
  choices: Record<string, string> | null
  format: string
  hint: string
  exam: boolean
  selectedBy?: string
}

/** What grading said, as `diffdojo api answer` returns it. */
export type DojoResult = {
  questionId: number
  correct: boolean | null
  xp: number
  answerText: string | null
  explanation: string | null
  evidence: string | null
  detail: string | null
  feedback: string | null
  trophies: { id: string; name: string }[]
}

/** `diffdojo api battle-state` (src/battle.js view()). */
export type BattleView = {
  mode: string | null
  modeLabel: string | null
  phase: 'menu' | 'fight' | 'gameover' | 'victory'
  stage: number
  stages: number | null
  wave: number
  lives: number
  maxLives: number
  player: { name: string; hp: number; maxHp: number }
  enemy: { id: string; name: string; level: number; hp: number; maxHp: number; boss: boolean; color: string | null } | null
  best: Record<string, number>
  wins: Record<string, number>
  hasQuestion: boolean
}

/** A battle question: always four answers, a-d. */
export type BattleQuestion = {
  id: number
  prompt: string
  code: string | null
  choices: Record<string, string>
  type: string
  family: string
  difficulty: string
  location: string | null
}

/** What one exchange of blows came to. */
export type BattleResult = {
  correct: boolean
  correctKey: string
  picked: string
  prompt: string
  xp: number
  explanation: string | null
  enemyName: string
  playerName?: string
  damage?: number
  enemyDamage?: number
  enemyMissed?: boolean
  enemyDefeated?: boolean
  nextEnemy?: string
  victory?: boolean
  lifeLost?: boolean
  gameOver?: boolean
  enemyHpBefore: number
  enemyHpAfter: number
  playerHpBefore: number
  playerHpAfter: number
  trophies: { id: string; name: string }[]
}

export type BattleAnim = { kind: 'enemyHit' | 'playerHit' | 'dodge'; frame: number }

declare module 'claude-code' {
  interface PluginState {
    diffdojo: {
      battleOn: boolean
      battleScene: Shaped<BattleView | null>
      battleAfter: Shaped<BattleView | null>
      battleQuestion: Shaped<BattleQuestion | null>
      battleResult: Shaped<BattleResult | null>
      battleAnim: Shaped<BattleAnim | null>
      battleTick: number
      battleIntro: number
      battleBusy: boolean
      current: Shaped<DojoQuestion | null>
      result: Shaped<DojoResult | null>
      queued: number
      header: string
      enabled: boolean
      working: boolean
      isHidden: boolean
      isBusy: boolean
    }
  }
}
