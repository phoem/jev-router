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

// Where the debug values and the usage figure show: the top band, which has room
// for rows, or the status line, which the app draws as one short line.
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
      usageShown: JevUsageShown
      detailsAt: JevDetailsAt
      spend: JevSpend
      spendAll: JevSpend
    }
  }
}
