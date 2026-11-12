export type JevMode = 'off' | 'report' | 'apply'

export type JevPick = { model: string; level: number; isApplied: boolean }

declare module 'claude-code' {
  interface PluginState {
    'jev-router': {
      mode: JevMode
      pick: JevPick | null
      problem: string | null
    }
  }
}
