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

declare module 'claude-code' {
  interface PluginState {
    diffdojo: {
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
