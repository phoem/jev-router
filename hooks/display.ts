// What the mod shows: the routing line, the debug values, the TypeSafe usage
// figures, the routing stats and the lookup log. Pure functions over plain data.

import type {
  JevDetail,
  JevLogEntry,
  JevMode,
  JevModelStat,
  JevPick,
  JevRouted,
  JevSpend,
  JevUsageShown,
} from '../types'

// From docs.typesafe.ai/models: input tokens are billed, output tokens are free.
export const PRICE_PER_MTOK_USD = 0.042

export const NO_SPEND: JevSpend = { requests: 0, inputTokens: 0, outputTokens: 0, rateLimited: 0 }

export const NO_STAT: JevModelStat = { picked: 0, applied: 0, steps: 0, inputTokens: 0, outputTokens: 0 }

export const describe = (now: JevMode, picked: JevPick | null, wrong: string | null): string => {
  if (now === 'off') {
    return 'Jev: off'
  }

  const label = now === 'apply' ? 'Jev: on (apply)' : 'Jev: on (report)'

  if (wrong !== null) {
    return `${label} · no pick: ${wrong}`
  }

  return picked === null ? label : `${label} → ${picked.model}`
}

// The depth Score as Jev answered it, the two Nouls, and the level they led to.
export const debugPart = (detail: JevDetail, level: number): string => {
  const confidence = detail.confidence === undefined ? '' : `, confidence ${detail.confidence.toFixed(2)}`
  const spread =
    detail.probabilities === undefined
      ? ''
      : `, p ${detail.probabilities.map(one => Math.round(one * 100)).join('/')}%`

  return `depth ${detail.depth.toFixed(2)}${confidence}${spread} · stakes ${detail.stakes.toFixed(2)} · follow-up ${detail.followUp.toFixed(2)} · level ${level}`
}

// A stored count read back: all four figures must be whole, non-negative numbers.
export const asSpend = (value: unknown): JevSpend | undefined => {
  const held = value as Partial<Record<keyof JevSpend, unknown>> | null
  const figures = [held?.requests, held?.inputTokens, held?.outputTokens, held?.rateLimited]

  return figures.every(one => typeof one === 'number' && Number.isInteger(one) && one >= 0)
    ? (held as JevSpend)
    : undefined
}

const compact = (count: number): string => {
  if (count >= 1_000_000) {
    return `${Math.round(count / 100_000) / 10}M`
  }

  return count >= 1000 ? `${Math.round(count / 100) / 10}k` : String(count)
}

const cost = (spend: JevSpend): number => (spend.inputTokens * PRICE_PER_MTOK_USD) / 1_000_000

// A lookup costs a few thousandths of a cent, so small sums keep their digits.
const dollars = (usd: number): string => {
  if (usd === 0) {
    return '$0'
  }

  if (usd < 0.01) {
    return `$${usd.toFixed(6)}`
  }

  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

const times = (count: number): string => `${count} time${count === 1 ? '' : 's'}`

// One short TypeSafe figure, for the status line: this session, then all sessions.
export const usagePart = (shown: JevUsageShown, session: JevSpend, all: JevSpend): string => {
  if (shown === 'money') {
    return `TypeSafe ${dollars(cost(session))} this session, ${dollars(cost(all))} in all`
  }

  if (shown === 'tokens') {
    return `TypeSafe ${compact(session.inputTokens)} input tokens this session, ${compact(all.inputTokens)} in all`
  }

  return `TypeSafe rate-limited ${times(session.rateLimited)} this session, ${times(all.rateLimited)} in all`
}

// Everything known about the router's TypeSafe usage, one fact a line.
export const usageReport = (session: JevSpend, all: JevSpend): string => {
  const counted = (spend: JevSpend): string =>
    `${spend.requests} requests, ${spend.inputTokens} input tokens, ${spend.outputTokens} output tokens, about ${dollars(cost(spend))}`

  return [
    "TypeSafe (Jev) usage, counting this router's lookups only:",
    `This session: ${counted(session)}`,
    `All sessions: ${counted(all)}`,
    `Rate-limited by TypeSafe: ${times(session.rateLimited)} this session, ${times(all.rateLimited)} in all`,
    `Cost is an estimate at $${PRICE_PER_MTOK_USD} per million input tokens; output tokens are free (docs.typesafe.ai/models).`,
    "What is left: TypeSafe's API reports no balance or limit figures. Rate limits are set per organization and shown at console.typesafe.ai/rate-limits.",
  ].join('\n')
}

// A stored count read back: an object of models, each with five whole numbers.
export const asRouted = (value: unknown): JevRouted | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const keys: (keyof JevModelStat)[] = ['picked', 'applied', 'steps', 'inputTokens', 'outputTokens']
  const isStat = (one: unknown): boolean =>
    typeof one === 'object' &&
    one !== null &&
    keys.every(key => {
      const figure = (one as Record<string, unknown>)[key]

      return typeof figure === 'number' && Number.isInteger(figure) && figure >= 0
    })

  return Object.values(value).every(isStat) ? (value as JevRouted) : undefined
}

// The models in the order of the `models` setting, then any others that have counts.
const statsNames = (order: readonly string[], ...counts: JevRouted[]): string[] => [
  ...new Set([...order, ...counts.flatMap(held => Object.keys(held))]),
]

// The routing stats as rows for a band: what each model was picked for, and the
// tokens the turns that ran on it used.
export const statsRows = (stat: JevRouted, order: readonly string[]): string[] => {
  const names = statsNames(order, stat)
  const picked = names
    .filter(name => (stat[name]?.picked ?? 0) > 0)
    .map(name => `${name} ${stat[name]?.picked ?? 0}`)
  const used = names
    .filter(name => (stat[name]?.steps ?? 0) > 0)
    .map(name => `${name} ${compact(stat[name]?.inputTokens ?? 0)}/${compact(stat[name]?.outputTokens ?? 0)}`)
  const rows = [
    picked.length > 0 ? `Picked this session: ${picked.join(' · ')}` : 'Picked this session: no lookups yet',
  ]

  if (used.length > 0) {
    rows.push(`Tokens in/out by model, apply mode: ${used.join(' · ')}`)
  }

  return rows
}

// The routing stats in full, for the chat.
export const statsReport = (session: JevRouted, all: JevRouted, order: readonly string[]): string => {
  const names = statsNames(order, session, all)
  const count = (stat: JevRouted): string[] =>
    names.map(name => {
      const held = stat[name] ?? NO_STAT

      return `  ${name}: picked ${held.picked}, applied ${held.applied} · ${held.steps} requests, ${held.inputTokens} input tokens, ${held.outputTokens} output tokens`
    })

  return [
    "Jev routing stats, counting this router's lookups only:",
    'This session:',
    ...count(session),
    'All sessions:',
    ...count(all),
    'Picked counts what each lookup chose, in report mode too (where nothing was rerouted). Applied counts the lookups made in apply mode.',
    'Requests and tokens are the Claude requests that ran on the picked model in apply mode; input includes cached input. Subagents and turns that were not routed are not counted.',
  ].join('\n')
}

const isLogEntry = (value: unknown): value is JevLogEntry => {
  const held = value as Partial<Record<keyof JevLogEntry, unknown>> | null

  return (
    typeof held === 'object' &&
    held !== null &&
    typeof held.t === 'string' &&
    typeof held.prompt === 'string' &&
    (held.mode === 'report' || held.mode === 'apply') &&
    typeof held.ms === 'number'
  )
}

// The lookups in a log file, oldest first; a line that is not one is skipped.
export const parseLog = (text: string): JevLogEntry[] => {
  const entries: JevLogEntry[] = []

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue
    }

    try {
      const entry: unknown = JSON.parse(line)

      if (isLogEntry(entry)) {
        entries.push(entry)
      }
    } catch {
      // A line cut by hand or by the size cap is not worth stopping for.
    }
  }

  return entries
}

// One logged lookup as one line: when, the mode, what Jev made of it and the model
// picked (or why there was no pick), the tokens, the time, and the prompt's start.
export const logLine = (entry: JevLogEntry): string => {
  const clock = `${entry.t.slice(0, 19).replace('T', ' ')}Z`
  const flat = entry.prompt.replace(/\s+/g, ' ')
  const snippet = `"${flat.length > 60 ? `${flat.slice(0, 60)}…` : flat}"`
  const took = `${entry.ms}ms`

  if (entry.model === undefined || entry.depth === undefined) {
    return `${clock} ${entry.mode} · no pick: ${entry.error ?? 'no answer'} · ${took} · ${snippet}`
  }

  const confidence = entry.confidence === undefined ? '' : `, confidence ${entry.confidence.toFixed(2)}`
  const tokens =
    entry.inputTokens === undefined ? '' : ` · ${entry.inputTokens} in/${entry.outputTokens ?? 0} out`

  return `${clock} ${entry.mode} → ${entry.model} (level ${entry.level ?? '?'}) · depth ${entry.depth.toFixed(2)}${confidence} · stakes ${(entry.stakes ?? 0).toFixed(2)} · follow-up ${(entry.followUp ?? 0).toFixed(2)}${tokens} · ${took} · ${snippet}`
}
