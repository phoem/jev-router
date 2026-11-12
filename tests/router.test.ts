import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { decide, parseAnswers, parseModels } from '../hooks/policy'

const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
const TYPED = { wait: false, origin: { kind: 'composer' } } as const

const jevAnswer = (depth: number, stakes = 0, followUp = 0): string =>
  JSON.stringify({
    model: 'jev-test',
    answers: {
      depth: { type: 'score', score: depth },
      stakes: { type: 'noul', noul: stakes },
      follow_up: { type: 'noul', noul: followUp },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  })

// Each hook here stands for the engine: nothing else sits beneath the mod.
const world = (on: On, reply: { status: number; text: string }) => {
  const seen = {
    statuses: [] as (string | undefined)[],
    requests: [] as { url: string; authorization?: string; body: string }[],
    stepModels: [] as string[],
    clock: mock.clock(on),
  }
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
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

  const toggled = await $.prompt.submit({ text: 'jev on', ...TYPED })
  expect(toggled.drop).toBe('Jev: on (report only)')

  await $.prompt.submit({ text: 'add a retry to the upload call', ...TYPED })
  await seen.clock.settle()

  expect(seen.requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(seen.requests[0]?.authorization).toBe('Bearer test-key')
  expect(seen.requests[0]?.body).toContain('add a retry to the upload call')
  expect(seen.statuses.at(-1)).toBe('Jev: on (report only) · would pick sonnet')

  await $.turn.start({ text: 'add a retry to the upload call', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  expect(seen.stepModels).toEqual(['opus'])
})

test('apply mode runs the main loop of that turn on the picked model', async ($, on) => {
  const seen = world(on, { status: 200, text: jevAnswer(0) })

  await $.prompt.submit({ text: 'jev apply', ...TYPED })
  await $.prompt.submit({ text: 'rename this variable', ...TYPED })
  await $.turn.start({ text: 'rename this variable', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'opus', messageCount: 3, agentId: 'a1' }))
  await drain($.turn.step({ turnId: 't2', index: 0, model: 'opus', messageCount: 5 }))

  expect(seen.stepModels).toEqual(['haiku', 'opus', 'opus'])
  expect(seen.statuses.at(-1)).toBe('Jev: on (routing) · this turn runs on haiku')
})

test('a failed lookup says so and leaves the turn on the session model', async ($, on) => {
  const seen = world(on, { status: 401, text: '{"detail":"bad key"}' })

  await $.prompt.submit({ text: 'jev apply', ...TYPED })
  const entered = await $.prompt.submit({ text: 'rename this variable', ...TYPED })
  await $.turn.start({ text: 'rename this variable', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }))

  expect(entered.text).toBe('rename this variable')
  expect(seen.stepModels).toEqual(['opus'])
  expect(seen.statuses.at(-1)).toBe('Jev: on (routing) · no pick: TypeSafe answered 401')
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
  expect(parseAnswers(jevAnswer(1.4, 0.3, 0.8))).toEqual({ depth: 1.4, stakes: 0.3, followUp: 0.8 })
  expect(parseModels(' haiku , opus ')).toEqual(['haiku', 'opus'])
  expect(parseModels('')).toEqual(MODELS)
})
