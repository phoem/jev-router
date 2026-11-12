// The routing policy: what Jev is asked, and how its answers become a model.
// Pure functions, so the thresholds can be tuned and tested without a session.

export const JEV_MODEL = 'jev-latest'

// A mistake this likely to be costly moves the pick up one level.
export const STAKES_THRESHOLD = 0.6

// A prompt this likely to continue the task under way never picks a lower
// level than the turn before it.
export const FOLLOW_UP_THRESHOLD = 0.6

export const DEFAULT_MODELS = ['haiku', 'sonnet', 'opus', 'fable']

const LEVELS = [
  'A mechanical task or a direct lookup: renaming, reformatting, running a given command, reading out a value, a yes/no or one-line factual answer',
  'A routine, well-specified task: a small feature, a bug with a known cause, a clear explanation, edits that follow an obvious pattern in a few files',
  'A task that needs careful multi-step reasoning: a bug with an unknown cause, a design choice with trade-offs, a change across components that interact, or a request that must be interpreted before it can be done',
  'A task at the limit of difficulty: a new architecture, subtle concurrency, security or correctness problems, long planning across a large codebase, or deep research and analysis',
]

export type Turn = { role: 'user' | 'assistant'; text: string }

// `confidence` and `probabilities` describe the depth Score and are shown, not
// used by the policy.
export type Judgments = {
  depth: number
  stakes: number
  followUp: number
  confidence?: number
  probabilities?: number[]
}

export type Tokens = { input: number; output: number }

// What a request was billed for, read from any answered request.
export const parseUsage = (body: string): Tokens | undefined => {
  let parsed: unknown

  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }

  const { input_tokens: input, output_tokens: output } =
    (parsed as { usage?: Record<string, unknown> } | null)?.usage ?? {}

  return typeof input === 'number' && typeof output === 'number' ? { input, output } : undefined
}

export type Decision = { level: number; model: string }

export const buildRequest = (prompt: string, recent: readonly Turn[]) => ({
  model: JEV_MODEL,
  state: { prompt, recent_conversation: recent },
  questions: {
    depth: {
      type: 'score',
      instructions:
        'How much reasoning does the work requested in `prompt` need from the AI coding assistant that will carry it out? When `prompt` is a short follow-up such as "yes", "continue" or "do it", judge the work it tells the assistant to carry on with from `recent_conversation`.',
      criteria: LEVELS,
    },
    stakes: {
      type: 'noul',
      instructions:
        'Would a mistake in carrying out `prompt` be costly or hard to undo?',
      criteria: {
        true: 'It changes production systems, deletes or overwrites data, touches security-sensitive code, moves money, or sends messages to other people',
        false: 'A mistake would be cheap to notice and easy to undo',
      },
    },
    follow_up: {
      type: 'noul',
      instructions:
        'Does `prompt` continue the task already under way in `recent_conversation`, rather than start a new, self-contained task?',
      criteria: {
        true: 'An approval, a correction, an answer to a question the assistant asked, or the next small step of the same task',
        false: 'A new request that can be understood without `recent_conversation`, or there is no earlier conversation',
      },
    },
  },
})

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && value >= 0 && value <= 1

export const parseAnswers = (body: string): Judgments | undefined => {
  let parsed: unknown

  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }

  const answers = (parsed as { answers?: Record<string, Record<string, unknown>> } | null)?.answers
  const depth = answers?.depth?.score
  const stakes = answers?.stakes?.noul
  const followUp = answers?.follow_up?.noul
  const isDepth = typeof depth === 'number' && depth >= 0 && depth <= LEVELS.length - 1

  if (!isDepth || !isUnit(stakes) || !isUnit(followUp)) {
    return undefined
  }

  // The rest is for display: an answer without it still routes.
  const judged: Judgments = { depth, stakes, followUp }
  const confidence = answers?.depth?.confidence
  const spread = answers?.depth?.probabilities as Record<string, unknown> | undefined
  const probabilities = LEVELS.map((_, level) => spread?.[String(level)])

  if (isUnit(confidence)) {
    judged.confidence = confidence
  }

  if (probabilities.every(isUnit)) {
    judged.probabilities = probabilities
  }

  return judged
}

export const parseModels = (setting: string): string[] => {
  const models = setting
    .split(',')
    .map(model => model.trim())
    .filter(model => model !== '')

  return models.length > 0 ? models : DEFAULT_MODELS
}

export const decide = (
  judged: Judgments,
  models: readonly string[],
  previousLevel?: number,
): Decision => {
  const top = LEVELS.length - 1
  // The nearest level to the score, a tie going up.
  let level = Math.floor(judged.depth + 0.5)

  if (judged.stakes >= STAKES_THRESHOLD) {
    level += 1
  }

  if (judged.followUp >= FOLLOW_UP_THRESHOLD && previousLevel !== undefined) {
    level = Math.max(level, previousLevel)
  }

  level = Math.min(Math.max(level, 0), top)
  const model = models[Math.min(level, models.length - 1)] ?? 'sonnet'

  return { level, model }
}
