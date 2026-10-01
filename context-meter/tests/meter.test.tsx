import { describe, expect, test } from 'claude-code/testing'
import type { On, SessionContextUsage } from 'claude-code'

import { bar, colorFor, compact } from '../hooks/meter'

const BAND = {
  plugin: 'context-meter',
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

// Answers what the engine would beneath the plugins, the window's fill read
// from `fill()` so a test can move it.
const engine = (on: On, fill: () => SessionContextUsage) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context: fill(), rateLimits: [] } }))
  // What the band shows when the mod passes (a survey's turn).
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>survey</Text>
      </Box>
    )
  })
}

describe('colors', () => {
  test('green when empty, red when full, amber-ish in between', async () => {
    expect(colorFor(0)).toBe('#13ec13')
    expect(colorFor(100)).toBe('#ec1313')
    expect(colorFor(-5)).toBe(colorFor(0))
    expect(colorFor(150)).toBe(colorFor(100))

    // Red channel rises and green falls as the window fills.
    const red = (hex: string) => parseInt(hex.slice(1, 3), 16)
    const green = (hex: string) => parseInt(hex.slice(3, 5), 16)
    let prev = colorFor(0)
    for (let p = 10; p <= 100; p += 10) {
      const c = colorFor(p)
      expect(red(c) >= red(prev)).toBe(true)
      expect(green(c) <= green(prev)).toBe(true)
      prev = c
    }
  })

  test('bar fills proportionally', async () => {
    expect(bar(0, 20)).toEqual({ filled: '', empty: '░'.repeat(20) })
    expect(bar(50, 20)).toEqual({ filled: '█'.repeat(10), empty: '░'.repeat(10) })
    expect(bar(100, 20)).toEqual({ filled: '█'.repeat(20), empty: '' })
  })

  test('token counts read compactly', async () => {
    expect(compact(950)).toBe('950')
    expect(compact(84_321)).toBe('84k')
    expect(compact(200_000)).toBe('200k')
    expect(compact(1_000_000)).toBe('1M')
    expect(compact(1_250_000)).toBe('1.3M')
  })
})

describe('band', () => {
  test('waits for a response before showing a reading', async ($, on) => {
    engine(on, () => ({ window: 200_000 }))
    await $.session.start(START)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /waiting for a response/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('shows the percent and recolors as the window fills', async ($, on) => {
    let context: SessionContextUsage = { window: 200_000, tokens: 20_000, percent: 10 }
    engine(on, () => context)
    await $.session.start(START)

    for (const surface of SURFACES) {
      context = { window: 200_000, tokens: 20_000, percent: 10 }
      await $.session.measure({ context, rateLimits: [], changed: ['context'] })
      const ui = await $.ui.mount({ ...BAND, surface })

      const low = await ui.find({ type: 'Text', text: /10%/ })
      expect(low?.props.color).toBe(colorFor(10))
      expect(await ui.find({ type: 'Text', text: /20k \/ 200k tokens/ })).toBeDefined()

      context = { window: 200_000, tokens: 190_000, percent: 95 }
      await $.session.measure({ context, rateLimits: [], changed: ['context'] })

      const high = await ui.find({ type: 'Text', text: /95%/ })
      expect(high?.props.color).toBe(colorFor(95))
      expect(await ui.find({ type: 'Text', text: /190k \/ 200k tokens/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('steps aside for a survey', async ($, on) => {
    engine(on, () => ({ window: 200_000, tokens: 20_000, percent: 10 }))
    await $.session.start(START)

    const ui = await $.ui.mount({
      ...BAND,
      surface: 'terminal',
      props: { ...BAND.props, hasSurvey: true },
    })
    expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'survey' })).toBeDefined()
    await ui.unmount()
  })
})
