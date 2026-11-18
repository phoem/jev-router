export type JevMode = 'off' | 'report' | 'apply'

// The mode routing runs in when it is on, kept while it is off.
export type JevChoice = 'report' | 'apply'

// What Jev answered for the pick: the Score's position, its confidence and
// per-level probabilities when the answer carried them, and the two Nouls.
export type JevDetail = {
  depth: number
  confidence?: number
  probabilities?: number[]
  stakes: number
  followUp: number
}

export type JevPick = { model: string; level: number; detail?: JevDetail }

// Where the debug values, the usage figure and the stats show: the top band,
// which has room for rows, or the status line, which the app draws as one short line.
export type JevDetailsAt = 'top' | 'status'

// Which TypeSafe figure shows beside the routing state.
export type JevUsageShown = 'hide' | 'money' | 'tokens' | 'limits'

// What the router's own lookups have used at TypeSafe: answered requests, the
// tokens they were billed for, and the requests TypeSafe rate-limited (429).
export type JevSpend = {
  requests: number
  inputTokens: number
  outputTokens: number
  rateLimited: number
}

// What routing came to for one model: the lookups that picked it, those made in
// apply mode, and the Claude requests its turns made with the tokens they used
// (input includes cached input). Tokens only exist for turns run on the model.
export type JevModelStat = {
  picked: number
  applied: number
  steps: number
  inputTokens: number
  outputTokens: number
}

// Routing stats by model, keyed by the model name from the `models` setting.
export type JevRouted = Record<string, JevModelStat>

// What one chat has when it is left, kept under its session id so that reopening
// the chat picks up where it was: the routing mode, the mode picked for it, and
// the usage and routing stats counted in it. `at` is when it was last saved.
export type JevSessionRecord = {
  mode: JevMode
  chosen: JevChoice | null
  spend: JevSpend
  routed: JevRouted
  at: number
}

// One line of the lookup log, one lookup each. A lookup that failed has `error`
// and no answers; the prompt is as sent to TypeSafe, cut to its first 4,000 characters.
export type JevLogEntry = {
  t: string
  session: string
  mode: JevChoice
  prompt: string
  recentTurns: number
  ms: number
  status?: number
  error?: string
  depth?: number
  confidence?: number
  probabilities?: number[]
  stakes?: number
  followUp?: number
  level?: number
  model?: string
  inputTokens?: number
  outputTokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    'jev-router': {
      mode: JevMode
      chosen: JevChoice | null
      pick: JevPick | null
      problem: string | null
      isBandShown: boolean
      isStatusShown: boolean
      isDebugShown: boolean
      isStatsShown: boolean
      isLogOn: boolean
      logProblem: string | null
      usageShown: JevUsageShown
      detailsAt: JevDetailsAt
      spend: JevSpend
      spendAll: JevSpend
      routed: JevRouted
      routedAll: JevRouted
    }
  }
}
