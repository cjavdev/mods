import { describe, expect, test } from 'claude-code/testing'
import type { On, SessionContextUsage } from 'claude-code'

import { bar, compact } from '../hooks/meter'

const HINT = {
  plugin: 'context-meter',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: 'auto mode on' },
} as const

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const SURFACES = ['terminal', 'desktop'] as const

// Answers what the engine would beneath the plugins, the window's fill read
// from `fill()` so a test can move it.
const engine = (on: On, fill: () => SessionContextUsage) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context: fill(), rateLimits: [] } }))
  // The hint row as the engine draws it: its line, then any tail.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tail ? `${e.props.hint} · ${e.props.tail}` : e.props.hint}</Text>
  })
}

describe('helpers', () => {
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

describe('meter', () => {
  test('nothing until a response', async ($, on) => {
    engine(on, () => ({ window: 200_000 }))
    await $.session.start(START)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...HINT, surface })
      expect(await ui.find({ type: 'Text', text: 'auto mode on' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('five cells, the percent and the counts, at the end of the hint row', async ($, on) => {
    let context: SessionContextUsage = { window: 1_000_000, tokens: 49_000, percent: 5 }
    engine(on, () => context)
    await $.session.start(START)

    for (const surface of SURFACES) {
      context = { window: 1_000_000, tokens: 49_000, percent: 5 }
      await $.session.measure({ context, rateLimits: [], changed: ['context'] })
      const ui = await $.ui.mount({ ...HINT, surface })
      expect(await ui.find({ type: 'Text', text: 'auto mode on · ░░░░░ 5% 49k/1M' })).toBeDefined()

      context = { window: 200_000, tokens: 152_000, percent: 76 }
      await $.session.measure({ context, rateLimits: [], changed: ['context'] })
      expect(await ui.find({ type: 'Text', text: 'auto mode on · ████░ 76% 152k/200k' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('off in /config: the hint row is left alone', { options: { enabled: false } }, async ($, on) => {
    engine(on, () => ({ window: 200_000, tokens: 20_000, percent: 10 }))
    await $.session.start(START)
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'auto mode on' })).toBeDefined()
    await ui.unmount()
  })
})
