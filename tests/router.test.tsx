import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { decide, parseAnswers, parseModels, parseUsage } from '../hooks/policy'

const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
const TYPED = { wait: false, origin: { kind: 'composer' } } as const
const SESSION = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const BAND = {
  plugin: 'jev-router',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const jevAnswer = (depth: number, stakes = 0, followUp = 0, inputTokens = 545): string =>
  JSON.stringify({
    model: 'jev-test',
    answers: {
      depth: {
        type: 'score',
        score: depth,
        confidence: 0.84,
        probabilities: { '0': 0, '1': 0.91, '2': 0.09, '3': 0 },
      },
      stakes: { type: 'noul', noul: stakes },
      follow_up: { type: 'noul', noul: followUp },
    },
    usage: { input_tokens: inputTokens, output_tokens: 71 },
  })

const command = async ($: Engine, args: string): Promise<string | undefined> => {
  const ran = await $.command.run({
    command: 'jev',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  return ran.text
}

// Each hook here stands for the engine: nothing else sits beneath the mod.
const world = (
  on: On,
  reply: { status: number; text: string },
  stored: Readonly<Record<string, unknown>> = { isStatusShown: true },
) => {
  const seen = {
    statuses: [] as (string | undefined)[],
    requests: [] as { url: string; authorization?: string; body: string }[],
    stepModels: [] as string[],
    clock: mock.clock(on),
    store: { ...stored } as Record<string, unknown>,
  }
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  on('store.get', (_, e) => ({ value: seen.store[e.key] }))
  on('store.set', (_, e) => {
    seen.store[e.key] = e.value

    return { value: undefined }
  })
  on('session.messages', () => ({ value: [] }))
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    seen.requests.push({
      url: e.url,
      authorization: e.init?.headers?.authorization,
      body: typeof e.init?.body === 'string' ? e.init.body : '',
    })

    return {
      value: {
        status: reply.status,
        ok: reply.status >= 200 && reply.status < 300,
        headers: {},
        text: reply.text,
      },
    }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // What the engine draws in the band when the mod draws nothing.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('command.register', () => ({ value: { command: 'jev' } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    seen.stepModels.push(e.model)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })

  return seen
}

const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of stream) {
    // The chunks are not what these tests read.
  }
}

test('off by default: the prompt goes through and nothing is sent to TypeSafe', async ($, on) => {
  const seen = world(on, { status: 200, text: jevAnswer(1) })

  const entered = await $.prompt.submit({ text: 'fix the failing test', ...TYPED })

  expect(entered.text).toBe('fix the failing test')
  expect(seen.requests).toEqual([])
})

test('jev on is answered by the mod, and report mode shows the pick without routing', async ($, on) => {
  const seen = world(on, { status: 200, text: jevAnswer(1) })
  await $.session.start(SESSION)

  const toggled = await $.prompt.submit({ text: 'jev on', ...TYPED })
  expect(toggled.drop).toBe('Jev: on (report)')

  await $.prompt.submit({ text: 'add a retry to the upload call', ...TYPED })
  await seen.clock.settle()

  expect(seen.requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(seen.requests[0]?.authorization).toBe('Bearer test-key')
  expect(seen.requests[0]?.body).toContain('add a retry to the upload call')
  expect(seen.statuses.at(-1)).toBe('Jev: on (report) → sonnet')

  await $.turn.start({ text: 'add a retry to the upload call', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  expect(seen.stepModels).toEqual(['opus'])
})

test('apply mode runs the main loop of that turn on the picked model', async ($, on) => {
  const seen = world(on, { status: 200, text: jevAnswer(0) })
  await $.session.start(SESSION)

  await $.prompt.submit({ text: 'jev apply', ...TYPED })
  await $.prompt.submit({ text: 'rename this variable', ...TYPED })
  await $.turn.start({ text: 'rename this variable', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'opus', messageCount: 3, agentId: 'a1' }))
  await drain($.turn.step({ turnId: 't2', index: 0, model: 'opus', messageCount: 5 }))

  expect(seen.stepModels).toEqual(['haiku', 'opus', 'opus'])
  expect(seen.statuses.at(-1)).toBe('Jev: on (apply) → haiku')
})

test('a failed lookup says so and leaves the turn on the session model', async ($, on) => {
  const seen = world(on, { status: 401, text: '{"detail":"bad key"}' })
  await $.session.start(SESSION)

  await $.prompt.submit({ text: 'jev apply', ...TYPED })
  const entered = await $.prompt.submit({ text: 'rename this variable', ...TYPED })
  await $.turn.start({ text: 'rename this variable', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))

  expect(entered.text).toBe('rename this variable')
  expect(seen.stepModels).toEqual(['opus'])
  expect(seen.statuses.at(-1)).toBe('Jev: on (apply) · no pick: TypeSafe answered 401')
})

test('jev off stops the lookups', async ($, on) => {
  const seen = world(on, { status: 200, text: jevAnswer(2) })

  await $.prompt.submit({ text: 'jev on', ...TYPED })
  const toggled = await $.prompt.submit({ text: 'Jev Off', ...TYPED })
  await $.prompt.submit({ text: 'why does the cache miss?', ...TYPED })
  await seen.clock.settle()

  expect(toggled.drop).toBe('Jev: off')
  expect(seen.requests).toEqual([])
})

test('each indicator hides and shows on its own, and the choice is kept', async ($, on) => {
  const seen = world(on, { status: 200, text: jevAnswer(1) }, {})
  await $.session.start(SESSION)

  // With nothing stored: the band draws, the status line does not.
  expect(seen.statuses.at(-1)).toBeUndefined()
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Jev/ })).toBeDefined()
  await ui.unmount()

  const shown = await $.prompt.submit({ text: 'jev statusband show', ...TYPED })
  expect(shown.drop).toBe('Status band shown.')
  expect(seen.statuses.at(-1)).toBe('Jev: off')

  const hidden = await $.prompt.submit({ text: 'jev topband hide', ...TYPED })
  expect(hidden.drop).toBe('Top band hidden. /jev topband show brings it back.')
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Jev/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()

  expect(seen.store).toEqual({ isBandShown: false, isStatusShown: true })
})

test('/jev runs the same commands, and help lists them', async ($, on) => {
  world(on, { status: 200, text: jevAnswer(1) })
  const run = (args: string) => command($, args)

  expect(await run('apply')).toBe('Jev: on (apply)')
  expect(await run('statusband  hide')).toBe('Status band hidden. /jev statusband show brings it back.')

  const listed = (await run('help')) ?? ''
  expect(listed).toContain('Now: Jev: on (apply)')
  expect(listed).toContain('/jev statusband show|hide')
  expect(listed).toContain('models by difficulty haiku, sonnet, opus, fable')
  // A bare /jev and a word it does not know answer with the same list.
  expect(await run('')).toBe(listed)
  expect(await run('nonsense')).toBe(listed)
})

test('/jev usage counts what the lookups used at TypeSafe, this session and in all', async ($, on) => {
  const earlier = { requests: 10, inputTokens: 1_000_000, outputTokens: 5000, rateLimited: 1 }
  const seen = world(on, { status: 200, text: jevAnswer(1, 0, 0, 5_000_000) }, { spendTotal: earlier })
  await $.session.start(SESSION)

  const before = (await command($, 'usage')) ?? ''
  expect(before).toContain('This session: 0 requests, 0 input tokens, 0 output tokens, about $0\n')
  expect(before).toContain('All sessions: 10 requests, 1000000 input tokens, 5000 output tokens, about $0.0420\n')
  expect(before).toContain('Rate-limited by TypeSafe: 0 times this session, 1 time in all\n')
  expect(before).toContain('$0.042 per million input tokens; output tokens are free')
  expect(before).toContain('console.typesafe.ai/rate-limits')

  // Two lookups in flight at once are both counted.
  await command($, 'on')
  await $.prompt.submit({ text: 'add a retry to the upload call', ...TYPED })
  await $.prompt.submit({ text: 'and log each attempt', ...TYPED })
  await seen.clock.settle()

  const after = (await command($, 'usage')) ?? ''
  expect(after).toContain('This session: 2 requests, 10000000 input tokens, 142 output tokens, about $0.4200\n')
  expect(after).toContain('All sessions: 12 requests, 11000000 input tokens, 5142 output tokens, about $0.4620\n')
  expect(seen.store.spendTotal).toEqual({
    requests: 12,
    inputTokens: 11_000_000,
    outputTokens: 5142,
    rateLimited: 1,
  })
})

test('a request TypeSafe rate-limits is counted apart, and still leaves the turn alone', async ($, on) => {
  const seen = world(on, { status: 429, text: '{"detail":"slow down"}' })
  await $.session.start(SESSION)
  await command($, 'apply')

  const entered = await $.prompt.submit({ text: 'rename this variable', ...TYPED })

  expect(entered.text).toBe('rename this variable')
  expect(seen.statuses.at(-1)).toBe('Jev: on (apply) · no pick: TypeSafe answered 429')
  expect(await command($, 'usage')).toContain('Rate-limited by TypeSafe: 1 time this session, 1 time in all')
  expect(await command($, 'usage')).toContain('This session: 0 requests, 0 input tokens')
})

test('a TypeSafe figure and the debug values join the status band, and are kept', async ($, on) => {
  const stored = { isStatusShown: true, detailsAt: 'status' }
  const seen = world(on, { status: 200, text: jevAnswer(1, 0, 0, 5_000_000) }, stored)
  await $.session.start(SESSION)

  expect(await command($, 'usage money')).toBe('TypeSafe usage on the status band: money.')
  expect(seen.statuses.at(-1)).toBe('Jev: off | TypeSafe $0 this session, $0 in all')
  await command($, 'usage hide')
  await command($, 'on')
  await command($, 'usage money')
  await $.prompt.submit({ text: 'add a retry to the upload call', ...TYPED })
  await seen.clock.settle()
  expect(seen.statuses.at(-1)).toBe(
    'Jev: on (report) → sonnet | TypeSafe $0.2100 this session, $0.2100 in all',
  )
  await command($, 'usage tokens')
  expect(seen.statuses.at(-1)).toBe(
    'Jev: on (report) → sonnet | TypeSafe 5M input tokens this session, 5M in all',
  )
  await command($, 'usage limits')
  expect(seen.statuses.at(-1)).toBe(
    'Jev: on (report) → sonnet | TypeSafe rate-limited 0 times this session, 0 times in all',
  )
  expect(await command($, 'usage hide')).toBe('TypeSafe usage hidden.')
  expect(seen.statuses.at(-1)).toBe('Jev: on (report) → sonnet')
  await command($, 'off')

  expect(await command($, 'debug show')).toBe('Debug values shown on the status band after each lookup.')
  await command($, 'on')
  await $.prompt.submit({ text: 'add a retry to the upload call', ...TYPED })
  await seen.clock.settle()
  expect(seen.statuses.at(-1)).toBe(
    'Jev: on (report) → sonnet | depth 1.00, confidence 0.84, p 0/91/9/0% · stakes 0.00 · follow-up 0.00 · level 1',
  )

  await command($, 'debug hide')
  expect(seen.statuses.at(-1)).toBe('Jev: on (report) → sonnet')
  expect(seen.store).toEqual({
    isStatusShown: true,
    detailsAt: 'status',
    usageShown: 'hide',
    isDebugShown: false,
    spendTotal: { requests: 2, inputTokens: 10_000_000, outputTokens: 142, rateLimited: 0 },
  })

  // With the status band hidden, the answer says where the figure would show.
  await command($, 'statusband hide')
  expect(await command($, 'usage money')).toBe(
    'TypeSafe usage on the status band: money. The status band is hidden: /jev statusband show shows it.',
  )
})

test('the debug values and the usage figure show on the top band by default, and can move to the status line', async ($, on) => {
  const seen = world(on, { status: 200, text: jevAnswer(1, 0, 0, 5_000_000) })
  await $.session.start(SESSION)
  const debugRow = 'depth 1.00, confidence 0.84, p 0/91/9/0% · stakes 0.00 · follow-up 0.00 · level 1'
  const usageRow = 'TypeSafe $0.2100 this session, $0.2100 in all'

  expect(await command($, 'debug show')).toBe('Debug values shown on the top band after each lookup.')
  expect(await command($, 'usage money')).toBe('TypeSafe usage on the top band: money.')
  await command($, 'on')
  await $.prompt.submit({ text: 'add a retry to the upload call', ...TYPED })
  await seen.clock.settle()

  // The status line stays short; the band has one row for each detail.
  expect(seen.statuses.at(-1)).toBe('Jev: on (report) → sonnet')
  const onBand = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await onBand.find({ type: 'Text', text: /depth/ }))?.text).toBe(debugRow)
  expect((await onBand.find({ type: 'Text', text: /TypeSafe/ }))?.text).toBe(usageRow)
  // The buttons are drawn the same with or without the detail rows.
  expect(await onBand.find({ key: 'mode' })).toBeDefined()
  expect(await onBand.find({ key: 'power' })).toBeDefined()
  await onBand.unmount()

  // Moved to the status line, they follow the routing text and leave the band.
  expect(await command($, 'details status')).toBe(
    'The debug values and the TypeSafe usage figure now show on the status band.',
  )
  expect(seen.statuses.at(-1)).toBe(`Jev: on (report) → sonnet | ${debugRow} | ${usageRow}`)
  const offBand = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await offBand.find({ type: 'Text', text: /depth/ })).toBeUndefined()
  expect(await offBand.find({ key: 'mode' })).toBeDefined()
  expect(await offBand.find({ key: 'power' })).toBeDefined()
  await offBand.unmount()
  expect(seen.store.detailsAt).toBe('status')

  // A hidden band says so.
  await command($, 'details top')
  await command($, 'topband hide')
  expect(await command($, 'debug show')).toBe(
    'Debug values shown on the top band after each lookup. The top band is hidden: /jev topband show shows it.',
  )
})

test('a session starts with the stored choice', async ($, on) => {
  const seen = world(on, { status: 200, text: jevAnswer(1) }, { isBandShown: false, isStatusShown: true })
  await $.session.start(SESSION)

  expect(seen.statuses.at(-1)).toBe('Jev: off')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Jev/ })).toBeUndefined()
  await ui.unmount()
})

test('the band has one button that flips the mode and one that turns routing on and off', async ($, on) => {
  world(on, { status: 200, text: jevAnswer(1) })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = async () => (await ui.find({ type: 'Text', text: /Jev/ }))?.text
    const label = async (key: string) => (await ui.find({ key }))?.text

    expect(await line()).toBe('Jev: off')
    expect(await label('mode')).toBe('Mode: Report only')
    expect(await label('power')).toBe('Turn on')

    // Flipping the mode while off only picks it.
    await ui.press({ key: 'mode' })
    expect(await label('mode')).toBe('Mode: Apply')
    expect(await line()).toBe('Jev: off')

    await ui.press({ key: 'power' })
    expect(await line()).toBe('Jev: on (apply)')
    expect(await label('power')).toBe('Turn off')

    // Flipping the mode while on switches to it.
    await ui.press({ key: 'mode' })
    expect(await label('mode')).toBe('Mode: Report only')
    expect(await line()).toBe('Jev: on (report)')

    // Off and on again keeps the mode picked.
    await ui.press({ key: 'power' })
    expect(await line()).toBe('Jev: off')
    await ui.press({ key: 'power' })
    expect(await line()).toBe('Jev: on (report)')

    await ui.press({ key: 'power' })
    await ui.unmount()
  }
})

test('/jev on turns routing on in the mode last picked', async ($, on) => {
  world(on, { status: 200, text: jevAnswer(1) })

  expect(await command($, 'on')).toBe('Jev: on (report)')
  expect(await command($, 'apply')).toBe('Jev: on (apply)')
  expect(await command($, 'off')).toBe('Jev: off')
  expect(await command($, 'on')).toBe('Jev: on (apply)')
})

test('the policy maps the judgments to a level and a model', () => {
  const calm = { stakes: 0, followUp: 0 }

  expect(decide({ depth: 0.2, ...calm }, MODELS)).toEqual({ level: 0, model: 'haiku' })
  expect(decide({ depth: 1.5, ...calm }, MODELS)).toEqual({ level: 2, model: 'opus' })
  expect(decide({ depth: 3, ...calm }, MODELS)).toEqual({ level: 3, model: 'fable' })
  // High stakes move the pick up one level, never past the top.
  expect(decide({ depth: 0.2, stakes: 0.9, followUp: 0 }, MODELS).model).toBe('sonnet')
  expect(decide({ depth: 3, stakes: 0.9, followUp: 0 }, MODELS).level).toBe(3)
  // A follow-up never drops below the level of the turn it continues.
  expect(decide({ depth: 0, stakes: 0, followUp: 0.9 }, MODELS, 2).model).toBe('opus')
  expect(decide({ depth: 0, stakes: 0, followUp: 0.1 }, MODELS, 2).model).toBe('haiku')
  // A shorter model list: its last model covers the higher levels.
  expect(decide({ depth: 3, ...calm }, ['haiku', 'sonnet']).model).toBe('sonnet')
})

test('answers and settings the router cannot read are declined', () => {
  expect(parseAnswers('not json')).toBeUndefined()
  expect(parseAnswers('{"answers":{"depth":{"score":1}}}')).toBeUndefined()
  expect(parseAnswers(jevAnswer(7))).toBeUndefined()
  expect(parseAnswers(jevAnswer(1.4, 0.3, 0.8))).toEqual({
    depth: 1.4,
    stakes: 0.3,
    followUp: 0.8,
    confidence: 0.84,
    probabilities: [0, 0.91, 0.09, 0],
  })
  // What a request was billed for is read apart from the answers.
  expect(parseUsage(jevAnswer(1))).toEqual({ input: 545, output: 71 })
  expect(parseUsage('{"answers":{}}')).toBeUndefined()
  expect(parseUsage('not json')).toBeUndefined()
  // An answer with only the three judgments still routes.
  expect(parseAnswers('{"answers":{"depth":{"score":1},"stakes":{"noul":0},"follow_up":{"noul":1}}}')).toEqual({
    depth: 1,
    stakes: 0,
    followUp: 1,
  })
  expect(parseModels(' haiku , opus ')).toEqual(['haiku', 'opus'])
  expect(parseModels('')).toEqual(MODELS)
})
