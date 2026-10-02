import { describe, expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

const BAND = {
  plugin: 'cache-saver',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const SURFACES = ['terminal', 'desktop'] as const
const ROW_5M = '{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":2000}}}'

const USAGE = {
  input_tokens: 10,
  output_tokens: 490,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 19_500,
}

type World = {
  forks: number
  filled: string[]
  compacted: { role: string; text: string }[] | null
  submitted: string[]
}

// The engine beneath the plugin, recording what the plugin asked of it.
const engine = (on: On): World => {
  const world: World = { forks: 0, filled: [], compacted: null, submitted: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: { ...USAGE, model: e.model } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: ROW_5M, stderr: '' } }))
  on('classic.Stop', () => ({}))
  on('model.fork', () => {
    world.forks += 1
    return {
      value: {
        isAnswered: true as const,
        text: '## Summary\nThe user is building mods.',
        usage: { input_tokens: 50, output_tokens: 4200, cache_read_input_tokens: 119_990, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('prompt.submit', (_$, e) => {
    world.submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: {} }))
  on('ui.log', () => ({ value: {} }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.fill', (_$, e) => {
    world.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: world.filled.at(-1) ?? '', cursor: 0 } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi', toolUses: [] }] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  // The engine's own summarizer; the plugin answers above it for option B.
  on('session.compact', (_$, e) => {
    world.compacted = [{ role: 'user', text: 'engine summary' }]
    return { messages: [...(e.messages ?? [])] }
  })
  return world
}

const step = async ($: EngineInterface) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of stream);
  return stream.result
}

const gone = async ($: EngineInterface) => {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const found = await ui.find({ type: 'Text', text: /cache-saver|Prompt cache went cold/ })
  await ui.unmount()
  return found === undefined
}

describe('cache-saver', () => {
  test('summarizes before expiry and offers A/B once cold', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const world = engine(on)
    await $.session.start(START)
    await step($)
    await $.classic.Stop({ stop_hook_active: false })

    // Nothing to show while the cache is fresh.
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /cache-saver/ })).toBeUndefined()
    await ui.unmount()

    // 45s before the 5m TTL lapses the summary is built over the warm cache.
    await clock.advance(4 * 60_000 + 20_000)
    expect(world.forks).toBe(1)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /summary ready \(4k tokens\)/ })).toBeDefined()
    await ui.unmount()

    // The fork's read restarted the entry: still warm 4 minutes later, and
    // no second summary for the same idle stretch.
    await clock.advance(4 * 60_000)
    expect(world.forks).toBe(1)

    await clock.advance(2 * 60_000)
    for (const surface of SURFACES) {
      ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: 'Prompt cache went cold ' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'keep-full' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /re-cache 120k tokens/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /4k tokens \(97% smaller\)/ })).toBeDefined()
      await ui.unmount()
    }
    expect(world.forks).toBe(1)
  })

  test('B holds the typed prompt, arms /compact, and answers it with the summary', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const world = engine(on)
    await $.session.start(START)
    await step($)
    await clock.advance(4 * 60_000 + 20_000)
    await clock.advance(6 * 60_000)

    const held = await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
    expect('drop' in held && held.drop).toBeTruthy()
    expect(world.submitted).toEqual([])

    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Held: “keep going”/ })).toBeDefined()
    await ui.press({ key: 'use-summary' })
    await ui.unmount()
    expect(world.filled).toEqual(['/compact'])

    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Press Enter' })).toBeDefined()
    await ui.unmount()

    // The person's /compact: the plugin answers it, the engine's summarizer never runs.
    const result = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
    expect(world.compacted).toBe(null)
    expect(result.messages?.[0]?.text).toContain('The user is building mods.')
    expect(result.tokensAfter).toBe(4200)

    await clock.settle()
    expect(world.submitted).toEqual(['keep going'])
    expect(await gone($)).toBe(true)
  })

  test('a /compact nobody armed goes to the engine', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const world = engine(on)
    await $.session.start(START)
    await step($)
    await clock.advance(4 * 60_000 + 20_000)
    await clock.advance(6 * 60_000)

    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
    expect(world.compacted).not.toBe(null)
    expect(await gone($)).toBe(true)
  })

  test('A keeps the full session and sends the held prompt', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const world = engine(on)
    await $.session.start(START)
    await step($)
    await clock.advance(4 * 60_000 + 20_000)
    await clock.advance(6 * 60_000)

    await $.prompt.submit({ text: 'hello again', wait: false, origin: { kind: 'composer' } })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'keep-full' })
    await ui.unmount()

    expect(world.submitted).toEqual(['hello again'])
    expect(await gone($)).toBe(true)
  })

  test('small sessions are left alone', { options: { minTokens: 500_000 } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const world = engine(on)
    await $.session.start(START)
    await step($)
    await clock.advance(10 * 60_000)
    expect(world.forks).toBe(0)
  })
})
