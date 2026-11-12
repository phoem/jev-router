import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { JevMode, JevPick } from '../types'
import { buildRequest, decide, parseAnswers, parseModels } from './policy'
import type { Judgments, Turn } from './policy'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const TIMEOUT_MS = 5000
const RECENT_TURNS = 6
const TURN_CHARS = 600
const PROMPT_CHARS = 4000
const TOGGLE = /^jev (on|off|report|apply|status)$/i
const USAGE = 'Say: jev on, jev off, jev report, jev apply or jev status.'

// Prompts a person typed: the terminal, a phone or web client, a host app.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const mode = atom({ plugin: 'jev-router', key: 'mode' } as const, 'off')
const pick = atom({ plugin: 'jev-router', key: 'pick' } as const, null)
const problem = atom({ plugin: 'jev-router', key: 'problem' } as const, null)

// The pick waiting for its turn to start, and the turn it was bound to.
let armed: { text: string; model: string } | null = null
let active: { turnId: string; model: string } | null = null

function describe(now: JevMode, picked: JevPick | null, wrong: string | null): string {
  if (now === 'off') {
    return 'Jev: off'
  }

  const label = now === 'apply' ? 'Jev: on (routing)' : 'Jev: on (report only)'

  if (wrong !== null) {
    return `${label} · no pick: ${wrong}`
  }

  if (picked === null) {
    return label
  }

  if (now === 'report') {
    return `${label} · would pick ${picked.model}`
  }

  return picked.isApplied
    ? `${label} · this turn runs on ${picked.model}`
    : `${label} · picked ${picked.model}`
}

async function show($: EngineInterface): Promise<string> {
  const line = describe(await read($, mode), await read($, pick), await read($, problem))
  $.ui.status(line)

  return line
}

async function switchTo($: EngineInterface, word: string, startMode: JevMode): Promise<string> {
  const wanted: JevMode | undefined =
    word === 'on' ? startMode : word === 'off' || word === 'report' || word === 'apply' ? word : undefined

  if (wanted === undefined && word !== 'status') {
    return USAGE
  }

  if (wanted !== undefined) {
    await update($, mode, () => wanted)
    await update($, pick, () => null)
    await update($, problem, () => null)
    armed = null
    active = null
  }

  return show($)
}

async function judge($: EngineInterface, text: string): Promise<Judgments | string> {
  const key = await $.env.get('TYPESAFE_API_KEY')

  if (key === undefined || key === '') {
    return 'TYPESAFE_API_KEY is not set'
  }

  const recent: Turn[] = (await $.session.messages())
    .filter(message => message.text !== '')
    .slice(-RECENT_TURNS)
    .map(message => ({ role: message.role, text: message.text.slice(0, TURN_CHARS) }))
  const request = buildRequest(text.slice(0, PROMPT_CHARS), recent)

  let giveUp = (): void => {}
  const timedOut = new Promise<undefined>(resolve => {
    giveUp = () => resolve(undefined)
  })
  const timer = $.clock.after(TIMEOUT_MS, () => giveUp())
  const response = await Promise.race([
    $.http.fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
    timedOut,
  ])
  timer.cancel()

  if (response === undefined) {
    return 'TypeSafe timed out'
  }

  if (!response.ok) {
    return `TypeSafe answered ${response.status}`
  }

  return parseAnswers(response.text) ?? 'TypeSafe sent an answer the router could not read'
}

async function route(
  $: EngineInterface,
  text: string,
  now: JevMode,
  models: readonly string[],
): Promise<void> {
  let judged: Judgments | string

  try {
    judged = await judge($, text)
  } catch {
    judged = 'TypeSafe could not be reached'
  }

  if (typeof judged === 'string') {
    const wrong = judged
    armed = null
    await update($, pick, () => null)
    await update($, problem, () => wrong)
  } else {
    const previous = await read($, pick)
    const chosen = decide(judged, models, previous?.level)
    armed = now === 'apply' ? { text: text.trim(), model: chosen.model } : null
    await update($, pick, () => ({ ...chosen, isApplied: false }))
    await update($, problem, () => null)
  }

  await show($)
}

export const register: Register = (on, options) => {
  const startMode: JevMode = options.defaultMode === 'apply' ? 'apply' : 'report'
  const models = parseModels(typeof options.models === 'string' ? options.models : '')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jev',
      description: 'Turn Jev model routing on or off for this session',
      argumentHint: '[on|off|report|apply|status]',
    })
    await show($)

    return next(e)
  })

  on('command.run', { command: 'jev' }, async ($, e) => ({
    text: await switchTo($, e.args.trim().toLowerCase() || 'status', startMode),
  }))

  on('prompt.submit', async ($, e, next) => {
    const isTyped = PERSON.has(e.origin.kind) && e.isMeta !== true && e.command === undefined

    if (!isTyped) {
      return next(e)
    }

    const toggle = TOGGLE.exec(e.text.trim())

    if (toggle !== null) {
      return { drop: await switchTo($, (toggle[1] ?? '').toLowerCase(), startMode) }
    }

    const now = await read($, mode)

    if (now === 'off') {
      return next(e)
    }

    // Report mode never holds the prompt back; apply mode needs the pick
    // before the turn's first request.
    const routing = route($, e.text, now, models)

    if (now === 'apply') {
      await routing
    }

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined && armed !== null && armed.text === e.text.trim()) {
      active = { turnId: e.turnId, model: armed.model }
      armed = null
    }

    return next(e)
  })

  // Subagents keep their own models: only the main loop's requests are routed.
  on('turn.step', async function* ($, e, next) {
    const routed = active

    if (e.agentId !== undefined || routed === null || routed.turnId !== e.turnId) {
      return yield* next(e)
    }

    if (e.index === 0) {
      await update($, pick, held => (held === null ? held : { ...held, isApplied: true }))
      await show($)
    }

    return yield* next({ ...e, model: routed.model })
  })
}
