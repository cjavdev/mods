import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fill } from '../types'
import { bar, colorFor, compact } from './meter'

const fill = atom({ plugin: 'context-meter', key: 'fill' } as const, null)

// Reads the window's fill (the free call: no token counting) and stores it;
// a changed value redraws the band.
const refresh = async ($: EngineInterface) => {
  const { context } = await $.session.usage()
  const now: Fill | null =
    context.tokens === undefined || context.percent === undefined
      ? null
      : { tokens: context.tokens, window: context.window, percent: context.percent }

  await update($, fill, prev =>
    prev?.tokens === now?.tokens && prev?.window === now?.window ? prev : now,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    // Catches a model switch, /compact or /clear between turns.
    $.clock.every(3000, () => void refresh($))
    return result
  })

  // A tool result follows a model response, so the bar moves mid-turn.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  // The engine pushes this after each main-thread turn when the fill moved.
  on('session.measure', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const f = await read($, fill)
    const width = Math.max(10, Math.min(30, e.props.bodyColumns - 40))

    // No reading until a response of the live window: a fresh session, or
    // one just compacted or cleared.
    if (f === null) {
      return (
        <Box>
          <Text dimColor>Context {'░'.repeat(width)} waiting for a response</Text>
        </Box>
      )
    }

    const color = colorFor(f.percent)
    const { filled, empty } = bar(f.percent, width)

    return (
      <Box>
        <Text dimColor>Context </Text>
        <Text color={color}>{filled}</Text>
        <Text dimColor>{empty}</Text>
        <Text color={color} bold>
          {` ${f.percent}%`}
        </Text>
        <Text dimColor>{` · ${compact(f.tokens)} / ${compact(f.window)} tokens`}</Text>
      </Box>
    )
  })
}
