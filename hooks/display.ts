// What the mod shows: the routing line, the debug values, and the TypeSafe
// usage figures. Pure functions over plain data.

import type { JevDetail, JevMode, JevPick, JevSpend, JevUsageShown } from '../types'

// From docs.typesafe.ai/models: input tokens are billed, output tokens are free.
export const PRICE_PER_MTOK_USD = 0.042

export const NO_SPEND: JevSpend = { requests: 0, inputTokens: 0, outputTokens: 0, rateLimited: 0 }

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
