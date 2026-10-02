import { describe, expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { bigDigits, fmtAgo, fmtClock, fmtShot, prefixOf, ttlFromTranscript } from '../hooks/clock'

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

const HINT = {
  plugin: 'cache-shot-clock',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: 'auto mode on · 1 shell' },
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
const engine = (on: On, transcript: () => string, toasts: string[] = []) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: { ...USAGE, model: e.model } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: transcript(), stderr: '' } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: {} }
  })
  on('classic.Stop', () => ({}))
  // The hint row as the engine draws it: its line, then any tail.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tail ? `${e.props.hint} · ${e.props.tail}` : e.props.hint}</Text>
  })
  // What the band shows beneath the mod: nothing of its own.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

type Mounted = { find: (q: { type: 'Text'; text: string | RegExp }) => Promise<unknown> }

// Whether the panel's three LED rows read `shot`.
const reads = async (ui: Mounted, shot: string) => {
  for (const row of bigDigits(shot)) {
    if ((await ui.find({ type: 'Text', text: row })) === undefined) return false
  }
  return true
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

  test('reads like an arena shot clock', async () => {
    expect(fmtShot(300_000)).toBe('5:00')
    expect(fmtShot(45_200)).toBe('46')
    expect(fmtShot(9_420)).toBe('9.5')
    expect(fmtShot(100)).toBe('0.1')
    expect(fmtShot(0)).toBe('0.0')
    expect(bigDigits('24')).toEqual(['▀▀█ █ █', '█▀▀ ▀▀█', '▀▀▀   ▀'])
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

// What the hint row reads with the mod's tail.
const HINT_LINE = (clock: string) => `auto mode on · 1 shell · ⏱ ${clock}`

describe('bar', () => {
  test('nothing until the first response', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    engine(on, () => '')
    await $.session.start(START)
    for (const surface of SURFACES) {
      let ui = await $.ui.mount({ ...HINT, surface })
      expect(await ui.find({ type: 'Text', text: 'auto mode on · 1 shell' })).toBeDefined()
      await ui.unmount()
      ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /SHOT CLOCK/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('just the clock in the bar, no band, while there is time', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_5M)
    await $.session.start(START)
    await step($)
    await $.classic.Stop({ stop_hook_active: false })

    for (const surface of SURFACES) {
      let ui = await $.ui.mount({ ...HINT, surface })
      expect(await ui.find({ type: 'Text', text: HINT_LINE('05:00') })).toBeDefined()
      await ui.unmount()
      ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /SHOT CLOCK/ })).toBeUndefined()
      await ui.unmount()
    }

    await clock.advance(4 * 60_000)
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: HINT_LINE('01:00') })).toBeDefined()
    await ui.unmount()
  })

  test('learns a 1h TTL from the transcript', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_1H)
    await $.session.start(START)
    await step($)
    await $.classic.Stop({ stop_hook_active: false })
    await clock.advance(10 * 60_000)

    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: HINT_LINE('50:00') })).toBeDefined()
    await ui.unmount()
  })

  test('a subagent step leaves the clock alone', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_5M)
    await $.session.start(START)
    await step($)
    await clock.advance(60_000)
    await step($, 'agent-1')

    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: HINT_LINE('04:00') })).toBeDefined()
    await ui.unmount()
  })

  test('forced TTL wins over the transcript', { options: { ttl: '1h' } }, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_5M)
    await $.session.start(START)
    await step($)
    await $.classic.Stop({ stop_hook_active: false })

    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: HINT_LINE('60:00') })).toBeDefined()
    await ui.unmount()
  })
})

describe('big clock', () => {
  test('takes over for the last 15 seconds, tenths at the end, then the buzzer', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const toasts: string[] = []
    engine(on, () => ROW_5M, toasts)
    await $.session.start(START)
    await step($)
    await $.classic.Stop({ stop_hook_active: false })

    await clock.advance(5 * 60_000 - 15_000)
    for (const surface of SURFACES) {
      let ui = await $.ui.mount({ ...BAND, surface })
      expect(await reads(ui, '15')).toBe(true)
      expect(await ui.find({ type: 'Text', text: 'SHOT CLOCK' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '121k tokens on the line' })).toBeDefined()
      await ui.unmount()
      // The bar steps aside while the big clock is up.
      ui = await $.ui.mount({ ...HINT, surface })
      expect(await ui.find({ type: 'Text', text: 'auto mode on · 1 shell' })).toBeDefined()
      await ui.unmount()
    }

    await clock.advance(10_700)
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await reads(ui, '4.3')).toBe(true)
    await ui.unmount()

    await clock.advance(5_000)
    expect(toasts.some(t => t.startsWith('BZZZT!'))).toBe(true)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'SHOT CLOCK VIOLATION' })).toBeDefined()
    expect(await reads(ui, '0.0')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /re-writes 121k tokens/ })).toBeDefined()
    await ui.unmount()

    // Ten seconds past the buzzer it folds back into the bar.
    await clock.advance(10_000)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /SHOT CLOCK/ })).toBeUndefined()
    await ui.unmount()
    ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: HINT_LINE('00:00') })).toBeDefined()
    await ui.unmount()
  })

  test('a hit after a 5m gap proves 1h and restarts the clock', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, () => '')
    await $.session.start(START)
    await step($)
    await clock.advance(6 * 60_000)
    // The stub's response still read 100k from the cache six minutes on.
    await step($)
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: HINT_LINE('60:00') })).toBeDefined()
    await ui.unmount()
  })

  test('bigAt 0 keeps it to the bar', { options: { bigAt: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_5M)
    await $.session.start(START)
    await step($)
    await clock.advance(5 * 60_000 - 5_000)
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /SHOT CLOCK/ })).toBeUndefined()
    await ui.unmount()
    ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: HINT_LINE('00:05') })).toBeDefined()
    await ui.unmount()
  })

  test('off in /config: no bar clock, no big clock', { options: { enabled: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on, () => ROW_5M)
    await $.session.start(START)
    await step($)
    await clock.advance(5 * 60_000 - 5_000)
    let ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'auto mode on · 1 shell' })).toBeDefined()
    await ui.unmount()
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /SHOT CLOCK/ })).toBeUndefined()
    await ui.unmount()
  })

  test('testTtlSeconds counts down from a short test TTL', { options: { testTtlSeconds: 30 } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const toasts: string[] = []
    engine(on, () => ROW_1H, toasts)
    await $.session.start(START)
    await step($)
    await $.classic.Stop({ stop_hook_active: false })

    let ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: HINT_LINE('00:30') })).toBeDefined()
    await ui.unmount()

    await clock.advance(18_000)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await reads(ui, '12')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /30s test TTL/ })).toBeDefined()
    await ui.unmount()

    await clock.advance(13_000)
    expect(toasts.some(t => t.startsWith('BZZZT!'))).toBe(true)
    // No "60 seconds left" warning on a clock shorter than that.
    expect(toasts.some(t => t.startsWith('Shot clock:'))).toBe(false)
  })
})
