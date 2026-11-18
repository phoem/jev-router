import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type {
  JevChoice,
  JevDetail,
  JevDetailsAt,
  JevLogEntry,
  JevMode,
  JevModelStat,
  JevRouted,
  JevSessionRecord,
  JevSpend,
  JevUsageShown,
} from '../types'
import {
  NO_SPEND,
  NO_STAT,
  asRouted,
  asSessions,
  asSpend,
  debugPart,
  describe,
  logLine,
  parseLog,
  pruneSessions,
  statsReport,
  statsRows,
  usagePart,
  usageReport,
} from './display'
import { buildRequest, decide, parseAnswers, parseModels, parseUsage } from './policy'
import type { Judgments, Tokens, Turn } from './policy'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const TIMEOUT_MS = 5000
const RECENT_TURNS = 6
const TURN_CHARS = 600
const PROMPT_CHARS = 4000
// The log is one file rewritten whole for each entry, so it stays small: past the
// cap the oldest lines go until about the keep size is left.
const LOG_MAX_CHARS = 800_000
const LOG_KEEP_CHARS = 500_000
const LOG_SHOWN = 5
// How many chats' modes and stats are kept for reopening them.
const SESSIONS_KEPT = 50
const LOG_SHOWN_MAX = 20
const TOGGLE =
  /^jev\s+(on|off|report|apply|status|help|usage(?:\s+(?:money|tokens|limits|hide))?|details\s+(?:top|status)|stats(?:\s+(?:show|hide))?|debuglog(?:\s+(?:on|off|clear))?|log(?:\s+\d+)?|(?:topband|statusband|debug)\s+(?:show|hide))$/i
const DISPLAY = /^(topband|statusband|debug) (show|hide)$/
const USAGE = /^usage(?: (money|tokens|limits|hide))?$/
const DETAILS = /^details (top|status)$/
const STATS = /^stats(?: (show|hide))?$/
const LOGSET = /^debuglog(?: (on|off|clear))?$/
const LOGSHOW = /^log(?: (\d+))?$/
const STATUS_HIDDEN = ' The status band is hidden: /jev statusband show shows it.'
const TOP_HIDDEN = ' The top band is hidden: /jev topband show shows it.'
const HELP = [
  '/jev on - turn routing on for this session, in the mode last picked',
  '/jev report - show the model Jev would pick for each prompt, and change nothing',
  '/jev apply - run each turn on the model Jev picks',
  '/jev off - turn routing off: nothing more is sent to TypeSafe',
  '/jev status - show the current state. A chat keeps its mode and its stats, and picks them up again when you reopen it',
  "/jev usage - what the router's lookups have used at TypeSafe: requests, tokens, estimated cost",
  '/jev usage money|tokens|limits|hide - show one TypeSafe figure, or hide it',
  '/jev stats - how many lookups picked each model, and the tokens its turns used',
  '/jev stats show|hide - show those as rows on the band, or hide them',
  "/jev debug show|hide - show Jev's scores, confidence and probabilities, or hide them",
  '/jev details top|status - where the debug values, usage and stats show: the top band (default, has room) or the status line (short)',
  "/jev debuglog on|off - log every lookup (your prompt text, Jev's answers, the model picked) to a file; off by default",
  '/jev debuglog clear - empty the log; /jev debuglog alone says where it is',
  '/jev log [n] - show the last n logged lookups (5 by default)',
  '/jev topband show|hide - the band above the prompt, with the mode buttons',
  '/jev statusband show|hide - the status line under the prompt',
  '/jev help - this list',
]

// Prompts a person typed: the terminal, a phone or web client, a host app.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const mode = atom({ plugin: 'jev-router', key: 'mode' } as const, 'off')
const pick = atom({ plugin: 'jev-router', key: 'pick' } as const, null)
const problem = atom({ plugin: 'jev-router', key: 'problem' } as const, null)
// What the router's lookups have used at TypeSafe, and what routing came to for
// each model: this session, and in all sessions (kept in the store, read back at
// the start).
const spend = atom({ plugin: 'jev-router', key: 'spend' } as const, NO_SPEND)
const spendAll = atom({ plugin: 'jev-router', key: 'spendAll' } as const, NO_SPEND)
const routed = atom({ plugin: 'jev-router', key: 'routed' } as const, {})
const routedAll = atom({ plugin: 'jev-router', key: 'routedAll' } as const, {})

// What draws, and what the bands add to the routing line. Kept in the store too,
// so the choices outlast the session.
const bandShown = atom({ plugin: 'jev-router', key: 'isBandShown' } as const, true)
const statusShown = atom({ plugin: 'jev-router', key: 'isStatusShown' } as const, false)
const debugShown = atom({ plugin: 'jev-router', key: 'isDebugShown' } as const, false)
const statsShown = atom({ plugin: 'jev-router', key: 'isStatsShown' } as const, false)
const usageShown = atom({ plugin: 'jev-router', key: 'usageShown' } as const, 'hide')
const detailsAt = atom({ plugin: 'jev-router', key: 'detailsAt' } as const, 'top')

// The lookup log is on for this session only: it writes prompt text to disk, so
// every new session starts with it off. `logProblem` is why the last write failed.
const logOn = atom({ plugin: 'jev-router', key: 'isLogOn' } as const, false)
const logProblem = atom({ plugin: 'jev-router', key: 'logProblem' } as const, null)

// The mode picked on the band or by /jev report|apply; null until then, when
// the defaultMode setting stands.
const chosen = atom({ plugin: 'jev-router', key: 'chosen' } as const, null)

// The pick waiting for its turn to start, and the turn it was bound to.
let armed: { text: string; model: string } | null = null
let active: { turnId: string; model: string } | null = null

// The `models` setting, for the order the stats list models in.
let modelOrder: readonly string[] = []

// The debug values, the usage figure and the stats, whichever are on, one row each.
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

  if (await read($, statsShown)) {
    rows.push(...statsRows(await read($, routed), modelOrder))
  }

  return rows
}

// Sets the status band and answers the routing line, which the top band shows too.
// The details go after the routing text only when they are set to show here.
async function show($: EngineInterface): Promise<string> {
  void remember($)

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

  return `The debug values, usage figure and stats now show on the ${at} band.${note}`
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

async function setStats($: EngineInterface, isShown: boolean): Promise<string> {
  await update($, statsShown, () => isShown)
  await $.store.set('isStatsShown', isShown)
  await show($)

  if (!isShown) {
    return 'Stats hidden.'
  }

  const { at, note } = await whereDetails($)

  return `Stats shown on the ${at} band: what each model was picked for, and the tokens its turns used.${note}`
}

async function reportUsage($: EngineInterface): Promise<string> {
  return usageReport(await read($, spend), await read($, spendAll))
}

async function reportStats($: EngineInterface): Promise<string> {
  return statsReport(await read($, routed), await read($, routedAll), modelOrder)
}

// The counts below are made one at a time, whichever lookup or turn they come
// from, so two in flight together do not overwrite each other's counts or the
// log file's. A total is re-read from the store each time, so sessions open at
// once do not overwrite each other's either. Counting never fails a lookup.
let queue: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch(() => undefined)

  return queue
}

// Keeps this chat's mode and stats under its session id, so that reopening the
// chat can pick them up. Re-reads the saved chats first, so chats open at once do
// not overwrite each other's records.
async function saveSession($: EngineInterface): Promise<void> {
  try {
    const record: JevSessionRecord = {
      mode: await read($, mode),
      chosen: await read($, chosen),
      spend: await read($, spend),
      routed: await read($, routed),
      at: await $.clock.now(),
    }
    const held = asSessions(await $.store.get('sessions'))
    await $.store.set('sessions', pruneSessions({ ...held, [await $.session.id()]: record }, SESSIONS_KEPT))
  } catch {
    // What a chat keeps is a convenience; the chat works the same without it.
  }
}

function remember($: EngineInterface): Promise<void> {
  return enqueue(() => saveSession($))
}

// Picks up what this chat had when it was left, if it was left with something to
// pick up: the routing mode, the mode picked for it, and its stats. A chat that is
// already in use (the module was reloaded in it) keeps what it has. Returns the
// routing line to tell the person, or undefined when nothing was picked up. The
// lookup log is not picked up: it starts off in every chat.
async function loadSession($: EngineInterface): Promise<string | undefined> {
  const isFresh =
    (await read($, mode)) === 'off' &&
    (await read($, spend)).requests === 0 &&
    Object.keys(await read($, routed)).length === 0

  if (!isFresh) {
    return undefined
  }

  const record = asSessions(await $.store.get('sessions'))[await $.session.id()]
  const hasStats = record !== undefined && (record.spend.requests > 0 || Object.keys(record.routed).length > 0)

  if (record === undefined || (record.mode === 'off' && !hasStats)) {
    return undefined
  }

  await update($, mode, () => record.mode)
  await update($, chosen, () => record.chosen)
  await update($, spend, () => record.spend)
  await update($, routed, () => record.routed)

  return describe(record.mode, null, null)
}

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
    await saveSession($)
  } catch {
    // The figures are for display; the lookup's answer stands without them.
  }
}

function record($: EngineInterface, tokens: Tokens | undefined, isRateLimited: boolean): Promise<void> {
  return enqueue(() => count($, tokens, isRateLimited))
}

// Changes one model's routing stats, for this session and for all sessions.
async function countRouted(
  $: EngineInterface,
  model: string,
  add: (held: JevModelStat) => JevModelStat,
): Promise<void> {
  const change = (all: JevRouted): JevRouted => ({ ...all, [model]: add(all[model] ?? NO_STAT) })

  try {
    const total = change(asRouted(await $.store.get('routingTotal')) ?? {})
    await $.store.set('routingTotal', total)
    await update($, routed, change)
    await update($, routedAll, () => total)
    await saveSession($)
  } catch {
    // The stats are for display; routing goes on without them.
  }
}

// A lookup picked this model; `isApplied` when it was made in apply mode.
function recordPick($: EngineInterface, model: string, isApplied: boolean): Promise<void> {
  return enqueue(() =>
    countRouted($, model, held => ({
      ...held,
      picked: held.picked + 1,
      applied: held.applied + (isApplied ? 1 : 0),
    })),
  )
}

// A Claude request ran on this routed model, with the tokens it used if reported.
function recordStep($: EngineInterface, model: string, usage: TurnUsage | null): Promise<void> {
  const input = usage === null ? 0 : usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const output = usage === null ? 0 : usage.output_tokens

  return enqueue(() =>
    countRouted($, model, held => ({
      ...held,
      steps: held.steps + 1,
      inputTokens: held.inputTokens + input,
      outputTokens: held.outputTokens + output,
    })),
  )
}

// Where the lookup log is: in the Claude config folder, not in a project, since
// it holds prompt text. Undefined when no home folder can be found.
async function logPath($: EngineInterface): Promise<string | undefined> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const profile = await $.env.get('USERPROFILE')
  const home = await $.env.get('HOME')
  const base = [profile, home].find(one => one !== undefined && one !== '')
  const folder = configured !== undefined && configured !== '' ? configured : base === undefined ? undefined : `${base}/.claude`

  return folder === undefined ? undefined : `${folder.replace(/[\\/]+$/, '')}/jev-router/lookups.jsonl`
}

async function readLog($: EngineInterface, path: string): Promise<string> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : ''
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Adds one entry to the log; a failure is kept for /jev debuglog to say.
async function appendLog($: EngineInterface, entry: JevLogEntry): Promise<void> {
  try {
    const path = await logPath($)

    if (path === undefined) {
      return
    }

    let text = `${await readLog($, path)}${JSON.stringify(entry)}\n`

    if (text.length > LOG_MAX_CHARS) {
      text = text.slice(text.indexOf('\n', text.length - LOG_KEEP_CHARS) + 1)
    }

    await $.fs.write(path, text)
    await update($, logProblem, () => null)
  } catch (error) {
    const why = reasonOf(error)
    await update($, logProblem, () => why)
  }
}

function logEntry($: EngineInterface, entry: JevLogEntry): Promise<void> {
  return enqueue(() => appendLog($, entry))
}

async function setLog($: EngineInterface, which: string | undefined): Promise<string> {
  const path = await logPath($)

  if (path === undefined) {
    return 'The lookup log has nowhere to go: no home or Claude config folder was found.'
  }

  if (which === 'on' || which === 'clear') {
    try {
      await $.fs.write(path, which === 'clear' ? '' : await readLog($, path))
    } catch (error) {
      return `The lookup log was not changed: ${path} cannot be written (${reasonOf(error)}).`
    }

    if (which === 'clear') {
      return `Lookup log cleared: ${path}`
    }

    await update($, logOn, () => true)
    await update($, logProblem, () => null)

    return `Lookup log on. Each lookup (your prompt text, Jev's answers, the model picked and the tokens) is added to ${path}. /jev log shows the latest, /jev debuglog off stops it, and it starts off again in every new session.`
  }

  if (which === 'off') {
    await update($, logOn, () => false)

    return `Lookup log off. What was logged stays in ${path}; /jev debuglog clear empties it.`
  }

  const entries = parseLog(await readLog($, path).catch(() => ''))
  const wrong = await read($, logProblem)

  return [
    `Lookup log: ${(await read($, logOn)) ? 'on' : 'off'}. ${entries.length} lookups are in ${path}.`,
    ...(wrong === null ? [] : [`The last write failed: ${wrong}`]),
    '/jev debuglog on|off|clear, and /jev log [n] to read it.',
  ].join('\n')
}

async function showLog($: EngineInterface, wanted: number): Promise<string> {
  const path = await logPath($)

  if (path === undefined || !(await $.fs.exists(path))) {
    return 'No lookups are logged yet. /jev debuglog on starts the log.'
  }

  const all = parseLog(await $.fs.read(path))
  const shown = all.slice(-Math.min(Math.max(wanted, 1), LOG_SHOWN_MAX))

  if (shown.length === 0) {
    return `No lookups are logged yet in ${path}. /jev debuglog on starts the log.`
  }

  return [`The last ${shown.length} of ${all.length} logged lookups, from ${path}:`, ...shown.map(logLine)].join('\n')
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
  const savedStats = await $.store.get('isStatsShown')
  const savedUsage = await $.store.get('usageShown')
  const savedAt = await $.store.get('detailsAt')
  const savedSpend = asSpend(await $.store.get('spendTotal'))
  const savedRouted = asRouted(await $.store.get('routingTotal'))

  if (savedSpend !== undefined) {
    await update($, spendAll, () => savedSpend)
  }

  if (savedRouted !== undefined) {
    await update($, routedAll, () => savedRouted)
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

  if (typeof savedStats === 'boolean') {
    await update($, statsShown, () => savedStats)
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

  const stats = STATS.exec(word)

  if (stats !== null) {
    return stats[1] === undefined ? reportStats($) : setStats($, stats[1] === 'show')
  }

  const logSet = LOGSET.exec(word)

  if (logSet !== null) {
    return setLog($, logSet[1])
  }

  const logShow = LOGSHOW.exec(word)

  if (logShow !== null) {
    return showLog($, logShow[1] === undefined ? LOG_SHOWN : Number(logShow[1]))
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

// What one request to TypeSafe came to: its answers or why it has none, the
// HTTP status, the tokens it was billed for, how long it took, and how many
// recent messages went along with the prompt.
type Lookup = {
  judged?: Judgments
  problem?: string
  status?: number
  tokens?: Tokens
  ms: number
  recent: number
}

async function judge($: EngineInterface, text: string): Promise<Lookup> {
  const key = await $.env.get('TYPESAFE_API_KEY')

  if (key === undefined || key === '') {
    return { problem: 'TYPESAFE_API_KEY is not set', ms: 0, recent: 0 }
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
  const started = await $.clock.now()
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
  const ms = (await $.clock.now()) - started

  if (response === undefined) {
    return { problem: 'TypeSafe timed out', ms, recent: recent.length }
  }

  const { status } = response

  if (status === 429) {
    await record($, undefined, true)
  }

  if (!response.ok) {
    return { problem: `TypeSafe answered ${status}`, status, ms, recent: recent.length }
  }

  const tokens = parseUsage(response.text)
  await record($, tokens, false)
  const judged = parseAnswers(response.text)

  return judged === undefined
    ? { problem: 'TypeSafe sent an answer the router could not read', status, tokens, ms, recent: recent.length }
    : { judged, status, tokens, ms, recent: recent.length }
}

async function route(
  $: EngineInterface,
  text: string,
  now: JevMode,
  models: readonly string[],
): Promise<void> {
  let lookup: Lookup

  try {
    lookup = await judge($, text)
  } catch {
    lookup = { problem: 'TypeSafe could not be reached', ms: 0, recent: 0 }
  }

  const { judged } = lookup
  const decision = judged === undefined ? undefined : decide(judged, models, (await read($, pick))?.level)

  if (judged === undefined || decision === undefined) {
    const wrong = lookup.problem ?? 'no answer'
    armed = null
    await update($, pick, () => null)
    await update($, problem, () => wrong)
  } else {
    const detail: JevDetail = judged
    armed = now === 'apply' ? { text: text.trim(), model: decision.model } : null
    await update($, pick, () => ({ ...decision, detail }))
    await update($, problem, () => null)
    await recordPick($, decision.model, now === 'apply')
  }

  await show($)

  // The log is added to after the pick is shown, and not waited for, so it never
  // holds a turn back.
  if (await read($, logOn)) {
    void logEntry($, {
      t: new Date(await $.clock.now()).toISOString(),
      session: await $.session.id(),
      mode: now === 'apply' ? 'apply' : 'report',
      prompt: text.slice(0, PROMPT_CHARS),
      recentTurns: lookup.recent,
      ms: lookup.ms,
      status: lookup.status,
      error: lookup.problem,
      depth: judged?.depth,
      confidence: judged?.confidence,
      probabilities: judged?.probabilities,
      stakes: judged?.stakes,
      followUp: judged?.followUp,
      level: decision?.level,
      model: decision?.model,
      inputTokens: lookup.tokens?.input,
      outputTokens: lookup.tokens?.output,
    })
  }
}

export const register: Register = (on, options) => {
  const startMode: JevMode = options.defaultMode === 'apply' ? 'apply' : 'report'
  const models = parseModels(typeof options.models === 'string' ? options.models : '')
  modelOrder = models

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jev',
      description: 'Turn Jev model routing on or off for this session',
      argumentHint: '[on|off|report|apply|status|usage|stats|debug|debuglog|log|details|topband|statusband|help]',
    })
    await loadDisplay($)
    const restored = await loadSession($)
    await show($)

    if (restored !== undefined) {
      $.ui.toast(`Jev picked up where this chat left off: ${restored}`)
    }

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
    const isLogging = await read($, logOn)
    const logFailure = await read($, logProblem)
    const line = describe(now, await read($, pick), await read($, problem))
    const rows = (await read($, detailsAt)) === 'top' ? await detailRows($) : []
    const { Box, Button, Text } = $.ui.resolve(e)
    const logging = !isLogging ? '' : logFailure === null ? ' · logging' : ' · log error'

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {`${line}${logging}`}
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

  // Subagents keep their own models: only the main loop's requests are routed,
  // and each one counts toward the model it ran on.
  on('turn.step', async function* ($, e, next) {
    const bound = active

    if (e.agentId !== undefined || bound === null || bound.turnId !== e.turnId) {
      return yield* next(e)
    }

    const result = yield* next({ ...e, model: bound.model })
    await recordStep($, bound.model, result.usage)

    return result
  })
}
