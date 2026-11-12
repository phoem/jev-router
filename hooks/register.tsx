import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { JevChoice, JevDetail, JevDetailsAt, JevMode, JevSpend, JevUsageShown } from '../types'
import { NO_SPEND, asSpend, debugPart, describe, usagePart, usageReport } from './display'
import { buildRequest, decide, parseAnswers, parseModels, parseUsage } from './policy'
import type { Judgments, Tokens, Turn } from './policy'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const TIMEOUT_MS = 5000
const RECENT_TURNS = 6
const TURN_CHARS = 600
const PROMPT_CHARS = 4000
const TOGGLE =
  /^jev\s+(on|off|report|apply|status|help|usage(?:\s+(?:money|tokens|limits|hide))?|details\s+(?:top|status)|(?:topband|statusband|debug)\s+(?:show|hide))$/i
const DISPLAY = /^(topband|statusband|debug) (show|hide)$/
const USAGE = /^usage(?: (money|tokens|limits|hide))?$/
const DETAILS = /^details (top|status)$/
const STATUS_HIDDEN = ' The status band is hidden: /jev statusband show shows it.'
const TOP_HIDDEN = ' The top band is hidden: /jev topband show shows it.'
const HELP = [
  '/jev on - turn routing on for this session, in the mode last picked',
  '/jev report - show the model Jev would pick for each prompt, and change nothing',
  '/jev apply - run each turn on the model Jev picks',
  '/jev off - turn routing off: nothing more is sent to TypeSafe',
  '/jev status - show the current state',
  "/jev usage - what the router's lookups have used at TypeSafe: requests, tokens, estimated cost",
  '/jev usage money|tokens|limits|hide - show one TypeSafe figure, or hide it',
  "/jev debug show|hide - show Jev's scores, confidence and probabilities, or hide them",
  '/jev details top|status - where those two show: the top band (default, has room) or the status line (short)',
  '/jev topband show|hide - the band above the prompt, with the mode buttons',
  '/jev statusband show|hide - the status line under the prompt',
  '/jev help - this list',
]

// Prompts a person typed: the terminal, a phone or web client, a host app.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const mode = atom({ plugin: 'jev-router', key: 'mode' } as const, 'off')
const pick = atom({ plugin: 'jev-router', key: 'pick' } as const, null)
const problem = atom({ plugin: 'jev-router', key: 'problem' } as const, null)
// What the router's lookups have used at TypeSafe: this session, and in all
// sessions (kept in the store, read back at the start).
const spend = atom({ plugin: 'jev-router', key: 'spend' } as const, NO_SPEND)
const spendAll = atom({ plugin: 'jev-router', key: 'spendAll' } as const, NO_SPEND)

// What draws, and what the status band adds to the routing line. Kept in the
// store too, so the choices outlast the session.
const bandShown = atom({ plugin: 'jev-router', key: 'isBandShown' } as const, true)
const statusShown = atom({ plugin: 'jev-router', key: 'isStatusShown' } as const, false)
const debugShown = atom({ plugin: 'jev-router', key: 'isDebugShown' } as const, false)
const usageShown = atom({ plugin: 'jev-router', key: 'usageShown' } as const, 'hide')
const detailsAt = atom({ plugin: 'jev-router', key: 'detailsAt' } as const, 'top')

// The mode picked on the band or by /jev report|apply; null until then, when
// the defaultMode setting stands.
const chosen = atom({ plugin: 'jev-router', key: 'chosen' } as const, null)

// The pick waiting for its turn to start, and the turn it was bound to.
let armed: { text: string; model: string } | null = null
let active: { turnId: string; model: string } | null = null

// The debug values and the usage figure, whichever are on, one row each.
async function detailRows($: EngineInterface): Promise<string[]> {
  const picked = await read($, pick)
  const rows: string[] = []
  const usageKind = await read($, usageShown)

  if ((await read($, debugShown)) && picked?.detail !== undefined) {
    rows.push(debugPart(picked.detail, picked.level))
  }

  if (usageKind !== 'hide') {
    rows.push(usagePart(usageKind, await read($, spend), await read($, spendAll)))
  }

  return rows
}

// Sets the status band and answers the routing line, which the top band shows too.
// The details go after the routing text only when they are set to show here.
async function show($: EngineInterface): Promise<string> {
  const line = describe(await read($, mode), await read($, pick), await read($, problem))

  if (!(await read($, statusShown))) {
    $.ui.status(undefined)

    return line
  }

  const rows = (await read($, detailsAt)) === 'status' ? await detailRows($) : []
  $.ui.status([line, ...rows].join(' | '))

  return line
}

// Where the details show now, and a note when that band is hidden.
async function whereDetails($: EngineInterface): Promise<{ at: JevDetailsAt; note: string }> {
  const at = await read($, detailsAt)
  const isTopShown = await read($, bandShown)
  const isStatusLineShown = await read($, statusShown)

  if (at === 'top') {
    return { at, note: isTopShown ? '' : TOP_HIDDEN }
  }

  return { at, note: isStatusLineShown ? '' : STATUS_HIDDEN }
}

async function setDisplay($: EngineInterface, which: string, isShown: boolean): Promise<string> {
  if (which === 'topband') {
    await update($, bandShown, () => isShown)
    await $.store.set('isBandShown', isShown)

    return isShown ? 'Top band shown.' : 'Top band hidden. /jev topband show brings it back.'
  }

  if (which === 'statusband') {
    await update($, statusShown, () => isShown)
    await $.store.set('isStatusShown', isShown)
    await show($)

    return isShown ? 'Status band shown.' : 'Status band hidden. /jev statusband show brings it back.'
  }

  await update($, debugShown, () => isShown)
  await $.store.set('isDebugShown', isShown)
  await show($)

  if (!isShown) {
    return 'Debug values hidden.'
  }

  const { at, note } = await whereDetails($)

  return `Debug values shown on the ${at} band after each lookup.${note}`
}

async function setDetails($: EngineInterface, at: JevDetailsAt): Promise<string> {
  await update($, detailsAt, () => at)
  await $.store.set('detailsAt', at)
  await show($)

  const { note } = await whereDetails($)

  return `The debug values and the TypeSafe usage figure now show on the ${at} band.${note}`
}

async function setUsage($: EngineInterface, shown: JevUsageShown): Promise<string> {
  await update($, usageShown, () => shown)
  await $.store.set('usageShown', shown)
  await show($)

  if (shown === 'hide') {
    return 'TypeSafe usage hidden.'
  }

  const { at, note } = await whereDetails($)

  return `TypeSafe usage on the ${at} band: ${shown}.${note}`
}

async function reportUsage($: EngineInterface): Promise<string> {
  return usageReport(await read($, spend), await read($, spendAll))
}

// Counts one answered lookup, or one rate-limited request, for this session and
// for all sessions. The total is re-read from the store each time, so sessions
// open at once do not overwrite each other's counts, and the counts are made one
// at a time, so lookups in flight together do not overwrite each other's.
// Counting never fails a lookup.
let counting: Promise<void> = Promise.resolve()

async function count($: EngineInterface, tokens: Tokens | undefined, isRateLimited: boolean): Promise<void> {
  const add = (held: JevSpend): JevSpend => ({
    requests: held.requests + (isRateLimited ? 0 : 1),
    inputTokens: held.inputTokens + (tokens?.input ?? 0),
    outputTokens: held.outputTokens + (tokens?.output ?? 0),
    rateLimited: held.rateLimited + (isRateLimited ? 1 : 0),
  })

  try {
    const total = add(asSpend(await $.store.get('spendTotal')) ?? NO_SPEND)
    await $.store.set('spendTotal', total)
    await update($, spend, add)
    await update($, spendAll, () => total)
  } catch {
    // The figures are for display; the lookup's answer stands without them.
  }
}

function record($: EngineInterface, tokens: Tokens | undefined, isRateLimited: boolean): Promise<void> {
  counting = counting.then(() => count($, tokens, isRateLimited))

  return counting
}

async function help($: EngineInterface, startMode: JevMode, models: readonly string[]): Promise<string> {
  const line = describe(await read($, mode), await read($, pick), await read($, problem))

  return [
    `Jev model routing. Now: ${line}`,
    ...HELP,
    `Settings: default mode ${startMode}; models by difficulty ${models.join(', ')}.`,
  ].join('\n')
}

async function loadDisplay($: EngineInterface): Promise<void> {
  const savedBand = await $.store.get('isBandShown')
  const savedStatus = await $.store.get('isStatusShown')
  const savedDebug = await $.store.get('isDebugShown')
  const savedUsage = await $.store.get('usageShown')
  const savedAt = await $.store.get('detailsAt')
  const savedSpend = asSpend(await $.store.get('spendTotal'))

  if (savedSpend !== undefined) {
    await update($, spendAll, () => savedSpend)
  }

  if (typeof savedBand === 'boolean') {
    await update($, bandShown, () => savedBand)
  }

  if (typeof savedStatus === 'boolean') {
    await update($, statusShown, () => savedStatus)
  }

  if (typeof savedDebug === 'boolean') {
    await update($, debugShown, () => savedDebug)
  }

  if (savedAt === 'top' || savedAt === 'status') {
    await update($, detailsAt, () => savedAt)
  }

  if (savedUsage === 'hide' || savedUsage === 'money' || savedUsage === 'tokens' || savedUsage === 'limits') {
    await update($, usageShown, () => savedUsage)
  }
}

async function switchTo(
  $: EngineInterface,
  word: string,
  startMode: JevMode,
  models: readonly string[],
): Promise<string> {
  const where = DETAILS.exec(word)

  if (where !== null) {
    return setDetails($, where[1] === 'status' ? 'status' : 'top')
  }

  const display = DISPLAY.exec(word)

  if (display !== null) {
    return setDisplay($, display[1] ?? '', display[2] === 'show')
  }

  const usage = USAGE.exec(word)

  if (usage !== null) {
    const shown = usage[1]

    return shown === 'money' || shown === 'tokens' || shown === 'limits' || shown === 'hide'
      ? setUsage($, shown)
      : reportUsage($)
  }

  if (word === 'report' || word === 'apply') {
    await update($, chosen, () => word)
  }

  const wanted: JevMode | undefined =
    word === 'on'
      ? ((await read($, chosen)) ?? startMode)
      : word === 'off' || word === 'report' || word === 'apply'
        ? word
        : undefined

  // Anything it does not know, `help` included, answers with the list.
  if (wanted === undefined && word !== 'status') {
    return help($, startMode, models)
  }

  if (wanted !== undefined) {
    await setMode($, wanted)
  }

  return show($)
}

async function setMode($: EngineInterface, wanted: JevMode): Promise<void> {
  await update($, mode, () => wanted)
  await update($, pick, () => null)
  await update($, problem, () => null)
  armed = null
  active = null
}

// The band's mode button: picks the other mode, and switches to it only while on.
async function flipMode($: EngineInterface, startMode: JevMode): Promise<void> {
  const held = (await read($, chosen)) ?? startMode
  const choice: JevChoice = held === 'apply' ? 'report' : 'apply'
  await update($, chosen, () => choice)

  if ((await read($, mode)) !== 'off') {
    await setMode($, choice)
  }

  await show($)
}

// The band's on/off button, reading the mode as it stands when pressed.
async function flipPower($: EngineInterface, startMode: JevMode): Promise<void> {
  const now = await read($, mode)
  await setMode($, now === 'off' ? ((await read($, chosen)) ?? startMode) : 'off')
  await show($)
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

  if (response.status === 429) {
    await record($, undefined, true)
  }

  if (!response.ok) {
    return `TypeSafe answered ${response.status}`
  }

  await record($, parseUsage(response.text), false)

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
    const detail: JevDetail = judged
    armed = now === 'apply' ? { text: text.trim(), model: chosen.model } : null
    await update($, pick, () => ({ ...chosen, detail }))
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
      argumentHint: '[on|off|report|apply|status|usage|debug|details|topband|statusband|help]',
    })
    await loadDisplay($)
    await show($)

    return next(e)
  })

  // A bare /jev answers with the list.
  on('command.run', { command: 'jev' }, async ($, e) => ({
    text: await switchTo($, e.args.trim().toLowerCase().replace(/\s+/g, ' ') || 'help', startMode, models),
  }))

  // The band above the prompt: the state, one button that names the mode and
  // flips it, and one that turns routing on or off; under them, one row for each
  // detail that is set to show here.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, bandShown))) {
      return next(e)
    }

    const now = await read($, mode)
    const choice = (await read($, chosen)) ?? startMode
    const line = describe(now, await read($, pick), await read($, problem))
    const rows = (await read($, detailsAt)) === 'top' ? await detailRows($) : []
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {line}
            </Text>
          </Box>
          <Box gap={1} flexShrink={0}>
            <Button
              key="mode"
              label={choice === 'apply' ? 'Mode: Apply' : 'Mode: Report only'}
              onPress={() => flipMode($, startMode)}
            />
            <Button
              key="power"
              label={now === 'off' ? 'Turn on' : 'Turn off'}
              onPress={() => flipPower($, startMode)}
            />
          </Box>
        </Box>
        {rows.map(row => (
          <Text dimColor wrap="wrap">
            {row}
          </Text>
        ))}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    const isTyped = PERSON.has(e.origin.kind) && e.isMeta !== true && e.command === undefined

    if (!isTyped) {
      return next(e)
    }

    const toggle = TOGGLE.exec(e.text.trim())

    if (toggle !== null) {
      const word = (toggle[1] ?? '').toLowerCase().replace(/\s+/g, ' ')

      return { drop: await switchTo($, word, startMode, models) }
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

    return yield* next({ ...e, model: routed.model })
  })
}
