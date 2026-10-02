import { describe, expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { fmtAgo, fmtClock, prefixOf, ttlFromTranscript } from '../hooks/clock'

const BAND = {
  plugin: 'cache-shot-clock',
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

const USAGE = {
  input_tokens: 10,
  output_tokens: 500,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 20_000,
}

const ROW_5M = '{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":2000}}}'
const ROW_1H = '{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":2000,"ephemeral_5m_input_tokens":0}}}'
const ROW_NONE = '{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}}}'

// The engine beneath the plugin: one model response per step, and a
// transcript whose tail `transcript()` names.
const engine = (on: On, transcript: () => string) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: { ...USAGE, model: e.model } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: transcript(), stderr: '' } }))
  on('ui.toast', () => ({ value: {} }))
  on('classic.Stop', () => ({}))
  // What the band shows beneath the mod: nothing of its own.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const step = async ($: EngineInterface, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId })
  for await (const _ of stream);
  return stream.result
}

describe('helpers', () => {
  test('formats the clock', async () => {
    expect(fmtClock(300_000)).toBe('5:00')
    expect(fmtClock(61_001)).toBe('1:02')
    expect(fmtClock(3_600_000)).toBe('60:00')
    expect(fmtClock(3_661_000)).toBe('1:01:01')
    expect(fmtClock(-5)).toBe('0:00')
    expect(fmtAgo(45_000)).toBe('45s')
    expect(fmtAgo(3 * 60_000)).toBe('3m')
    expect(fmtAgo(65 * 60_000)).toBe('1h 5m')
  })

  test('prefix is everything the next request re-sends', async () => {
    expect(prefixOf(USAGE)).toBe(120_510)
  })

  test('reads the TTL from the newest write in the transcript', async () => {
    expect(ttlFromTranscript('')).toBe(null)
    expect(ttlFromTranscript(ROW_5M)).toBe('5m')
    expect(ttlFromTranscript([ROW_5M, ROW_1H, ROW_NONE].join('\n'))).toBe('1h')
    expect(ttlFromTranscript([ROW_1H, ROW_5M].join('\n'))).toBe('5m')
  })
})

describe('band', () => {
  test('hidden until the first response', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    engine(on, () => '')
    await $.session.start(START)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('counts down a 5m cache and goes cold', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_5M)
    await $.session.start(START)
    await step($)
    await $.classic.Stop({ stop_hook_active: false })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: '5:00' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /5m TTL · 121k tokens warm/ })).toBeDefined()
      await ui.unmount()
    }

    await clock.advance(4 * 60_000)
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '1:00' })).toBeDefined()
    await ui.unmount()

    await clock.advance(2 * 60_000)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'cold' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /for 1m · next turn re-writes/ })).toBeDefined()
    await ui.unmount()

    // A new response restarts the clock. This one still read 100k from the
    // cache six minutes on, which only a 1h entry survives.
    await step($)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '60:00' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1h TTL/ })).toBeDefined()
    await ui.unmount()
  })

  test('learns a 1h TTL from the transcript', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_1H)
    await $.session.start(START)
    await step($)
    await $.classic.Stop({ stop_hook_active: false })
    await clock.advance(10 * 60_000)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '50:00' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1h TTL/ })).toBeDefined()
    await ui.unmount()
  })

  test('a subagent step leaves the clock alone', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_5M)
    await $.session.start(START)
    await step($)
    await clock.advance(60_000)
    await step($, 'agent-1')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '4:00' })).toBeDefined()
    await ui.unmount()
  })

  test('forced TTL wins over the transcript', { options: { ttl: '1h' } }, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_5M)
    await $.session.start(START)
    await step($)
    await $.classic.Stop({ stop_hook_active: false })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '60:00' })).toBeDefined()
    await ui.unmount()
  })
})
